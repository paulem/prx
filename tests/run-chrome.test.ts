import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import {
  createFakeSystem,
  externalProxy,
  writeFakeConfig,
  type FakeSystem,
} from "./fake-system.ts";
import { startTestProxy, trustProbeTarget, type TestProxy } from "./test-proxy.ts";

const CHROME_PATH = "/Applications/Google Chrome.app";
const LANDING_URL = "https://api.ipify.org";

beforeAll(() => {
  trustProbeTarget();
});

let proxy: TestProxy | undefined;
afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
});

let socks: TestProxy | undefined;
afterEach(async () => {
  await socks?.close();
  socks = undefined;
});

/** A fake with Chrome installed and an external proxy that has only an HTTP endpoint */
async function withLiveProxy(): Promise<FakeSystem> {
  proxy = await startTestProxy("live");
  const fake = createFakeSystem();
  writeFakeConfig(fake, externalProxy({ http: proxy }));
  fake.applications.set("Google Chrome", CHROME_PATH);
  return fake;
}

/** A fake with Chrome installed and an external proxy that has both endpoints */
async function withBothEndpoints(): Promise<FakeSystem> {
  proxy = await startTestProxy("live");
  socks = await startTestProxy("socks");
  const fake = createFakeSystem();
  writeFakeConfig(fake, externalProxy({ http: proxy, socks }));
  fake.applications.set("Google Chrome", CHROME_PATH);
  return fake;
}

describe("prx run chrome", () => {
  test("launches Chrome detached through open with the proxy-server flag", async () => {
    const fake = await withLiveProxy();

    const exitCode = await runCli(["run", "chrome"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.launches).toEqual([
      {
        command: "open",
        args: [
          "-n",
          "-a",
          CHROME_PATH,
          "--args",
          `--proxy-server=http://127.0.0.1:${proxy?.port}`,
          LANDING_URL,
        ],
      },
    ]);
    expect(fake.spawns).toEqual([]);
    expect(fake.stdout()).toBe("");
    expect(fake.stderr()).toMatch(
      /^prx: http endpoint http:\/\/127\.0\.0\.1:\d+ is live \(\d+ ms\), launching chrome\n$/,
    );
  });

  test("prefers the SOCKS endpoint when the proxy has one, and probes through it", async () => {
    const fake = await withBothEndpoints();
    await proxy?.close();

    const exitCode = await runCli(["run", "chrome"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.launches[0]?.args.slice(4)).toEqual([
      `--proxy-server=socks5://127.0.0.1:${socks?.port}`,
      LANDING_URL,
    ]);
    expect(fake.stderr()).toMatch(
      /^prx: socks endpoint socks5:\/\/127\.0\.0\.1:\d+ is live \(\d+ ms\), launching chrome\n$/,
    );
  });

  test("a dead SOCKS endpoint stops the launch even when the HTTP endpoint is live", async () => {
    const fake = await withBothEndpoints();
    await socks?.close();

    const exitCode = await runCli(["run", "chrome"], fake.system);

    expect(exitCode).toBe(1);
    expect(fake.launches).toEqual([]);
    expect(fake.stderr()).toBe(
      `Endpoint socks5://127.0.0.1:${socks?.port} is not live: connection refused (ECONNREFUSED). ` +
        "Run prx status to see every endpoint.\n",
    );
  });

  test("--via http injects the HTTP endpoint when both exist", async () => {
    const fake = await withBothEndpoints();

    const exitCode = await runCli(["run", "--via", "http", "chrome"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.launches[0]?.args.slice(4)).toEqual([
      `--proxy-server=http://127.0.0.1:${proxy?.port}`,
      LANDING_URL,
    ]);
  });

  test("--via with a type the proxy lacks fails with endpoint_missing before any launch", async () => {
    const fake = await withLiveProxy();

    const exitCode = await runCli(["run", "--json", "--via", "socks", "chrome"], fake.system);

    expect(exitCode).toBe(2);
    expect(fake.launches).toEqual([]);
    expect(JSON.parse(fake.stdout())).toEqual({
      error: {
        code: "endpoint_missing",
        message: "The proxy has no socks endpoint. Run prx init to record one.",
        hint: "Run prx init to record one.",
      },
    });
  });

  test("--via with an unknown type is a usage error", async () => {
    const fake = await withLiveProxy();

    const exitCode = await runCli(["run", "--via", "ftp", "chrome"], fake.system);

    expect(exitCode).toBe(2);
    expect(fake.launches).toEqual([]);
    expect(fake.stderr()).toMatch(/--via/);
  });

  test("passthrough arguments follow the injected flag, before the landing page", async () => {
    const fake = await withLiveProxy();

    await runCli(["run", "chrome", "--incognito", "https://example.com"], fake.system);

    expect(fake.launches[0]?.args.slice(4)).toEqual([
      `--proxy-server=http://127.0.0.1:${proxy?.port}`,
      "--incognito",
      "https://example.com",
      LANDING_URL,
    ]);
  });

  test("refuses with exit 3 when Chrome is already running", async () => {
    const fake = await withLiveProxy();
    fake.running.add("Google Chrome");

    const exitCode = await runCli(["run", "chrome"], fake.system);

    expect(exitCode).toBe(3);
    expect(fake.launches).toEqual([]);
    expect(fake.stderr()).toBe(
      "Google Chrome is already running. Chrome ignores proxy flags when an instance exists, so quit it and run again.\n",
    );
  });

  test("--json reports the launch with preset, endpoint and latency and no PID", async () => {
    const fake = await withBothEndpoints();

    const exitCode = await runCli(["run", "--json", "chrome"], fake.system);

    expect(exitCode).toBe(0);
    expect(JSON.parse(fake.stdout())).toEqual({
      preset: "chrome",
      endpoint: { type: "socks", host: "127.0.0.1", port: socks?.port },
      latencyMs: expect.any(Number),
    });
    expect(fake.stderr()).toBe("");
  });

  test("--json reports the running refusal as an error object with exit 3", async () => {
    const fake = await withLiveProxy();
    fake.running.add("Google Chrome");

    const exitCode = await runCli(["run", "--json", "chrome"], fake.system);

    expect(exitCode).toBe(3);
    expect(JSON.parse(fake.stdout())).toEqual({
      error: {
        code: "app_already_running",
        message:
          "Google Chrome is already running. Chrome ignores proxy flags when an instance exists, so quit it and run again.",
        hint: "Chrome ignores proxy flags when an instance exists, so quit it and run again.",
      },
    });
  });

  test("Chrome missing from both Applications folders is a usage error", async () => {
    const fake = await withLiveProxy();
    fake.applications.clear();

    const exitCode = await runCli(["run", "chrome"], fake.system);

    expect(exitCode).toBe(2);
    expect(fake.stderr()).toBe(
      "chrome is not installed: no 'Google Chrome.app' found in /Applications or ~/Applications\n",
    );
  });
});
