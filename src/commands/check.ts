import { proxyUrl, readConfig } from "../config.ts";
import type { Reporter } from "../output.ts";
import { DEFAULT_PROBE_URL, probe } from "../probe.ts";
import type { SystemAdapter } from "../system.ts";

export interface CheckCommand {
  system: SystemAdapter;
  reporter: Reporter;
  probeTimeoutMs: number;
}

export async function runCheck({
  system,
  reporter,
  probeTimeoutMs,
}: CheckCommand): Promise<number> {
  const config = await readConfig(system);
  const proxy = config.proxy;
  const result = await probe(proxy, { url: DEFAULT_PROBE_URL, timeoutMs: probeTimeoutMs });

  if (result.live) {
    reporter.result(`Proxy ${proxyUrl(proxy)} is live (${result.latencyMs} ms)\n`, {
      live: true,
      latencyMs: result.latencyMs,
      proxy,
    });
    return 0;
  }

  reporter.result(`Proxy ${proxyUrl(proxy)} is not live: ${result.message}\n`, {
    live: false,
    reason: result.reason,
    message: result.message,
    proxy,
  });
  return 1;
}
