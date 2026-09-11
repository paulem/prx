# prx

A macOS command-line launcher that starts one app at a time through a configured proxy, so a system-wide proxy is never needed.

## Language

**Proxy**:
What prx routes apps through. It has one or more endpoints and exactly one source, external or built-in.
_Avoid_: upstream, server

**Endpoint**:
A host, port and endpoint type that an app's traffic is routed through. A proxy exposes one endpoint per type.
_Avoid_: address, listener, port

**Endpoint type**:
The protocol an endpoint speaks, `http` or `socks`, which decides how prx and apps reach it.
_Avoid_: proxy type, proxy kind, backend, provider, scheme

**External proxy**:
A proxy someone else runs. prx only records its endpoints and never starts or stops it.
_Avoid_: manual proxy, remote proxy, user proxy

**Built-in proxy**:
A proxy prx runs itself, as a tunnel with an HTTP endpoint layered in front of the tunnel's SOCKS endpoint.
_Avoid_: managed proxy, internal proxy, local proxy, daemon

**Tunnel**:
The ssh connection the built-in proxy keeps open to a remote machine, which exposes the SOCKS endpoint.
_Avoid_: ssh session, dynamic forward, socks server

**Running**:
The state of a built-in proxy whose processes exist. Running says nothing about whether an endpoint is live.
_Avoid_: started, up, active, alive

**App**:
A program that prx launches on the user's behalf, such as Claude Code or Chrome. "Child process" is used only for the literal OS process of an attached launch.
_Avoid_: child, target, program, tool

**Preset**:
A built-in description of how to launch one app through the proxy: where the app lives, how the proxy is injected, and how it is launched.
_Avoid_: profile, app config, launcher

**Probe**:
A single HTTPS request sent through an endpoint to decide whether it is live.
_Avoid_: health check, ping, liveness check, connectivity test

**Live**:
The state of an endpoint whose probe succeeded within the timeout.
_Avoid_: up, healthy, reachable, working

**Injection**:
The way an endpoint is handed to an app: environment variables or command-line arguments.
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

**Hint**:
The next command a person should run after an error, shown apart from the error's message.
_Avoid_: suggestion, tip, advice, help text
