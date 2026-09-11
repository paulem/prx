import { setTimeout as sleep } from "node:timers/promises";
import { fetch, ProxyAgent, Socks5ProxyAgent, type Dispatcher } from "undici";
import { endpointUrl, type Endpoint } from "./config.ts";

export const DEFAULT_PROBE_URL = "https://example.com/";
export const DEFAULT_PROBE_TIMEOUT_MS = 5000;
const RETRY_DELAY_MS = 250;

export type ProbeFailureReason = "refused" | "rejected" | "timed_out" | "failed";

export type ProbeResult =
  | { live: true; latencyMs: number }
  | { live: false; reason: ProbeFailureReason; message: string };

export interface ProbeOptions {
  url: string;
  timeoutMs: number;
}

/**
 * Sends one HTTPS request through the endpoint and reports whether it answered.
 * Any HTTP status counts as live; only failing to get a response does not
 */
export async function probe(endpoint: Endpoint, options: ProbeOptions): Promise<ProbeResult> {
  const agent = createAgent(endpoint, options.timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(options.url, {
      method: "HEAD",
      dispatcher: agent,
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    await response.body?.cancel();
    return { live: true, latencyMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    return { live: false, ...describeFailure(error) };
  } finally {
    await agent.destroy();
  }
}

/** Probes again and again until the endpoint is live or the timeout has passed, reporting the last result */
export async function probeUntilLive(
  endpoint: Endpoint,
  options: ProbeOptions,
): Promise<ProbeResult> {
  const deadline = performance.now() + options.timeoutMs;
  for (;;) {
    const remainingMs = Math.max(1, Math.ceil(deadline - performance.now()));
    const result = await probe(endpoint, { url: options.url, timeoutMs: remainingMs });
    const leftMs = deadline - performance.now();
    if (result.live || leftMs <= 0) {
      return result;
    }
    await sleep(Math.min(RETRY_DELAY_MS, leftMs));
  }
}

function createAgent(endpoint: Endpoint, timeoutMs: number): Dispatcher {
  const uri = endpointUrl(endpoint);
  if (endpoint.type === "http") {
    return new ProxyAgent({ uri, connectTimeout: timeoutMs });
  }
  return withoutWarnings(() => new Socks5ProxyAgent(uri, { connectTimeout: timeoutMs }));
}

// undici calls its SOCKS5 agent experimental and warns on the first construction; the warning
// would land on the terminal in the middle of prx's own output, so it is swallowed
function withoutWarnings<T>(construct: () => T): T {
  const emitWarning = process.emitWarning;
  process.emitWarning = () => {};
  try {
    return construct();
  } finally {
    process.emitWarning = emitWarning;
  }
}

const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);
const TIMEOUT_ERROR_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ABORT_ERR",
]);
const REJECTED_CONNECT_PATTERN = /Proxy response \((\d+)\)/;
const SOCKS_ERROR_CODE_PREFIX = "UND_ERR_SOCKS5";

function describeFailure(error: unknown): { reason: ProbeFailureReason; message: string } {
  for (const cause of causeChain(error)) {
    const code = typeof cause.code === "string" ? cause.code : undefined;
    const message = typeof cause.message === "string" ? cause.message : "";
    const rejected = REJECTED_CONNECT_PATTERN.exec(message);
    if (rejected !== null) {
      return { reason: "rejected", message: `proxy rejected CONNECT with status ${rejected[1]}` };
    }
    if (code?.startsWith(SOCKS_ERROR_CODE_PREFIX)) {
      return { reason: "rejected", message: `proxy rejected the SOCKS5 connect: ${message}` };
    }
    if (cause.name === "TimeoutError" || (code !== undefined && TIMEOUT_ERROR_CODES.has(code))) {
      return { reason: "timed_out", message: "no response from the proxy before the timeout" };
    }
    if (code !== undefined && CONNECTION_ERROR_CODES.has(code)) {
      return { reason: "refused", message: `connection refused (${code})` };
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return { reason: "failed", message };
}

function causeChain(error: unknown): Array<Record<string, unknown>> {
  const chain: Array<Record<string, unknown>> = [];
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !chain.includes(current as never)) {
    chain.push(current as Record<string, unknown>);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}
