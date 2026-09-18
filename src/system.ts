import * as clack from "@clack/prompts";
import { execFile, spawn } from "node:child_process";
import { cyan } from "./style.ts";
import {
  access,
  constants,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export type PromptAnswer<T> = { kind: "answered"; value: T } | { kind: "cancelled" };

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** Shown dimmed next to the label while the option is highlighted */
  hint?: string | undefined;
}

export interface SelectQuestion<T extends string> {
  message: string;
  options: SelectOption<T>[];
  /** The option highlighted at first; the first option when omitted */
  initialValue?: T | undefined;
}

export interface TextQuestion {
  message: string;
  initialValue: string;
  /** Returns the problem with an input, or undefined when it is acceptable */
  validate: (input: string) => string | undefined;
}

export interface ConfirmQuestion {
  message: string;
  initialValue: boolean;
}

/** Interactive questions, answered by a person at the terminal or scripted by a test */
export interface Prompter {
  select: <T extends string>(question: SelectQuestion<T>) => Promise<PromptAnswer<T>>;
  text: (question: TextQuestion) => Promise<PromptAnswer<string>>;
  confirm: (question: ConfirmQuestion) => Promise<PromptAnswer<boolean>>;
}

export interface SpawnRequest {
  command: string;
  args: string[];
  /** Variables added on top of prx's own environment */
  env: Record<string, string>;
}

export interface LaunchRequest {
  command: string;
  args: string[];
}

export interface BackgroundRequest {
  command: string;
  args: string[];
  /** Variables added on top of prx's own environment */
  env: Record<string, string>;
  /** Where the process's stdout and stderr are appended */
  logPath: string;
}

export interface SpawnOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export type OutputStream = "stdout" | "stderr";

/** A transient activity indicator on stderr, gone without a trace once cleared */
export interface Spinner {
  start: (message: string) => void;
  message: (message: string) => void;
  clear: () => void;
}

/**
 * The single seam between prx and the operating system. Every OS touchpoint
 * goes through here so tests can substitute it
 */
export interface SystemAdapter {
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
  /** Whether a stream may carry color, symbols and spinners: a terminal, and NO_COLOR unset */
  decorates: (stream: OutputStream) => boolean;
  spinner: () => Spinner;
  homeDir: () => string;
  /** The directory prx keeps its config in, honouring XDG_CONFIG_HOME */
  configDir: () => string;
  /** The directory prx keeps pid files, generated configs and logs in, honouring XDG_STATE_HOME */
  stateDir: () => string;
  pathExists: (path: string) => Promise<boolean>;
  /** Deletes a file or a whole directory; a missing path is not an error */
  remove: (path: string) => Promise<void>;
  /** Resolves to undefined when the file does not exist */
  readTextFile: (path: string) => Promise<string | undefined>;
  /** The entry names in a directory, sorted; empty when the directory does not exist */
  listDirectory: (path: string) => Promise<string[]>;
  /** Creates missing parent directories */
  writeTextFile: (path: string, text: string) => Promise<void>;
  /** Resolves to the executable's path when the command is on PATH */
  findOnPath: (command: string) => Promise<string | undefined>;
  /** Resolves to the bundle path when the app is in /Applications or ~/Applications */
  findApplication: (name: string) => Promise<string | undefined>;
  /** Runs the app in the foreground sharing this terminal, resolving when it exits */
  spawnAttached: (request: SpawnRequest) => Promise<SpawnOutcome>;
  /** Starts the launcher command and resolves once it has handed the app off, capturing no output */
  launchDetached: (request: LaunchRequest) => Promise<void>;
  /** Whether an app from an Applications folder has a running instance */
  isApplicationRunning: (name: string) => Promise<boolean>;
  /** Starts a process that outlives prx, with its output replacing the log file, and resolves to its pid */
  startBackground: (request: BackgroundRequest) => Promise<number>;
  isProcessAlive: (pid: number) => Promise<boolean>;
  /** Sends a signal; a process that is already gone is not an error */
  signalProcess: (pid: number, signal: NodeJS.Signals) => Promise<void>;
  /** Whether nothing listens on the port on 127.0.0.1 */
  isPortFree: (port: number) => Promise<boolean>;
  /** The public keys ssh-agent holds, one per line; empty when it holds none or there is no agent */
  sshAgentKeys: () => Promise<string[]>;
  prompt: Prompter;
}

