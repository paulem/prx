import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import tls from "node:tls";

/**
 * How the in-process proxy answers a connect:
 * - live: an HTTP proxy that accepts the CONNECT tunnel and answers the HTTPS request itself
 * - reject: an HTTP proxy that accepts TCP but refuses the tunnel with 403
 * - silent: an HTTP proxy that accepts TCP and never answers
 * - socks: a SOCKS5 proxy with no auth that accepts the connect and answers the HTTPS request itself
 * - socks-reject: a SOCKS5 proxy that completes the greeting and refuses the connect
 */
export type TestProxyMode = "live" | "reject" | "silent" | "socks" | "socks-reject";

export interface TestProxy {
  host: string;
  port: number;
  close: () => Promise<void>;
}

const fixturesDir = join(import.meta.dirname, "fixtures");
export const probeTargetCertPath = join(fixturesDir, "probe-target.crt");
const probeTargetCert = readFileSync(probeTargetCertPath);
const probeTargetKey = readFileSync(join(fixturesDir, "probe-target.key"));

/** Makes this process trust the test certificate the live proxy serves for the probe target */
export function trustProbeTarget(): void {
  tls.setDefaultCACertificates([probeTargetCert]);
}

/** Starts a proxy on an ephemeral port, or on the given port for an endpoint that must come up late */
export function startTestProxy(mode: TestProxyMode, port = 0): Promise<TestProxy> {
  const sockets = new Set<net.Socket>();
  const target = http.createServer((_request, response) => {
    response.writeHead(204);
    response.end();
  });

  function serveTarget(socket: Duplex): void {
    const secureSocket = new tls.TLSSocket(socket, {
      isServer: true,
      cert: probeTargetCert,
      key: probeTargetKey,
    });
    target.emit("connection", secureSocket);
  }

  const proxy =
    mode === "socks" || mode === "socks-reject"
      ? socks5Server(mode === "socks" ? serveTarget : undefined)
      : httpProxyServer(mode, serveTarget);

  proxy.on("connection", (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve) => {
    proxy.listen(port, "127.0.0.1", () => {
      const address = proxy.address();
      if (address === null || typeof address === "string") {
        throw new Error("test proxy did not bind to a TCP port");
      }
      resolve({
        host: "127.0.0.1",
        port: address.port,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) {
              socket.destroy();
            }
            proxy.close(() => done());
          }),
      });
    });
  });
}

function httpProxyServer(
  mode: "live" | "reject" | "silent",
  serveTarget: (socket: Duplex) => void,
): http.Server {
  const proxy = http.createServer((_request, response) => {
    response.writeHead(400);
    response.end();
  });
  proxy.on("connect", (_request, socket) => {
    if (mode === "silent") {
      return;
    }
    if (mode === "reject") {
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    serveTarget(socket);
  });
  return proxy;
}

const SOCKS_VERSION = 0x05;
const NO_AUTH = 0x00;
const SUCCEEDED = 0x00;
const CONNECTION_NOT_ALLOWED = 0x02;
const IPV4 = 0x01;
const DOMAIN_NAME = 0x03;
const IPV6 = 0x04;

// The two client messages: a greeting listing auth methods, then a connect request naming the target
function greetingLength(bytes: Buffer): number | undefined {
  if (bytes.length < 2) {
    return undefined;
  }
  const length = 2 + (bytes[1] ?? 0);
  return bytes.length >= length ? length : undefined;
}

function connectRequestLength(bytes: Buffer): number | undefined {
  if (bytes.length < 5) {
    return undefined;
  }
  let addressLength: number;
  switch (bytes[3]) {
    case IPV4:
      addressLength = 4;
      break;
    case DOMAIN_NAME:
      addressLength = 1 + (bytes[4] ?? 0);
      break;
    case IPV6:
      addressLength = 16;
      break;
    default:
      throw new Error(`test SOCKS5 proxy got an unknown address type ${bytes[3]}`);
  }
  const length = 4 + addressLength + 2;
  return bytes.length >= length ? length : undefined;
}

/** A no-auth SOCKS5 server; with a target it serves the tunnel, without one it refuses every connect */
function socks5Server(serveTarget: ((socket: Duplex) => void) | undefined): net.Server {
  return net.createServer((socket) => {
    let buffered = Buffer.alloc(0);
    let stage: "greeting" | "request" = "greeting";

    function onData(chunk: Buffer): void {
      buffered = Buffer.concat([buffered, chunk]);
      if (stage === "greeting") {
        const length = greetingLength(buffered);
        if (length === undefined) {
          return;
        }
        buffered = buffered.subarray(length);
        stage = "request";
        socket.write(Buffer.from([SOCKS_VERSION, NO_AUTH]));
      }
      const length = connectRequestLength(buffered);
      if (length === undefined) {
        return;
      }
      socket.off("data", onData);
      if (serveTarget === undefined) {
        socket.end(Buffer.from([SOCKS_VERSION, CONNECTION_NOT_ALLOWED, 0, IPV4, 0, 0, 0, 0, 0, 0]));
        return;
      }
      socket.write(Buffer.from([SOCKS_VERSION, SUCCEEDED, 0, IPV4, 0, 0, 0, 0, 0, 0]));
      const rest = buffered.subarray(length);
      if (rest.length > 0) {
        socket.unshift(rest);
      }
      serveTarget(socket);
    }

    socket.on("data", onData);
  });
}
