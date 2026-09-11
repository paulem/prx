import { describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import {
  createFakeSystem,
  externalProxy,
  FAKE_CONFIG_PATH,
  writeFakeConfig,
} from "./fake-system.ts";

const HTTP_ONLY = externalProxy({ http: { host: "127.0.0.1", port: 8118 } });

describe("prx config", () => {
  test("prints the config path and its contents", async () => {
    const fake = createFakeSystem();
    writeFakeConfig(fake, HTTP_ONLY);

    const exitCode = await runCli(["config"], fake.system);

    expect(exitCode).toBe(0);
    expect(fake.stdout()).toBe(
      [
        FAKE_CONFIG_PATH,
        "{",
        '  "version": 1,',
        '  "proxy": {',
        '    "source": "external",',
        '    "endpoints": {',
        '      "http": {',
        '        "host": "127.0.0.1",',
        '        "port": 8118',
        "      }",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  test("--json prints path and contents as one object", async () => {
    const fake = createFakeSystem();
    writeFakeConfig(fake, HTTP_ONLY);

    const exitCode = await runCli(["config", "--json"], fake.system);

    expect(exitCode).toBe(0);
    expect(JSON.parse(fake.stdout())).toEqual({
      path: FAKE_CONFIG_PATH,
      config: { version: 1, proxy: HTTP_ONLY },
    });
  });

  test("missing config is an error naming the path", async () => {
    const fake = createFakeSystem();

    const exitCode = await runCli(["config"], fake.system);

    expect(exitCode).toBe(2);
    expect(fake.stderr()).toBe(
      `No config found at ${FAKE_CONFIG_PATH}. Run prx init to create one.\n`,
    );
  });
});

/** Runs prx config against a proxy object and returns the validation problem it reports */
async function problemFor(proxy: unknown): Promise<string> {
  const fake = createFakeSystem();
  fake.files.set(FAKE_CONFIG_PATH, JSON.stringify({ version: 1, proxy }));
  const exitCode = await runCli(["config"], fake.system);
  expect(exitCode).toBe(2);
  return fake.stderr().replace(`Config at ${FAKE_CONFIG_PATH} is invalid: `, "");
}

describe("prx config validation", () => {
  test("reads an external proxy with both endpoints", async () => {
    const fake = createFakeSystem();
    const proxy = externalProxy({
      http: { host: "127.0.0.1", port: 8118 },
      socks: { host: "127.0.0.1", port: 1080 },
    });
    writeFakeConfig(fake, proxy);

    const exitCode = await runCli(["config", "--json"], fake.system);

    expect(exitCode).toBe(0);
    expect(JSON.parse(fake.stdout()).config.proxy).toEqual(proxy);
  });

  test("reads a built-in proxy", async () => {
    const fake = createFakeSystem();
    const proxy = {
      source: "built-in",
      tunnel: { user: "me", host: "box.example", port: 22, identityFile: "/home/test/.ssh/id" },
      socksPort: 1080,
      httpPort: 8118,
    } as const;
    writeFakeConfig(fake, proxy);

    const exitCode = await runCli(["config", "--json"], fake.system);

    expect(exitCode).toBe(0);
    expect(JSON.parse(fake.stdout()).config.proxy).toEqual(proxy);
  });

  test("the old single-address shape is rejected with a pointer to prx init", async () => {
    expect(await problemFor({ type: "http", host: "127.0.0.1", port: 8118 })).toBe(
      'proxy.source must be "external" or "built-in". Run prx init to write the current shape.\n',
    );
  });

  test("an external proxy needs at least one endpoint", async () => {
    expect(await problemFor({ source: "external", endpoints: {} })).toBe(
      "proxy.endpoints must have at least one of http or socks\n",
    );
  });

  test("an endpoint needs a host and a port in range", async () => {
    expect(
      await problemFor({ source: "external", endpoints: { socks: { host: "", port: 1080 } } }),
    ).toBe("proxy.endpoints.socks.host must be a non-empty string\n");
    expect(
      await problemFor({ source: "external", endpoints: { http: { host: "h", port: 70000 } } }),
    ).toBe("proxy.endpoints.http.port must be an integer between 1 and 65535\n");
  });

  test("a built-in proxy needs a complete tunnel and distinct ports", async () => {
    const tunnel = { user: "me", host: "box.example", port: 22 };
    expect(await problemFor({ source: "built-in", socksPort: 1, httpPort: 2 })).toBe(
      "proxy.tunnel must be an object\n",
    );
    expect(
      await problemFor({
        source: "built-in",
        tunnel: { ...tunnel, user: "" },
        socksPort: 1,
        httpPort: 2,
      }),
    ).toBe("proxy.tunnel.user must be a non-empty string\n");
    expect(
      await problemFor({
        source: "built-in",
        tunnel: { ...tunnel, port: 0 },
        socksPort: 1,
        httpPort: 2,
      }),
    ).toBe("proxy.tunnel.port must be an integer between 1 and 65535\n");
    expect(await problemFor({ source: "built-in", tunnel, socksPort: 8118, httpPort: 8118 })).toBe(
      "proxy.socksPort and proxy.httpPort must differ\n",
    );
  });

  test("malformed JSON config is invalid, not a crash", async () => {
    const fake = createFakeSystem();
    fake.files.set(FAKE_CONFIG_PATH, "{not json");

    const exitCode = await runCli(["config"], fake.system);

    expect(exitCode).toBe(2);
    expect(fake.stderr()).toMatch(/is invalid: not valid JSON/);
  });
});
