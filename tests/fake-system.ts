import type {
  LaunchRequest,
  PromptAnswer,
  SpawnOutcome,
  SpawnRequest,
  SystemAdapter,
} from "../src/system.ts";

/** Scripted answer that cancels the prompt, as Ctrl-C would */
export const CANCEL = Symbol("cancel");
/** Scripted answer that accepts a text prompt's initial value, as a bare Enter would */
export const USE_DEFAULT = Symbol("use default");

export type ScriptedAnswer = string | boolean | typeof CANCEL | typeof USE_DEFAULT;

export type AskedQuestion =
  | { kind: "select"; message: string; options: { value: string; label: string }[] }
  | { kind: "text"; message: string; initialValue: string }
  | { kind: "confirm"; message: string; initialValue: boolean };

export interface RejectedInput {
  input: string;
  message: string;
}

export interface FakeSystem {
  system: SystemAdapter;
  stdout: () => string;
  stderr: () => string;
  /** In-memory files keyed by absolute path */
  files: Map<string, string>;
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
  /** Answers handed to prompts in order; a text prompt consumes one per attempt */
  answers: ScriptedAnswer[];
  /** Every prompt the CLI asked, in order */
  questions: AskedQuestion[];
  /** Text inputs a prompt's validation turned down, with the message shown */
  rejectedInputs: RejectedInput[];
}

export const FAKE_HOME = "/home/test";
export const FAKE_CONFIG_PATH = `${FAKE_HOME}/.config/prx/config.json`;

function answered<T>(value: T): PromptAnswer<T> {
  return { kind: "answered", value };
}

export function createFakeSystem(): FakeSystem {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
  const onPath = new Map<string, string>();
  const applications = new Map<string, string>();
  const spawns: SpawnRequest[] = [];
  const launches: LaunchRequest[] = [];
  const running = new Set<string>();
  const answers: ScriptedAnswer[] = [];
  const questions: AskedQuestion[] = [];
  const rejectedInputs: RejectedInput[] = [];

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
      configDir: () => `${FAKE_HOME}/.config/prx`,
      readTextFile: async (path) => files.get(path),
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
      prompt: {
        async select(question) {
          questions.push({ kind: "select", message: question.message, options: question.options });
          const answer = nextAnswer();
          if (answer === CANCEL) {
            return { kind: "cancelled" };
          }
          const option = question.options.find((candidate) => candidate.value === answer);
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
    files,
    onPath,
    applications,
    spawns,
    spawnOutcome: { exitCode: 0, signal: null },
    launches,
    running,
    answers,
    questions,
    rejectedInputs,
  };
  return fake;
}

export function writeFakeConfig(fake: FakeSystem, proxy: { host: string; port: number }): void {
  fake.files.set(
    FAKE_CONFIG_PATH,
    JSON.stringify({ version: 1, proxy: { type: "http", host: proxy.host, port: proxy.port } }),
  );
}
