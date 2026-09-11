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
        args: ["-n", "-a", CHROME_PATH, "--args", `--proxy-server=http://127.0.0.1:${proxy?.port}`],
      },
    ]);
    expect(fake.spawns).toEqual([]);
    expect(fake.stdout()).toBe("");
    expect(fake.stderr()).toMatch(
      /^prx: http endpoint http:\/\/127\.0\.0\.1:\d+ is live \(\d+ ms\), launching chrome\n$/,
    );
  });

  test("passthrough arguments follow the injected flag", async () => {
    const fake = await withLiveProxy();

    await runCli(["run", "chrome", "--incognito", "https://example.com"], fake.system);

    expect(fake.launches[0]?.args.slice(4)).toEqual([
      `--proxy-server=http://127.0.0.1:${proxy?.port}`,
      "--incognito",
      "https://example.com",
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
    const fake = await withLiveProxy();

    const exitCode = await runCli(["run", "--json", "chrome"], fake.system);

    expect(exitCode).toBe(0);
    expect(JSON.parse(fake.stdout())).toEqual({
      preset: "chrome",
      endpoint: { type: "http", host: "127.0.0.1", port: proxy?.port },
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
