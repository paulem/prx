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
import { argsInjection, envInjection, exitCodeFromOutcome, macOpenLaunch } from "../launch.ts";
import type { Reporter } from "../output.ts";
import { findPreset, locateApp, type Preset } from "../presets/index.ts";
import { DEFAULT_PROBE_URL, probe } from "../probe.ts";
import type { SystemAdapter } from "../system.ts";
import { initWizard } from "./init.ts";

export interface RunCommand {
  system: SystemAdapter;
  reporter: Reporter;
  probeTimeoutMs: number;
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
      `Unknown preset '${presetName}'. Run prx list to see the presets.`,
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
        `${preset.app.name} is already running. ${preset.refuseWhenRunning}`,
      );
    }
  }

  const latencyMs = await probeBeforeLaunch(command, preset, endpoint);

  if (json) {
    reporter.result("", { preset: preset.name, endpoint, latencyMs });
  } else {
    const probeSummary =
      latencyMs === null ? "not probed (--no-check)" : `is live (${latencyMs} ms)`;
    system.writeStderr(
      `prx: ${endpoint.type} endpoint ${endpointUrl(endpoint)} ${probeSummary}, launching ${preset.name}\n`,
    );
  }

  const injected = inject(preset, endpoint);
  if (preset.launch === "detached") {
    await system.launchDetached(macOpenLaunch(appPath, [...injected.args, ...passthrough]));
    return 0;
  }

  const outcome = await system.spawnAttached({
    command: appPath,
    args: [...injected.args, ...passthrough],
    env: injected.env,
  });
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
        `The proxy has no ${via} endpoint. Run prx init to record one.`,
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
    `The proxy has no ${preset.endpoints.join(" or ")} endpoint, which ${preset.name} needs. Run prx init to record one.`,
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
      return initWizard({ system: command.system, probeTimeoutMs: command.probeTimeoutMs });
    }
    throw error;
  }
}

async function probeBeforeLaunch(
  command: RunCommand,
  preset: Preset,
  endpoint: Endpoint,
): Promise<number | null> {
  if (!command.check) {
    return null;
  }
  const result = await probe(endpoint, {
    url: preset.probeUrl ?? DEFAULT_PROBE_URL,
    timeoutMs: command.probeTimeoutMs,
  });
  if (!result.live) {
    throw new PrxError(
      "proxy_not_live",
      `Endpoint ${endpointUrl(endpoint)} is not live: ${result.message}`,
    );
  }
  return result.latencyMs;
}

function notFoundHint(preset: Preset): string {
  if (preset.app.kind === "path") {
    return `no '${preset.app.command}' command found on PATH`;
  }
  return `no '${preset.app.name}.app' found in /Applications or ~/Applications`;
}
