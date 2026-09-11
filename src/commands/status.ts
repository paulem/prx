import { isBuiltInProxyRunning } from "../builtin-proxy.ts";
import {
  endpointUrl,
  proxyEndpoints,
  readConfig,
  type Endpoint,
  type ProxyConfig,
} from "../config.ts";
import type { Reporter } from "../output.ts";
import { DEFAULT_PROBE_URL, probe, type ProbeResult } from "../probe.ts";
import type { SystemAdapter } from "../system.ts";

export interface StatusCommand {
  system: SystemAdapter;
  reporter: Reporter;
  probeTimeoutMs: number;
}

export interface EndpointReport {
  endpoint: Endpoint;
  result: ProbeResult;
}

export async function runStatus({
  system,
  reporter,
  probeTimeoutMs,
}: StatusCommand): Promise<number> {
  const config = await readConfig(system);
  const { proxy } = config;
  if (proxy.source === "external") {
    const reports = await probeEndpoints(proxy, probeTimeoutMs);
    reporter.result(formatEndpointReports(reports), {
      source: "external",
      endpoints: endpointReportsJson(reports),
    });
    return allLive(reports) ? 0 : 1;
  }

  const [running, reports] = await Promise.all([
    isBuiltInProxyRunning(system),
    probeEndpoints(proxy, probeTimeoutMs),
  ]);
  const headline = running ? "Built-in proxy is running" : "Built-in proxy is not running";
  reporter.result(formatBuiltInReport(system, headline, running, reports), {
    source: "built-in",
    running,
    endpoints: endpointReportsJson(reports),
  });
  return allLive(reports) ? 0 : 1;
}

/** The running line, one line per endpoint, and where to look when running but not live */
export function formatBuiltInReport(
  system: SystemAdapter,
  headline: string,
  running: boolean,
  reports: EndpointReport[],
): string {
  const logHint = running && !allLive(reports) ? `Logs are in ${system.stateDir()}\n` : "";
  return `${headline}\n${formatEndpointReports(reports)}${logHint}`;
}

/** Probes every endpoint of the proxy at once with the default probe URL */
export function probeEndpoints(
  proxy: ProxyConfig,
  probeTimeoutMs: number,
  probeEndpoint: typeof probe = probe,
): Promise<EndpointReport[]> {
  return Promise.all(
    proxyEndpoints(proxy).map(async (endpoint) => ({
      endpoint,
      result: await probeEndpoint(endpoint, { url: DEFAULT_PROBE_URL, timeoutMs: probeTimeoutMs }),
    })),
  );
}

export function allLive(reports: EndpointReport[]): boolean {
  return reports.every((report) => report.result.live);
}

export function formatEndpointReport({ endpoint, result }: EndpointReport): string {
  const url = endpointUrl(endpoint);
  if (result.live) {
    return `Endpoint ${url} is live (${result.latencyMs} ms)\n`;
  }
  return `Endpoint ${url} is not live: ${result.message}\n`;
}

export function formatEndpointReports(reports: EndpointReport[]): string {
  return reports.map(formatEndpointReport).join("");
}

/** The per-endpoint results keyed by endpoint type, for JSON output */
export function endpointReportsJson(reports: EndpointReport[]): Record<string, unknown> {
  return Object.fromEntries(
    reports.map(({ endpoint, result }) => [
      endpoint.type,
      { host: endpoint.host, port: endpoint.port, ...result },
    ]),
  );
}
