import { isBuiltInProxyRunning, startBuiltInProxy } from "../builtin-proxy.ts";
import {
  proxyEndpoints,
  readConfig,
  type BuiltInProxyConfig,
  type Config,
  type Endpoint,
  type EndpointType,
} from "../config.ts";
import { PrxError } from "../errors.ts";
import type { Reporter, View } from "../output.ts";
import { DEFAULT_PROBE_URL, probeUntilLive, type ProbeResult } from "../probe.ts";
import type { SystemAdapter } from "../system.ts";
import type { Block } from "../style.ts";
import {
  allLive,
  builtInBlock,
  builtInView,
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

export const STARTING_MESSAGE = "Starting the built-in proxy";

export async function runUp(command: UpCommand): Promise<number> {
  const { system, reporter } = command;
  const config = await readConfig(system);
  const proxy = requireBuiltIn(config, "start");
  const report = await bringUp(command, proxy);
  reporter.result(upView(system, report), {
    source: "built-in",
    running: true,
    started: report.started,
    endpoints: endpointReportsJson(report.reports),
  });
  return allLive(report.reports) ? 0 : 1;
}

/** Starts the proxy unless it is running, then waits for both endpoints up to the start timeout */
export async function bringUp(
  { system, reporter, probeTimeoutMs, startTimeoutMs }: UpCommand,
  proxy: BuiltInProxyConfig,
): Promise<UpReport> {
  const started = !(await isBuiltInProxyRunning(system));
  if (started) {
    await reporter.wait(STARTING_MESSAGE, () => startBuiltInProxy(system, proxy));
  }
  const narration = narrateWait(startTimeoutMs, describePending, proxyEndpoints(proxy));
  const reports = await reporter.wait(narration.current(), (progress) =>
    probeEndpointsWith(proxy, (endpoint) =>
      probeUntilLive(endpoint, {
        url: DEFAULT_PROBE_URL,
        timeoutMs: probeTimeoutMs,
        waitMs: startTimeoutMs,
        onAttempt(result) {
          narration.record(endpoint, result);
          progress(narration.current());
        },
      }),
    ),
  );
  return { started, reports };
}

export function upView(system: SystemAdapter, report: UpReport): View {
  return builtInView(system, upHeadline(report), true, report.reports);
}

export function upBlock(system: SystemAdapter, report: UpReport): Block {
  return builtInBlock(system, upHeadline(report), true, report.reports);
}

export function formatUpReport(system: SystemAdapter, report: UpReport): string {
  return formatBuiltInReport(system, upHeadline(report), true, report.reports);
}

function upHeadline(report: UpReport): string {
  return report.started ? "Built-in proxy started" : "Built-in proxy is already running";
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

/** Words for a spinner while endpoints come up: what is still pending, for how long, and why */
export interface WaitNarration {
  current: () => string;
  record: (endpoint: Endpoint, result: ProbeResult) => void;
}

export function narrateWait(
  waitMs: number,
  describe: (pending: EndpointType[]) => string,
  endpoints: Endpoint[],
): WaitNarration {
  const startedAt = performance.now();
  const pending = new Set(endpoints.map((endpoint) => endpoint.type));
  let lastFailure: string | undefined;
  return {
    record(endpoint, result) {
      if (result.live) {
        pending.delete(endpoint.type);
      } else {
        lastFailure = result.message;
      }
    },
    current() {
      const elapsed = Math.round((performance.now() - startedAt) / 1000);
      const total = Math.round(waitMs / 1000);
      const attempt = lastFailure === undefined ? "" : `, last attempt: ${lastFailure}`;
      return `Waiting for ${describe([...pending])}, ${elapsed} s of ${total} s${attempt}`;
    },
  };
}

function describePending(pending: EndpointType[]): string {
  if (pending.length === 1) {
    return `the ${pending[0]} endpoint`;
  }
  return `the ${pending.join(" and ")} endpoints`;
}
