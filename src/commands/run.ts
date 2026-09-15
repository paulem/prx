import {
  isBuiltInProxyRunning,
  readTunnelFailure,
  restartBuiltInProxy,
  startBuiltInProxy,
} from "../builtin-proxy.ts";
import {
  endpointUrl,
  findEndpoint,
  readConfig,
  type Config,
  type Endpoint,
  type EndpointType,
  type ProxyConfig,
} from "../config.ts";
import { PrxError } from "../errors.ts";
import type { Reporter } from "../output.ts";
import { argsInjection, envInjection, exitCodeFromOutcome, macOpenLaunch } from "../launch.ts";
import { findPreset, locateApp, type Preset } from "../presets/index.ts";
import { DEFAULT_PROBE_URL, probe, probeUntilLive, type ProbeResult } from "../probe.ts";
import { bold, dim, renderBlock, symbol } from "../style.ts";
import type { SystemAdapter } from "../system.ts";
import { initWizard } from "./init.ts";
import { narrateWait, RESTARTING_MESSAGE, STARTING_MESSAGE } from "./up.ts";

export interface RunCommand {
  system: SystemAdapter;
  reporter: Reporter;
  probeTimeoutMs: number;
  startTimeoutMs: number;
  presetName: string;
  passthrough: string[];
  check: boolean;
  json: boolean;
  /** Overrides the preset's endpoint preference for this launch */
  via?: EndpointType;
}

export async function runRun(command: RunCommand): Promise<number> {
  const { system, reporter, presetName, passthrough, json } = command;

  const preset = findPreset(presetName);
  if (preset === undefined) {
    throw new PrxError(
      "unknown_preset",
      `Unknown preset '${presetName}'.`,
      "Run prx list to see the presets.",
    );
  }

  const config = await readConfigOrInit(command);
  const endpoint = chooseEndpoint(preset, config.proxy, command.via);

  const appPath = await locateApp(system, preset.app);
  if (appPath === undefined) {
    throw new PrxError(
      "app_not_installed",
      `${preset.name} is not installed: ${notFoundHint(preset)}`,
    );
  }

  if (preset.refuseWhenRunning !== undefined && preset.app.kind === "application") {
    if (await system.isApplicationRunning(preset.app.name)) {
      throw new PrxError(
        "app_already_running",
        `${preset.app.name} is already running.`,
        preset.refuseWhenRunning,
      );
    }
  }

  const latencyMs = await makeLive(command, preset, endpoint, config.proxy);

  if (json) {
    reporter.json({ preset: preset.name, endpoint, latencyMs });
  } else {
    const url = endpointUrl(endpoint);
    const plainSummary =
      latencyMs === null ? "not probed (--no-check)" : `is live (${latencyMs} ms)`;
    const decoratedSummary = latencyMs === null ? "not probed" : `${latencyMs} ms`;
    reporter.notice({
      plain: `prx: ${endpoint.type} endpoint ${url} ${plainSummary}, launching ${preset.name}\n`,
      decorated: renderBlock({
        mark: symbol("step"),
        lines: [`${bold(preset.name)} via ${url}  ${dim(decoratedSummary)}`],
      }),
    });
  }

  const injected = inject(preset, endpoint);
  const landing = preset.landingUrl === undefined ? [] : [preset.landingUrl];
  const args = [...injected.args, ...passthrough, ...landing];
  if (preset.launch === "detached") {
    await system.launchDetached(macOpenLaunch(appPath, args));
    return 0;
  }

  const outcome = await system.spawnAttached({ command: appPath, args, env: injected.env });
  return exitCodeFromOutcome(outcome);
}

// The option wins outright; otherwise the first type the preset prefers that the proxy has
function chooseEndpoint(
  preset: Preset,
  proxy: ProxyConfig,
  via: EndpointType | undefined,
): Endpoint {
  if (via !== undefined) {
    if (!preset.endpoints.includes(via)) {
      throw new PrxError(
        "endpoint_missing",
        `${preset.name} cannot use a ${via} endpoint, only ${preset.endpoints.join(" or ")}.`,
      );
    }
    const endpoint = findEndpoint(proxy, via);
    if (endpoint === undefined) {
      throw new PrxError(
        "endpoint_missing",
        `The proxy has no ${via} endpoint.`,
        "Run prx init to record one.",
      );
    }
    return endpoint;
  }
  for (const type of preset.endpoints) {
    const endpoint = findEndpoint(proxy, type);
    if (endpoint !== undefined) {
      return endpoint;
    }
  }
  throw new PrxError(
    "endpoint_missing",
    `The proxy has no ${preset.endpoints.join(" or ")} endpoint, which ${preset.name} needs.`,
    "Run prx init to record one.",
  );
}

