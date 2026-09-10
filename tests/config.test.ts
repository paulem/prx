import { describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import { createFakeSystem, FAKE_CONFIG_PATH, writeFakeConfig } from "./fake-system.ts";

describe("prx config", () => {
  test("prints the config path and its contents", async () => {
    const fake = createFakeSystem();
    writeFakeConfig(fake, { host: "127.0.0.1", port: 8118 });

    const exitCode = await runCli(["config"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.stdout()).toBe(
      [
        FAKE_CONFIG_PATH,
        "{",
        '  "version": 1,',
        '  "proxy": {',
        '    "type": "http",',
        '    "host": "127.0.0.1",',
        '    "port": 8118',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  test("--json prints path and contents as one object", async () => {
    const fake = createFakeSystem();
    writeFakeConfig(fake, { host: "127.0.0.1", port: 8118 });

    const exitCode = await runCli(["config", "--json"], fake.system);

    expect(exitCode).toBe(0);
    expect(JSON.parse(fake.stdout())).toEqual({
      path: FAKE_CONFIG_PATH,
      config: { version: 1, proxy: { type: "http", host: "127.0.0.1", port: 8118 } },
    });
  });

  test("missing config is an error naming the path", async () => {
    const fake = createFakeSystem();

    const exitCode = await runCli(["config"], fake.system);

    expect(exitCode).toBe(2);
    expect(fake.stderr()).toBe(
      `No config found at ${FAKE_CONFIG_PATH}. Run prx init to create one.\n`,
    );
  });
});
