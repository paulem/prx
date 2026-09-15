import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  buildBundle,
  isolatedHomeEnv,
  runNode,
  type BuiltBundle,
  type ProcessResult,
} from "./built-bundle.ts";
import { probeTargetCertPath } from "./test-proxy.ts";

const SERVER = join(import.meta.dirname, "serve-test-proxy.ts");

// Both fakes print what they were handed, then serve the endpoint the real binary would, so
// prx up sees it come live. autossh reads the SOCKS port from -D, privoxy from its config file
const FAKE_AUTOSSH = `#!/bin/sh
printf 'arg=%s\\n' "$@"
echo "AUTOSSH_GATETIME=$AUTOSSH_GATETIME"
port=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-D" ]; then port="\${2#127.0.0.1:}"; fi
  shift
done
exec "${process.execPath}" "${SERVER}" socks "$port"
`;
const FAKE_PRIVOXY = `#!/bin/sh
printf 'arg=%s\\n' "$@"
port=$(sed -n 's/^listen-address 127.0.0.1://p' "$2")
exec "${process.execPath}" "${SERVER}" live "$port"
`;

interface InstalledHome {
  home: string;
  binDir: string;
  stateDir: string;
  socksPort: number;
  httpPort: number;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no TCP port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function writeExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, source);
  await chmod(path, 0o755);
}

async function installedHome(): Promise<InstalledHome> {
  const home = await mkdtemp(join(tmpdir(), "prx-lifecycle-"));
  const binDir = join(home, "bin");
  await mkdir(binDir, { recursive: true });
  await writeExecutable(join(binDir, "autossh"), FAKE_AUTOSSH);
  await writeExecutable(join(binDir, "privoxy"), FAKE_PRIVOXY);

  const [socksPort, httpPort] = await Promise.all([freePort(), freePort()]);
  await mkdir(join(home, ".config", "prx"), { recursive: true });
  await writeFile(
    join(home, ".config", "prx", "config.json"),
    JSON.stringify({
      version: 1,
      proxy: {
        source: "built-in",
        tunnel: { user: "me", host: "box.example", port: 22 },
        socksPort,
        httpPort,
      },
    }),
  );
  return { home, binDir, stateDir: join(home, ".local", "state", "prx"), socksPort, httpPort };
}

async function isAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(path: string): Promise<number | undefined> {
  try {
    return Number((await readFile(path, "utf8")).trim());
  } catch {
    return undefined;
  }
}

describe("the built-in proxy lifecycle through the built bundle", () => {
  let bundle: BuiltBundle;
  let installed: InstalledHome;

  beforeAll(async () => {
    [bundle, installed] = await Promise.all([buildBundle(), installedHome()]);
  });

  // Nothing prx started may outlive the test run, whatever the assertions did
  afterAll(async () => {
    for (const name of ["autossh", "privoxy"]) {
      const pid = await readPid(join(installed.stateDir, `${name}.pid`));
      if (pid !== undefined && (await isAlive(pid))) {
        process.kill(pid, "SIGKILL");
      }
    }
  });

  function runPrx(args: string[]): Promise<ProcessResult> {
    return runNode(
      [bundle.path, ...args],
      isolatedHomeEnv(installed.home, {
        PATH: [installed.binDir, process.env.PATH].join(delimiter),
        NODE_EXTRA_CA_CERTS: probeTargetCertPath,
      }),
    );
  }

  test("up starts the fakes with the documented argv and waits for both endpoints", async () => {
    const result = await runPrx(["up"]);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(
      new RegExp(
        "^Built-in proxy started\n" +
          `Endpoint http://127\\.0\\.0\\.1:${installed.httpPort} is live \\(\\d+ ms\\)\n` +
          `Endpoint socks5://127\\.0\\.0\\.1:${installed.socksPort} is live \\(\\d+ ms\\)\n$`,
      ),
    );

    const autosshLog = await readFile(join(installed.stateDir, "autossh.log"), "utf8");
    expect(autosshLog).toBe(
      [
        "-M",
        "0",
        "-F",
        "/dev/null",
        "-N",
        "-D",
        `127.0.0.1:${installed.socksPort}`,
        "-p",
        "22",
        "-l",
        "me",
        "-o",
        "BatchMode=yes",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ServerAliveInterval=3",
        "-o",
        "ServerAliveCountMax=2",
        "-o",
        "ConnectTimeout=10",
        "box.example",
      ]
        .map((arg) => `arg=${arg}\n`)
        .join("") +
        "AUTOSSH_GATETIME=0\n" +
        `serving socks on ${installed.socksPort}\n`,
    );
    const privoxyLog = await readFile(join(installed.stateDir, "privoxy.log"), "utf8");
    expect(privoxyLog).toBe(
      `arg=--no-daemon\narg=${installed.stateDir}/privoxy.conf\n` +
        `serving live on ${installed.httpPort}\n`,
    );
    expect(await readFile(join(installed.stateDir, "privoxy.conf"), "utf8")).toBe(
      `confdir ${installed.stateDir}\n` +
        `logdir ${installed.stateDir}\n` +
        `listen-address 127.0.0.1:${installed.httpPort}\n` +
        `forward-socks5 / 127.0.0.1:${installed.socksPort} .\n`,
    );
  });

  test("status reports running and live, and the pid files name live processes", async () => {
    const result = await runPrx(["status", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      source: "built-in",
      running: true,
      endpoints: { http: { live: true }, socks: { live: true } },
    });
    for (const name of ["autossh", "privoxy"]) {
      const pid = await readPid(join(installed.stateDir, `${name}.pid`));
      expect(pid).toBeGreaterThan(0);
      expect(await isAlive(pid as number)).toBe(true);
    }
  });

  test("down stops both processes and status then reports not running", async () => {
    const pids = await Promise.all(
      ["autossh", "privoxy"].map((name) => readPid(join(installed.stateDir, `${name}.pid`))),
    );

    const down = await runPrx(["down"]);

    expect(down).toEqual({ exitCode: 0, stdout: "Built-in proxy stopped\n", stderr: "" });
    for (let attempt = 0; attempt < 50 && (await isAlive(pids[0] as number)); attempt += 1) {
      await sleep(100);
    }
    expect(await isAlive(pids[0] as number)).toBe(false);
    expect(await isAlive(pids[1] as number)).toBe(false);

    const status = await runPrx(["status", "--json"]);
    expect(status.exitCode).toBe(1);
    expect(JSON.parse(status.stdout)).toMatchObject({ running: false });
  });
});
