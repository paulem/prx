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

function savedConfig(fake: FakeSystem): unknown {
  const text = fake.files.get(FAKE_CONFIG_PATH);
  return text === undefined ? undefined : JSON.parse(text);
}

function questionMessages(fake: FakeSystem): string[] {
  return fake.questions.map((question) => question.message);
}

describe("prx init with an external proxy", () => {
  test("records an HTTP endpoint, probes it, saves and lists the presets", async () => {
    const http = await testProxy("live");
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
          "claude  found    attached\nchrome  missing  detached\n$",
      ),
    );
    expect(fake.stderr()).toBe("");
  });

  test("offers the external source and defaults to recording only an HTTP endpoint", async () => {
    const fake = createFakeSystem();
    fake.answers.push("external", CANCEL);

    await runCli(["init"], fake.system);

    expect(fake.questions[0]).toEqual({
      kind: "select",
      message: "Proxy source",
      options: [{ value: "external", label: "External proxy, something else runs it" }],
    });
    expect(fake.questions[1]).toEqual({
      kind: "confirm",
      message: "Record an HTTP endpoint?",
      initialValue: true,
    });
  });

  test("records both endpoints and probes each one", async () => {
    const http = await testProxy("live");
    const socks = await testProxy("socks");
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
    const socks = await testProxy("socks");
    const fake = createFakeSystem();
    fake.answers.push("external", false, true, `socks5://127.0.0.1:${socks.port}`);

    const exitCode = await runCli(["init"], fake.system);

    expect(exitCode).toBe(0);
    expect(savedConfig(fake)).toEqual({ version: 1, proxy: externalProxy({ socks }) });
  });

  test("refuses to save no endpoint and asks again", async () => {
    const http = await testProxy("live");
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
    const http = await testProxy("live");
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
    const http = await testProxy("live");
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
    const http = await testProxy("live");
    const socks = await closedPort();
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
    const http = await closedPort();
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
    const http = await testProxy("live");
    const fake = createFakeSystem();
    writeFakeConfig(fake, externalProxy({ http: { host: "10.0.0.1", port: 3128 } }));
    fake.answers.push("external", true, `127.0.0.1:${http.port}`, false);

    await runCli(["init"], fake.system);

    expect(savedConfig(fake)).toEqual({ version: 1, proxy: externalProxy({ http }) });
  });
});

describe("prx run on a first run", () => {
  test("starts the wizard when there is no config, then launches", async () => {
    const http = await testProxy("live");
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
