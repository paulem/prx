import { proxyUrl, readConfig, type ProxyConfig } from "../config.ts";
import { PrxError } from "../errors.ts";
import { envInjection, exitCodeFromOutcome } from "../launch.ts";
import type { Reporter } from "../output.ts";
import { findPreset, locateApp, type Preset } from "../presets/index.ts";
import { DEFAULT_PROBE_URL, probe } from "../probe.ts";
import type { SystemAdapter } from "../system.ts";

export interface RunCommand {
  system: SystemAdapter;
  reporter: Reporter;
  probeTimeoutMs: number;
  presetName: string;
  passthrough: string[];
  check: boolean;
  json: boolean;
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

  const config = await readConfig(system);
  const proxy = config.proxy;

  const appPath = await locateApp(system, preset.app);
  if (appPath === undefined) {
    throw new PrxError(
      "app_not_installed",
      `${preset.name} is not installed: ${notFoundHint(preset)}`,
    );
  }

  const latencyMs = await probeBeforeLaunch(command, preset, proxy);

  if (json) {
    reporter.result("", { preset: preset.name, proxy, latencyMs });
  } else {
    const probeSummary =
      latencyMs === null ? "not probed (--no-check)" : `is live (${latencyMs} ms)`;
    system.writeStderr(`prx: proxy ${proxyUrl(proxy)} ${probeSummary}, launching ${preset.name}\n`);
  }

  const outcome = await system.spawnAttached({
    command: appPath,
    args: passthrough,
    env: envInjection(proxy),
  });
  return exitCodeFromOutcome(outcome);
}

async function probeBeforeLaunch(
  command: RunCommand,
  preset: Preset,
  proxy: ProxyConfig,
): Promise<number | null> {
  if (!command.check) {
    return null;
  }
  const result = await probe(proxy, {
    url: preset.probeUrl ?? DEFAULT_PROBE_URL,
    timeoutMs: command.probeTimeoutMs,
  });
  if (!result.live) {
    throw new PrxError("proxy_not_live", `Proxy ${proxyUrl(proxy)} is not live: ${result.message}`);
  }
  return result.latencyMs;
}

function notFoundHint(preset: Preset): string {
  if (preset.app.kind === "path") {
    return `no '${preset.app.command}' command found on PATH`;
  }
  return `no '${preset.app.name}.app' found in /Applications or ~/Applications`;
}
