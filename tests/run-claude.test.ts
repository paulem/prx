import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import {
  createFakeSystem,
  externalProxy,
  writeFakeConfig,
  type FakeSystem,
} from "./fake-system.ts";
import { startTestProxy, trustProbeTarget, type TestProxy } from "./test-proxy.ts";

const CLAUDE_PATH = "/home/test/.local/bin/claude";

beforeAll(() => {
  trustProbeTarget();
});

let proxy: TestProxy | undefined;
afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
});

async function withLiveProxy(): Promise<FakeSystem> {
  proxy = await startTestProxy("live");
  const fake = createFakeSystem();
  writeFakeConfig(fake, externalProxy({ http: proxy }));
  fake.onPath.set("claude", CLAUDE_PATH);
  return fake;
}

describe("prx run claude", () => {
  test("launches claude attached with the proxy injected through the environment", async () => {
    const fake = await withLiveProxy();

    const exitCode = await runCli(["run", "claude"], fake.system);

    expect(exitCode).toBe(0);
    const proxyAddress = `http://127.0.0.1:${proxy?.port}`;
    expect(fake.spawns).toEqual([
      {
        command: CLAUDE_PATH,
        args: [],
        env: {
          HTTP_PROXY: proxyAddress,
          HTTPS_PROXY: proxyAddress,
          http_proxy: proxyAddress,
          https_proxy: proxyAddress,
          NO_PROXY: "localhost,127.0.0.1,::1",
          no_proxy: "localhost,127.0.0.1,::1",
        },
      },
    ]);
    expect(fake.stdout()).toBe("");
    expect(fake.stderr()).toMatch(
      /^prx: http endpoint http:\/\/127\.0\.0\.1:\d+ is live \(\d+ ms\), launching claude\n$/,
    );
  });

  test("everything after the preset name reaches claude verbatim", async () => {
    const fake = await withLiveProxy();

    await runCli(["run", "claude", "--resume", "--json", "-p", "hello world"], fake.system);

    expect(fake.spawns[0]?.args).toEqual(["--resume", "--json", "-p", "hello world"]);
    expect(fake.stdout()).toBe("");
  });

  test("exits with the app's exit code", async () => {
    const fake = await withLiveProxy();
    fake.spawnOutcome = { exitCode: 7, signal: null };

    const exitCode = await runCli(["run", "claude"], fake.system);

    expect(exitCode).toBe(7);
  });

  test("exits with 128 plus the signal number when the app is killed", async () => {
    const fake = await withLiveProxy();
    fake.spawnOutcome = { exitCode: null, signal: "SIGTERM" };

    const exitCode = await runCli(["run", "claude"], fake.system);

    expect(exitCode).toBe(143);
  });

  test("--no-check launches without probing", async () => {
    const fake = createFakeSystem();
    writeFakeConfig(fake, externalProxy({ http: { host: "127.0.0.1", port: 1 } }));
    fake.onPath.set("claude", CLAUDE_PATH);

    const exitCode = await runCli(["run", "--no-check", "claude"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.spawns).toHaveLength(1);
    expect(fake.stderr()).toBe(
      "prx: http endpoint http://127.0.0.1:1 not probed (--no-check), launching claude\n",
    );
  });

  test("a proxy that is not live stops the launch with exit 1", async () => {
    const closed = await startTestProxy("live");
    await closed.close();
    const fake = createFakeSystem();
    writeFakeConfig(fake, externalProxy({ http: closed }));
    fake.onPath.set("claude", CLAUDE_PATH);

    const exitCode = await runCli(["run", "claude"], fake.system);

    expect(exitCode).toBe(1);
    expect(fake.spawns).toEqual([]);
    expect(fake.stderr()).toBe(
      `Endpoint http://127.0.0.1:${closed.port} is not live: connection refused (ECONNREFUSED)\n`,
    );
  });

  test("--json reports the launch on stdout before handing over", async () => {
    const fake = await withLiveProxy();

    const exitCode = await runCli(["run", "--json", "claude"], fake.system);

    expect(exitCode).toBe(0);
    expect(JSON.parse(fake.stdout())).toEqual({
      preset: "claude",
      endpoint: { type: "http", host: "127.0.0.1", port: proxy?.port },
      latencyMs: expect.any(Number),
    });
    expect(fake.stderr()).toBe("");
    expect(fake.spawns).toHaveLength(1);
  });
});

describe("prx run claude endpoint selection", () => {
  test("keeps using the HTTP endpoint when the proxy also has a SOCKS one", async () => {
    proxy = await startTestProxy("live");
    const fake = createFakeSystem();
    writeFakeConfig(fake, externalProxy({ http: proxy, socks: { host: "127.0.0.1", port: 1 } }));
    fake.onPath.set("claude", CLAUDE_PATH);

    const exitCode = await runCli(["run", "--json", "claude"], fake.system);

    expect(exitCode).toBe(0);
    expect(JSON.parse(fake.stdout()).endpoint).toEqual({
      type: "http",
      host: "127.0.0.1",
      port: proxy.port,
    });
  });

  test("a SOCKS-only proxy fails with endpoint_missing and exit 2 before any launch", async () => {
    const fake = createFakeSystem();
    writeFakeConfig(fake, externalProxy({ socks: { host: "127.0.0.1", port: 1080 } }));
    fake.onPath.set("claude", CLAUDE_PATH);

    const exitCode = await runCli(["run", "claude"], fake.system);

    expect(exitCode).toBe(2);
    expect(fake.spawns).toEqual([]);
    expect(fake.stderr()).toBe(
      "The proxy has no http endpoint, which claude needs. Run prx init to record one.\n",
    );
  });

  test("--via socks fails with endpoint_missing because claude cannot use SOCKS", async () => {
    const fake = await withLiveProxy();

    const exitCode = await runCli(["run", "--via", "socks", "claude"], fake.system);

    expect(exitCode).toBe(2);
    expect(fake.spawns).toEqual([]);
    expect(fake.stderr()).toBe("claude cannot use a socks endpoint, only http.\n");
  });
});

describe("prx run errors", () => {
  test("an unknown preset is a usage error with exit 2", async () => {
    const fake = await withLiveProxy();

    const exitCode = await runCli(["run", "clod"], fake.system);

    expect(exitCode).toBe(2);
    expect(fake.spawns).toEqual([]);
    expect(fake.stderr()).toBe("Unknown preset 'clod'. Run prx list to see the presets.\n");
  });

  test("an app that is not installed is a usage error with exit 2", async () => {
    const fake = await withLiveProxy();
    fake.onPath.clear();

    const exitCode = await runCli(["run", "claude"], fake.system);

    expect(exitCode).toBe(2);
    expect(fake.spawns).toEqual([]);
    expect(fake.stderr()).toBe("claude is not installed: no 'claude' command found on PATH\n");
  });

  test("errors in JSON mode are one object on stdout with the same exit code", async () => {
    const fake = await withLiveProxy();
    fake.onPath.clear();

    const exitCode = await runCli(["run", "--json", "claude"], fake.system);

    expect(exitCode).toBe(2);
    expect(JSON.parse(fake.stdout())).toEqual({
      error: {
        code: "app_not_installed",
        message: "claude is not installed: no 'claude' command found on PATH",
      },
    });
    expect(fake.stderr()).toBe("");
  });
});
