import type { SpawnOutcome, SpawnRequest, SystemAdapter } from "../src/system.ts";

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
}

export const FAKE_HOME = "/home/test";
export const FAKE_CONFIG_PATH = `${FAKE_HOME}/.config/prx/config.json`;

export function createFakeSystem(): FakeSystem {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
  const onPath = new Map<string, string>();
  const applications = new Map<string, string>();
  const spawns: SpawnRequest[] = [];
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
    },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    files,
    onPath,
    applications,
    spawns,
    spawnOutcome: { exitCode: 0, signal: null },
  };
  return fake;
}

export function writeFakeConfig(fake: FakeSystem, proxy: { host: string; port: number }): void {
  fake.files.set(
    FAKE_CONFIG_PATH,
    JSON.stringify({ version: 1, proxy: { type: "http", host: proxy.host, port: proxy.port } }),
  );
}
