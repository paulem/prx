import { isBuiltInProxyRunning, startBuiltInProxy } from "../builtin-proxy.ts";
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
import { narrateWait, STARTING_MESSAGE } from "./up.ts";

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

  const started = await startIfStopped(command, config.proxy);
  if (started) {
    reporter.notice({
      plain: "prx: started the built-in proxy\n",
      decorated: renderBlock({ mark: symbol("step"), lines: ["Built-in proxy started"] }),
    });
  }

  const latencyMs = await probeBeforeLaunch(
    command,
    preset,
    endpoint,
    started,
    notLiveHint(config.proxy),
  );

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

// A launch after a reboot is never a dead end: a built-in proxy that is not running is started
// exactly as up starts it, with the same checks and errors
async function startIfStopped(
  { system, reporter }: RunCommand,
  proxy: ProxyConfig,
): Promise<boolean> {
  if (proxy.source !== "built-in" || (await isBuiltInProxyRunning(system))) {
    return false;
  }
  await reporter.wait(STARTING_MESSAGE, () => startBuiltInProxy(system, proxy));
  return true;
}

// A proxy that was just started gets the whole start timeout to come up; one that was already
// there is probed once
async function probeBeforeLaunch(
  command: RunCommand,
  preset: Preset,
  endpoint: Endpoint,
  justStarted: boolean,
  hint: string,
): Promise<number | null> {
  if (!command.check) {
    return null;
  }
  const url = endpointUrl(endpoint);
  const options = { url: preset.probeUrl ?? DEFAULT_PROBE_URL, timeoutMs: command.probeTimeoutMs };
  let result: ProbeResult;
  if (justStarted) {
    const narration = narrateWait(command.startTimeoutMs, () => url, [endpoint]);
    result = await command.reporter.wait(narration.current(), (progress) =>
      probeUntilLive(endpoint, {
        ...options,
        waitMs: command.startTimeoutMs,
        onAttempt(attempt) {
          narration.record(endpoint, attempt);
          progress(narration.current());
        },
      }),
    );
  } else {
    result = await command.reporter.wait(`Probing ${url}`, () => probe(endpoint, options));
  }
  if (!result.live) {
    throw new PrxError("proxy_not_live", `Endpoint ${url} is not live: ${result.message}.`, hint);
  }
  return result.latencyMs;
}

// A built-in proxy leaves logs worth pointing at; an external one has only its endpoints
function notLiveHint(proxy: ProxyConfig): string {
  const where = proxy.source === "built-in" ? " and the log directory" : "";
  return `Run prx status to see every endpoint${where}.`;
}

function notFoundHint(preset: Preset): string {
  if (preset.app.kind === "path") {
    return `no '${preset.app.command}' command found on PATH`;
  }
  return `no '${preset.app.name}.app' found in /Applications or ~/Applications`;
}
