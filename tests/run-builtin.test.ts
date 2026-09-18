import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import {
  builtInProxy,
  createFakeSystem,
  FAKE_STATE_DIR,
  writeFakeConfig,
  type FakeSystem,
} from "./fake-system.ts";
import { proxyPool, trustProbeTarget, type TestProxy } from "./test-proxy.ts";

const CLAUDE_PATH = "/home/test/.local/bin/claude";
const CHROME_PATH = "/Applications/Google Chrome.app";

beforeAll(() => {
  trustProbeTarget();
});

const pool = proxyPool();
afterEach(() => pool.closeAll());

interface Endpoints {
  http: TestProxy;
  socks: TestProxy;
}

/** A fake with both apps and both dependencies installed, and a stopped built-in proxy served by test proxies */
async function withStoppedProxy(): Promise<{ fake: FakeSystem; endpoints: Endpoints }> {
  const fake = createFakeSystem();
  fake.onPath.set("claude", CLAUDE_PATH);
  fake.applications.set("Google Chrome", CHROME_PATH);
  fake.onPath.set("autossh", "/opt/homebrew/bin/autossh");
  fake.onPath.set("privoxy", "/opt/homebrew/bin/privoxy");
  const endpoints = { http: await pool.open("live"), socks: await pool.open("socks") };
  writeFakeConfig(
    fake,
    builtInProxy({ socksPort: endpoints.socks.port, httpPort: endpoints.http.port }),
  );
  return { fake, endpoints };
}

function markRunning(fake: FakeSystem): void {
  fake.files.set(`${FAKE_STATE_DIR}/autossh.pid`, "1001\n");
  fake.files.set(`${FAKE_STATE_DIR}/privoxy.pid`, "1002\n");
  fake.alivePids.add(1001);
  fake.alivePids.add(1002);
}

function runWith(fake: FakeSystem, args: string[]): Promise<number> {
  return runCli(["run", ...args], fake.system, { probeTimeoutMs: 1000 });
}

