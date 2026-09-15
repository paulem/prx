import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import {
  builtInProxy,
  CANCEL,
  createFakeSystem,
  externalProxy,
  FAKE_CONFIG_PATH,
  writeFakeConfig,
  type FakeSystem,
} from "./fake-system.ts";
import { proxyPool, trustProbeTarget } from "./test-proxy.ts";

const CLAUDE_PATH = "/home/test/.local/bin/claude";

beforeAll(() => {
  trustProbeTarget();
});

const pool = proxyPool();
afterEach(() => pool.closeAll());

/** A fake whose stdout and stderr are terminals, so output carries symbols and color */
function decoratedFake(): FakeSystem {
  const fake = createFakeSystem();
  fake.decorated.add("stdout");
  fake.decorated.add("stderr");
  return fake;
}

/** The output as a person reads it, with color codes and hyperlinks stripped */
function visible(text: string): string {
  return stripVTControlCharacters(text);
}

describe("decorated status", () => {
  test("a live built-in proxy gets a green headline and an aligned endpoint table", async () => {
    const http = await pool.open("live");
    const socks = await pool.open("socks");
    const fake = decoratedFake();
    writeFakeConfig(fake, builtInProxy({ httpPort: http.port, socksPort: socks.port }));
    fake.alivePids.add(1);
    fake.alivePids.add(2);
    fake.files.set("/home/test/.local/state/prx/autossh.pid", "1\n");
    fake.files.set("/home/test/.local/state/prx/privoxy.pid", "2\n");

    const exitCode = await runCli(["status"], fake.system, { probeTimeoutMs: 1000 });

    expect(exitCode).toBe(0);
    expect(visible(fake.stdout())).toMatch(
      new RegExp(
        "^◆  Built-in proxy is running\n" +
          `   http   127\\.0\\.0\\.1:${http.port}  live  \\d+ ms\n` +
          `   socks  127\\.0\\.0\\.1:${socks.port}  live  \\d+ ms\n$`,
      ),
    );
    expect(fake.stdout()).toContain("[32m");
    expect(fake.spinners).toEqual([
      { kind: "start", message: "Probing endpoints" },
      { kind: "clear" },
    ]);
  });

  test("a running proxy with a dead endpoint warns, names the reason, and links the logs", async () => {
    const http = await pool.open("live");
    const socks = await pool.closed();
    const fake = decoratedFake();
    writeFakeConfig(fake, builtInProxy({ httpPort: http.port, socksPort: socks.port }));
    fake.alivePids.add(1);
    fake.alivePids.add(2);
    fake.files.set("/home/test/.local/state/prx/autossh.pid", "1\n");
    fake.files.set("/home/test/.local/state/prx/privoxy.pid", "2\n");

    const exitCode = await runCli(["status"], fake.system, { probeTimeoutMs: 1000 });

    expect(exitCode).toBe(1);
    const lines = visible(fake.stdout()).split("\n");
    expect(lines[0]).toBe("▲  Built-in proxy is running");
    expect(lines[2]).toBe(
      `   socks  127.0.0.1:${socks.port}  not live  connection refused (ECONNREFUSED)`,
    );
    expect(lines[3]).toBe("   logs   ~/.local/state/prx");
    expect(lines[4]).toBe("   Run prx up to restart it.");
    expect(fake.stdout()).toContain("]8;;file:///home/test/.local/state/prx\\");
  });

  test("a dead tunnel gets a tunnel row and its hint under the table", async () => {
    const http = await pool.open("live");
    const socks = await pool.closed();
    const fake = decoratedFake();
    writeFakeConfig(fake, builtInProxy({ httpPort: http.port, socksPort: socks.port }));
    fake.alivePids.add(1);
    fake.alivePids.add(2);
    fake.files.set("/home/test/.local/state/prx/autossh.pid", "1\n");
    fake.files.set("/home/test/.local/state/prx/privoxy.pid", "2\n");
    fake.files.set(
      "/home/test/.local/state/prx/autossh.log",
      "me@box.example: Permission denied (publickey).\n",
    );

    await runCli(["status"], fake.system, { probeTimeoutMs: 1000 });

    const lines = visible(fake.stdout()).split("\n");
    expect(lines[3]).toBe("   tunnel  me@box.example: Permission denied (publickey).");
    expect(lines[4]).toBe("   logs    ~/.local/state/prx");
    expect(lines[5]).toBe(
      "   Run prx init to pick a key file, or add one to ssh-agent with: ssh-add <path>",
    );
  });

  test("a stopped built-in proxy is muted and says how to start it", async () => {
    const http = await pool.closed();
    const socks = await pool.closed();
    const fake = decoratedFake();
    writeFakeConfig(fake, builtInProxy({ httpPort: http.port, socksPort: socks.port }));

    await runCli(["status"], fake.system, { probeTimeoutMs: 1000 });

    expect(visible(fake.stdout())).toBe(
      "●  Built-in proxy is not running\n   Run prx up to start it.\n",
    );
  });

  test("a stopped built-in proxy shows the one endpoint something else answers on", async () => {
    const http = await pool.open("silent");
    const socks = await pool.closed();
    const fake = decoratedFake();
    writeFakeConfig(fake, builtInProxy({ httpPort: http.port, socksPort: socks.port }));

    await runCli(["status"], fake.system, { probeTimeoutMs: 300 });

    expect(visible(fake.stdout())).toBe(
      "●  Built-in proxy is not running\n" +
        `   http  127.0.0.1:${http.port}  not live  no response from the proxy before the timeout\n` +
        "   Run prx up to start it.\n",
    );
  });

  test("an external proxy gets its own headline", async () => {
    const http = await pool.open("live");
    const fake = decoratedFake();
    writeFakeConfig(fake, externalProxy({ http }));

    await runCli(["status"], fake.system, { probeTimeoutMs: 1000 });

    expect(visible(fake.stdout())).toMatch(
      new RegExp(`^◆  External proxy\n   http  127\\.0\\.0\\.1:${http.port}  live  \\d+ ms\n$`),
    );
  });

  test("a pipe on stdout gets the plain text even when stderr is a terminal", async () => {
    const http = await pool.open("live");
    const fake = createFakeSystem();
    fake.decorated.add("stderr");
    writeFakeConfig(fake, externalProxy({ http }));

    await runCli(["status"], fake.system, { probeTimeoutMs: 1000 });

    expect(fake.stdout()).toMatch(/^Endpoint http:\/\/127\.0\.0\.1:\d+ is live \(\d+ ms\)\n$/);
    expect(fake.spinners[0]).toEqual({ kind: "start", message: "Probing endpoints" });
  });
});

