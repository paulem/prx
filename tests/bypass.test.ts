import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import type { Address, ProxyConfig } from "../src/config.ts";
import { createFakeSystem, writeFakeConfig, type FakeSystem } from "./fake-system.ts";
import { startTestProxy, trustProbeTarget, type TestProxy } from "./test-proxy.ts";

const CLAUDE_PATH = "/home/test/.local/bin/claude";
const CHROME_PATH = "/Applications/Google Chrome.app";
const LANDING_URL = "https://api.ipify.org";
/** What every env-injected app bypasses before anything is configured */
const LOCAL = "localhost,127.0.0.1,::1";

beforeAll(() => {
  trustProbeTarget();
});

let proxy: TestProxy | undefined;
afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
});

function bypassProxy(http: Address, bypass: string[]): ProxyConfig {
  return {
    source: "external",
    endpoints: { http: { host: http.host, port: http.port } },
    bypass,
  };
}

/** A fake with both apps installed and a live proxy that bypasses the given hosts */
async function withBypass(bypass: string[]): Promise<FakeSystem> {
  proxy = await startTestProxy("live");
  const fake = createFakeSystem();
  writeFakeConfig(fake, bypassProxy(proxy, bypass));
  fake.onPath.set("claude", CLAUDE_PATH);
  fake.applications.set("Google Chrome", CHROME_PATH);
  return fake;
}

describe("bypass injection", () => {
  test("claude reaches configured hosts directly, after the local bypass", async () => {
    const fake = await withBypass([".sourcecraft.tech", ".ru"]);

    const exitCode = await runCli(["run", "claude"], fake.system);

    expect(exitCode).toBe(0);
    const expected = `${LOCAL},.sourcecraft.tech,.ru`;
    expect(fake.spawns[0]?.env.NO_PROXY).toBe(expected);
    expect(fake.spawns[0]?.env.no_proxy).toBe(expected);
  });

  test("a wildcard entry is injected in the leading-dot spelling", async () => {
    const fake = await withBypass(["*.example.com"]);

    await runCli(["run", "claude"], fake.system);

    expect(fake.spawns[0]?.env.NO_PROXY).toBe(`${LOCAL},.example.com`);
  });

  test("an IDN entry is injected as punycode", async () => {
    const fake = await withBypass([".рф"]);

    await runCli(["run", "claude"], fake.system);

    expect(fake.spawns[0]?.env.NO_PROXY).toBe(`${LOCAL},.xn--p1ai`);
  });

  test("chrome gets the same list through the bypass flag", async () => {
    const fake = await withBypass([".ru"]);

    const exitCode = await runCli(["run", "chrome"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.launches[0]?.args).toEqual([
      "-n",
      "-a",
      CHROME_PATH,
      "--args",
      `--proxy-server=http://127.0.0.1:${proxy?.port}`,
      `--proxy-bypass-list=${LOCAL},.ru`,
      LANDING_URL,
    ]);
  });
});

describe("bypass reporting", () => {
  test("the launch line names the configured hosts", async () => {
    const fake = await withBypass([".sourcecraft.tech", ".ru"]);

    await runCli(["run", "claude"], fake.system);

    expect(fake.stderr()).toMatch(
      /launching claude\nprx: 2 hosts bypass the proxy: \.sourcecraft\.tech, \.ru\n$/,
    );
  });

  test("one configured host reads as one host", async () => {
    const fake = await withBypass([".ru"]);

    await runCli(["run", "claude"], fake.system);

    expect(fake.stderr()).toMatch(/prx: 1 host bypasses the proxy: \.ru\n$/);
  });

  test("--json carries the configured hosts, not the local ones", async () => {
    const fake = await withBypass(["*.example.com"]);

    await runCli(["run", "--json", "claude"], fake.system);

    expect(JSON.parse(fake.stdout()).bypass).toEqual([".example.com"]);
  });

  test("--json leaves the field out when nothing is configured", async () => {
    const fake = await withBypass([]);

    await runCli(["run", "--json", "claude"], fake.system);

    expect(JSON.parse(fake.stdout())).not.toHaveProperty("bypass");
  });
});
