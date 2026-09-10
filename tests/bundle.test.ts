import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "tsup";
import { beforeAll, describe, expect, test } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { bundleOptions } from "../tsup.config.ts";

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runNode(args: string[]): Promise<ProcessResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, args, (error, stdout, stderr) => {
      let exitCode: number | null = 0;
      if (error) {
        exitCode = typeof error.code === "number" ? error.code : null;
      }
      resolve({ exitCode, stdout, stderr });
    });
  });
}

describe("built bundle", () => {
  let outDir: string;
  let bundlePath: string;

  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), "prx-bundle-"));
    bundlePath = join(outDir, "prx.js");
    await build({ ...bundleOptions, outDir, silent: true });
  });

  test("starts with a node shebang", async () => {
    const bundle = await readFile(bundlePath, "utf8");

    expect(bundle.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  test("--version prints the package version", async () => {
    const result = await runNode([bundlePath, "--version"]);

    expect(result).toEqual({ exitCode: 0, stdout: `${pkg.version}\n`, stderr: "" });
  });

  test("refuses to run on Node older than 24", async () => {
    const fakeOldNode = join(outDir, "fake-old-node.mjs");
    await writeFile(
      fakeOldNode,
      'Object.defineProperty(process.versions, "node", { value: "22.1.0" });\n',
    );

    const result = await runNode(["--import", fakeOldNode, bundlePath, "--version"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("prx needs Node 24 or newer, found 22.1.0\n");
  });
});
