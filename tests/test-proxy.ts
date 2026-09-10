import { readFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import tls from "node:tls";

/**
 * How the in-process proxy answers a CONNECT request:
 * - live: accepts the tunnel and answers the HTTPS request itself
 * - reject: accepts TCP but refuses the tunnel with 403
 * - silent: accepts TCP and never answers
 */
export type TestProxyMode = "live" | "reject" | "silent";

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

export function startTestProxy(mode: TestProxyMode): Promise<TestProxy> {
  const sockets = new Set<import("node:net").Socket>();
  const target = http.createServer((_request, response) => {
    response.writeHead(204);
    response.end();
  });
  const proxy = http.createServer((_request, response) => {
    response.writeHead(400);
    response.end();
  });

  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
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
    const secureSocket = new tls.TLSSocket(socket, {
      isServer: true,
      cert: probeTargetCert,
      key: probeTargetKey,
    });
    target.emit("connection", secureSocket);
  });

  return new Promise((resolve) => {
    proxy.listen(0, "127.0.0.1", () => {
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
