import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  buildBundle,
  isolatedHomeEnv,
  runNode,
  type BuiltBundle,
  type ProcessResult,
} from "./built-bundle.ts";
import { probeTargetCertPath, startTestProxy, type TestProxy } from "./test-proxy.ts";

// Prints every proxy variable it was handed, then its arguments, then exits as told
const FAKE_CLAUDE = `#!/bin/sh
echo "HTTP_PROXY=$HTTP_PROXY"
echo "HTTPS_PROXY=$HTTPS_PROXY"
echo "http_proxy=$http_proxy"
echo "https_proxy=$https_proxy"
echo "NO_PROXY=$NO_PROXY"
echo "no_proxy=$no_proxy"
for arg in "$@"; do
  echo "arg=$arg"
done
exit "\${FAKE_CLAUDE_EXIT_CODE:-0}"
`;

interface InstalledHome {
  home: string;
  binDir: string;
}

async function installedHome(proxy: TestProxy): Promise<InstalledHome> {
  const home = await mkdtemp(join(tmpdir(), "prx-home-"));
  const binDir = join(home, "bin");
  await mkdir(binDir, { recursive: true });
  const fakeClaude = join(binDir, "claude");
  await writeFile(fakeClaude, FAKE_CLAUDE);
  await chmod(fakeClaude, 0o755);

  await mkdir(join(home, ".config", "prx"), { recursive: true });
  await writeFile(
    join(home, ".config", "prx", "config.json"),
    JSON.stringify({
      version: 1,
      proxy: { source: "external", endpoints: { http: { host: proxy.host, port: proxy.port } } },
    }),
  );
  return { home, binDir };
}

describe("prx run claude through the built bundle", () => {
  let bundle: BuiltBundle;
  let proxy: TestProxy;
  let installed: InstalledHome;

  beforeAll(async () => {
    [bundle, proxy] = await Promise.all([buildBundle(), startTestProxy("live")]);
    installed = await installedHome(proxy);
  });

  afterAll(async () => {
    await proxy.close();
  });

  function runPrx(args: string[], exitCode = 0): Promise<ProcessResult> {
    return runNode(
      [bundle.path, ...args],
      isolatedHomeEnv(installed.home, {
        PATH: [installed.binDir, process.env.PATH].join(delimiter),
        NODE_EXTRA_CA_CERTS: probeTargetCertPath,
        FAKE_CLAUDE_EXIT_CODE: String(exitCode),
      }),
    );
  }

  test("the app sees the proxy in its environment and prx reports the probe on stderr", async () => {
    const result = await runPrx(["run", "claude"]);

    const proxyAddress = `http://127.0.0.1:${proxy.port}`;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      `HTTP_PROXY=${proxyAddress}\n` +
        `HTTPS_PROXY=${proxyAddress}\n` +
        `http_proxy=${proxyAddress}\n` +
        `https_proxy=${proxyAddress}\n` +
        "NO_PROXY=localhost,127.0.0.1,::1\n" +
        "no_proxy=localhost,127.0.0.1,::1\n",
    );
    expect(result.stderr).toMatch(
      /^prx: http endpoint http:\/\/127\.0\.0\.1:\d+ is live \(\d+ ms\), launching claude\n$/,
    );
  });

  test("passthrough arguments reach the app verbatim", async () => {
    const result = await runPrx(["run", "claude", "--resume", "-p", "hello world"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("arg=--resume\narg=-p\narg=hello world\n");
  });

  test("the app's exit code is forwarded", async () => {
    const result = await runPrx(["run", "claude"], 7);

    expect(result.exitCode).toBe(7);
  });
});
