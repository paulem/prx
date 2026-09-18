import {
  isBuiltInProxyRunning,
  restartBuiltInProxy,
  startBuiltInProxy,
  type TunnelFailure,
} from "../builtin-proxy.ts";
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
  builtInReportJson,
  builtInView,
  explainNotLive,
  formatBuiltInReport,
  PROBING_MESSAGE,
  probeEndpoints,
  probeEndpointsWith,
  type BuiltInReport,
  type EndpointReport,
} from "./status.ts";

export interface UpCommand {
  system: SystemAdapter;
  reporter: Reporter;
  probeTimeoutMs: number;
  startTimeoutMs: number;
}

/** What up did to the processes: nothing for a live proxy, a restart for a stalled one */
export type UpOutcome = "started" | "restarted" | "already-running";

export interface UpReport {
  outcome: UpOutcome;
  reports: EndpointReport[];
  tunnelFailure: TunnelFailure | undefined;
}

export const STARTING_MESSAGE = "Starting the built-in proxy";
export const RESTARTING_MESSAGE = "Restarting the built-in proxy";

export async function runUp(command: UpCommand): Promise<number> {
  const { system, reporter } = command;
  const config = await readConfig(system);
  const proxy = requireBuiltIn(config, "start");
  const report = await bringUp(command, proxy);
  reporter.result(upView(system, report), {
    source: "built-in",
    running: true,
    started: report.outcome === "started",
    restarted: report.outcome === "restarted",
    ...builtInReportJson(builtInReport(report)),
  });
  return allLive(report.reports) ? 0 : 1;
}

/**
 * Starts a stopped proxy, restarts a stalled one and leaves a live one alone, then waits for
 * both endpoints up to the start timeout
 */
export async function bringUp(command: UpCommand, proxy: BuiltInProxyConfig): Promise<UpReport> {
  const { system, reporter, probeTimeoutMs } = command;
  if (!(await isBuiltInProxyRunning(system))) {
    await reporter.wait(STARTING_MESSAGE, () => startBuiltInProxy(system, proxy));
    return waitForEndpoints(command, proxy, "started");
  }
  const reports = await reporter.wait(PROBING_MESSAGE, () => probeEndpoints(proxy, probeTimeoutMs));
  if (allLive(reports)) {
    return { outcome: "already-running", reports, tunnelFailure: undefined };
  }
  return restartUp(command, proxy);
}

/** Restarts a running proxy, stalled or started from an older config, and waits like bringUp */
export async function restartUp(command: UpCommand, proxy: BuiltInProxyConfig): Promise<UpReport> {
  const { system, reporter } = command;
  await reporter.wait(RESTARTING_MESSAGE, () => restartBuiltInProxy(system, proxy));
  return waitForEndpoints(command, proxy, "restarted");
}

async function waitForEndpoints(
  { system, reporter, probeTimeoutMs, startTimeoutMs }: UpCommand,
  proxy: BuiltInProxyConfig,
  outcome: UpOutcome,
): Promise<UpReport> {
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
  const tunnelFailure = await explainNotLive(system, proxy, true, reports);
  return { outcome, reports, tunnelFailure };
}

export function upView(system: SystemAdapter, report: UpReport): View {
  return builtInView(system, builtInReport(report));
}

export function upBlock(system: SystemAdapter, report: UpReport): Block {
  return builtInBlock(system, builtInReport(report));
}

export function formatUpReport(system: SystemAdapter, report: UpReport): string {
  return formatBuiltInReport(system, builtInReport(report));
}

const HEADLINES: Record<UpOutcome, string> = {
  started: "Built-in proxy started",
  restarted: "Built-in proxy restarted",
  "already-running": "Built-in proxy is already running",
};

function builtInReport(report: UpReport): BuiltInReport {
  return {
    headline: HEADLINES[report.outcome],
    running: true,
    reports: report.reports,
    tunnelFailure: report.tunnelFailure,
    hint: report.tunnelFailure?.hint,
  };
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
