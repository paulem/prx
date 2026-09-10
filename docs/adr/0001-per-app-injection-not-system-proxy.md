# Inject the proxy per app, never system-wide

prx exists to route specific apps through a proxy while everything else on the Mac keeps using the network directly. We inject the proxy into each app at launch, through environment variables or command-line arguments, and never touch macOS network settings, launchd environment, or any global proxy mechanism. A system-wide proxy would be simpler to implement but would proxy every process, which is exactly the behaviour this tool is built to avoid.

## Consequences

- Apps that ignore both environment variables and proxy arguments cannot be supported until a dedicated injection kind exists for them.
- Traffic from an app is only proxied when it is launched through prx. Launching the same app directly is unproxied by design.
