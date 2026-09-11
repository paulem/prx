import { join } from "node:path";
import { BUILT_IN_HOST, type BuiltInProxyConfig } from "./config.ts";
import { PrxError } from "./errors.ts";
import type { BackgroundRequest, SystemAdapter } from "./system.ts";

/** What prx runs for a built-in proxy, both required on PATH */
export const DEPENDENCIES = ["autossh", "privoxy"] as const;
export const INSTALL_HINT = "brew install autossh privoxy";

/**
 * How long a freshly started proxy gets to become live. A tunnel that stalls once needs the
 * ServerAlive window (10 s) for ssh to give up, then a ConnectTimeout (10 s) at worst for
 * autossh to reconnect, so the wait covers both with room for the handshake
 */
export const DEFAULT_START_TIMEOUT_MS = 30_000;

type Dependency = (typeof DEPENDENCIES)[number];

interface ProcessPaths {
  pid: string;
  log: string;
}

export interface BuiltInProxyPaths {
  stateDir: string;
  privoxyConfig: string;
  autossh: ProcessPaths;
  privoxy: ProcessPaths;
}

export function builtInProxyPaths(system: SystemAdapter): BuiltInProxyPaths {
  const stateDir = system.stateDir();
  return {
    stateDir,
    privoxyConfig: join(stateDir, "privoxy.conf"),
    autossh: { pid: join(stateDir, "autossh.pid"), log: join(stateDir, "autossh.log") },
    privoxy: { pid: join(stateDir, "privoxy.pid"), log: join(stateDir, "privoxy.log") },
  };
}

/**
 * Whether both processes exist. A pid file whose process is gone is stale and is removed,
 * so a reboot leaves nothing that looks running
 */
export async function isBuiltInProxyRunning(system: SystemAdapter): Promise<boolean> {
  const paths = builtInProxyPaths(system);
  const alive = await Promise.all([
    livePid(system, paths.autossh.pid),
    livePid(system, paths.privoxy.pid),
  ]);
  return alive.every((pid) => pid !== undefined);
}

/** Checks the dependencies and ports, then starts autossh and privoxy in the background */
export async function startBuiltInProxy(
  system: SystemAdapter,
  proxy: BuiltInProxyConfig,
): Promise<void> {
  const binaries = await findDependencies(system);
  await assertPortsFree(system, [proxy.socksPort, proxy.httpPort]);

  const paths = builtInProxyPaths(system);
  await system.writeTextFile(paths.privoxyConfig, privoxyConfig(paths.stateDir, proxy));
  await startProcess(system, paths.autossh, autosshRequest(binaries.autossh, proxy, paths));
  await startProcess(system, paths.privoxy, {
    command: binaries.privoxy,
    args: ["--no-daemon", paths.privoxyConfig],
    env: {},
    logPath: paths.privoxy.log,
  });
}

/** Signals whatever is still running and removes the pid files; resolves to whether anything was running */
export async function stopBuiltInProxy(system: SystemAdapter): Promise<boolean> {
  const paths = builtInProxyPaths(system);
  const stopped = await Promise.all([
    stopProcess(system, paths.autossh.pid),
    stopProcess(system, paths.privoxy.pid),
  ]);
  return stopped.some(Boolean);
}

/** The paths of autossh and privoxy, or a dependency_missing error naming what to install */
export async function findDependencies(system: SystemAdapter): Promise<Record<Dependency, string>> {
  const found = await Promise.all(DEPENDENCIES.map((name) => system.findOnPath(name)));
  const missing = DEPENDENCIES.filter((_name, index) => found[index] === undefined);
  if (missing.length > 0) {
    const subject = missing.join(" and ");
    const verb = missing.length === 1 ? "is" : "are";
    const pronoun = missing.length === 1 ? "it" : "them";
    throw new PrxError(
      "dependency_missing",
      `${subject} ${verb} not installed.`,
      `Install ${pronoun} with: ${INSTALL_HINT}`,
    );
  }
  return { autossh: found[0] as string, privoxy: found[1] as string };
}

async function assertPortsFree(system: SystemAdapter, ports: number[]): Promise<void> {
  const free = await Promise.all(ports.map((port) => system.isPortFree(port)));
  const busy = ports.find((_port, index) => !free[index]);
  if (busy !== undefined) {
    throw new PrxError(
      "port_in_use",
      `Port ${busy} is already in use, so the built-in proxy cannot listen there.`,
    );
  }
}

// privoxy treats confdir and logdir as mandatory, so the generated config always names both
function privoxyConfig(stateDir: string, proxy: BuiltInProxyConfig): string {
  return [
    `confdir ${stateDir}`,
    `logdir ${stateDir}`,
    `listen-address ${BUILT_IN_HOST}:${proxy.httpPort}`,
    `forward-socks5 / ${BUILT_IN_HOST}:${proxy.socksPort} .`,
    "",
  ].join("\n");
}

// The option set from ADR-0004: nothing from ~/.ssh/config, never a prompt, and a tunnel that
// notices a dead connection within seconds so autossh can reconnect
function autosshRequest(
  command: string,
  proxy: BuiltInProxyConfig,
  paths: BuiltInProxyPaths,
): BackgroundRequest {
  const { tunnel } = proxy;
  const identity =
    tunnel.identityFile === undefined
      ? []
      : ["-i", tunnel.identityFile, "-o", "IdentitiesOnly=yes"];
  return {
    command,
    args: [
      "-M",
      "0",
      "-F",
      "/dev/null",
      "-N",
      "-D",
      `${BUILT_IN_HOST}:${proxy.socksPort}`,
      "-p",
      String(tunnel.port),
      "-l",
      tunnel.user,
      ...identity,
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ServerAliveInterval=5",
      "-o",
      "ServerAliveCountMax=2",
      "-o",
      "ConnectTimeout=10",
      tunnel.host,
    ],
    env: { AUTOSSH_GATETIME: "0" },
    logPath: paths.autossh.log,
  };
}

async function startProcess(
  system: SystemAdapter,
  paths: ProcessPaths,
  request: BackgroundRequest,
): Promise<void> {
  const pid = await system.startBackground(request);
  await system.writeTextFile(paths.pid, `${pid}\n`);
}

async function stopProcess(system: SystemAdapter, pidPath: string): Promise<boolean> {
  const pid = await livePid(system, pidPath);
  if (pid === undefined) {
    return false;
  }
  await system.signalProcess(pid, "SIGTERM");
  await system.remove(pidPath);
  return true;
}

/** The pid in the file when that process is alive; a stale or unreadable pid file is removed */
async function livePid(system: SystemAdapter, pidPath: string): Promise<number | undefined> {
  const text = await system.readTextFile(pidPath);
  if (text === undefined) {
    return undefined;
  }
  const pid = Number(text.trim());
  if (Number.isInteger(pid) && pid > 0 && (await system.isProcessAlive(pid))) {
    return pid;
  }
  await system.remove(pidPath);
  return undefined;
}
