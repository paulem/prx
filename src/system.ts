import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
  };
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}
