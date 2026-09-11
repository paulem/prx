import { describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import {
  builtInProxy,
  createFakeSystem,
  externalProxy,
  FAKE_STATE_DIR,
  writeFakeConfig,
  type FakeSystem,
} from "./fake-system.ts";

const AUTOSSH_PID = `${FAKE_STATE_DIR}/autossh.pid`;
const PRIVOXY_PID = `${FAKE_STATE_DIR}/privoxy.pid`;

/** A fake whose built-in proxy is running: both pid files exist and both pids are alive */
function runningFake(): FakeSystem {
  const fake = createFakeSystem();
  writeFakeConfig(fake, builtInProxy());
  fake.files.set(AUTOSSH_PID, "1001\n");
  fake.files.set(PRIVOXY_PID, "1002\n");
  fake.alivePids.add(1001);
  fake.alivePids.add(1002);
  return fake;
}

describe("prx down", () => {
  test("sends SIGTERM to both processes and removes the pid files", async () => {
    const fake = runningFake();

    const exitCode = await runCli(["down"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.signals).toEqual([
      { pid: 1001, signal: "SIGTERM" },
      { pid: 1002, signal: "SIGTERM" },
    ]);
    expect(fake.files.has(AUTOSSH_PID)).toBe(false);
    expect(fake.files.has(PRIVOXY_PID)).toBe(false);
    expect(fake.stdout()).toBe("Built-in proxy stopped\n");
    expect(fake.stderr()).toBe("");
  });

  test("--json prints one object", async () => {
    const fake = runningFake();

    const exitCode = await runCli(["down", "--json"], fake.system);

    expect(exitCode).toBe(0);
    expect(JSON.parse(fake.stdout())).toEqual({ stopped: true });
  });

  test("a proxy that is not running is reported with exit 0 and nothing signalled", async () => {
    const fake = createFakeSystem();
    writeFakeConfig(fake, builtInProxy());

    const exitCode = await runCli(["down"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.signals).toEqual([]);
    expect(fake.stdout()).toBe("Built-in proxy is not running\n");
  });

  test("stale pid files are removed and count as not running", async () => {
    const fake = createFakeSystem();
    writeFakeConfig(fake, builtInProxy());
    fake.files.set(AUTOSSH_PID, "4242\n");
    fake.files.set(PRIVOXY_PID, "not a pid\n");

    const exitCode = await runCli(["down", "--json"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.signals).toEqual([]);
    expect(fake.files.has(AUTOSSH_PID)).toBe(false);
    expect(fake.files.has(PRIVOXY_PID)).toBe(false);
    expect(JSON.parse(fake.stdout())).toEqual({ stopped: false });
  });

  test("a surviving process is stopped even when its sibling is already gone", async () => {
    const fake = runningFake();
    fake.alivePids.delete(1001);

    await runCli(["down"], fake.system);

    expect(fake.signals).toEqual([{ pid: 1002, signal: "SIGTERM" }]);
    expect(fake.stdout()).toBe("Built-in proxy stopped\n");
  });

  test("an external proxy fails with not_builtin", async () => {
    const fake = createFakeSystem();
    writeFakeConfig(fake, externalProxy({ http: { host: "127.0.0.1", port: 8118 } }));

    const exitCode = await runCli(["down", "--json"], fake.system);

    expect(exitCode).toBe(2);
    expect(JSON.parse(fake.stdout())).toEqual({
      error: {
        code: "not_builtin",
        message: "The proxy is external, so there is nothing for prx to stop.",
      },
    });
  });
});
