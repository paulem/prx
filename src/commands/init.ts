import {
  addressFormatHint,
  configPath,
  ENDPOINT_TYPES,
  parseEndpointAddress,
  writeConfig,
  type Address,
  type Config,
  type EndpointType,
  type ExternalProxyConfig,
} from "../config.ts";
import { PrxError } from "../errors.ts";
import type { PromptAnswer, SystemAdapter } from "../system.ts";
import { formatPresetListing, listPresets } from "./list.ts";
import { allLive, formatEndpointReports, probeEndpoints } from "./status.ts";

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

export async function runInit(command: InitCommand): Promise<number> {
  await initWizard(command);
  return 0;
}

/** Asks for the proxy, probes it, and writes the config; throws when the person backs out */
export async function initWizard(command: InitCommand): Promise<Config> {
  const { system } = command;
  answerOrCancel(
    await system.prompt.select<"external">({
      message: "Proxy source",
      options: [{ value: "external", label: "External proxy, something else runs it" }],
    }),
  );

  const config: Config = { version: 1, proxy: await askExternalProxy(command) };
  await writeConfig(system, config);
  system.writeStdout(`Saved config to ${configPath(system)}\n`);
  system.writeStdout(formatPresetListing(await listPresets(system)));
  return config;
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