describe("prx run with a stopped built-in proxy", () => {
  test("starts it as up does, waits for the HTTP endpoint, says so, and launches claude", async () => {
    const { fake, endpoints } = await withStoppedProxy();

    const exitCode = await runWith(fake, ["claude"]);

    expect(exitCode).toBe(0);
    expect(fake.backgroundStarts.map((start) => start.command)).toEqual([
      "/opt/homebrew/bin/autossh",
      "/opt/homebrew/bin/privoxy",
    ]);
    expect(fake.backgroundStarts[0]?.args).toContain(`127.0.0.1:${endpoints.socks.port}`);
    expect(fake.files.get(`${FAKE_STATE_DIR}/autossh.pid`)).toBe("1001\n");
    expect(fake.files.get(`${FAKE_STATE_DIR}/privoxy.pid`)).toBe("1002\n");
    expect(fake.spawns).toHaveLength(1);
    expect(fake.spawns[0]?.env.HTTPS_PROXY).toBe(`http://127.0.0.1:${endpoints.http.port}`);
    expect(fake.stderr()).toMatch(
      new RegExp(
        "^prx: started the built-in proxy\n" +
          `prx: http endpoint http://127\\.0\\.0\\.1:${endpoints.http.port} is live \\(\\d+ ms\\), launching claude\n$`,
      ),
    );
    expect(fake.stdout()).toBe("");
  });

  test("waits for the SOCKS endpoint for chrome, even when the HTTP endpoint is dead", async () => {
    const { fake, endpoints } = await withStoppedProxy();
    await endpoints.http.close();

    const exitCode = await runWith(fake, ["chrome"]);

    expect(exitCode).toBe(0);
    expect(fake.backgroundStarts).toHaveLength(2);
    expect(fake.launches[0]?.args.slice(4)).toEqual([
      `--proxy-server=socks5://127.0.0.1:${endpoints.socks.port}`,
      `--proxy-bypass-list=localhost,127.0.0.1,::1`,
      "https://api.ipify.org",
    ]);
    expect(fake.stderr()).toMatch(/^prx: started the built-in proxy\nprx: socks endpoint /);
  });

  test("keeps waiting while the chosen endpoint comes up", async () => {
    const { fake, endpoints } = await withStoppedProxy();
    await endpoints.http.close();
    setTimeout(async () => {
      await pool.open("live", endpoints.http.port);
    }, 200);

    const exitCode = await runWith(fake, ["claude"]);

    expect(exitCode).toBe(0);
    expect(fake.spawns).toHaveLength(1);
  });

  test("a chosen endpoint that never comes up stops the launch with exit 1", async () => {
    const { fake, endpoints } = await withStoppedProxy();
    await endpoints.http.close();

    const exitCode = await runCli(["run", "claude"], fake.system, {
      probeTimeoutMs: 300,
      startTimeoutMs: 300,
    });

    expect(exitCode).toBe(1);
    expect(fake.backgroundStarts).toHaveLength(2);
    expect(fake.spawns).toEqual([]);
    expect(fake.stderr()).toBe(
      "prx: started the built-in proxy\n" +
        `Endpoint http://127.0.0.1:${endpoints.http.port} is not live: connection refused (ECONNREFUSED). ` +
        "Run prx status to see every endpoint and the log directory.\n",
    );
  });

  test("the not-live error carries the tunnel error and its hint", async () => {
    const { fake, endpoints } = await withStoppedProxy();
    await endpoints.http.close();
    fake.files.set(
      `${FAKE_STATE_DIR}/autossh.log`,
      "me@box.example: Permission denied (publickey).\n",
    );

    const exitCode = await runCli(["run", "claude"], fake.system, {
      probeTimeoutMs: 300,
      startTimeoutMs: 300,
    });

    expect(exitCode).toBe(1);
    expect(fake.stderr()).toBe(
      "prx: started the built-in proxy\n" +
        `Endpoint http://127.0.0.1:${endpoints.http.port} is not live: connection refused (ECONNREFUSED). ` +
        "Tunnel: me@box.example: Permission denied (publickey). " +
        "Run prx init to pick a key file, or add one to ssh-agent with: ssh-add <path>\n",
    );
  });

  test("--no-check still starts the proxy and launches without probing", async () => {
    const { fake, endpoints } = await withStoppedProxy();
    await endpoints.http.close();
    await endpoints.socks.close();

    const exitCode = await runWith(fake, ["--no-check", "claude"]);

    expect(exitCode).toBe(0);
    expect(fake.backgroundStarts).toHaveLength(2);
    expect(fake.spawns).toHaveLength(1);
    expect(fake.stderr()).toBe(
      "prx: started the built-in proxy\n" +
        `prx: http endpoint http://127.0.0.1:${endpoints.http.port} not probed (--no-check), launching claude\n`,
    );
  });

  test("--json keeps the launch object unchanged and prints nothing else", async () => {
    const { fake, endpoints } = await withStoppedProxy();

    const exitCode = await runWith(fake, ["--json", "claude"]);

    expect(exitCode).toBe(0);
    expect(fake.backgroundStarts).toHaveLength(2);
    expect(JSON.parse(fake.stdout())).toEqual({
      preset: "claude",
      endpoint: { type: "http", host: "127.0.0.1", port: endpoints.http.port },
      latencyMs: expect.any(Number),
    });
    expect(fake.stderr()).toBe("");
  });

  test("a missing dependency surfaces as the same error as up, before any launch", async () => {
    const { fake } = await withStoppedProxy();
    fake.onPath.delete("autossh");

    const exitCode = await runWith(fake, ["claude"]);

    expect(exitCode).toBe(2);
    expect(fake.spawns).toEqual([]);
    expect(fake.stderr()).toBe(
      "autossh is not installed. Install it with: brew install autossh privoxy\n",
    );
  });

  test("a busy port surfaces as port_in_use, before any launch", async () => {
    const { fake, endpoints } = await withStoppedProxy();
    fake.busyPorts.add(endpoints.socks.port);

    const exitCode = await runWith(fake, ["--json", "chrome"]);

    expect(exitCode).toBe(2);
    expect(fake.launches).toEqual([]);
    expect(JSON.parse(fake.stdout())).toMatchObject({ error: { code: "port_in_use" } });
  });

  test("an app that is not installed is reported before the proxy is started", async () => {
    const { fake } = await withStoppedProxy();
    fake.onPath.delete("claude");

    const exitCode = await runWith(fake, ["claude"]);

    expect(exitCode).toBe(2);
    expect(fake.backgroundStarts).toEqual([]);
  });
});

