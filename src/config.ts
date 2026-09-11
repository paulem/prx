import { join } from "node:path";
import { PrxError } from "./errors.ts";
import type { SystemAdapter } from "./system.ts";

export type EndpointType = "http" | "socks";

/** Every endpoint type, in the order prx lists endpoints */
export const ENDPOINT_TYPES: readonly EndpointType[] = ["http", "socks"];

export interface Address {
  host: string;
  port: number;
}

/** A host, port and endpoint type that an app's traffic is routed through */
export interface Endpoint extends Address {
  type: EndpointType;
}

export interface ExternalProxyConfig {
  source: "external";
  endpoints: Partial<Record<EndpointType, Address>>;
}

export interface TunnelConfig {
  user: string;
  host: string;
  port: number;
  identityFile?: string;
}

export interface BuiltInProxyConfig {
  source: "built-in";
  tunnel: TunnelConfig;
  socksPort: number;
  httpPort: number;
}

export type ProxyConfig = ExternalProxyConfig | BuiltInProxyConfig;

export interface Config {
  version: 1;
  proxy: ProxyConfig;
}

const CONFIG_FILE_NAME = "config.json";
/** Where a built-in proxy's endpoints listen */
export const BUILT_IN_HOST = "127.0.0.1";

export function configPath(system: SystemAdapter): string {
  return join(system.configDir(), CONFIG_FILE_NAME);
}

/** The proxy's endpoints as one view, so commands never branch on the source to find one */
export function proxyEndpoints(proxy: ProxyConfig): Endpoint[] {
  if (proxy.source === "built-in") {
    return [
      { type: "http", host: BUILT_IN_HOST, port: proxy.httpPort },
      { type: "socks", host: BUILT_IN_HOST, port: proxy.socksPort },
    ];
  }
  return ENDPOINT_TYPES.flatMap((type) => {
    const address = proxy.endpoints[type];
    return address === undefined ? [] : [{ type, ...address }];
  });
}

export function findEndpoint(proxy: ProxyConfig, type: EndpointType): Endpoint | undefined {
  return proxyEndpoints(proxy).find((endpoint) => endpoint.type === type);
}

const URL_SCHEMES: Record<EndpointType, string> = { http: "http", socks: "socks5" };

export function endpointUrl(endpoint: Endpoint): string {
  return `${URL_SCHEMES[endpoint.type]}://${endpoint.host}:${endpoint.port}`;
}

export type ParsedAddress = { ok: true; address: Address } | { ok: false; message: string };

export function addressFormatHint(type: EndpointType): string {
  return `host:port or ${URL_SCHEMES[type]}://host:port`;
}

/** Reads an endpoint address typed by a person, as host:port or with the type's URL scheme */
export function parseEndpointAddress(type: EndpointType, input: string): ParsedAddress {
  const formatMessage = `Enter ${addressFormatHint(type)}`;
  const trimmed = input.trim();
  if (isPortOutOfRange(trimmed)) {
    return { ok: false, message: PORT_RANGE_MESSAGE };
  }
  const scheme = URL_SCHEMES[type];
  const withScheme = trimmed.includes("://") ? trimmed : `${scheme}://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, message: formatMessage };
  }
  // A special scheme such as http: normalises an empty path to "/", socks5: leaves it empty
  const isPlainHostAndPort =
    url.protocol === `${scheme}:` &&
    url.username === "" &&
    (url.pathname === "/" || url.pathname === "") &&
    url.search === "" &&
    url.port !== "";
  if (!isPlainHostAndPort) {
    return { ok: false, message: formatMessage };
  }
  return { ok: true, address: { host: url.hostname, port: Number(url.port) } };
}

export const PORT_RANGE_MESSAGE = "Port must be between 1 and 65535";

export function isValidPort(port: unknown): port is number {
  return Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535;
}

// The URL parser rejects an out-of-range port as malformed, so the range is checked on the text first
function isPortOutOfRange(address: string): boolean {
  const port = /:(\d+)\/?$/.exec(address)?.[1];
  return port !== undefined && !isValidPort(Number(port));
}

export async function readConfig(system: SystemAdapter): Promise<Config> {
  const path = configPath(system);
  const text = await system.readTextFile(path);
  if (text === undefined) {
    throw new PrxError("config_missing", `No config found at ${path}. Run prx init to create one.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PrxError("config_invalid", `Config at ${path} is invalid: not valid JSON`);
  }

  const problem = describeConfigProblem(parsed);
  if (problem !== undefined) {
    throw new PrxError("config_invalid", `Config at ${path} is invalid: ${problem}`);
  }
  return parsed as Config;
}

export async function writeConfig(system: SystemAdapter, config: Config): Promise<void> {
  await system.writeTextFile(configPath(system), `${JSON.stringify(config, null, 2)}\n`);
}

function describeConfigProblem(value: unknown): string | undefined {
  if (!isObject(value)) {
    return "expected an object";
  }
  const { version, proxy } = value;
  if (version !== 1) {
    return "version must be 1";
  }
  if (!isObject(proxy)) {
    return "proxy must be an object";
  }
  if (proxy.source === "external") {
    return describeExternalProblem(proxy);
  }
  if (proxy.source === "built-in") {
    return describeBuiltInProblem(proxy);
  }
  return 'proxy.source must be "external" or "built-in". Run prx init to write the current shape.';
}

function describeExternalProblem(proxy: Record<string, unknown>): string | undefined {
  const { endpoints } = proxy;
  if (!isObject(endpoints)) {
    return "proxy.endpoints must be an object";
  }
  const recorded = ENDPOINT_TYPES.filter((type) => endpoints[type] !== undefined);
  if (recorded.length === 0) {
    return "proxy.endpoints must have at least one of http or socks";
  }
  for (const type of recorded) {
    const problem = describeAddressProblem(`proxy.endpoints.${type}`, endpoints[type]);
    if (problem !== undefined) {
      return problem;
    }
  }
  return undefined;
}

function describeBuiltInProblem(proxy: Record<string, unknown>): string | undefined {
  const { tunnel, socksPort, httpPort } = proxy;
  if (!isObject(tunnel)) {
    return "proxy.tunnel must be an object";
  }
  if (!isNonEmptyString(tunnel.user)) {
    return "proxy.tunnel.user must be a non-empty string";
  }
  if (!isNonEmptyString(tunnel.host)) {
    return "proxy.tunnel.host must be a non-empty string";
  }
  if (!isValidPort(tunnel.port)) {
    return "proxy.tunnel.port must be an integer between 1 and 65535";
  }
  if (tunnel.identityFile !== undefined && !isNonEmptyString(tunnel.identityFile)) {
    return "proxy.tunnel.identityFile must be a non-empty string when set";
  }
  if (!isValidPort(socksPort)) {
    return "proxy.socksPort must be an integer between 1 and 65535";
  }
  if (!isValidPort(httpPort)) {
    return "proxy.httpPort must be an integer between 1 and 65535";
  }
  if (socksPort === httpPort) {
    return "proxy.socksPort and proxy.httpPort must differ";
  }
  return undefined;
}

function describeAddressProblem(label: string, value: unknown): string | undefined {
  if (!isObject(value)) {
    return `${label} must be an object`;
  }
  if (!isNonEmptyString(value.host)) {
    return `${label}.host must be a non-empty string`;
  }
  if (!isValidPort(value.port)) {
    return `${label}.port must be an integer between 1 and 65535`;
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
