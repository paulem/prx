import { join } from "node:path";
import { findDependencies } from "../builtin-proxy.ts";
import {
  addressFormatHint,
  configPath,
  ENDPOINT_TYPES,
  isValidPort,
  parseEndpointAddress,
  PORT_RANGE_MESSAGE,
  writeConfig,
  type Address,
  type BuiltInProxyConfig,
  type Config,
  type EndpointType,
  type ExternalProxyConfig,
  type TunnelConfig,
} from "../config.ts";
import { PrxError } from "../errors.ts";
import type { PromptAnswer, SystemAdapter } from "../system.ts";
import { formatPresetListing, listPresets } from "./list.ts";
import { allLive, formatEndpointReports, probeEndpoints } from "./status.ts";
import { bringUp, formatUpReport } from "./up.ts";

export interface InitCommand {
  system: SystemAdapter;
  probeTimeoutMs: number;
}

const ENDPOINT_LABELS: Record<EndpointType, string> = { http: "HTTP", socks: "SOCKS" };
const RECORD_QUESTIONS: Record<EndpointType, string> = {
  http: "Record an HTTP endpoint?",
  socks: "Record a SOCKS endpoint?",
};
const DEFAULT_ADDRESSES: Record<EndpointType, string> = {
  http: "127.0.0.1:8118",
  socks: "127.0.0.1:1080",
};
// An HTTP endpoint is what most setups have; a SOCKS endpoint is offered but not assumed
const RECORD_BY_DEFAULT: Record<EndpointType, boolean> = { http: true, socks: false };
const DEFAULT_SSH_PORT = "22";
const DEFAULT_SOCKS_PORT = "1080";
const DEFAULT_HTTP_PORT = "8118";

export async function runInit(command: InitCommand): Promise<number> {
  await initWizard(command);
  return 0;
}

/** Asks for the proxy, probes it, and writes the config; throws when the person backs out */
export async function initWizard(command: InitCommand): Promise<Config> {
  const { system, probeTimeoutMs } = command;
  const source = answerOrCancel(
    await system.prompt.select<"external" | "built-in">({
      message: "Proxy source",
      options: [
        { value: "external", label: "External proxy, something else runs it" },
        { value: "built-in", label: "Built-in proxy, prx runs an ssh tunnel" },
      ],
    }),
  );

  const proxy =
    source === "external" ? await askExternalProxy(command) : await askBuiltInProxy(system);
  const config: Config = { version: 1, proxy };
  await writeConfig(system, config);
  system.writeStdout(`Saved config to ${configPath(system)}\n`);

  if (proxy.source === "built-in") {
    const startNow = answerOrCancel(
      await system.prompt.confirm({ message: "Start the built-in proxy now?", initialValue: true }),
    );
    if (startNow) {
      system.writeStdout(formatUpReport(system, await bringUp(system, proxy, probeTimeoutMs)));
    }
  }

  system.writeStdout(formatPresetListing(await listPresets(system)));
  return config;
}

// The dependency check comes first so a missing binary is reported before any typing
async function askBuiltInProxy(system: SystemAdapter): Promise<BuiltInProxyConfig> {
  await findDependencies(system);
  const tunnel = await askTunnel(system);
  const socksPort = await askFreePort(system, "SOCKS port", DEFAULT_SOCKS_PORT, () => undefined);
  const httpPort = await askFreePort(system, "HTTP port", DEFAULT_HTTP_PORT, (port) =>
    port === socksPort ? "Must differ from the SOCKS port" : undefined,
  );
  return { source: "built-in", tunnel, socksPort, httpPort };
}

async function askTunnel(system: SystemAdapter): Promise<TunnelConfig> {
  const user = await askText(system, "ssh user", "", requireNonBlank);
  const host = await askText(system, "ssh host", "", requireHost);
  const port = Number(await askText(system, "ssh port", DEFAULT_SSH_PORT, requirePort));
  const identityFile = (
    await askText(system, "Identity file, empty to use ssh-agent", "", () => undefined)
  ).trim();
  if (identityFile === "") {
    return { user, host, port };
  }
  return { user, host, port, identityFile: expandHome(system, identityFile) };
}

