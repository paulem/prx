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

const AUTOSSH = "/opt/homebrew/bin/autossh";
const PRIVOXY = "/opt/homebrew/bin/privoxy";
const TUNNEL_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ExitOnForwardFailure=yes",
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  "ServerAliveInterval=5",
  "-o",
  "ServerAliveCountMax=2",
  "-o",
  "ConnectTimeout=10",
];

beforeAll(() => {
  trustProbeTarget();
});

const pool = proxyPool();
afterEach(() => pool.closeAll());

/** A fake with both dependencies installed and a built-in proxy whose endpoints are served by test proxies */
async function withDependencies(live: boolean): Promise<FakeSystem> {
  const fake = createFakeSystem();
  fake.onPath.set("autossh", AUTOSSH);
  fake.onPath.set("privoxy", PRIVOXY);
  const http = await pool.open("live");
  const socks = await pool.open("socks");
  if (!live) {
    await http.close();
    await socks.close();
  }
  writeFakeConfig(fake, builtInProxy({ socksPort: socks.port, httpPort: http.port }));
  return fake;
}

function ports(fake: FakeSystem): { socksPort: number; httpPort: number } {
  const text = fake.files.get("/home/test/.config/prx/config.json") ?? "{}";
  return JSON.parse(text).proxy;
}

function upWith(fake: FakeSystem, args: string[] = []): Promise<number> {
  return runCli(["up", ...args], fake.system, { probeTimeoutMs: 1000 });
}

