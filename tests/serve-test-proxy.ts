import { startTestProxy, type TestProxyMode } from "./test-proxy.ts";

// Runs one test proxy as its own process until SIGTERM, standing in for autossh or privoxy
// when the built bundle is exercised: node tests/serve-test-proxy.ts <mode> <port>

const [mode, port] = process.argv.slice(2);
if (mode === undefined || port === undefined) {
  process.stderr.write("usage: serve-test-proxy.ts <mode> <port>\n");
  process.exit(2);
}

const proxy = await startTestProxy(mode as TestProxyMode, Number(port));
process.stdout.write(`serving ${mode} on ${proxy.port}\n`);
process.on("SIGTERM", async () => {
  await proxy.close();
  process.exit(0);
});
