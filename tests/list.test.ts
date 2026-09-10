import { describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import { createFakeSystem } from "./fake-system.ts";

describe("prx list", () => {
  test("shows each preset with found or missing and its launch mode", async () => {
    const fake = createFakeSystem();
    fake.onPath.set("claude", "/home/test/.local/bin/claude");

    const exitCode = await runCli(["list"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.stdout()).toBe("claude  found    attached\nchrome  missing  detached\n");
    expect(fake.stderr()).toBe("");
  });

  test("finds Chrome in the Applications folder", async () => {
    const fake = createFakeSystem();
    fake.applications.set("Google Chrome", "/Applications/Google Chrome.app");

    await runCli(["list"], fake.system);

    expect(fake.stdout()).toBe("claude  missing  attached\nchrome  found    detached\n");
  });

  test("--json prints one object listing the presets", async () => {
    const fake = createFakeSystem();
    fake.onPath.set("claude", "/home/test/.local/bin/claude");

    const exitCode = await runCli(["list", "--json"], fake.system);

    expect(exitCode).toBe(0);
    expect(JSON.parse(fake.stdout())).toEqual({
      presets: [
        { name: "claude", found: true, launch: "attached" },
        { name: "chrome", found: false, launch: "detached" },
      ],
    });
  });
});