describe("prx up", () => {
  test("starts autossh and privoxy with pid and log files in the state directory", async () => {
    const fake = await withDependencies(true);
    const { socksPort, httpPort } = ports(fake);

    const exitCode = await upWith(fake);

    expect(exitCode).toBe(0);
    expect(fake.backgroundStarts).toEqual([
      {
        command: AUTOSSH,
        args: [
          "-M",
          "0",
          "-F",
          "/dev/null",
          "-N",
          "-D",
          `127.0.0.1:${socksPort}`,
          "-p",
          "22",
          "-l",
          "me",
          ...TUNNEL_OPTIONS,
          "box.example",
        ],
        env: { AUTOSSH_GATETIME: "0" },
        logPath: `${FAKE_STATE_DIR}/autossh.log`,
      },
      {
        command: PRIVOXY,
        args: ["--no-daemon", `${FAKE_STATE_DIR}/privoxy.conf`],
        env: {},
        logPath: `${FAKE_STATE_DIR}/privoxy.log`,
      },
    ]);
    expect(fake.files.get(`${FAKE_STATE_DIR}/privoxy.conf`)).toBe(
      `confdir ${FAKE_STATE_DIR}\n` +
        `logdir ${FAKE_STATE_DIR}\n` +
        `listen-address 127.0.0.1:${httpPort}\n` +
        `forward-socks5 / 127.0.0.1:${socksPort} .\n`,
    );
    expect(fake.files.get(`${FAKE_STATE_DIR}/autossh.pid`)).toBe("1001\n");
    expect(fake.files.get(`${FAKE_STATE_DIR}/privoxy.pid`)).toBe("1002\n");
    expect(fake.stdout()).toMatch(
      new RegExp(
        "^Built-in proxy started\n" +
          `Endpoint http://127\\.0\\.0\\.1:${httpPort} is live \\(\\d+ ms\\)\n` +
          `Endpoint socks5://127\\.0\\.0\\.1:${socksPort} is live \\(\\d+ ms\\)\n$`,
      ),
    );
    expect(fake.stderr()).toBe("");
  });

  test("passes the identity file with IdentitiesOnly when one is configured", async () => {
    const fake = await withDependencies(true);
    writeFakeConfig(
      fake,
      builtInProxy({
        ...ports(fake),
        tunnel: { user: "me", host: "box.example", port: 2222, identityFile: "/home/test/.ssh/id" },
      }),
    );

    await upWith(fake);

    expect(fake.backgroundStarts[0]?.args.slice(7, 15)).toEqual([
      "-p",
      "2222",
      "-l",
      "me",
      "-i",
      "/home/test/.ssh/id",
      "-o",
      "IdentitiesOnly=yes",
    ]);
  });

  test("--json prints the status report with started", async () => {
    const fake = await withDependencies(true);
    const { socksPort, httpPort } = ports(fake);

    const exitCode = await upWith(fake, ["--json"]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(fake.stdout())).toEqual({
      source: "built-in",
      running: true,
      started: true,
      endpoints: {
        http: { host: "127.0.0.1", port: httpPort, live: true, latencyMs: expect.any(Number) },
        socks: { host: "127.0.0.1", port: socksPort, live: true, latencyMs: expect.any(Number) },
      },
    });
  });

  test("exits 1 and leaves the processes running when the endpoints do not become live", async () => {
    const fake = await withDependencies(false);
    const { socksPort, httpPort } = ports(fake);

    const exitCode = await runCli(["up"], fake.system, {
      probeTimeoutMs: 300,
      startTimeoutMs: 300,
    });

    expect(exitCode).toBe(1);
    expect(fake.backgroundStarts).toHaveLength(2);
    expect(fake.signals).toEqual([]);
    expect(fake.alivePids).toEqual(new Set([1001, 1002]));
    expect(fake.stdout()).toBe(
      "Built-in proxy started\n" +
        `Endpoint http://127.0.0.1:${httpPort} is not live: connection refused (ECONNREFUSED)\n` +
        `Endpoint socks5://127.0.0.1:${socksPort} is not live: connection refused (ECONNREFUSED)\n` +
        `Logs are in ${FAKE_STATE_DIR}\n`,
    );
  });

  test("names the tunnel error after the wait and how to fix a rejected key file", async () => {
    const fake = await withDependencies(false);
    const { socksPort, httpPort } = ports(fake);
    writeFakeConfig(
      fake,
      builtInProxy({
        socksPort,
        httpPort,
        tunnel: { user: "me", host: "box.example", port: 22, identityFile: "/home/test/.ssh/id" },
      }),
    );
    fake.files.set(
      `${FAKE_STATE_DIR}/autossh.log`,
      "me@box.example: Permission denied (publickey).\n",
    );

    const exitCode = await runCli(["up"], fake.system, {
      probeTimeoutMs: 300,
      startTimeoutMs: 300,
    });

    expect(exitCode).toBe(1);
    expect(fake.stdout()).toBe(
      "Built-in proxy started\n" +
        `Endpoint http://127.0.0.1:${httpPort} is not live: connection refused (ECONNREFUSED)\n` +
        `Endpoint socks5://127.0.0.1:${socksPort} is not live: connection refused (ECONNREFUSED)\n` +
        "Tunnel: me@box.example: Permission denied (publickey).\n" +
        `Logs are in ${FAKE_STATE_DIR}\n` +
        "Authorize ~/.ssh/id on box.example, or run prx init to pick another key.\n",
    );
  });

  test("a stale host key and an unreachable host each get their own hint", async () => {
    const cases = [
      [
        "Host key verification failed.",
        "Remove the stale host key with: ssh-keygen -R box.example",
      ],
      [
        "ssh: connect to host box.example port 22: Connection refused",
        "Check the host and port with prx config, or run prx init to change them.",
      ],
    ];
    for (const [line, hint] of cases) {
      const fake = await withDependencies(false);
      fake.files.set(`${FAKE_STATE_DIR}/autossh.log`, `${line}\n`);

      await runCli(["up", "--json"], fake.system, { probeTimeoutMs: 300, startTimeoutMs: 300 });

      expect(JSON.parse(fake.stdout()).tunnelFailure).toEqual({ message: line, hint });
    }
  });

  test("keeps probing until an endpoint comes up within the timeout", async () => {
    const fake = await withDependencies(true);
    const { socksPort } = ports(fake);
    const slowStarter = await pool.closed();
    writeFakeConfig(fake, builtInProxy({ socksPort, httpPort: slowStarter.port }));
    setTimeout(async () => {
      await pool.open("live", slowStarter.port);
    }, 200);

    const exitCode = await upWith(fake);

    expect(exitCode).toBe(0);
    expect(fake.stdout()).toContain(`Endpoint http://127.0.0.1:${slowStarter.port} is live`);
  });

  test("waits past a single probe timeout for an endpoint that stalls and then heals", async () => {
    const fake = await withDependencies(true);
    const { socksPort } = ports(fake);
    const stalled = await pool.open("silent");
    writeFakeConfig(fake, builtInProxy({ socksPort, httpPort: stalled.port }));
    setTimeout(async () => {
      await stalled.close();
      await pool.open("live", stalled.port);
    }, 800);

    const exitCode = await runCli(["up"], fake.system, {
      probeTimeoutMs: 300,
      startTimeoutMs: 3000,
    });

    expect(fake.stdout()).toContain(`Endpoint http://127.0.0.1:${stalled.port} is live`);
    expect(exitCode).toBe(0);
  });

  test("a second up reports already running, starts nothing, and still probes", async () => {
    const fake = await withDependencies(true);
    await upWith(fake);
    const startsAfterFirst = fake.backgroundStarts.length;

    const exitCode = await upWith(fake, ["--json"]);

    expect(exitCode).toBe(0);
    expect(fake.backgroundStarts).toHaveLength(startsAfterFirst);
    const lastLine = fake.stdout().trimEnd().split("\n").at(-1) ?? "";
    expect(JSON.parse(lastLine)).toMatchObject({ running: true, started: false });
  });

  test("already running is reported in text mode", async () => {
    const fake = await withDependencies(true);
    await upWith(fake);

    await upWith(fake);

    expect(fake.stdout()).toMatch(/\nBuilt-in proxy is already running\nEndpoint /);
  });

  test("a stale pid file counts as not running and is replaced", async () => {
    const fake = await withDependencies(true);
    fake.files.set(`${FAKE_STATE_DIR}/autossh.pid`, "4242\n");
    fake.files.set(`${FAKE_STATE_DIR}/privoxy.pid`, "4243\n");

    const exitCode = await upWith(fake);

    expect(exitCode).toBe(0);
    expect(fake.backgroundStarts).toHaveLength(2);
    expect(fake.files.get(`${FAKE_STATE_DIR}/autossh.pid`)).toBe("1001\n");
    expect(fake.files.get(`${FAKE_STATE_DIR}/privoxy.pid`)).toBe("1002\n");
    expect(fake.stdout()).toMatch(/^Built-in proxy started\n/);
  });
});

