import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import {
  CANCEL,
  createFakeSystem,
  FAKE_CONFIG_PATH,
  USE_DEFAULT,
  writeFakeConfig,
  type FakeSystem,
} from "./fake-system.ts";
import { startTestProxy, trustProbeTarget, type TestProxy } from "./test-proxy.ts";

beforeAll(() => {
  trustProbeTarget();
});

let proxy: TestProxy | undefined;
afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
});

function savedConfig(fake: FakeSystem): unknown {
  const text = fake.files.get(FAKE_CONFIG_PATH);
  return text === undefined ? undefined : JSON.parse(text);
}

describe("prx init", () => {
  test("walks through type and address, probes, saves and lists the presets", async () => {
    proxy = await startTestProxy("live");
    const fake = createFakeSystem();
    fake.onPath.set("claude", "/home/test/.local/bin/claude");
    fake.answers.push("http", `127.0.0.1:${proxy.port}`);

    const exitCode = await runCli(["init"], fake.system);

    expect(exitCode).toBe(0);
    expect(savedConfig(fake)).toEqual({
      version: 1,
      proxy: { type: "http", host: "127.0.0.1", port: proxy.port },
    });
    expect(fake.questions.map((question) => question.message)).toEqual([
      "Proxy type",
      "Proxy address (host:port or http://host:port)",
    ]);
    expect(fake.stdout()).toMatch(
      new RegExp(
        `^Proxy http://127\\.0\\.0\\.1:${proxy.port} is live \\(\\d+ ms\\)\n` +
          `Saved config to ${FAKE_CONFIG_PATH}\n` +
          "claude  found    attached\nchrome  missing  detached\n$",
      ),
    );
    expect(fake.stderr()).toBe("");
  });

  test("offers only the HTTP proxy type", async () => {
    const fake = createFakeSystem();
    fake.answers.push(CANCEL);

    await runCli(["init"], fake.system);

    expect(fake.questions[0]).toEqual({
      kind: "select",
      message: "Proxy type",
      options: [{ value: "http", label: "HTTP proxy, no auth" }],
    });
  });

  test("accepts the http://host:port form", async () => {
    proxy = await startTestProxy("live");
    const fake = createFakeSystem();
    fake.answers.push("http", `http://localhost:${proxy.port}`);

    await runCli(["init"], fake.system);

    expect(savedConfig(fake)).toEqual({
      version: 1,
      proxy: { type: "http", host: "localhost", port: proxy.port },
    });
  });

  test("defaults the address to 127.0.0.1:8118", async () => {
    const fake = createFakeSystem();
    fake.answers.push("http", USE_DEFAULT, true);

    await runCli(["init"], fake.system, { probeTimeoutMs: 300 });

    expect(fake.questions[1]).toMatchObject({ kind: "text", initialValue: "127.0.0.1:8118" });
    expect(savedConfig(fake)).toEqual({
      version: 1,
      proxy: { type: "http", host: "127.0.0.1", port: 8118 },
    });
  });

  test("rejects a bad address with a clear message and asks again", async () => {
    proxy = await startTestProxy("live");
    const fake = createFakeSystem();
    fake.answers.push("http", "not an address", "127.0.0.1:99999", `127.0.0.1:${proxy.port}`);

    const exitCode = await runCli(["init"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.rejectedInputs).toEqual([
      { input: "not an address", message: "Enter host:port or http://host:port" },
      { input: "127.0.0.1:99999", message: "Port must be between 1 and 65535" },
    ]);
    expect(savedConfig(fake)).toMatchObject({ proxy: { port: proxy.port } });
  });

  test("asks whether to save anyway when the probe fails, and saves on yes", async () => {
    const closed = await startTestProxy("live");
    await closed.close();
    const fake = createFakeSystem();
    fake.answers.push("http", `127.0.0.1:${closed.port}`, true);

    const exitCode = await runCli(["init"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.stdout()).toContain(
      `Proxy http://127.0.0.1:${closed.port} is not live: connection refused (ECONNREFUSED)\n`,
    );
    expect(fake.questions[2]).toMatchObject({
      kind: "confirm",
      message: "Save the config anyway?",
    });
    expect(savedConfig(fake)).toMatchObject({ proxy: { port: closed.port } });
  });

  test("declining to save anyway exits without writing", async () => {
    const closed = await startTestProxy("live");
    await closed.close();
    const fake = createFakeSystem();
    fake.answers.push("http", `127.0.0.1:${closed.port}`, false);

    const exitCode = await runCli(["init"], fake.system);

    expect(exitCode).toBe(1);
    expect(savedConfig(fake)).toBeUndefined();
    expect(fake.stderr()).toBe("Cancelled, nothing was saved\n");
  });

  test("cancelling a prompt exits without writing", async () => {
    const fake = createFakeSystem();
    fake.answers.push("http", CANCEL);

    const exitCode = await runCli(["init"], fake.system);

    expect(exitCode).toBe(1);
    expect(savedConfig(fake)).toBeUndefined();
    expect(fake.stderr()).toBe("Cancelled, nothing was saved\n");
  });

  test("re-running replaces the existing config", async () => {
    proxy = await startTestProxy("live");
    const fake = createFakeSystem();
    writeFakeConfig(fake, { host: "10.0.0.1", port: 3128 });
    fake.answers.push("http", `127.0.0.1:${proxy.port}`);

    await runCli(["init"], fake.system);

    expect(savedConfig(fake)).toMatchObject({ proxy: { host: "127.0.0.1", port: proxy.port } });
  });
});

describe("prx run on a first run", () => {
  test("starts the wizard when there is no config, then launches", async () => {
    proxy = await startTestProxy("live");
    const fake = createFakeSystem();
    fake.onPath.set("claude", "/home/test/.local/bin/claude");
    fake.answers.push("http", `127.0.0.1:${proxy.port}`);

    const exitCode = await runCli(["run", "claude", "--resume"], fake.system);

    expect(exitCode).toBe(0);
    expect(savedConfig(fake)).toMatchObject({ proxy: { port: proxy.port } });
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
