import { constants } from "node:os";
import { endpointUrl, type Endpoint } from "./config.ts";
import type { LaunchRequest, SpawnOutcome } from "./system.ts";

/** Hosts an env-injected app reaches directly, so local servers keep working */
export const BYPASS_HOSTS = "localhost,127.0.0.1,::1";

const SIGNAL_EXIT_CODE_BASE = 128;

export function envInjection(endpoint: Endpoint): Record<string, string> {
  const url = endpointUrl(endpoint);
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    NO_PROXY: BYPASS_HOSTS,
    no_proxy: BYPASS_HOSTS,
  };
}

export function argsInjection(endpoint: Endpoint): string[] {
  return [`--proxy-server=${endpointUrl(endpoint)}`];
}

/** Starts a new instance of a macOS app bundle with arguments, without waiting for it */
export function macOpenLaunch(appPath: string, args: string[]): LaunchRequest {
  return { command: "open", args: ["-n", "-a", appPath, "--args", ...args] };
}

/** Mirrors what a shell reports for a child: its exit code, or 128 plus the signal number */
export function exitCodeFromOutcome(outcome: SpawnOutcome): number {
  if (outcome.signal !== null) {
    return SIGNAL_EXIT_CODE_BASE + constants.signals[outcome.signal];
  }
  return outcome.exitCode ?? 1;
}