interface Injected {
  env: Record<string, string>;
  args: string[];
}

function inject(preset: Preset, endpoint: Endpoint): Injected {
  if (preset.injection === "env") {
    return { env: envInjection(endpoint), args: [] };
  }
  return { env: {}, args: argsInjection(endpoint) };
}

// A first run is never a dead end: without a config the wizard runs first, unless a wrapper
// is parsing the output, since it cannot answer prompts
async function readConfigOrInit(command: RunCommand): Promise<Config> {
  try {
    return await readConfig(command.system);
  } catch (error) {
    if (error instanceof PrxError && error.code === "config_missing" && !command.json) {
      return initWizard({
        system: command.system,
        reporter: command.reporter,
        probeTimeoutMs: command.probeTimeoutMs,
        startTimeoutMs: command.startTimeoutMs,
      });
    }
    throw error;
  }
}

/**
 * A launch is never a dead end: a stopped built-in proxy is started and a stalled one is
 * restarted, exactly as up does it, and either gets the whole start timeout to come up. A
 * proxy nobody touched is probed once. Resolves to the latency, or null without a probe
 */
async function makeLive(
  command: RunCommand,
  preset: Preset,
  endpoint: Endpoint,
  proxy: ProxyConfig,
): Promise<number | null> {
  const { system, reporter } = command;
  const url = endpointUrl(endpoint);
  const options = { url: preset.probeUrl ?? DEFAULT_PROBE_URL, timeoutMs: command.probeTimeoutMs };
  const stopped = proxy.source === "built-in" && !(await isBuiltInProxyRunning(system));
  if (stopped) {
    await reporter.wait(STARTING_MESSAGE, () => startBuiltInProxy(system, proxy));
    announce(reporter, "started");
  }
  if (!command.check) {
    return null;
  }
  let result: ProbeResult;
  if (stopped) {
    result = await waitUntilLive(command, endpoint, options);
  } else {
    result = await reporter.wait(`Probing ${url}`, () => probe(endpoint, options));
    if (!result.live && proxy.source === "built-in") {
      await reporter.wait(RESTARTING_MESSAGE, () => restartBuiltInProxy(system, proxy));
      announce(reporter, "restarted");
      result = await waitUntilLive(command, endpoint, options);
    }
  }
  if (!result.live) {
    throw await notLiveError(system, proxy, `Endpoint ${url} is not live: ${result.message}.`);
  }
  return result.latencyMs;
}

function announce(reporter: Reporter, outcome: "started" | "restarted"): void {
  reporter.notice({
    plain: `prx: ${outcome} the built-in proxy\n`,
    decorated: renderBlock({ mark: symbol("step"), lines: [`Built-in proxy ${outcome}`] }),
  });
}

function waitUntilLive(
  command: RunCommand,
  endpoint: Endpoint,
  options: { url: string; timeoutMs: number },
): Promise<ProbeResult> {
  const narration = narrateWait(command.startTimeoutMs, () => endpointUrl(endpoint), [endpoint]);
  return command.reporter.wait(narration.current(), (progress) =>
    probeUntilLive(endpoint, {
      ...options,
      waitMs: command.startTimeoutMs,
      onAttempt(attempt) {
        narration.record(endpoint, attempt);
        progress(narration.current());
      },
    }),
  );
}

// A built-in proxy has a tunnel whose log may explain the failure, and status shows the log
// directory; an external one has only its endpoints
async function notLiveError(
  system: SystemAdapter,
  proxy: ProxyConfig,
  summary: string,
): Promise<PrxError> {
  if (proxy.source !== "built-in") {
    return new PrxError("proxy_not_live", summary, "Run prx status to see every endpoint.");
  }
  const statusHint = "Run prx status to see every endpoint and the log directory.";
  const failure = await readTunnelFailure(system, proxy);
  if (failure === undefined) {
    return new PrxError("proxy_not_live", summary, statusHint);
  }
  return new PrxError(
    "proxy_not_live",
    `${summary} Tunnel: ${failure.message}`,
    failure.hint ?? statusHint,
  );
}

function notFoundHint(preset: Preset): string {
  if (preset.app.kind === "path") {
    return `no '${preset.app.command}' command found on PATH`;
  }
  return `no '${preset.app.name}.app' found in /Applications or ~/Applications`;
}