export function createNodeSystemAdapter(env: NodeJS.ProcessEnv = process.env): SystemAdapter {
  return {
    writeStdout(text) {
      process.stdout.write(text);
    },
    writeStderr(text) {
      process.stderr.write(text);
    },
    decorates(stream) {
      const noColor = env.NO_COLOR !== undefined && env.NO_COLOR !== "";
      return process[stream].isTTY === true && !noColor;
    },
    spinner: createSpinner,
    homeDir: homedir,
    configDir() {
      const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
      return join(base, "prx");
    },
    stateDir() {
      const base = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
      return join(base, "prx");
    },
    pathExists,
    async remove(path) {
      await rm(path, { recursive: true, force: true });
    },
    async readTextFile(path) {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if (isMissingFile(error)) {
          return undefined;
        }
        throw error;
      }
    },
    async listDirectory(path) {
      try {
        return (await readdir(path)).toSorted();
      } catch (error) {
        if (isMissingFile(error)) {
          return [];
        }
        throw error;
      }
    },
    async writeTextFile(path, text) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, "utf8");
    },
    async findOnPath(command) {
      const directories = (env.PATH ?? "").split(delimiter).filter((entry) => entry !== "");
      const candidates = directories.map((directory) => join(directory, command));
      return firstExisting(candidates, isExecutableFile);
    },
    async findApplication(name) {
      const bundle = `${name}.app`;
      const candidates = [join("/Applications", bundle), join(homedir(), "Applications", bundle)];
      return firstExisting(candidates, pathExists);
    },
    spawnAttached(request) {
      return new Promise((resolve, reject) => {
        const child = spawn(request.command, request.args, {
          stdio: "inherit",
          env: { ...env, ...request.env },
        });
        child.on("error", reject);
        child.on("exit", (exitCode, signal) => resolve({ exitCode, signal }));
      });
    },
    launchDetached(request) {
      return new Promise((resolve, reject) => {
        const child = spawn(request.command, request.args, { stdio: "ignore" });
        child.on("error", reject);
        child.on("exit", (exitCode) => {
          if (exitCode === 0) {
            resolve();
          } else {
            reject(new Error(`${request.command} exited with code ${exitCode}`));
          }
        });
      });
    },
    isApplicationRunning(name) {
      // pgrep exits 0 when a process with exactly that name exists and 1 when none does
      return new Promise((resolve, reject) => {
        execFile("pgrep", ["-x", name], (error) => {
          if (error === null) {
            resolve(true);
          } else if (error.code === 1) {
            resolve(false);
          } else {
            reject(error);
          }
        });
      });
    },
    async startBackground(request) {
      await mkdir(dirname(request.logPath), { recursive: true });
      const log = await open(request.logPath, "w");
      try {
        return await new Promise<number>((resolve, reject) => {
          const child = spawn(request.command, request.args, {
            detached: true,
            stdio: ["ignore", log.fd, log.fd],
            env: { ...env, ...request.env },
          });
          child.on("error", reject);
          child.on("spawn", () => {
            child.unref();
            resolve(child.pid as number);
          });
        });
      } finally {
        await log.close();
      }
    },
    async isProcessAlive(pid) {
      // Signal 0 checks for the process without touching it; EPERM means it exists but is not ours
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return isErrorWithCode(error, "EPERM");
      }
    },
    async signalProcess(pid, signal) {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if (!isErrorWithCode(error, "ESRCH")) {
          throw error;
        }
      }
    },
    isPortFree(port) {
      return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", (error) => {
          if (isErrorWithCode(error, "EADDRINUSE")) {
            resolve(false);
          } else {
            reject(error);
          }
        });
        server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
      });
    },
    sshAgentKeys() {
      // ssh-add exits 1 when the agent holds nothing and 2 when there is no agent to ask
      return new Promise((resolve) => {
        execFile("ssh-add", ["-L"], (error, stdout) => {
          resolve(error === null ? nonEmptyLines(stdout) : []);
        });
      });
    },
    prompt: {
      async select<T extends string>(question: SelectQuestion<T>) {
        // clack types options through a conditional on the value type, which a generic cannot satisfy
        const options = question.options as Parameters<typeof clack.select<T>>[0]["options"];
        const initial =
          question.initialValue === undefined ? {} : { initialValue: question.initialValue };
        return answerFrom(
          await clack.select<T>({ message: question.message, options, ...initial }),
        );
      },
      async text(question) {
        return answerFrom(
          await clack.text({
            message: question.message,
            initialValue: question.initialValue,
            validate: (input) => question.validate(input ?? ""),
          }),
        );
      },
      async confirm(question) {
        return answerFrom(
          await clack.confirm({ message: question.message, initialValue: question.initialValue }),
        );
      },
    },
  };
}

