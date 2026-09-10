import type { SystemAdapter } from "../src/system.ts";

export interface FakeSystem {
  system: SystemAdapter;
  stdout: () => string;
  stderr: () => string;
}

export function createFakeSystem(): FakeSystem {
  const out: string[] = [];
  const err: string[] = [];
  return {
    system: {
      writeStdout(text) {
        out.push(text);
      },
      writeStderr(text) {
        err.push(text);
      },
    },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}
