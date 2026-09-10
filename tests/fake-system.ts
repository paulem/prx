import type { SystemAdapter } from "../src/system.ts";

export interface FakeSystem {
  system: SystemAdapter;
  stdout: () => string;
  stderr: () => string;
  /** In-memory files keyed by absolute path */
  files: Map<string, string>;
}

export const FAKE_HOME = "/home/test";
export const FAKE_CONFIG_PATH = `${FAKE_HOME}/.config/prx/config.json`;

export function createFakeSystem(): FakeSystem {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
  return {
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
    },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    files,
  };
}

export function writeFakeConfig(fake: FakeSystem, proxy: { host: string; port: number }): void {
  fake.files.set(
    FAKE_CONFIG_PATH,
    JSON.stringify({ version: 1, proxy: { type: "http", host: proxy.host, port: proxy.port } }),
  );
}
