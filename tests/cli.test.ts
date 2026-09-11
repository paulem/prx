import { describe, expect, test } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { runCli } from "../src/cli.ts";
import { createFakeSystem } from "./fake-system.ts";

describe("prx", () => {
  test("--version prints the package version", async () => {
    const fake = createFakeSystem();

    const exitCode = await runCli(["--version"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.stdout()).toBe(`${pkg.version}\n`);
    expect(fake.stderr()).toBe("");
  });
});

describe("prx help", () => {
  const plannedCommands = ["run", "init", "up", "down", "status", "list", "config", "uninstall"];

  test("--help lists the planned commands on stdout", async () => {
    const fake = createFakeSystem();

    const exitCode = await runCli(["--help"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.stderr()).toBe("");
    for (const command of plannedCommands) {
      expect(fake.stdout()).toContain(command);
    }
  });

  test("bare prx prints the same help as --help", async () => {
    const withFlag = createFakeSystem();
    const bare = createFakeSystem();

    await runCli(["--help"], withFlag.system);
    const exitCode = await runCli([], bare.system);

    expect(exitCode).toBe(0);
    expect(bare.stdout()).toBe(withFlag.stdout());
    expect(bare.stderr()).toBe("");
  });
});

describe("prx usage errors", () => {
  test("unknown command prints a usage error to stderr and exits 2", async () => {
    const fake = createFakeSystem();

    const exitCode = await runCli(["bogus"], fake.system);

    expect(exitCode).toBe(2);
    expect(fake.stdout()).toBe("");
    expect(fake.stderr()).toMatch(/unknown command 'bogus'/);
    expect(fake.stderr()).toMatch(/--help/);
  });
});
