# prx

A macOS command-line launcher that starts one app at a time through a configured proxy, so a system-wide proxy is never needed.

## Language

**Proxy**:
The single configured endpoint, a host and port, that an app's network traffic is routed through.
_Avoid_: tunnel, upstream, server

**Proxy type**:
The kind of proxy recorded in the config, which decides how prx reaches it. Only `http` exists today.
_Avoid_: proxy kind, backend, provider

**App**:
A program that prx launches on the user's behalf, such as Claude Code or Chrome. "Child process" is used only for the literal OS process of an attached launch.
_Avoid_: child, target, program, tool

**Preset**:
A built-in description of how to launch one app through the proxy: where the app lives, how the proxy is injected, and how it is launched.
_Avoid_: profile, app config, launcher

**Probe**:
A single HTTPS request sent through the proxy to decide whether it is live.
_Avoid_: health check, ping, liveness check, connectivity test

**Live**:
The state of a proxy whose probe succeeded within the timeout.
_Avoid_: up, healthy, reachable, working

**Injection**:
The way the proxy address is handed to an app: environment variables or command-line arguments.
_Avoid_: proxy mode, method, strategy

**Attached launch**:
A launch where prx stays in the foreground, shares the terminal with the app, and exits with the app's exit code.
_Avoid_: foreground, blocking, interactive

**Detached launch**:
A launch where prx starts the app and returns immediately without waiting for it.
_Avoid_: background, fire-and-forget

**Passthrough arguments**:
Everything on the command line after the app's name, handed to the app verbatim.
_Avoid_: extra args, child args, rest args

**Bypass**:
Hosts whose traffic goes directly to the network instead of through the proxy. Always the local machine itself.
_Avoid_: exclusions, no-proxy list, whitelist
