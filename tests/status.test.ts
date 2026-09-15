import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import {
  builtInProxy,
  createFakeSystem,
  externalProxy,
  FAKE_STATE_DIR,
  writeFakeConfig,
  type FakeSystem,
} from "./fake-system.ts";
import { proxyPool, trustProbeTarget } from "./test-proxy.ts";

beforeAll(() => {
  trustProbeTarget();
});

const pool = proxyPool();
afterEach(() => pool.closeAll());

async function statusOf(fake: FakeSystem, args: string[] = []): Promise<number> {
  return runCli(["status", ...args], fake.system, { probeTimeoutMs: 1000 });
}

describe("prx status on an external proxy", () => {
  test("probes both endpoints and prints one line each, exit 0 when both are live", async () => {
    const http = await pool.open("live");
    const socks = await pool.open("socks");
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
    const http = await pool.open("live");
    const socks = await pool.closed();
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
    const http = await pool.open("live");
    const socks = await pool.closed();
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
    const socks = await pool.open("socks");
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
    const socks = await pool.open("socks-reject");
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
    const http = await pool.open("reject");
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
    const http = await pool.open("silent");
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

/** Makes the fake's built-in proxy running: both pid files exist and both pids are alive */
function markRunning(fake: FakeSystem): void {
  fake.files.set(`${FAKE_STATE_DIR}/autossh.pid`, "1001\n");
  fake.files.set(`${FAKE_STATE_DIR}/privoxy.pid`, "1002\n");
  fake.alivePids.add(1001);
  fake.alivePids.add(1002);
}

describe("prx status on a built-in proxy", () => {
  test("prints the running state before the endpoint lines", async () => {
    const http = await pool.open("live");
    const socks = await pool.open("socks");
    const fake = createFakeSystem();
    writeFakeConfig(fake, builtInProxy({ socksPort: socks.port, httpPort: http.port }));
    markRunning(fake);

    const exitCode = await statusOf(fake);

    expect(exitCode).toBe(0);
    expect(fake.stdout()).toMatch(
      new RegExp(
        "^Built-in proxy is running\n" +
          `Endpoint http://127\\.0\\.0\\.1:${http.port} is live \\(\\d+ ms\\)\n` +
          `Endpoint socks5://127\\.0\\.0\\.1:${socks.port} is live \\(\\d+ ms\\)\n$`,
      ),
    );
  });

  test("names the log directory when running but not live", async () => {
    const http = await pool.closed();
    const socks = await pool.closed();
    const fake = createFakeSystem();
    writeFakeConfig(fake, builtInProxy({ socksPort: socks.port, httpPort: http.port }));
    markRunning(fake);

    const exitCode = await statusOf(fake);

    expect(exitCode).toBe(1);
    expect(fake.stdout()).toBe(
      "Built-in proxy is running\n" +
        `Endpoint http://127.0.0.1:${http.port} is not live: connection refused (ECONNREFUSED)\n` +
        `Endpoint socks5://127.0.0.1:${socks.port} is not live: connection refused (ECONNREFUSED)\n` +
        `Logs are in ${FAKE_STATE_DIR}\n`,
    );
  });

  test("explains a dead tunnel from the autossh log and says what to do about the key", async () => {
    const http = await pool.closed();
    const socks = await pool.closed();
    const fake = createFakeSystem();
    writeFakeConfig(fake, builtInProxy({ socksPort: socks.port, httpPort: http.port }));
    markRunning(fake);
    fake.files.set(
      `${FAKE_STATE_DIR}/autossh.log`,
      "me@box.example: Permission denied (publickey).\nme@box.example: Permission denied (publickey).\n\n",
    );

    const exitCode = await statusOf(fake);

    expect(exitCode).toBe(1);
    expect(fake.stdout()).toBe(
      "Built-in proxy is running\n" +
        `Endpoint http://127.0.0.1:${http.port} is not live: connection refused (ECONNREFUSED)\n` +
        `Endpoint socks5://127.0.0.1:${socks.port} is not live: connection refused (ECONNREFUSED)\n` +
        "Tunnel: me@box.example: Permission denied (publickey).\n" +
        `Logs are in ${FAKE_STATE_DIR}\n` +
        "Run prx init to pick a key file, or add one to ssh-agent with: ssh-add <path>\n",
    );
  });

  test("an unrecognised tunnel error is shown without a hint, in JSON too", async () => {
    const http = await pool.closed();
    const socks = await pool.closed();
    const fake = createFakeSystem();
    writeFakeConfig(fake, builtInProxy({ socksPort: socks.port, httpPort: http.port }));
    markRunning(fake);
    fake.files.set(
      `${FAKE_STATE_DIR}/autossh.log`,
      "kex_exchange_identification: read: Connection reset\n",
    );

    const exitCode = await statusOf(fake, ["--json"]);

    expect(exitCode).toBe(1);
    expect(JSON.parse(fake.stdout())).toMatchObject({
      running: true,
      tunnelFailure: { message: "kex_exchange_identification: read: Connection reset" },
    });
    expect(JSON.parse(fake.stdout()).tunnelFailure).not.toHaveProperty("hint");
  });

  test("a live proxy never reads the tunnel log", async () => {
    const http = await pool.open("live");
    const socks = await pool.open("socks");
    const fake = createFakeSystem();
    writeFakeConfig(fake, builtInProxy({ socksPort: socks.port, httpPort: http.port }));
    markRunning(fake);
    fake.files.set(
      `${FAKE_STATE_DIR}/autossh.log`,
      "me@box.example: Permission denied (publickey).\n",
    );

    await statusOf(fake, ["--json"]);

    expect(JSON.parse(fake.stdout())).not.toHaveProperty("tunnelFailure");
  });

  test("a stopped proxy is reported as not running without a log hint", async () => {
    const http = await pool.closed();
    const socks = await pool.closed();
    const fake = createFakeSystem();
    writeFakeConfig(fake, builtInProxy({ socksPort: socks.port, httpPort: http.port }));

    const exitCode = await statusOf(fake);

    expect(exitCode).toBe(1);
    expect(fake.stdout()).toBe(
      "Built-in proxy is not running\n" +
        `Endpoint http://127.0.0.1:${http.port} is not live: connection refused (ECONNREFUSED)\n` +
        `Endpoint socks5://127.0.0.1:${socks.port} is not live: connection refused (ECONNREFUSED)\n`,
    );
  });

  test("--json gains running", async () => {
    const http = await pool.open("live");
    const socks = await pool.open("socks");
    const fake = createFakeSystem();
    writeFakeConfig(fake, builtInProxy({ socksPort: socks.port, httpPort: http.port }));
    markRunning(fake);

    const exitCode = await statusOf(fake, ["--json"]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(fake.stdout())).toEqual({
      source: "built-in",
      running: true,
      endpoints: {
        http: { host: "127.0.0.1", port: http.port, live: true, latencyMs: expect.any(Number) },
        socks: { host: "127.0.0.1", port: socks.port, live: true, latencyMs: expect.any(Number) },
      },
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
        hint: "Run prx init to create one.",
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