describe("prx up refusals", () => {
  test("a missing dependency names the binary and the install command", async () => {
    const fake = await withDependencies(true);
    fake.onPath.delete("privoxy");

    const exitCode = await upWith(fake);

    expect(exitCode).toBe(2);
    expect(fake.backgroundStarts).toEqual([]);
    expect(fake.stderr()).toBe(
      "privoxy is not installed. Install it with: brew install autossh privoxy\n",
    );
  });

  test("both dependencies missing are named together, in JSON mode as dependency_missing", async () => {
    const fake = await withDependencies(true);
    fake.onPath.clear();

    const exitCode = await upWith(fake, ["--json"]);

    expect(exitCode).toBe(2);
    expect(JSON.parse(fake.stdout())).toEqual({
      error: {
        code: "dependency_missing",
        message:
          "autossh and privoxy are not installed. Install them with: brew install autossh privoxy",
        hint: "Install them with: brew install autossh privoxy",
      },
    });
  });

  test("a busy port fails with port_in_use and starts nothing", async () => {
    const fake = await withDependencies(true);
    const { httpPort } = ports(fake);
    fake.busyPorts.add(httpPort);

    const exitCode = await upWith(fake, ["--json"]);

    expect(exitCode).toBe(2);
    expect(fake.backgroundStarts).toEqual([]);
    expect(fake.files.has(`${FAKE_STATE_DIR}/privoxy.conf`)).toBe(false);
    expect(JSON.parse(fake.stdout())).toEqual({
      error: {
        code: "port_in_use",
        message: `Port ${httpPort} is already in use, so the built-in proxy cannot listen there.`,
      },
    });
  });

  test("an external proxy fails with not_builtin", async () => {
    const fake = createFakeSystem();
    writeFakeConfig(fake, externalProxy({ http: { host: "127.0.0.1", port: 8118 } }));

    const exitCode = await upWith(fake);

    expect(exitCode).toBe(2);
    expect(fake.stderr()).toBe("The proxy is external, so there is nothing for prx to start.\n");
  });
});
