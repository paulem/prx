import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "tsup";
import { bundleOptions } from "../tsup.config.ts";

export interface BuiltBundle {
  dir: string;
  path: string;
}

/** Builds the shipped bundle into a fresh temp directory, exactly as install.sh would */
export async function buildBundle(): Promise<BuiltBundle> {
  const dir = await mkdtemp(join(tmpdir(), "prx-bundle-"));
  await build({ ...bundleOptions, outDir: dir, silent: true });
  return { dir, path: join(dir, "prx.js") };
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Runs this Node binary with the given arguments and captures what a terminal would see */
export function runNode(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { env }, (error, stdout, stderr) => {
      let exitCode: number | null = 0;
      if (error) {
        exitCode = typeof error.code === "number" ? error.code : null;
      }
      resolve({ exitCode, stdout, stderr });
    });
  });
}

/** The environment a subprocess gets when it must treat a temp directory as the user's home */
export function isolatedHomeEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const { XDG_CONFIG_HOME: _ignored, ...inherited } = process.env;
  return { ...inherited, HOME: home, ...extra };
}
