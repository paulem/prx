import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import {
  createFakeSystem,
  externalProxy,
  writeFakeConfig,
  type FakeSystem,
} from "./fake-system.ts";
import { startTestProxy, trustProbeTarget, type TestProxy } from "./test-proxy.ts";

beforeAll(() => {
  trustProbeTarget();
});

const proxies: TestProxy[] = [];
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
});

async function testProxy(mode: Parameters<typeof startTestProxy>[0]): Promise<TestProxy> {
  const proxy = await startTestProxy(mode);
  proxies.push(proxy);
  return proxy;
}

async function closedPort(): Promise<TestProxy> {
  const proxy = await startTestProxy("live");
  await proxy.close();
  return proxy;
}

async function statusOf(fake: FakeSystem, args: string[] = []): Promise<number> {
  return runCli(["status", ...args], fake.system, { probeTimeoutMs: 1000 });
}

describe("prx status on an external proxy", () => {
  test("probes both endpoints and prints one line each, exit 0 when both are live", async () => {
    const http = await testProxy("live");
    const socks = await testProxy("socks");
    const fake = createFakeSystem();
    writeFakeConfig(fake, externalProxy({ http, socks }));

    const exitCode = await statusOf(fake);

    expect(exitCode).toBe(0);
    expect(fake.stdout()).toMatch(
      new RegExp(
        `^Endpoint http://127\\.0\\.0\\.1:${http.port} is live \\(\\d+ ms\\)\n` +
          `Endpoint socks5://127\\.0\\.0\\.1:${socks.port} is live \\(\\d+ ms\\)\n$`,
      ),
    );
    expect(fake.stderr()).toBe("");
  });

  test("exits 1 when any endpoint is not live", async () => {
    const http = await testProxy("live");
    const socks = await closedPort();
    const fake = createFakeSystem();
    writeFakeConfig(fake, externalProxy({ http, socks }));

    const exitCode = await statusOf(fake);

    expect(exitCode).toBe(1);
    expect(fake.stdout()).toMatch(
      new RegExp(
        `^Endpoint http://127\\.0\\.0\\.1:${http.port} is live \\(\\d+ ms\\)\n` +
          `Endpoint socks5://127\\.0\\.0\\.1:${socks.port} is not live: connection refused \\(ECONNREFUSED\\)\n$`,
      ),
    );
  });

  test("--json prints one object with the source and each endpoint's result", async () => {
    const http = await testProxy("live");
    const socks = await closedPort();
    const fake = createFakeSystem();
    writeFakeConfig(fake, externalProxy({ http, socks }));

    const exitCode = await statusOf(fake, ["--json"]);

    expect(exitCode).toBe(1);
    expect(JSON.parse(fake.stdout())).toEqual({
      source: "external",
      endpoints: {
        http: { host: "127.0.0.1", port: http.port, live: true, latencyMs: expect.any(Number) },
        socks: {
          host: "127.0.0.1",
          port: socks.port,
          live: false,
          reason: "refused",
          message: "connection refused (ECONNREFUSED)",
        },
      },
    });
    expect(fake.stderr()).toBe("");
  });

  test("a proxy with only a SOCKS endpoint is probed through SOCKS5", async () => {
    const socks = await testProxy("socks");
    const fake = createFakeSystem();
    writeFakeConfig(fake, externalProxy({ socks }));

    const exitCode = await statusOf(fake, ["--json"]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(fake.stdout())).toEqual({
      source: "external",
      endpoints: {
        socks: { host: "127.0.0.1", port: socks.port, live: true, latencyMs: expect.any(Number) },
      },
    });
  });

  test("a SOCKS handshake the proxy refuses is reported as rejected", async () => {
    const socks = await testProxy("socks-reject");
    const fake = createFakeSystem();
    writeFakeConfig(fake, externalProxy({ socks }));

    const exitCode = await statusOf(fake, ["--json"]);

    expect(exitCode).toBe(1);
    expect(JSON.parse(fake.stdout()).endpoints.socks).toMatchObject({
      live: false,
      reason: "rejected",
      message:
        "proxy rejected the SOCKS5 connect: SOCKS5 connection failed: Connection not allowed by ruleset",
    });
  });

  test("a rejected CONNECT is reported with the proxy's status", async () => {
    const http = await testProxy("reject");
    const fake = createFakeSystem();
    writeFakeConfig(fake, externalProxy({ http }));

    const exitCode = await statusOf(fake, ["--json"]);

    expect(exitCode).toBe(1);
    expect(JSON.parse(fake.stdout()).endpoints.http).toMatchObject({
      live: false,
      reason: "rejected",
      message: "proxy rejected CONNECT with status 403",
    });
  });

  test("a proxy that never answers is reported as timed out", async () => {
    const http = await testProxy("silent");
    const fake = createFakeSystem();
    writeFakeConfig(fake, externalProxy({ http }));

    const exitCode = await runCli(["status", "--json"], fake.system, { probeTimeoutMs: 300 });

    expect(exitCode).toBe(1);
    expect(JSON.parse(fake.stdout()).endpoints.http).toMatchObject({
      live: false,
      reason: "timed_out",
    });
  });
});

describe("prx status config errors", () => {
  test("missing config prints where it should be and exits 2", async () => {
    const fake = createFakeSystem();

    const exitCode = await statusOf(fake);

    expect(exitCode).toBe(2);
    expect(fake.stdout()).toBe("");
    expect(fake.stderr()).toBe(
      "No config found at /home/test/.config/prx/config.json. Run prx init to create one.\n",
    );
  });

  test("missing config in JSON mode prints an error object on stdout", async () => {
    const fake = createFakeSystem();

    const exitCode = await statusOf(fake, ["--json"]);

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
    fake.files.set("/home/test/.config/prx/config.json", '{"version":1,"proxy":{"source":"ftp"}}');

    const exitCode = await statusOf(fake);

    expect(exitCode).toBe(2);
    expect(fake.stderr()).toMatch(
      /^Config at \/home\/test\/\.config\/prx\/config\.json is invalid: /,
    );
  });
});

describe("prx check", () => {
  test("no longer exists", async () => {
    const fake = createFakeSystem();

    const exitCode = await runCli(["check"], fake.system);

    expect(exitCode).toBe(2);
    expect(fake.stderr()).toMatch(/unknown command 'check'/);
  });
});
