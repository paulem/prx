import { fetch, ProxyAgent } from "undici";
import { proxyUrl, type ProxyConfig } from "./config.ts";

export const DEFAULT_PROBE_URL = "https://example.com/";
export const DEFAULT_PROBE_TIMEOUT_MS = 5000;

export type ProbeFailureReason = "refused" | "rejected" | "timed_out" | "failed";

export type ProbeResult =
  | { live: true; latencyMs: number }
  | { live: false; reason: ProbeFailureReason; message: string };

export interface ProbeOptions {
  url: string;
  timeoutMs: number;
}

/**
 * Sends one HTTPS request through the proxy and reports whether it answered.
 * Any HTTP status counts as live; only failing to get a response does not
 */
export async function probe(proxy: ProxyConfig, options: ProbeOptions): Promise<ProbeResult> {
  const agent = new ProxyAgent({ uri: proxyUrl(proxy), connectTimeout: options.timeoutMs });
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

function describeFailure(error: unknown): { reason: ProbeFailureReason; message: string } {
  for (const cause of causeChain(error)) {
    const code = typeof cause.code === "string" ? cause.code : undefined;
    const message = typeof cause.message === "string" ? cause.message : "";
    const rejected = REJECTED_CONNECT_PATTERN.exec(message);
    if (rejected !== null) {
      return { reason: "rejected", message: `proxy rejected CONNECT with status ${rejected[1]}` };
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
