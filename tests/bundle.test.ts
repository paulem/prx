import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { buildBundle, runNode, type BuiltBundle } from "./built-bundle.ts";

describe("built bundle", () => {
  let bundle: BuiltBundle;

  beforeAll(async () => {
    bundle = await buildBundle();
  });

  test("starts with a node shebang", async () => {
    const source = await readFile(bundle.path, "utf8");

    expect(source.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  test("--version prints the package version", async () => {
    const result = await runNode([bundle.path, "--version"]);

    expect(result).toEqual({ exitCode: 0, stdout: `${pkg.version}\n`, stderr: "" });
  });

  test("refuses to run on Node older than 24", async () => {
    const fakeOldNode = join(bundle.dir, "fake-old-node.mjs");
    await writeFile(
      fakeOldNode,
      'Object.defineProperty(process.versions, "node", { value: "22.1.0" });\n',
    );

    const result = await runNode(["--import", fakeOldNode, bundle.path, "--version"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("prx needs Node 24 or newer, found 22.1.0\n");
  });
});