describe("decorated list", () => {
  test("prints a header row and marks each preset installed or not", async () => {
    const fake = decoratedFake();
    fake.onPath.set("claude", CLAUDE_PATH);

    await runCli(["list"], fake.system);

    expect(visible(fake.stdout())).toBe(
      "   Preset  Launch    Endpoints\n" +
        "◆  claude  attached  http\n" +
        "●  chrome  detached  socks, http  not installed\n",
    );
  });
});

describe("decorated run", () => {
  test("leaves one line naming the app, the endpoint and the latency", async () => {
    const http = await pool.open("live");
    const fake = decoratedFake();
    writeFakeConfig(fake, externalProxy({ http }));
    fake.onPath.set("claude", CLAUDE_PATH);

    const exitCode = await runCli(["run", "claude"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.stdout()).toBe("");
    expect(visible(fake.stderr())).toMatch(
      new RegExp(`^◇  claude via http://127\\.0\\.0\\.1:${http.port}  \\d+ ms\n$`),
    );
    expect(fake.spinners).toEqual([
      { kind: "start", message: `Probing http://127.0.0.1:${http.port}` },
      { kind: "clear" },
    ]);
  });

  test("a started built-in proxy gets its own line and a narrated wait", async () => {
    const http = await pool.open("live");
    const socks = await pool.open("socks");
    const fake = decoratedFake();
    fake.onPath.set("autossh", "/opt/homebrew/bin/autossh");
    fake.onPath.set("privoxy", "/opt/homebrew/bin/privoxy");
    fake.onPath.set("claude", CLAUDE_PATH);
    writeFakeConfig(fake, builtInProxy({ httpPort: http.port, socksPort: socks.port }));

    const exitCode = await runCli(["run", "claude"], fake.system, { startTimeoutMs: 5000 });

    expect(exitCode).toBe(0);
    const lines = visible(fake.stderr()).split("\n");
    expect(lines[0]).toBe("◇  Built-in proxy started");
    expect(lines[1]).toMatch(
      new RegExp(`^◇  claude via http://127\\.0\\.0\\.1:${http.port}  \\d+ ms$`),
    );
    expect(fake.spinners.map((event) => event.kind)).toEqual([
      "start",
      "clear",
      "start",
      "message",
      "clear",
    ]);
    expect(fake.spinners[2]?.message).toBe(`Waiting for http://127.0.0.1:${http.port}, 0 s of 5 s`);
  });
});

describe("decorated run without a probe", () => {
  test("says not probed in place of the latency", async () => {
    const fake = decoratedFake();
    writeFakeConfig(fake, externalProxy({ http: { host: "127.0.0.1", port: 1 } }));
    fake.onPath.set("claude", CLAUDE_PATH);

    await runCli(["run", "--no-check", "claude"], fake.system);

    expect(visible(fake.stderr())).toBe("◇  claude via http://127.0.0.1:1  not probed\n");
    expect(fake.spinners).toEqual([]);
  });
});

describe("decorated up and down", () => {
  test("up prints the started block with both endpoints", async () => {
    const http = await pool.open("live");
    const socks = await pool.open("socks");
    const fake = decoratedFake();
    fake.onPath.set("autossh", "/opt/homebrew/bin/autossh");
    fake.onPath.set("privoxy", "/opt/homebrew/bin/privoxy");
    writeFakeConfig(fake, builtInProxy({ httpPort: http.port, socksPort: socks.port }));

    const exitCode = await runCli(["up"], fake.system, { startTimeoutMs: 5000 });

    expect(exitCode).toBe(0);
    expect(visible(fake.stdout())).toMatch(
      new RegExp(
        "^◆  Built-in proxy started\n" +
          `   http   127\\.0\\.0\\.1:${http.port}  live  \\d+ ms\n` +
          `   socks  127\\.0\\.0\\.1:${socks.port}  live  \\d+ ms\n$`,
      ),
    );
    expect(fake.spinners[0]).toEqual({ kind: "start", message: "Starting the built-in proxy" });
    expect(fake.spinners[2]?.message).toBe("Waiting for the http and socks endpoints, 0 s of 5 s");
  });

  test("down prints one green line when something was stopped", async () => {
    const fake = decoratedFake();
    writeFakeConfig(fake, builtInProxy());
    fake.alivePids.add(1);
    fake.alivePids.add(2);
    fake.files.set("/home/test/.local/state/prx/autossh.pid", "1\n");
    fake.files.set("/home/test/.local/state/prx/privoxy.pid", "2\n");

    await runCli(["down"], fake.system);

    expect(visible(fake.stdout())).toBe("◆  Built-in proxy stopped\n");
  });

  test("down prints one muted line when nothing was running", async () => {
    const fake = decoratedFake();
    writeFakeConfig(fake, builtInProxy());

    await runCli(["down"], fake.system);

    expect(visible(fake.stdout())).toBe("●  Built-in proxy is not running\n");
  });
});

describe("decorated config", () => {
  test("links the config path and prints the contents below it", async () => {
    const fake = decoratedFake();
    writeFakeConfig(fake, externalProxy({ http: { host: "127.0.0.1", port: 8118 } }));

    await runCli(["config"], fake.system);

    expect(visible(fake.stdout())).toMatch(/^●  ~\/.config\/prx\/config.json\n\{\n/);
    expect(fake.stdout()).toContain("]8;;file:///home/test/.config/prx/config.json");
  });
});

describe("decorated errors", () => {
  test("prints a hintless error as a single red line", async () => {
    const fake = decoratedFake();
    writeFakeConfig(fake, externalProxy({ http: { host: "127.0.0.1", port: 8118 } }));

    const exitCode = await runCli(["up"], fake.system);

    expect(exitCode).toBe(2);
    expect(visible(fake.stderr())).toBe(
      "■  The proxy is external, so there is nothing for prx to start.\n",
    );
  });

  test("puts the hint on its own line under the summary", async () => {
    const fake = decoratedFake();

    const exitCode = await runCli(["run", "bogus"], fake.system);

    expect(exitCode).toBe(2);
    expect(visible(fake.stderr())).toBe(
      "■  Unknown preset 'bogus'.\n   Run prx list to see the presets.\n",
    );
    expect(fake.stderr()).toContain("[31m");
  });

  test("closes the wizard frame on stdout when the person backs out", async () => {
    const fake = decoratedFake();
    fake.answers.push(CANCEL);

    const exitCode = await runCli(["run", "claude"], fake.system);

    expect(exitCode).toBe(1);
    expect(visible(fake.stdout())).toBe("┌  prx init\n└  Cancelled, nothing was saved\n\n");
    expect(fake.stderr()).toBe("");
  });

  test("a cancel with only stderr decorated is an error block, since no frame was opened", async () => {
    const fake = createFakeSystem();
    fake.decorated.add("stderr");
    fake.answers.push(CANCEL);

    await runCli(["run", "claude"], fake.system);

    expect(fake.stdout()).toBe("");
    expect(visible(fake.stderr())).toBe("■  Cancelled, nothing was saved\n");
  });

  test("a cancel with only stdout decorated still closes the frame there", async () => {
    const fake = createFakeSystem();
    fake.decorated.add("stdout");
    fake.answers.push(CANCEL);

    await runCli(["run", "claude"], fake.system);

    expect(visible(fake.stdout())).toMatch(/└  Cancelled, nothing was saved\n\n$/);
    expect(fake.stderr()).toBe("");
  });
});

describe("decorated help", () => {
  test("colors the command names and lists examples", async () => {
    const fake = decoratedFake();

    await runCli(["--help"], fake.system);

    expect(fake.stdout()).toContain("[36m");
    expect(visible(fake.stdout())).toContain("Examples:\n  prx init");
  });

  test("plain help lists the same examples without color", async () => {
    const fake = createFakeSystem();

    await runCli(["--help"], fake.system);

    expect(fake.stdout()).not.toContain("[");
    expect(fake.stdout()).toContain("Examples:\n  prx init");
  });
});

describe("decorated init", () => {
  test("frames the wizard with an intro, a saved note, the presets and a next step", async () => {
    const http = await pool.open("live");
    const fake = decoratedFake();
    fake.onPath.set("claude", CLAUDE_PATH);
    fake.answers.push("external", true, `127.0.0.1:${http.port}`, false);

    const exitCode = await runCli(["init"], fake.system, { probeTimeoutMs: 1000 });

    expect(exitCode).toBe(0);
    expect(fake.files.has(FAKE_CONFIG_PATH)).toBe(true);
    const out = visible(fake.stdout());
    expect(out).toMatch(/^┌  prx init\n/);
    expect(out).toContain(`\n◆  http  127.0.0.1:${http.port}  live  `);
    expect(out).toContain("◇  Saved to ~/.config/prx/config.json ");
    expect(out).toContain(`│  Source  external`);
    expect(out).toContain(`│  HTTP    127.0.0.1:${http.port}`);
    expect(out).toContain("│  ◆  claude  attached  http\n");
    expect(out).toMatch(/└  Next: prx run claude\n\n$/);
  });

  test("tells a person with no app installed what to install", async () => {
    const http = await pool.open("live");
    const fake = decoratedFake();
    fake.answers.push("external", true, `127.0.0.1:${http.port}`, false);

    await runCli(["init"], fake.system, { probeTimeoutMs: 1000 });

    expect(visible(fake.stdout())).toMatch(
      /└  Install Claude Code or Chrome, then prx run <preset>\n\n$/,
    );
  });

  test("warns inside the frame when no endpoint is recorded", async () => {
    const http = await pool.open("live");
    const fake = decoratedFake();
    fake.answers.push("external", false, false, true, `127.0.0.1:${http.port}`, false);

    await runCli(["init"], fake.system, { probeTimeoutMs: 1000 });

    expect(visible(fake.stdout())).toContain("▲  Record at least one endpoint\n");
  });
});

describe("decorated uninstall", () => {
  test("lists the removals in a note and reports each as a step", async () => {
    const fake = decoratedFake();
    fake.files.set("/home/test/.local/bin/prx", "#!/usr/bin/env node\n");
    writeFakeConfig(fake, externalProxy({ http: { host: "127.0.0.1", port: 8118 } }));

    const exitCode = await runCli(["uninstall", "--yes"], fake.system);

    expect(exitCode).toBe(0);
    const out = visible(fake.stdout());
    expect(out).toMatch(/^┌  prx uninstall\n/);
    expect(out).toContain("◇  Will remove ");
    expect(out).toContain("│  ~/.local/bin/prx");
    expect(out).toContain("│  ~/.config/prx");
    expect(out).toContain("◇  Removed ~/.local/bin/prx\n");
    expect(out).toMatch(/└  prx is gone from this machine\n\n$/);
    expect(fake.files.has("/home/test/.local/bin/prx")).toBe(false);
  });

  test("closes the frame when the person declines", async () => {
    const fake = decoratedFake();
    fake.files.set("/home/test/.local/bin/prx", "#!/usr/bin/env node\n");
    fake.answers.push(false);

    await runCli(["uninstall"], fake.system);

    expect(visible(fake.stdout())).toMatch(/└  Nothing removed\n\n$/);
    expect(fake.files.has("/home/test/.local/bin/prx")).toBe(true);
  });
});
