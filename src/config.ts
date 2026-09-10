import { join } from "node:path";
import { PrxError } from "./errors.ts";
import type { SystemAdapter } from "./system.ts";

export interface ProxyConfig {
  type: "http";
  host: string;
  port: number;
}

export interface Config {
  version: 1;
  proxy: ProxyConfig;
}

const CONFIG_FILE_NAME = "config.json";

export function configPath(system: SystemAdapter): string {
  return join(system.configDir(), CONFIG_FILE_NAME);
}

export function proxyUrl(proxy: ProxyConfig): string {
  return `http://${proxy.host}:${proxy.port}`;
}

export type ParsedAddress = { ok: true; proxy: ProxyConfig } | { ok: false; message: string };

const ADDRESS_FORMAT_MESSAGE = "Enter host:port or http://host:port";

/** Reads a proxy address typed by a person, as host:port or http://host:port */
export function parseProxyAddress(input: string): ParsedAddress {
  const trimmed = input.trim();
  if (isPortOutOfRange(trimmed)) {
    return { ok: false, message: PORT_RANGE_MESSAGE };
  }
  const withScheme = trimmed.includes("://") ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, message: ADDRESS_FORMAT_MESSAGE };
  }
  const isPlainHostAndPort =
    url.protocol === "http:" &&
    url.username === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.port !== "";
  if (!isPlainHostAndPort) {
    return { ok: false, message: ADDRESS_FORMAT_MESSAGE };
  }
  return { ok: true, proxy: { type: "http", host: url.hostname, port: Number(url.port) } };
}

const PORT_RANGE_MESSAGE = "Port must be between 1 and 65535";

// The URL parser rejects an out-of-range port as malformed, so the range is checked on the text first
function isPortOutOfRange(address: string): boolean {
  const port = /:(\d+)\/?$/.exec(address)?.[1];
  return port !== undefined && (Number(port) < 1 || Number(port) > 65535);
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
  if (typeof value !== "object" || value === null) {
    return "expected an object";
  }
  const { version, proxy } = value as Record<string, unknown>;
  if (version !== 1) {
    return "version must be 1";
  }
  if (typeof proxy !== "object" || proxy === null) {
    return "proxy must be an object";
  }
  const { type, host, port } = proxy as Record<string, unknown>;
  if (type !== "http") {
    return 'proxy.type must be "http"';
  }
  if (typeof host !== "string" || host.length === 0) {
    return "proxy.host must be a non-empty string";
  }
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
    return "proxy.port must be an integer between 1 and 65535";
  }
  return undefined;
}