const SPINNER_FRAMES = ["◒", "◐", "◓", "◑"];
const SPINNER_INTERVAL_MS = 80;
const DEFAULT_COLUMNS = 80;
/** Back to the start of the line, then erase all of it */
const ERASE_LINE = "\r[2K";
const ELLIPSIS = "…";

/**
 * prx's own spinner rather than clack's, which puts stdin in raw mode to swallow keystrokes
 * while it turns. Raw mode suppresses SIGINT, so Ctrl-C became a silent exit 0, and whatever
 * was typed ahead was eaten instead of reaching the shell. A wait is not a prompt, so this one
 * only ever writes. The message is truncated to the terminal's width, which keeps a clear from
 * having wrapped rows to erase, and the cursor stays visible, since a signal would otherwise
 * leave it hidden for good
 */
function createSpinner(): Spinner {
  let timer: NodeJS.Timeout | undefined;
  let frame = 0;
  let message = "";

  function draw(): void {
    const glyph = SPINNER_FRAMES[frame] as string;
    process.stderr.write(`${ERASE_LINE}${cyan(glyph)}  ${truncate(message, columns() - 3)}`);
    frame = (frame + 1) % SPINNER_FRAMES.length;
  }

  return {
    start(first) {
      message = first;
      draw();
      // Never unref'd: a wait that does not end should hold the process open for a Ctrl-C
      timer = setInterval(draw, SPINNER_INTERVAL_MS);
    },
    message(next) {
      message = next;
    },
    clear() {
      clearInterval(timer);
      timer = undefined;
      process.stderr.write(ERASE_LINE);
    },
  };
}

// A pty nobody sized reports 0 columns, which would leave no room for the message at all
function columns(): number {
  const width = process.stderr.columns;
  return width !== undefined && width > 0 ? width : DEFAULT_COLUMNS;
}

function truncate(text: string, room: number): string {
  if (room <= 0) {
    return "";
  }
  return text.length <= room ? text : `${text.slice(0, room - 1)}${ELLIPSIS}`;
}

function nonEmptyLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function answerFrom<T>(value: T | symbol): PromptAnswer<T> {
  if (clack.isCancel(value)) {
    return { kind: "cancelled" };
  }
  return { kind: "answered", value: value as T };
}

// Checks every candidate at once; the earliest in the list still wins so PATH order is respected
async function firstExisting(
  candidates: string[],
  exists: (path: string) => Promise<boolean>,
): Promise<string | undefined> {
  const checks = await Promise.all(candidates.map(exists));
  return candidates.find((_candidate, index) => checks[index] === true);
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      return false;
    }
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isMissingFile(error: unknown): boolean {
  return isErrorWithCode(error, "ENOENT");
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
