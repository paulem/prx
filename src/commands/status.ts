import { isBuiltInProxyRunning } from "../builtin-proxy.ts";
import {
  endpointUrl,
  proxyEndpoints,
  readConfig,
  type Endpoint,
  type ProxyConfig,
} from "../config.ts";
import type { Reporter, View } from "../output.ts";
import { DEFAULT_PROBE_URL, probe, type ProbeResult } from "../probe.ts";
import {
  bold,
  dim,
  green,
  pathLink,
  red,
  renderBlock,
  symbol,
  table,
  type Block,
  type Cell,
  type Tone,
} from "../style.ts";
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

const PROBING_MESSAGE = "Probing endpoints";

export async function runStatus({
  system,
  reporter,
  probeTimeoutMs,
}: StatusCommand): Promise<number> {
  const config = await readConfig(system);
  const { proxy } = config;
  if (proxy.source === "external") {
    const reports = await reporter.wait(PROBING_MESSAGE, () =>
      probeEndpoints(proxy, probeTimeoutMs),
    );
    reporter.result(
      { plain: formatEndpointReports(reports), decorated: renderBlock(externalBlock(reports)) },
      { source: "external", endpoints: endpointReportsJson(reports) },
    );
    return allLive(reports) ? 0 : 1;
  }

  const [running, reports] = await reporter.wait(PROBING_MESSAGE, () =>
    Promise.all([isBuiltInProxyRunning(system), probeEndpoints(proxy, probeTimeoutMs)]),
  );
  const headline = running ? "Built-in proxy is running" : "Built-in proxy is not running";
  reporter.result(builtInView(system, headline, running, reports), {
    source: "built-in",
    running,
    endpoints: endpointReportsJson(reports),
  });
  return allLive(reports) ? 0 : 1;
}

/** Both renderings of a built-in proxy report under the given headline */
export function builtInView(
  system: SystemAdapter,
  headline: string,
  running: boolean,
  reports: EndpointReport[],
): View {
  return {
    plain: formatBuiltInReport(system, headline, running, reports),
    decorated: renderBlock(builtInBlock(system, headline, running, reports)),
  };
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

/**
 * The headline in the color of the proxy's state, then an aligned endpoint table, then the
 * log directory when the proxy runs but an endpoint is not live, or the way to start it
 */
export function builtInBlock(
  system: SystemAdapter,
  headline: string,
  running: boolean,
  reports: EndpointReport[],
): Block {
  const rows = endpointRows(reports);
  if (!running) {
    return {
      mark: symbol("muted"),
      lines: [headline, ...table(rows), dim("Run prx up to start it.")],
    };
  }
  if (allLive(reports)) {
    return { mark: symbol("success"), lines: [headline, ...table(rows)] };
  }
  rows.push([
    { text: "logs", style: dim },
    { text: pathLink(system.homeDir(), system.stateDir()), style: dim, span: true },
  ]);
  return { mark: symbol("warn"), lines: [headline, ...table(rows)] };
}

function externalBlock(reports: EndpointReport[]): Block {
  const tone: Tone = allLive(reports) ? "success" : "warn";
  return { mark: symbol(tone), lines: ["External proxy", ...table(endpointRows(reports))] };
}

/** One table row per endpoint: type, address, live or not, then the latency or the reason */
export function endpointRows(reports: EndpointReport[]): Cell[][] {
  return reports.map(({ endpoint, result }) => {
    const lead: Cell[] = [
      { text: endpoint.type, style: bold },
      { text: `${endpoint.host}:${endpoint.port}` },
    ];
    if (result.live) {
      return [
        ...lead,
        { text: "live", style: green },
        { text: `${result.latencyMs} ms`, style: dim },
      ];
    }
    return [...lead, { text: "not live", style: red }, { text: result.message, style: red }];
  });
}

/** Probes every endpoint of the proxy at once, with one probe attempt each */
export function probeEndpoints(
  proxy: ProxyConfig,
  probeTimeoutMs: number,
): Promise<EndpointReport[]> {
  return probeEndpointsWith(proxy, (endpoint) =>
    probe(endpoint, { url: DEFAULT_PROBE_URL, timeoutMs: probeTimeoutMs }),
  );
}

/** Runs the given probe against every endpoint of the proxy at once */
export function probeEndpointsWith(
  proxy: ProxyConfig,
  probeEndpoint: (endpoint: Endpoint) => Promise<ProbeResult>,
): Promise<EndpointReport[]> {
  return Promise.all(
    proxyEndpoints(proxy).map(async (endpoint) => ({
      endpoint,
      result: await probeEndpoint(endpoint),
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