describe("prx run with a stalled built-in proxy", () => {
  test("restarts it as up does, waits for the endpoint, says so, and launches", async () => {
    const { fake, endpoints } = await withStoppedProxy();
    markRunning(fake);
    await endpoints.http.close();
    setTimeout(async () => {
      await pool.open("live", endpoints.http.port);
    }, 500);

    const exitCode = await runCli(["run", "claude"], fake.system, {
      probeTimeoutMs: 300,
      startTimeoutMs: 3000,
    });

    expect(exitCode).toBe(0);
    expect(fake.signals).toEqual([
      { pid: 1001, signal: "SIGTERM" },
      { pid: 1002, signal: "SIGTERM" },
    ]);
    expect(fake.backgroundStarts).toHaveLength(2);
    expect(fake.spawns).toHaveLength(1);
    expect(fake.stderr()).toMatch(
      new RegExp(
        "^prx: restarted the built-in proxy\n" +
          `prx: http endpoint http://127\\.0\\.0\\.1:${endpoints.http.port} is live \\(\\d+ ms\\), launching claude\n$`,
      ),
    );
  });

  test("a restart that stays stalled stops the launch with exit 1", async () => {
    const { fake, endpoints } = await withStoppedProxy();
    markRunning(fake);
    await endpoints.http.close();

    const exitCode = await runCli(["run", "claude"], fake.system, {
      probeTimeoutMs: 300,
      startTimeoutMs: 300,
    });

    expect(exitCode).toBe(1);
    expect(fake.backgroundStarts).toHaveLength(2);
    expect(fake.spawns).toEqual([]);
    expect(fake.stderr()).toBe(
      "prx: restarted the built-in proxy\n" +
        `Endpoint http://127.0.0.1:${endpoints.http.port} is not live: connection refused (ECONNREFUSED). ` +
        "Run prx status to see every endpoint and the log directory.\n",
    );
  });

  test("--no-check launches through a stalled proxy without touching it", async () => {
    const { fake, endpoints } = await withStoppedProxy();
    markRunning(fake);
    await endpoints.http.close();

    const exitCode = await runWith(fake, ["--no-check", "claude"]);

    expect(exitCode).toBe(0);
    expect(fake.signals).toEqual([]);
    expect(fake.backgroundStarts).toEqual([]);
    expect(fake.spawns).toHaveLength(1);
  });
});

describe("prx run with a running built-in proxy", () => {
  test("starts nothing extra and launches with no extra stderr line", async () => {
    const { fake, endpoints } = await withStoppedProxy();
    markRunning(fake);

    const exitCode = await runWith(fake, ["claude"]);

    expect(exitCode).toBe(0);
    expect(fake.backgroundStarts).toEqual([]);
    expect(fake.spawns).toHaveLength(1);
    expect(fake.stderr()).toMatch(
      new RegExp(
        `^prx: http endpoint http://127\\.0\\.0\\.1:${endpoints.http.port} is live \\(\\d+ ms\\), launching claude\n$`,
      ),
    );
  });
});