// The port check needs the OS, which a validator cannot reach, so a busy port is reported
// after the answer and the question is asked again
async function askFreePort(
  system: SystemAdapter,
  message: string,
  initialValue: string,
  validate: (port: number) => string | undefined,
): Promise<number> {
  for (;;) {
    const input = await askText(system, message, initialValue, (candidate) => {
      const problem = requirePort(candidate);
      return problem ?? validate(Number(candidate.trim()));
    });
    const port = Number(input.trim());
    if (await system.isPortFree(port)) {
      return port;
    }
    system.writeStdout(`Port ${port} is already in use\n`);
  }
}

async function askText(
  system: SystemAdapter,
  message: string,
  initialValue: string,
  validate: (input: string) => string | undefined,
): Promise<string> {
  return answerOrCancel(await system.prompt.text({ message, initialValue, validate }));
}

function requireNonBlank(input: string): string | undefined {
  return input.trim() === "" ? "Enter a value" : undefined;
}

function requireHost(input: string): string | undefined {
  const trimmed = input.trim();
  if (trimmed === "") {
    return "Enter a hostname or IP address";
  }
  return /\s/.test(trimmed) ? "A hostname cannot contain spaces" : undefined;
}

function requirePort(input: string): string | undefined {
  const trimmed = input.trim();
  return /^\d+$/.test(trimmed) && isValidPort(Number(trimmed)) ? undefined : PORT_RANGE_MESSAGE;
}

// ssh gets the path without a shell in between, so a leading ~ is expanded here
function expandHome(system: SystemAdapter, path: string): string {
  if (path === "~" || path.startsWith("~/")) {
    return join(system.homeDir(), path.slice(1));
  }
  return path;
}

async function askExternalProxy({
  system,
  probeTimeoutMs,
}: InitCommand): Promise<ExternalProxyConfig> {
  const proxy: ExternalProxyConfig = { source: "external", endpoints: await askEndpoints(system) };

  const reports = await probeEndpoints(proxy, probeTimeoutMs);
  system.writeStdout(formatEndpointReports(reports));
  if (!allLive(reports)) {
    const saveAnyway = answerOrCancel(
      await system.prompt.confirm({ message: "Save the config anyway?", initialValue: false }),
    );
    if (!saveAnyway) {
      throw cancelled();
    }
  }
  return proxy;
}

async function askEndpoints(system: SystemAdapter): Promise<ExternalProxyConfig["endpoints"]> {
  for (;;) {
    const endpoints: ExternalProxyConfig["endpoints"] = {};
    for (const type of ENDPOINT_TYPES) {
      const record = answerOrCancel(
        await system.prompt.confirm({
          message: RECORD_QUESTIONS[type],
          initialValue: RECORD_BY_DEFAULT[type],
        }),
      );
      if (record) {
        endpoints[type] = await askAddress(system, type);
      }
    }
    if (Object.keys(endpoints).length > 0) {
      return endpoints;
    }
    system.writeStdout("Record at least one endpoint\n");
  }
}

async function askAddress(system: SystemAdapter, type: EndpointType): Promise<Address> {
  const input = answerOrCancel(
    await system.prompt.text({
      message: `${ENDPOINT_LABELS[type]} endpoint (${addressFormatHint(type)})`,
      initialValue: DEFAULT_ADDRESSES[type],
      validate(candidate) {
        const parsed = parseEndpointAddress(type, candidate);
        return parsed.ok ? undefined : parsed.message;
      },
    }),
  );
  const parsed = parseEndpointAddress(type, input);
  if (!parsed.ok) {
    throw new Error(`validated address failed to parse: ${parsed.message}`);
  }
  return parsed.address;
}

function answerOrCancel<T>(answer: PromptAnswer<T>): T {
  if (answer.kind === "cancelled") {
    throw cancelled();
  }
  return answer.value;
}

function cancelled(): PrxError {
  return new PrxError("cancelled", "Cancelled, nothing was saved");
}
