import { spawn } from "node:child_process";
import { access, constants, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export interface SpawnRequest {
  command: string;
  args: string[];
  /** Variables added on top of prx's own environment */
  env: Record<string, string>;
}

export interface SpawnOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * The single seam between prx and the operating system. Every OS touchpoint
 * goes through here so tests can substitute it
 */
export interface SystemAdapter {
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
  /** The directory prx keeps its config in, honouring XDG_CONFIG_HOME */
  configDir: () => string;
  /** Resolves to undefined when the file does not exist */
  readTextFile: (path: string) => Promise<string | undefined>;
  /** Creates missing parent directories */
  writeTextFile: (path: string, text: string) => Promise<void>;
  /** Resolves to the executable's path when the command is on PATH */
  findOnPath: (command: string) => Promise<string | undefined>;
  /** Resolves to the bundle path when the app is in /Applications or ~/Applications */
  findApplication: (name: string) => Promise<string | undefined>;
  /** Runs the app in the foreground sharing this terminal, resolving when it exits */
  spawnAttached: (request: SpawnRequest) => Promise<SpawnOutcome>;
}

export function createNodeSystemAdapter(env: NodeJS.ProcessEnv = process.env): SystemAdapter {
  return {
    writeStdout(text) {
      process.stdout.write(text);
    },
    writeStderr(text) {
      process.stderr.write(text);
    },
    configDir() {
      const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
      return join(base, "prx");
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
  };
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
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}
