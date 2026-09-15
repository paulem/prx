import { isBuiltInProxyRunning, readTunnelFailure, type TunnelFailure } from "../builtin-proxy.ts";
import {
  endpointUrl,
  proxyEndpoints,
  readConfig,
  type BuiltInProxyConfig,
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

export const PROBING_MESSAGE = "Probing endpoints";
const START_HINT = "Run prx up to start it.";
const RESTART_HINT = "Run prx up to restart it.";

/**
 * A stopped proxy's ports refuse connections, which is nothing to report; any other answer
 * means something prx does not track is listening there
 */
function unexpectedWhenStopped(reports: EndpointReport[]): EndpointReport[] {
  return reports.filter(({ result }) => result.live || result.reason !== "refused");
}

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
  const tunnelFailure = await explainNotLive(system, proxy, running, reports);
  const stalled = running && !allLive(reports);
  const report: BuiltInReport = {
    headline,
    running,
    reports,
    tunnelFailure,
    hint: stalled ? (tunnelFailure?.hint ?? RESTART_HINT) : undefined,
  };
  reporter.result(builtInView(system, report), {
    source: "built-in",
    running,
    ...builtInReportJson(report),
  });
  return allLive(reports) ? 0 : 1;
}

/** What status and up have to say about a built-in proxy */
export interface BuiltInReport {
  headline: string;
  running: boolean;
  reports: EndpointReport[];
  /** Why the tunnel is failing, when the proxy runs but an endpoint is not live */
  tunnelFailure: TunnelFailure | undefined;
  /** What to do about a stalled proxy, shown apart under the report */
  hint: string | undefined;
}

/** The autossh log only explains a proxy that runs while an endpoint is not live */
export function explainNotLive(
  system: SystemAdapter,
  proxy: BuiltInProxyConfig,
  running: boolean,
  reports: EndpointReport[],
): Promise<TunnelFailure | undefined> {
  if (!running || allLive(reports)) {
    return Promise.resolve(undefined);
  }
  return readTunnelFailure(system, proxy);
}

/** The endpoints and, when there is one, the tunnel failure, for JSON output */
export function builtInReportJson(report: BuiltInReport): Record<string, unknown> {
  const { tunnelFailure } = report;
  if (tunnelFailure === undefined) {
    return { endpoints: endpointReportsJson(report.reports) };
  }
  const hint = tunnelFailure.hint === undefined ? {} : { hint: tunnelFailure.hint };
  return {
    endpoints: endpointReportsJson(report.reports),
    tunnelFailure: { message: tunnelFailure.message, ...hint },
  };
}

/** Both renderings of a built-in proxy report */
export function builtInView(system: SystemAdapter, report: BuiltInReport): View {
  return {
    plain: formatBuiltInReport(system, report),
    decorated: renderBlock(builtInBlock(system, report)),
  };
}

/**
 * The running line, one line per endpoint, then the tunnel failure, where to look and what
 * to do when running but not live
 */
export function formatBuiltInReport(system: SystemAdapter, report: BuiltInReport): string {
  const { headline, running, reports, tunnelFailure, hint } = report;
  if (!running) {
    const unexpected = unexpectedWhenStopped(reports).map(formatEndpointReport);
    return `${[headline, ...unexpected, START_HINT].join("\n")}\n`;
  }
  const lines = [headline, ...reports.map(formatEndpointReport)];
  if (!allLive(reports)) {
    if (tunnelFailure !== undefined) {
      lines.push(`Tunnel: ${tunnelFailure.message}`);
    }
    lines.push(`Logs are in ${system.stateDir()}`);
    if (hint !== undefined) {
      lines.push(hint);
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The headline in the color of the proxy's state, then an aligned endpoint table, then the
 * tunnel failure and the log directory when the proxy runs but an endpoint is not live, or
 * the way to start it; a hint, when there is one, stands apart under the table
 */
export function builtInBlock(system: SystemAdapter, report: BuiltInReport): Block {
  const { headline, running, reports, tunnelFailure, hint } = report;
  if (!running) {
    return {
      mark: symbol("muted"),
      lines: [headline, ...table(endpointRows(unexpectedWhenStopped(reports))), dim(START_HINT)],
    };
  }
  const rows = endpointRows(reports);
  if (allLive(reports)) {
    return { mark: symbol("success"), lines: [headline, ...table(rows)] };
  }
  if (tunnelFailure !== undefined) {
    rows.push([
      { text: "tunnel", style: dim },
      { text: tunnelFailure.message, style: red, span: true },
    ]);
  }
  rows.push([
    { text: "logs", style: dim },
    { text: pathLink(system.homeDir(), system.stateDir()), style: dim, span: true },
  ]);
  const advice = hint === undefined ? [] : [dim(hint)];
  return { mark: symbol("warn"), lines: [headline, ...table(rows), ...advice] };
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
    return `Endpoint ${url} is live (${result.latencyMs} ms)`;
  }
  return `Endpoint ${url} is not live: ${result.message}`;
}

export function formatEndpointReports(reports: EndpointReport[]): string {
  return reports.map((report) => `${formatEndpointReport(report)}\n`).join("");
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
