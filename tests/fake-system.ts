import type { Address, BuiltInProxyConfig, EndpointType, ProxyConfig } from "../src/config.ts";
import type {
  BackgroundRequest,
  LaunchRequest,
  OutputStream,
  PromptAnswer,
  SpawnOutcome,
  SpawnRequest,
  SystemAdapter,
} from "../src/system.ts";

/** Scripted answer that cancels the prompt, as Ctrl-C would */
export const CANCEL = Symbol("cancel");
/** Scripted answer that accepts a prompt's initial value, as a bare Enter would */
export const USE_DEFAULT = Symbol("use default");

export type ScriptedAnswer = string | boolean | typeof CANCEL | typeof USE_DEFAULT;

export type AskedQuestion =
  | {
      kind: "select";
      message: string;
      options: { value: string; label: string; hint?: string | undefined }[];
      initialValue?: string | undefined;
    }
  | { kind: "text"; message: string; initialValue: string }
  | { kind: "confirm"; message: string; initialValue: boolean };

export interface RejectedInput {
  input: string;
  message: string;
}

export interface SentSignal {
  pid: number;
  signal: NodeJS.Signals;
}

export interface SpinnerEvent {
  kind: "start" | "message" | "clear";
  message?: string;
}

export interface FakeSystem {
  system: SystemAdapter;
  stdout: () => string;
  stderr: () => string;
  /** Streams the fake reports as decorated terminals; both plain unless a test says otherwise */
  decorated: Set<OutputStream>;
  /** Everything the CLI did with spinners, in order */
  spinners: SpinnerEvent[];
  /** In-memory files keyed by absolute path */
  files: Map<string, string>;
  /** Paths the CLI asked to delete, in order */
  removed: string[];
  /** Commands the fake reports as installed on PATH, mapped to their path */
  onPath: Map<string, string>;
  /** Apps the fake reports as installed in an Applications folder, mapped to their bundle path */
  applications: Map<string, string>;
  /** Every attached launch the CLI asked for, in order */
  spawns: SpawnRequest[];
  /** What the next attached launch reports when it ends */
  spawnOutcome: SpawnOutcome;
  /** Every detached launch the CLI asked for, in order */
  launches: LaunchRequest[];
  /** Apps the fake reports as having a running instance */
  running: Set<string>;
  /** Public key lines the fake reports as loaded in ssh-agent */
  agentKeys: string[];
  /** Every background process the CLI started, in order; each gets the next pid from 1001 */
  backgroundStarts: BackgroundRequest[];
  /** Pids the fake reports as alive; a started process is alive until it is signalled */
  alivePids: Set<number>;
  /** Every signal the CLI sent, in order */
  signals: SentSignal[];
  /** Ports the fake reports as already in use on 127.0.0.1 */
  busyPorts: Set<number>;
  /** Answers handed to prompts in order; a text prompt consumes one per attempt */
  answers: ScriptedAnswer[];
  /** Every prompt the CLI asked, in order */
  questions: AskedQuestion[];
  /** Text inputs a prompt's validation turned down, with the message shown */
  rejectedInputs: RejectedInput[];
}

export const FAKE_HOME = "/home/test";
export const FAKE_CONFIG_PATH = `${FAKE_HOME}/.config/prx/config.json`;
export const FAKE_STATE_DIR = `${FAKE_HOME}/.local/state/prx`;
const FIRST_PID = 1001;

function answered<T>(value: T): PromptAnswer<T> {
  return { kind: "answered", value };
}

