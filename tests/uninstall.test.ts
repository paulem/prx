import { describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import {
  builtInProxy,
  CANCEL,
  createFakeSystem,
  externalProxy,
  FAKE_CONFIG_PATH,
  FAKE_STATE_DIR,
  writeFakeConfig,
  type FakeSystem,
} from "./fake-system.ts";

const BINARY = "/home/test/.local/bin/prx";
const ZSHRC = "/home/test/.zshrc";
const PATH_BLOCK = '# >>> prx >>>\nexport PATH="$HOME/.local/bin:$PATH"\n# <<< prx <<<\n';
const ZSHRC_BEFORE = "alias ll='ls -l'\n";
const ZSHRC_AFTER = 'export EDITOR="vim"\n';

function installedFake(): FakeSystem {
  const fake = createFakeSystem();
  fake.files.set(BINARY, "#!/usr/bin/env node\n");
  writeFakeConfig(fake, externalProxy({ http: { host: "127.0.0.1", port: 8118 } }));
  fake.files.set(ZSHRC, `${ZSHRC_BEFORE}\n${PATH_BLOCK}${ZSHRC_AFTER}`);
  return fake;
}

describe("prx uninstall", () => {
  test("lists the binary, config directory and PATH block, asks once, and removes them", async () => {
    const fake = installedFake();
    fake.answers.push(true);

    const exitCode = await runCli(["uninstall"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.stdout()).toBe(
      "prx uninstall will remove:\n" +
        `  ${BINARY}\n` +
        "  /home/test/.config/prx\n" +
        `  the prx PATH block in ${ZSHRC}\n` +
        `Removed ${BINARY}\n` +
        "Removed /home/test/.config/prx\n" +
        `Removed the prx PATH block in ${ZSHRC}\n`,
    );
    expect(fake.questions).toEqual([
      { kind: "confirm", message: "Remove these?", initialValue: false },
    ]);
    expect(fake.files.has(BINARY)).toBe(false);
    expect(fake.files.has(FAKE_CONFIG_PATH)).toBe(false);
    expect(fake.removed).toEqual([BINARY, "/home/test/.config/prx"]);
  });

  test("removes exactly the marked block from .zshrc", async () => {
    const fake = installedFake();
    fake.answers.push(true);

    await runCli(["uninstall"], fake.system);

    expect(fake.files.get(ZSHRC)).toBe(`${ZSHRC_BEFORE}${ZSHRC_AFTER}`);
  });

  test("removes the block cleanly when no blank line precedes it", async () => {
    const fake = installedFake();
    fake.files.set(ZSHRC, `${ZSHRC_BEFORE}${PATH_BLOCK}${ZSHRC_AFTER}`);

    await runCli(["uninstall", "--yes"], fake.system);

    expect(fake.files.get(ZSHRC)).toBe(`${ZSHRC_BEFORE}${ZSHRC_AFTER}`);
  });

  test("a .zshrc that is only the block becomes empty", async () => {
    const fake = installedFake();
    fake.files.set(ZSHRC, PATH_BLOCK);

    await runCli(["uninstall", "--yes"], fake.system);

    expect(fake.files.get(ZSHRC)).toBe("");
  });

  test("--yes skips the confirmation", async () => {
    const fake = installedFake();

    const exitCode = await runCli(["uninstall", "--yes"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.questions).toEqual([]);
    expect(fake.removed).toEqual([BINARY, "/home/test/.config/prx"]);
  });

  test("declining removes nothing", async () => {
    const fake = installedFake();
    fake.answers.push(false);

    const exitCode = await runCli(["uninstall"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.stdout()).toMatch(/Nothing removed\n$/);
    expect(fake.removed).toEqual([]);
    expect(fake.files.get(ZSHRC)).toContain(PATH_BLOCK);
  });

  test("cancelling the prompt removes nothing", async () => {
    const fake = installedFake();
    fake.answers.push(CANCEL);

    const exitCode = await runCli(["uninstall"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.removed).toEqual([]);
  });

  test("lists only what exists", async () => {
    const fake = createFakeSystem();
    writeFakeConfig(fake, externalProxy({ http: { host: "127.0.0.1", port: 8118 } }));
    fake.answers.push(true);

    await runCli(["uninstall"], fake.system);

    expect(fake.stdout()).toBe(
      "prx uninstall will remove:\n  /home/test/.config/prx\nRemoved /home/test/.config/prx\n",
    );
  });

  test("stops a running built-in proxy and removes the state directory", async () => {
    const fake = installedFake();
    writeFakeConfig(fake, builtInProxy());
    fake.files.set(`${FAKE_STATE_DIR}/autossh.pid`, "1001\n");
    fake.files.set(`${FAKE_STATE_DIR}/privoxy.pid`, "1002\n");
    fake.files.set(`${FAKE_STATE_DIR}/privoxy.conf`, "listen-address 127.0.0.1:8118\n");
    fake.alivePids.add(1001);
    fake.alivePids.add(1002);

    const exitCode = await runCli(["uninstall", "--yes"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.stdout()).toBe(
      "prx uninstall will remove:\n" +
        `  ${BINARY}\n` +
        "  /home/test/.config/prx\n" +
        `  ${FAKE_STATE_DIR}\n` +
        `  the prx PATH block in ${ZSHRC}\n` +
        `Removed ${BINARY}\n` +
        "Removed /home/test/.config/prx\n" +
        `Removed ${FAKE_STATE_DIR}\n` +
        `Removed the prx PATH block in ${ZSHRC}\n`,
    );
    expect(fake.signals).toEqual([
      { pid: 1001, signal: "SIGTERM" },
      { pid: 1002, signal: "SIGTERM" },
    ]);
    expect(fake.removed).toContain(FAKE_STATE_DIR);
    expect([...fake.files.keys()].some((file) => file.startsWith(FAKE_STATE_DIR))).toBe(false);
  });

  test("removes a state directory left by a stopped proxy without signalling anything", async () => {
    const fake = createFakeSystem();
    fake.files.set(`${FAKE_STATE_DIR}/autossh.log`, "");

    const exitCode = await runCli(["uninstall", "--yes"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.signals).toEqual([]);
    expect(fake.removed).toEqual([FAKE_STATE_DIR]);
  });

  test("says so when there is nothing to remove", async () => {
    const fake = createFakeSystem();

    const exitCode = await runCli(["uninstall"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.stdout()).toBe("Nothing to remove, prx is not installed\n");
    expect(fake.questions).toEqual([]);
  });
});
