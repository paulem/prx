import { isBuiltInProxyRunning, startBuiltInProxy } from "../builtin-proxy.ts";
import { readConfig, type BuiltInProxyConfig, type Config } from "../config.ts";
import { PrxError } from "../errors.ts";
import type { Reporter } from "../output.ts";
import { DEFAULT_PROBE_URL, probeUntilLive } from "../probe.ts";
import type { SystemAdapter } from "../system.ts";
import {
  allLive,
  endpointReportsJson,
  formatBuiltInReport,
  probeEndpointsWith,
  type EndpointReport,
} from "./status.ts";

export interface UpCommand {
  system: SystemAdapter;
  reporter: Reporter;
  probeTimeoutMs: number;
  startTimeoutMs: number;
}

export interface UpReport {
  started: boolean;
  reports: EndpointReport[];
}

export async function runUp({
  system,
  reporter,
  probeTimeoutMs,
  startTimeoutMs,
}: UpCommand): Promise<number> {
  const config = await readConfig(system);
  const proxy = requireBuiltIn(config, "start");
  const report = await bringUp(system, proxy, probeTimeoutMs, startTimeoutMs);
  reporter.result(formatUpReport(system, report), {
    source: "built-in",
    running: true,
    started: report.started,
    endpoints: endpointReportsJson(report.reports),
  });
  return allLive(report.reports) ? 0 : 1;
}

/** Starts the proxy unless it is running, then waits for both endpoints up to the start timeout */
export async function bringUp(
  system: SystemAdapter,
  proxy: BuiltInProxyConfig,
  probeTimeoutMs: number,
  startTimeoutMs: number,
): Promise<UpReport> {
  const started = !(await isBuiltInProxyRunning(system));
  if (started) {
    await startBuiltInProxy(system, proxy);
  }
  const reports = await probeEndpointsWith(proxy, (endpoint) =>
    probeUntilLive(endpoint, {
      url: DEFAULT_PROBE_URL,
      timeoutMs: probeTimeoutMs,
      waitMs: startTimeoutMs,
    }),
  );
  return { started, reports };
}

export function formatUpReport(system: SystemAdapter, report: UpReport): string {
  const headline = report.started ? "Built-in proxy started" : "Built-in proxy is already running";
  return formatBuiltInReport(system, headline, true, report.reports);
}

export function requireBuiltIn(config: Config, action: "start" | "stop"): BuiltInProxyConfig {
  if (config.proxy.source !== "built-in") {
    throw new PrxError(
      "not_builtin",
      `The proxy is external, so there is nothing for prx to ${action}.`,
    );
  }
  return config.proxy;
}