export function createFakeSystem(): FakeSystem {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
  const removed: string[] = [];
  const onPath = new Map<string, string>();
  const applications = new Map<string, string>();
  const spawns: SpawnRequest[] = [];
  const launches: LaunchRequest[] = [];
  const running = new Set<string>();
  const agentKeys: string[] = [];
  const backgroundStarts: BackgroundRequest[] = [];
  const alivePids = new Set<number>();
  const signals: SentSignal[] = [];
  const busyPorts = new Set<number>();
  const answers: ScriptedAnswer[] = [];
  const questions: AskedQuestion[] = [];
  const rejectedInputs: RejectedInput[] = [];
  const decorated = new Set<OutputStream>();
  const spinners: SpinnerEvent[] = [];

  function nextAnswer(): ScriptedAnswer {
    const answer = answers.shift();
    if (answer === undefined) {
      throw new Error(`the CLI asked "${questions.at(-1)?.message}" but no answer was scripted`);
    }
    return answer;
  }

  const fake: FakeSystem = {
    system: {
      writeStdout(text) {
        out.push(text);
      },
      writeStderr(text) {
        err.push(text);
      },
      decorates: (stream) => decorated.has(stream),
      spinner: () => ({
        start: (message) => {
          spinners.push({ kind: "start", message });
        },
        message: (message) => {
          spinners.push({ kind: "message", message });
        },
        clear: () => {
          spinners.push({ kind: "clear" });
        },
      }),
      homeDir: () => FAKE_HOME,
      configDir: () => `${FAKE_HOME}/.config/prx`,
      stateDir: () => FAKE_STATE_DIR,
      pathExists: async (path) =>
        files.has(path) || [...files.keys()].some((file) => file.startsWith(`${path}/`)),
      remove: async (path) => {
        removed.push(path);
        for (const file of files.keys()) {
          if (file === path || file.startsWith(`${path}/`)) {
            files.delete(file);
          }
        }
      },
      readTextFile: async (path) => files.get(path),
      listDirectory: async (path) => {
        const names = new Set<string>();
        for (const file of files.keys()) {
          if (file.startsWith(`${path}/`)) {
            names.add(file.slice(path.length + 1).split("/")[0] as string);
          }
        }
        return [...names].toSorted();
      },
      writeTextFile: async (path, text) => {
        files.set(path, text);
      },
      findOnPath: async (command) => onPath.get(command),
      findApplication: async (name) => applications.get(name),
      spawnAttached: async (request) => {
        spawns.push(request);
        return fake.spawnOutcome;
      },
      launchDetached: async (request) => {
        launches.push(request);
      },
      isApplicationRunning: async (name) => running.has(name),
      startBackground: async (request) => {
        backgroundStarts.push(request);
        const pid = FIRST_PID + backgroundStarts.length - 1;
        alivePids.add(pid);
        return pid;
      },
      isProcessAlive: async (pid) => alivePids.has(pid),
      signalProcess: async (pid, signal) => {
        signals.push({ pid, signal });
        alivePids.delete(pid);
      },
      isPortFree: async (port) => !busyPorts.has(port),
      sshAgentKeys: async () => [...agentKeys],
      prompt: {
        async select(question) {
          questions.push({
            kind: "select",
            message: question.message,
            options: question.options,
            initialValue: question.initialValue,
          });
          const answer = nextAnswer();
          if (answer === CANCEL) {
            return { kind: "cancelled" };
          }
          const chosen =
            answer === USE_DEFAULT ? (question.initialValue ?? question.options[0]?.value) : answer;
          const option = question.options.find((candidate) => candidate.value === chosen);
          if (option === undefined) {
            throw new Error(`scripted answer ${String(answer)} is not one of the select options`);
          }
          return answered(option.value);
        },
        async text(question) {
          questions.push({
            kind: "text",
            message: question.message,
            initialValue: question.initialValue,
          });
          for (;;) {
            const answer = nextAnswer();
            if (answer === CANCEL) {
              return { kind: "cancelled" };
            }
            const input = answer === USE_DEFAULT ? question.initialValue : String(answer);
            const problem = question.validate(input);
            if (problem === undefined) {
              return answered(input);
            }
            rejectedInputs.push({ input, message: problem });
          }
        },
        async confirm(question) {
          questions.push({
            kind: "confirm",
            message: question.message,
            initialValue: question.initialValue,
          });
          const answer = nextAnswer();
          if (answer === CANCEL) {
            return { kind: "cancelled" };
          }
          return answered(answer === true);
        },
      },
    },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    decorated,
    spinners,
    files,
    removed,
    onPath,
    applications,
    spawns,
    spawnOutcome: { exitCode: 0, signal: null },
    launches,
    running,
    agentKeys,
    backgroundStarts,
    alivePids,
    signals,
    busyPorts,
    answers,
    questions,
    rejectedInputs,
  };
  return fake;
}

export function writeFakeConfig(fake: FakeSystem, proxy: ProxyConfig): void {
  fake.files.set(FAKE_CONFIG_PATH, JSON.stringify({ version: 1, proxy }));
}

/** An external proxy recording the given endpoints; a test proxy passes as an address */
export function externalProxy(endpoints: Partial<Record<EndpointType, Address>>): ProxyConfig {
  return {
    source: "external",
    endpoints: Object.fromEntries(
      Object.entries(endpoints).map(([type, { host, port }]) => [type, { host, port }]),
    ),
  };
}

/**
 * An OpenSSH private key that names the given cipher, which is all prx reads it for: "none" is
 * what an unencrypted key carries, any other name means a passphrase
 */
export function opensshPrivateKey(cipher: string): string {
  const name = Buffer.from(cipher, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(name.length);
  const body = Buffer.concat([Buffer.from("openssh-key-v1\0", "latin1"), length, name]).toString(
    "base64",
  );
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

/** A built-in proxy with a plain tunnel and the default ports, unless overridden */
export function builtInProxy(overrides: Partial<BuiltInProxyConfig> = {}): BuiltInProxyConfig {
  return {
    source: "built-in",
    tunnel: { user: "me", host: "box.example", port: 22 },
    socksPort: 1080,
    httpPort: 8118,
    ...overrides,
  };
}
