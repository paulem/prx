import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import {
  CANCEL,
  createFakeSystem,
  externalProxy,
  FAKE_CONFIG_PATH,
  USE_DEFAULT,
  writeFakeConfig,
  type FakeSystem,
} from "./fake-system.ts";
import { proxyPool, trustProbeTarget } from "./test-proxy.ts";

beforeAll(() => {
  trustProbeTarget();
});

const pool = proxyPool();
afterEach(() => pool.closeAll());

function savedConfig(fake: FakeSystem): unknown {
  const text = fake.files.get(FAKE_CONFIG_PATH);
  return text === undefined ? undefined : JSON.parse(text);
}

function questionMessages(fake: FakeSystem): string[] {
  return fake.questions.map((question) => question.message);
}

describe("prx init with an external proxy", () => {
  test("records an HTTP endpoint, probes it, saves and lists the presets", async () => {
    const http = await pool.open("live");
    const fake = createFakeSystem();
    fake.onPath.set("claude", "/home/test/.local/bin/claude");
    fake.answers.push("external", true, `127.0.0.1:${http.port}`, false);

    const exitCode = await runCli(["init"], fake.system);

    expect(exitCode).toBe(0);
    expect(savedConfig(fake)).toEqual({ version: 1, proxy: externalProxy({ http }) });
    expect(questionMessages(fake)).toEqual([
      "Proxy source",
      "Record an HTTP endpoint?",
      "HTTP endpoint (host:port or http://host:port)",
      "Record a SOCKS endpoint?",
    ]);
    expect(fake.stdout()).toMatch(
      new RegExp(
        `^Endpoint http://127\\.0\\.0\\.1:${http.port} is live \\(\\d+ ms\\)\n` +
          `Saved config to ${FAKE_CONFIG_PATH}\n` +
          "claude  found    attached  http\nchrome  missing  detached  socks,http\n$",
      ),
    );
    expect(fake.stderr()).toBe("");
  });

  test("defaults to recording only an HTTP endpoint", async () => {
    const fake = createFakeSystem();
    fake.answers.push("external", CANCEL);

    await runCli(["init"], fake.system);

    expect(fake.questions[1]).toEqual({
      kind: "confirm",
      message: "Record an HTTP endpoint?",
      initialValue: true,
    });
  });

  test("records both endpoints and probes each one", async () => {
    const http = await pool.open("live");
    const socks = await pool.open("socks");
    const fake = createFakeSystem();
    fake.answers.push("external", true, `127.0.0.1:${http.port}`, true, `127.0.0.1:${socks.port}`);

    const exitCode = await runCli(["init"], fake.system);

    expect(exitCode).toBe(0);
    expect(savedConfig(fake)).toEqual({ version: 1, proxy: externalProxy({ http, socks }) });
    expect(fake.questions[4]).toMatchObject({
      kind: "text",
      message: "SOCKS endpoint (host:port or socks5://host:port)",
      initialValue: "127.0.0.1:1080",
    });
    expect(fake.stdout()).toMatch(
      new RegExp(
        `^Endpoint http://127\\.0\\.0\\.1:${http.port} is live \\(\\d+ ms\\)\n` +
          `Endpoint socks5://127\\.0\\.0\\.1:${socks.port} is live \\(\\d+ ms\\)\n`,
      ),
    );
  });

  test("records only a SOCKS endpoint", async () => {
    const socks = await pool.open("socks");
    const fake = createFakeSystem();
    fake.answers.push("external", false, true, `socks5://127.0.0.1:${socks.port}`);

    const exitCode = await runCli(["init"], fake.system);

    expect(exitCode).toBe(0);
    expect(savedConfig(fake)).toEqual({ version: 1, proxy: externalProxy({ socks }) });
  });

  test("refuses to save no endpoint and asks again", async () => {
    const http = await pool.open("live");
    const fake = createFakeSystem();
    fake.answers.push("external", false, false, true, `127.0.0.1:${http.port}`, false);

    const exitCode = await runCli(["init"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.stdout()).toMatch(/^Record at least one endpoint\n/);
    expect(questionMessages(fake)).toEqual([
      "Proxy source",
      "Record an HTTP endpoint?",
      "Record a SOCKS endpoint?",
      "Record an HTTP endpoint?",
      "HTTP endpoint (host:port or http://host:port)",
      "Record a SOCKS endpoint?",
    ]);
    expect(savedConfig(fake)).toEqual({ version: 1, proxy: externalProxy({ http }) });
  });

  test("accepts the http://host:port form", async () => {
    const http = await pool.open("live");
    const fake = createFakeSystem();
    fake.answers.push("external", true, `http://localhost:${http.port}`, false);

    await runCli(["init"], fake.system);

    expect(savedConfig(fake)).toEqual({
      version: 1,
      proxy: { source: "external", endpoints: { http: { host: "localhost", port: http.port } } },
    });
  });

  test("defaults the HTTP address to 127.0.0.1:8118", async () => {
    const fake = createFakeSystem();
    fake.answers.push("external", true, USE_DEFAULT, false, true);

    await runCli(["init"], fake.system, { probeTimeoutMs: 300 });

    expect(fake.questions[2]).toMatchObject({ kind: "text", initialValue: "127.0.0.1:8118" });
    expect(savedConfig(fake)).toEqual({
      version: 1,
      proxy: { source: "external", endpoints: { http: { host: "127.0.0.1", port: 8118 } } },
    });
  });

  test("rejects a bad address with a clear message and asks again", async () => {
    const http = await pool.open("live");
    const fake = createFakeSystem();
    fake.answers.push(
      "external",
      true,
      "not an address",
      "127.0.0.1:99999",
      `socks5://127.0.0.1:${http.port}`,
      `127.0.0.1:${http.port}`,
      false,
    );

    const exitCode = await runCli(["init"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.rejectedInputs).toEqual([
      { input: "not an address", message: "Enter host:port or http://host:port" },
      { input: "127.0.0.1:99999", message: "Port must be between 1 and 65535" },
      { input: `socks5://127.0.0.1:${http.port}`, message: "Enter host:port or http://host:port" },
    ]);
    expect(savedConfig(fake)).toEqual({ version: 1, proxy: externalProxy({ http }) });
  });

  test("asks whether to save anyway when a probe fails, and saves on yes", async () => {
    const http = await pool.open("live");
    const socks = await pool.closed();
    const fake = createFakeSystem();
    fake.answers.push(
      "external",
      true,
      `127.0.0.1:${http.port}`,
      true,
      `127.0.0.1:${socks.port}`,
      true,
    );

    const exitCode = await runCli(["init"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.stdout()).toContain(
      `Endpoint socks5://127.0.0.1:${socks.port} is not live: connection refused (ECONNREFUSED)\n`,
    );
    expect(fake.questions[5]).toMatchObject({
      kind: "confirm",
      message: "Save the config anyway?",
      initialValue: false,
    });
    expect(savedConfig(fake)).toEqual({ version: 1, proxy: externalProxy({ http, socks }) });
  });

  test("declining to save anyway exits without writing", async () => {
    const http = await pool.closed();
    const fake = createFakeSystem();
    fake.answers.push("external", true, `127.0.0.1:${http.port}`, false, false);

    const exitCode = await runCli(["init"], fake.system);

    expect(exitCode).toBe(1);
    expect(savedConfig(fake)).toBeUndefined();
    expect(fake.stderr()).toBe("Cancelled, nothing was saved\n");
  });

  test("cancelling a prompt exits without writing", async () => {
    const fake = createFakeSystem();
    fake.answers.push("external", true, CANCEL);

    const exitCode = await runCli(["init"], fake.system);

    expect(exitCode).toBe(1);
    expect(savedConfig(fake)).toBeUndefined();
    expect(fake.stderr()).toBe("Cancelled, nothing was saved\n");
  });

  test("re-running replaces the existing config", async () => {
    const http = await pool.open("live");
    const fake = createFakeSystem();
    writeFakeConfig(fake, externalProxy({ http: { host: "10.0.0.1", port: 3128 } }));
    fake.answers.push("external", true, `127.0.0.1:${http.port}`, false);

    await runCli(["init"], fake.system);

    expect(savedConfig(fake)).toEqual({ version: 1, proxy: externalProxy({ http }) });
  });
});

describe("prx run on a first run", () => {
  test("starts the wizard when there is no config, then launches", async () => {
    const http = await pool.open("live");
    const fake = createFakeSystem();
    fake.onPath.set("claude", "/home/test/.local/bin/claude");
    fake.answers.push("external", true, `127.0.0.1:${http.port}`, false);

    const exitCode = await runCli(["run", "claude", "--resume"], fake.system);

    expect(exitCode).toBe(0);
    expect(savedConfig(fake)).toEqual({ version: 1, proxy: externalProxy({ http }) });
    expect(fake.spawns).toHaveLength(1);
    expect(fake.spawns[0]?.args).toEqual(["--resume"]);
  });

  test("cancelling the wizard exits without launching", async () => {
    const fake = createFakeSystem();
    fake.onPath.set("claude", "/home/test/.local/bin/claude");
    fake.answers.push(CANCEL);

    const exitCode = await runCli(["run", "claude"], fake.system);

    expect(exitCode).toBe(1);
    expect(fake.spawns).toEqual([]);
    expect(savedConfig(fake)).toBeUndefined();
  });

  test("in JSON mode a missing config is an error instead of a wizard", async () => {
    const fake = createFakeSystem();
    fake.onPath.set("claude", "/home/test/.local/bin/claude");

    const exitCode = await runCli(["run", "--json", "claude"], fake.system);

    expect(exitCode).toBe(2);
    expect(JSON.parse(fake.stdout())).toMatchObject({ error: { code: "config_missing" } });
    expect(fake.questions).toEqual([]);
  });
});

describe("prx init with a built-in proxy", () => {
  const AUTOSSH = "/opt/homebrew/bin/autossh";
  const PRIVOXY = "/opt/homebrew/bin/privoxy";

  function withDependencies(): FakeSystem {
    const fake = createFakeSystem();
    fake.onPath.set("autossh", AUTOSSH);
    fake.onPath.set("privoxy", PRIVOXY);
    return fake;
  }

  test("offers both sources", async () => {
    const fake = createFakeSystem();
    fake.answers.push(CANCEL);

    await runCli(["init"], fake.system);

    expect(fake.questions[0]).toEqual({
      kind: "select",
      message: "Proxy source",
      options: [
        { value: "external", label: "External proxy, something else runs it" },
        { value: "built-in", label: "Built-in proxy, prx runs an ssh tunnel" },
      ],
    });
  });

  test("a missing dependency stops the wizard with the install hint and saves nothing", async () => {
    const fake = createFakeSystem();
    fake.onPath.set("autossh", AUTOSSH);
    fake.answers.push("built-in");

    const exitCode = await runCli(["init"], fake.system);

    expect(exitCode).toBe(2);
    expect(questionMessages(fake)).toEqual(["Proxy source"]);
    expect(savedConfig(fake)).toBeUndefined();
    expect(fake.stderr()).toBe(
      "privoxy is not installed. Install it with: brew install autossh privoxy\n",
    );
  });

  test("asks the tunnel fields and ports with their defaults, saves, and can skip starting", async () => {
    const fake = withDependencies();
    fake.onPath.set("claude", "/home/test/.local/bin/claude");
    fake.answers.push(
      "built-in",
      "me",
      "box.example",
      USE_DEFAULT,
      USE_DEFAULT,
      USE_DEFAULT,
      USE_DEFAULT,
      false,
    );

    const exitCode = await runCli(["init"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.questions.slice(1)).toEqual([
      { kind: "text", message: "ssh user", initialValue: "" },
      { kind: "text", message: "ssh host", initialValue: "" },
      { kind: "text", message: "ssh port", initialValue: "22" },
      {
        kind: "select",
        message: "ssh key",
        options: [
          { value: "ssh-agent", label: "Keys in ssh-agent" },
          { value: "another-file", label: "Another file" },
        ],
        initialValue: "ssh-agent",
      },
      { kind: "text", message: "SOCKS port", initialValue: "1080" },
      { kind: "text", message: "HTTP port", initialValue: "8118" },
      { kind: "confirm", message: "Start the built-in proxy now?", initialValue: true },
    ]);
    expect(savedConfig(fake)).toEqual({
      version: 1,
      proxy: {
        source: "built-in",
        tunnel: { user: "me", host: "box.example", port: 22 },
        socksPort: 1080,
        httpPort: 8118,
      },
    });
    expect(fake.backgroundStarts).toEqual([]);
    expect(fake.stdout()).toBe(
      `Saved config to ${FAKE_CONFIG_PATH}\n` +
        "claude  found    attached  http\nchrome  missing  detached  socks,http\n",
    );
  });

  test("lists the keys in ~/.ssh with their comments, the first one preselected", async () => {
    const fake = withDependencies();
    fake.files.set("/home/test/.ssh/config", "Host box\n");
    fake.files.set("/home/test/.ssh/known_hosts", "");
    fake.files.set("/home/test/.ssh/id_ed25519_do", "private");
    fake.files.set("/home/test/.ssh/id_ed25519_do.pub", "ssh-ed25519 AAAA me@laptop\n");
    fake.files.set("/home/test/.ssh/id_rsa", "private");
    fake.files.set("/home/test/.ssh/id_rsa.pub", "ssh-rsa AAAA\n");
    fake.files.set("/home/test/.ssh/orphan.pub", "ssh-rsa AAAA\n");
    fake.answers.push(
      "built-in",
      "me",
      "box.example",
      USE_DEFAULT,
      "/home/test/.ssh/id_rsa",
      USE_DEFAULT,
      USE_DEFAULT,
      false,
    );

    await runCli(["init"], fake.system);

    expect(fake.questions[4]).toEqual({
      kind: "select",
      message: "ssh key",
      options: [
        { value: "/home/test/.ssh/id_ed25519_do", label: "id_ed25519_do", hint: "me@laptop" },
        { value: "/home/test/.ssh/id_rsa", label: "id_rsa", hint: undefined },
        { value: "ssh-agent", label: "Keys in ssh-agent" },
        { value: "another-file", label: "Another file" },
      ],
      initialValue: "/home/test/.ssh/id_ed25519_do",
    });
    expect(savedConfig(fake)).toMatchObject({
      proxy: { tunnel: { identityFile: "/home/test/.ssh/id_rsa" } },
    });
  });

  test("preselects the key that ~/.ssh/config names for the host", async () => {
    const fake = withDependencies();
    fake.files.set(
      "/home/test/.ssh/config",
      "Host github.com\n  IdentityFile ~/.ssh/id_github\n\nHost box.*\n  IdentityFile ~/.ssh/id_box\n",
    );
    fake.files.set("/home/test/.ssh/id_box", "private");
    fake.files.set("/home/test/.ssh/id_box.pub", "ssh-ed25519 AAAA me@laptop\n");
    fake.files.set("/home/test/.ssh/id_github", "private");
    fake.files.set("/home/test/.ssh/id_github.pub", "ssh-ed25519 AAAA\n");
    fake.answers.push(
      "built-in",
      "me",
      "box.example",
      USE_DEFAULT,
      USE_DEFAULT,
      USE_DEFAULT,
      USE_DEFAULT,
      false,
    );

    await runCli(["init"], fake.system);

    expect(fake.questions[4]).toMatchObject({
      options: [
        {
          value: "/home/test/.ssh/id_box",
          label: "id_box",
          hint: "me@laptop, named in ~/.ssh/config",
        },
        { value: "/home/test/.ssh/id_github", label: "id_github", hint: undefined },
        { value: "ssh-agent" },
        { value: "another-file" },
      ],
      initialValue: "/home/test/.ssh/id_box",
    });
    expect(savedConfig(fake)).toMatchObject({
      proxy: { tunnel: { identityFile: "/home/test/.ssh/id_box" } },
    });
  });

  test("a configured key without a public half is listed first when the file exists", async () => {
    const fake = withDependencies();
    fake.files.set("/home/test/.ssh/config", "Host box.example\n  IdentityFile ~/keys/box\n");
    fake.files.set("/home/test/keys/box", "private");
    fake.files.set("/home/test/.ssh/id_rsa", "private");
    fake.files.set("/home/test/.ssh/id_rsa.pub", "ssh-rsa AAAA\n");
    fake.answers.push(
      "built-in",
      "me",
      "box.example",
      USE_DEFAULT,
      USE_DEFAULT,
      USE_DEFAULT,
      USE_DEFAULT,
      false,
    );

    await runCli(["init"], fake.system);

    expect(fake.questions[4]).toMatchObject({
      options: [
        { value: "/home/test/keys/box", label: "~/keys/box", hint: "named in ~/.ssh/config" },
        { value: "/home/test/.ssh/id_rsa", label: "id_rsa" },
        { value: "ssh-agent" },
        { value: "another-file" },
      ],
      initialValue: "/home/test/keys/box",
    });
  });

  test("a configured key that does not exist is ignored", async () => {
    const fake = withDependencies();
    fake.files.set("/home/test/.ssh/config", "Host *\n  IdentityFile ~/keys/gone\n");
    fake.answers.push(
      "built-in",
      "me",
      "box.example",
      USE_DEFAULT,
      USE_DEFAULT,
      USE_DEFAULT,
      USE_DEFAULT,
      false,
    );

    await runCli(["init"], fake.system);

    expect(fake.questions[4]).toMatchObject({ initialValue: "ssh-agent" });
    expect(savedConfig(fake)).toMatchObject({
      proxy: { tunnel: { user: "me", host: "box.example", port: 22 } },
    });
  });

  test("saves another identity file and a custom ssh port, expanding a leading tilde", async () => {
    const fake = withDependencies();
    fake.files.set("/home/test/keys/box", "private");
    fake.answers.push(
      "built-in",
      "me",
      "box.example",
      "2222",
      "another-file",
      "~/keys/box",
      "1081",
      "8119",
      false,
    );

    await runCli(["init"], fake.system);

    expect(savedConfig(fake)).toEqual({
      version: 1,
      proxy: {
        source: "built-in",
        tunnel: {
          user: "me",
          host: "box.example",
          port: 2222,
          identityFile: "/home/test/keys/box",
        },
        socksPort: 1081,
        httpPort: 8119,
      },
    });
  });

  test("a missing identity file is reported and asked again", async () => {
    const fake = withDependencies();
    fake.files.set("/home/test/keys/box", "private");
    fake.answers.push(
      "built-in",
      "me",
      "box.example",
      USE_DEFAULT,
      "another-file",
      "~/keys/nope",
      "  ",
      "~/keys/box",
      USE_DEFAULT,
      USE_DEFAULT,
      false,
    );

    const exitCode = await runCli(["init"], fake.system);

    expect(exitCode).toBe(0);
    expect(questionMessages(fake).filter((message) => message === "Identity file")).toHaveLength(2);
    expect(fake.rejectedInputs).toEqual([{ input: "  ", message: "Enter a value" }]);
    expect(fake.stdout()).toMatch(/^No file at \/home\/test\/keys\/nope\n/);
    expect(savedConfig(fake)).toMatchObject({
      proxy: { tunnel: { identityFile: "/home/test/keys/box" } },
    });
  });

  test("validates the tunnel fields and asks again", async () => {
    const fake = withDependencies();
    fake.answers.push(
      "built-in",
      "  ",
      "me",
      "box example",
      "box.example",
      "0",
      "ssh",
      "22",
      USE_DEFAULT,
      USE_DEFAULT,
      "1080",
      "8118",
      false,
    );

    const exitCode = await runCli(["init"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.rejectedInputs).toEqual([
      { input: "  ", message: "Enter a value" },
      { input: "box example", message: "A hostname cannot contain spaces" },
      { input: "0", message: "Port must be between 1 and 65535" },
      { input: "ssh", message: "Port must be between 1 and 65535" },
      { input: "1080", message: "Must differ from the SOCKS port" },
    ]);
    expect(savedConfig(fake)).toMatchObject({ proxy: { socksPort: 1080, httpPort: 8118 } });
  });

  test("a busy port is reported and asked again, and the retried value is saved", async () => {
    const fake = withDependencies();
    fake.busyPorts.add(1080);
    fake.busyPorts.add(8118);
    fake.answers.push(
      "built-in",
      "me",
      "box.example",
      USE_DEFAULT,
      USE_DEFAULT,
      USE_DEFAULT,
      "1081",
      USE_DEFAULT,
      "8119",
      false,
    );

    const exitCode = await runCli(["init"], fake.system);

    expect(exitCode).toBe(0);
    expect(questionMessages(fake).filter((message) => message.endsWith("port"))).toEqual([
      "ssh port",
      "SOCKS port",
      "SOCKS port",
      "HTTP port",
      "HTTP port",
    ]);
    expect(fake.stdout()).toMatch(/^Port 1080 is already in use\nPort 8118 is already in use\n/);
    expect(savedConfig(fake)).toMatchObject({ proxy: { socksPort: 1081, httpPort: 8119 } });
  });

  test("starting now runs the same flow as up and prints its report", async () => {
    const http = await pool.open("live");
    const socks = await pool.open("socks");
    const fake = withDependencies();
    fake.answers.push(
      "built-in",
      "me",
      "box.example",
      USE_DEFAULT,
      USE_DEFAULT,
      String(socks.port),
      String(http.port),
      true,
    );

    const exitCode = await runCli(["init"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.backgroundStarts.map((start) => start.command)).toEqual([AUTOSSH, PRIVOXY]);
    expect(fake.backgroundStarts[0]?.args).toContain(`127.0.0.1:${socks.port}`);
    expect(fake.files.get("/home/test/.local/state/prx/privoxy.conf")).toContain(
      `listen-address 127.0.0.1:${http.port}\n`,
    );
    expect(fake.stdout()).toMatch(
      new RegExp(
        `^Saved config to ${FAKE_CONFIG_PATH}\n` +
          "Built-in proxy started\n" +
          `Endpoint http://127\\.0\\.0\\.1:${http.port} is live \\(\\d+ ms\\)\n` +
          `Endpoint socks5://127\\.0\\.0\\.1:${socks.port} is live \\(\\d+ ms\\)\n` +
          "claude  missing  attached  http\nchrome  missing  detached  socks,http\n$",
      ),
    );
  });

  test("cancelling the start prompt keeps the saved config and starts nothing", async () => {
    const fake = withDependencies();
    fake.answers.push(
      "built-in",
      "me",
      "box.example",
      USE_DEFAULT,
      USE_DEFAULT,
      USE_DEFAULT,
      USE_DEFAULT,
      CANCEL,
    );

    const exitCode = await runCli(["init"], fake.system);

    expect(exitCode).toBe(0);
    expect(savedConfig(fake)).toMatchObject({ proxy: { source: "built-in" } });
    expect(fake.backgroundStarts).toEqual([]);
    expect(fake.stderr()).toBe("");
    expect(fake.stdout()).toMatch(/^Saved config to .*\nclaude  missing/);
  });

  test("cancelling a tunnel question saves nothing", async () => {
    const fake = withDependencies();
    fake.answers.push("built-in", "me", CANCEL);

    const exitCode = await runCli(["init"], fake.system);

    expect(exitCode).toBe(1);
    expect(savedConfig(fake)).toBeUndefined();
    expect(fake.stderr()).toBe("Cancelled, nothing was saved\n");
  });

  test("prx run without a config sets up a built-in proxy, starts it, and launches", async () => {
    const http = await pool.open("live");
    const socks = await pool.open("socks");
    const fake = withDependencies();
    fake.onPath.set("claude", "/home/test/.local/bin/claude");
    fake.answers.push(
      "built-in",
      "me",
      "box.example",
      USE_DEFAULT,
      USE_DEFAULT,
      String(socks.port),
      String(http.port),
      true,
    );

    const exitCode = await runCli(["run", "claude"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.backgroundStarts).toHaveLength(2);
    expect(fake.spawns).toHaveLength(1);
    expect(fake.stderr()).toMatch(/^prx: http endpoint .* is live .*, launching claude\n$/);
  });
});
