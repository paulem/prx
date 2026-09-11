# The built-in proxy runs autossh and privoxy as detached processes

A built-in proxy needs an ssh dynamic forward that survives dropped connections, and an HTTP endpoint in front of it because Claude Code does not speak SOCKS. We run autossh for the tunnel and privoxy for the HTTP endpoint, both as detached processes that `prx up` starts and `prx down` stops, tracked through pid files in the state directory. Both are required Homebrew binaries; prx checks for them and refuses with an install hint, it never installs them.

## Considered options

- **launchd user agents.** Would survive logout and reboot and restart crashed processes, but prx would then own plists, `launchctl` calls, and a launchd-shaped notion of "running". autossh already covers reconnects, and surviving a reboot is not a requirement today.
- **In-process code, no dependencies.** prx could supervise a plain `ssh -D` and run its own HTTP CONNECT-to-SOCKS converter in Node. It is the only option that works on a Mac with no Homebrew, but it turns prx into a long-running daemon and replaces two battle-tested tools with code prx has to own and test.

## Consequences

- A built-in proxy does not survive a reboot; `prx run` starts it again when needed.
- The built-in source only works where autossh and privoxy are installed.
- Running and Live are separate states: the processes can exist while an endpoint is not live, so `prx status` reports both.
