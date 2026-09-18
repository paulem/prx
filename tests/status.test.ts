import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import {
  builtInProxy,
  createFakeSystem,
  externalProxy,
  FAKE_HOME,
  FAKE_STATE_DIR,
  opensshPrivateKey,
  writeFakeConfig,
  type FakeSystem,
} from "./fake-system.ts";
import { proxyPool, trustProbeTarget } from "./test-proxy.ts";

beforeAll(() => {
  trustProbeTarget();
});

const KEY_DIR = `${FAKE_HOME}/.ssh`;
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

  test("a stalled proxy names the log directory and says how to restart it", async () => {
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
        `Logs are in ${FAKE_STATE_DIR}\n` +
        "Run prx up to restart it.\n",
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

  test("a retry's reset does not bury the line that explains the tunnel", async () => {
    const http = await pool.closed();
    const socks = await pool.closed();
    const fake = createFakeSystem();
    writeFakeConfig(fake, builtInProxy({ socksPort: socks.port, httpPort: http.port }));
    markRunning(fake);
    fake.files.set(
      `${FAKE_STATE_DIR}/autossh.log`,
      "me@box.example: Permission denied (publickey).\n" +
        "kex_exchange_identification: read: Connection reset by peer\n" +
        "Connection closed by box.example port 22\n",
    );

    await statusOf(fake);

    expect(fake.stdout()).toContain("Tunnel: me@box.example: Permission denied (publickey).\n");
    expect(fake.stdout()).toContain(
      "Run prx init to pick a key file, or add one to ssh-agent with: ssh-add <path>\n",
    );
  });

  test("a locked key is named as the reason the tunnel was denied, with the way to unlock it", async () => {
    const http = await pool.closed();
    const socks = await pool.closed();
    const fake = createFakeSystem();
    writeFakeConfig(
      fake,
      builtInProxy({
        tunnel: { user: "me", host: "box.example", port: 22, identityFile: `${KEY_DIR}/id_box` },
        socksPort: socks.port,
        httpPort: http.port,
      }),
    );
    markRunning(fake);
    fake.files.set(`${KEY_DIR}/id_box`, opensshPrivateKey("aes256-ctr"));
    fake.files.set(`${KEY_DIR}/id_box.pub`, "ssh-ed25519 AAAAbox me@laptop\n");
    fake.files.set(
      `${FAKE_STATE_DIR}/autossh.log`,
      "me@box.example: Permission denied (publickey).\n",
    );

    await statusOf(fake);

    expect(fake.stdout()).toContain(
      "~/.ssh/id_box needs a passphrase and the tunnel never prompts, " +
        "so add it with: ssh-add --apple-use-keychain ~/.ssh/id_box\n",
    );
  });

  test("a key ssh-agent already holds is reported as one the host has not authorised", async () => {
    const http = await pool.closed();
    const socks = await pool.closed();
    const fake = createFakeSystem();
    writeFakeConfig(
      fake,
      builtInProxy({
        tunnel: { user: "me", host: "box.example", port: 22, identityFile: `${KEY_DIR}/id_box` },
        socksPort: socks.port,
        httpPort: http.port,
      }),
    );
    markRunning(fake);
    fake.files.set(`${KEY_DIR}/id_box`, opensshPrivateKey("aes256-ctr"));
    fake.files.set(`${KEY_DIR}/id_box.pub`, "ssh-ed25519 AAAAbox me@laptop\n");
    fake.agentKeys.push("ssh-ed25519 AAAAbox unlocked-at-some-point");
    fake.files.set(
      `${FAKE_STATE_DIR}/autossh.log`,
      "me@box.example: Permission denied (publickey).\n",
    );

    await statusOf(fake);

    expect(fake.stdout()).toContain(
      "Authorize ~/.ssh/id_box on box.example, or run prx init to pick another key.\n",
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

  test("a tunnel that timed out is explained as reconnecting", async () => {
    const http = await pool.closed();
    const socks = await pool.closed();
    const fake = createFakeSystem();
    writeFakeConfig(fake, builtInProxy({ socksPort: socks.port, httpPort: http.port }));
    markRunning(fake);
    fake.files.set(
      `${FAKE_STATE_DIR}/autossh.log`,
      "Timeout, server box.example not responding.\n",
    );

    await statusOf(fake, ["--json"]);

    expect(JSON.parse(fake.stdout()).tunnelFailure).toEqual({
      message: "Timeout, server box.example not responding.",
      hint: "The tunnel is reconnecting. Run prx status again in a few seconds, or prx up to restart it.",
    });
  });

  test("an unrecognised tunnel error still gets the restart hint in text mode", async () => {
    const http = await pool.closed();
    const socks = await pool.closed();
    const fake = createFakeSystem();
    writeFakeConfig(fake, builtInProxy({ socksPort: socks.port, httpPort: http.port }));
    markRunning(fake);
    fake.files.set(
      `${FAKE_STATE_DIR}/autossh.log`,
      "kex_exchange_identification: read: Connection reset\n",
    );

    await statusOf(fake);

    expect(fake.stdout()).toMatch(
      /\nTunnel: kex_exchange_identification: read: Connection reset\nLogs are in .*\nRun prx up to restart it\.\n$/,
    );
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

  test("a stopped proxy whose ports refuse connections says only how to start it", async () => {
    const http = await pool.closed();
    const socks = await pool.closed();
    const fake = createFakeSystem();
    writeFakeConfig(fake, builtInProxy({ socksPort: socks.port, httpPort: http.port }));

    const exitCode = await statusOf(fake);

    expect(exitCode).toBe(1);
    expect(fake.stdout()).toBe("Built-in proxy is not running\nRun prx up to start it.\n");
  });

  test("a stopped proxy still names an endpoint that something else answers on", async () => {
    const http = await pool.open("live");
    const socks = await pool.closed();
    const fake = createFakeSystem();
    writeFakeConfig(fake, builtInProxy({ socksPort: socks.port, httpPort: http.port }));

    const exitCode = await statusOf(fake);

    expect(exitCode).toBe(1);
    expect(fake.stdout()).toMatch(
      new RegExp(
        "^Built-in proxy is not running\n" +
          `Endpoint http://127\\.0\\.0\\.1:${http.port} is live \\(\\d+ ms\\)\n` +
          "Run prx up to start it.\n$",
      ),
    );
  });

  test("--json on a stopped proxy keeps every endpoint", async () => {
    const http = await pool.closed();
    const socks = await pool.closed();
    const fake = createFakeSystem();
    writeFakeConfig(fake, builtInProxy({ socksPort: socks.port, httpPort: http.port }));

    await statusOf(fake, ["--json"]);

    expect(JSON.parse(fake.stdout())).toMatchObject({
      running: false,
      endpoints: {
        http: { live: false, reason: "refused" },
        socks: { live: false, reason: "refused" },
      },
    });
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
