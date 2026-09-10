import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import { createFakeSystem, writeFakeConfig, type FakeSystem } from "./fake-system.ts";
import { startTestProxy, trustProbeTarget, type TestProxy } from "./test-proxy.ts";

beforeAll(() => {
  trustProbeTarget();
});

let proxy: TestProxy | undefined;
afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
});

async function checkAgainst(fake: FakeSystem, args: string[] = []): Promise<number> {
  return runCli(["check", ...args], fake.system);
}

describe("prx check", () => {
  test("reports a live proxy with its latency", async () => {
    proxy = await startTestProxy("live");
    const fake = createFakeSystem();
    writeFakeConfig(fake, proxy);

    const exitCode = await checkAgainst(fake);

    expect(exitCode).toBe(0);
    expect(fake.stdout()).toMatch(/^Proxy http:\/\/127\.0\.0\.1:\d+ is live \(\d+ ms\)\n$/);
    expect(fake.stderr()).toBe("");
  });

  test("--json prints one object with live, latency and proxy", async () => {
    proxy = await startTestProxy("live");
    const fake = createFakeSystem();
    writeFakeConfig(fake, proxy);

    const exitCode = await checkAgainst(fake, ["--json"]);

    expect(exitCode).toBe(0);
    const output = JSON.parse(fake.stdout());
    expect(output).toEqual({
      live: true,
      latencyMs: expect.any(Number),
      proxy: { type: "http", host: "127.0.0.1", port: proxy.port },
    });
    expect(fake.stderr()).toBe("");
  });

  test("a closed port is reported as refused with exit 1", async () => {
    const closed = await startTestProxy("live");
    await closed.close();
    const fake = createFakeSystem();
    writeFakeConfig(fake, closed);

    const exitCode = await checkAgainst(fake);

    expect(exitCode).toBe(1);
    expect(fake.stdout()).toMatch(/is not live: connection refused/);
  });

  test("a rejected CONNECT is reported with the proxy's status", async () => {
    proxy = await startTestProxy("reject");
    const fake = createFakeSystem();
    writeFakeConfig(fake, proxy);

    const exitCode = await checkAgainst(fake, ["--json"]);

    expect(exitCode).toBe(1);
    expect(JSON.parse(fake.stdout())).toEqual({
      live: false,
      reason: "rejected",
      message: "proxy rejected CONNECT with status 403",
      proxy: { type: "http", host: "127.0.0.1", port: proxy.port },
    });
  });

  test("a proxy that never answers is reported as timed out", async () => {
    proxy = await startTestProxy("silent");
    const fake = createFakeSystem();
    writeFakeConfig(fake, proxy);

    const exitCode = await runCli(["check", "--json"], fake.system, { probeTimeoutMs: 300 });

    expect(exitCode).toBe(1);
    expect(JSON.parse(fake.stdout())).toMatchObject({ live: false, reason: "timed_out" });
  });
});

describe("prx check config errors", () => {
  test("missing config prints where it should be and exits 2", async () => {
    const fake = createFakeSystem();

    const exitCode = await checkAgainst(fake);

    expect(exitCode).toBe(2);
    expect(fake.stdout()).toBe("");
    expect(fake.stderr()).toBe(
      "No config found at /home/test/.config/prx/config.json. Run prx init to create one.\n",
    );
  });

  test("missing config in JSON mode prints an error object on stdout", async () => {
    const fake = createFakeSystem();

    const exitCode = await checkAgainst(fake, ["--json"]);

    expect(exitCode).toBe(2);
    expect(JSON.parse(fake.stdout())).toEqual({
      error: {
        code: "config_missing",
        message:
          "No config found at /home/test/.config/prx/config.json. Run prx init to create one.",
      },
    });
    expect(fake.stderr()).toBe("");
  });

  test("invalid config names the file and exits 2", async () => {
    const fake = createFakeSystem();
    fake.files.set("/home/test/.config/prx/config.json", '{"version":1,"proxy":{"type":"socks"}}');

    const exitCode = await checkAgainst(fake);

    expect(exitCode).toBe(2);
    expect(fake.stderr()).toMatch(
      /^Config at \/home\/test\/\.config\/prx\/config\.json is invalid: /,
    );
  });

  test("malformed JSON config is invalid, not a crash", async () => {
    const fake = createFakeSystem();
    fake.files.set("/home/test/.config/prx/config.json", "{not json");

    const exitCode = await checkAgainst(fake);

    expect(exitCode).toBe(2);
    expect(fake.stderr()).toMatch(/is invalid: not valid JSON/);
  });
});
