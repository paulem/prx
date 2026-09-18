# prx

A macOS command-line launcher that starts one app at a time through a configured proxy, so a system-wide proxy is never needed.

prx remembers one proxy, which exposes an HTTP endpoint, a SOCKS endpoint, or both. The proxy is either external, something else runs it and prx only records its endpoints, or built-in, an ssh tunnel with an HTTP endpoint in front of it that prx starts and stops itself. For each supported app prx knows how to inject an endpoint at launch. `prx run claude` probes the endpoint, refuses to continue if it is not live, and otherwise launches Claude Code with the endpoint injected. Chrome works the same way through its own preset. Everything else on the Mac keeps talking to the network directly.

## Install

prx needs Node 24 or newer and pnpm. It installs from a local checkout:

```sh
git clone git@github.com:paulem/prx.git
cd prx
./install.sh
```

The script builds a single bundled file, copies it to `~/.local/bin/prx`, and adds `~/.local/bin` to `PATH` in `~/.zshrc` inside a marked block, but only when the directory is not already on `PATH` and the block is not already there. It never prompts, and re-running it upgrades an existing install. Pass `--no-modify-path` to leave `.zshrc` alone and manage `PATH` yourself.

## Usage

```
prx run [--no-check] [--via <type>] [--json] <preset> [passthrough...]
prx init
prx up [--json]
prx down [--json]
prx status [--json]
prx list [--json]
prx config [--json]
prx uninstall [--yes]
```

Bare `prx` prints help. `--help` and `--version` work as usual.

### Output

On a terminal, output is decorated: a symbol and color mark each state, waits show a spinner that names what prx is waiting for and why the last attempt failed, and file paths are clickable links shortened with `~`. When stdout is a pipe, or `NO_COLOR` is set, every command prints the plain lines shown in this README, one fact per line, so scripts can match them. `--json` prints one object instead. Errors go to stderr as one sentence followed by a hint naming the next command to run; on a terminal the hint sits on its own line.

### `prx run <preset> [passthrough...]`

Picks the endpoint for the app, probes it, then launches the app named by the preset with that endpoint injected. Each preset lists the endpoint types it can use in order of preference, and `run` takes the first one the proxy has: Chrome goes through the SOCKS endpoint when the proxy has one and falls back to HTTP, Claude Code always uses HTTP. `--via <type>` overrides the choice for one launch, so `prx run --via http chrome` sends Chrome through the HTTP endpoint. When the preset cannot use the type, or the proxy has no endpoint of a type the preset can use, the launch fails with `endpoint_missing` and exit 2 before anything starts.

The probe goes through the chosen endpoint, so a live HTTP endpoint never hides a dead SOCKS one. Before the launch, one line on stderr names the endpoint with its type, the probe latency, and the app:

```
prx: http endpoint http://127.0.0.1:8118 is live (42 ms), launching claude
prx: socks endpoint socks5://127.0.0.1:1080 is live (31 ms), launching chrome
```

When the config names a bypass, a second line says which hosts leave the app unproxied. It lists only what you configured; the local machine is bypassed by every launch and appears nowhere:

```
prx: 2 hosts bypass the proxy: .sourcecraft.tech, .ru
```

A built-in proxy that is not running, after a reboot for instance, is started first, exactly as `prx up` starts it and with the same `dependency_missing` and `port_in_use` refusals. A built-in proxy that is running but stalled, one whose endpoint fails the probe, is restarted the same way; that is what happens after a VPN is switched on or off under a live tunnel. Either way `run` then waits up to the start timeout for the chosen endpoint alone to come live and says so on stderr before the launch line:

```
prx: started the built-in proxy
prx: http endpoint http://127.0.0.1:8118 is live (1204 ms), launching claude
```

Everything after the preset name is passed to the app verbatim as passthrough arguments, so `prx run claude --resume` runs exactly like `claude --resume`. prx's own options go before the preset name:

```sh
prx run --no-check claude --resume
```

`--no-check` skips the probe and launches anyway; it still starts a stopped built-in proxy, without waiting for it, but never restarts a running one, since without a probe it cannot tell a stalled proxy from a live one. When no config exists yet, `run` starts the init wizard first, so a first run is never a dead end. In `--json` mode the wizard is skipped and a missing config is an error, since a wrapper cannot answer prompts.

An attached launch, such as `claude`, shares your terminal and exits with the app's exit code. A detached launch, such as `chrome`, returns as soon as the app has been handed off.

### `prx init`

Sets up the proxy interactively. The first question is the proxy source, external or built-in.

For an external proxy the wizard asks, for each endpoint type, whether to record one and its address: `host:port` or `http://host:port` for the HTTP endpoint, defaulting to `127.0.0.1:8118`, and `host:port` or `socks5://host:port` for the SOCKS endpoint, defaulting to `127.0.0.1:1080`. At least one endpoint is required. It probes each endpoint right away and shows the results. If a probe fails it asks whether to save anyway, so prx can be set up before the proxy is running.

For a built-in proxy the wizard first checks that `autossh` and `privoxy` are installed and stops with the install command when one is missing, so you never fill in the whole wizard only to be refused. Then it asks for the ssh user, host and port, defaulting to 22, and the ssh key: a list of the private keys in `~/.ssh`, each with its comment, followed by the keys in ssh-agent and a path typed by hand, which is checked to exist. The key that `~/.ssh/config` names for the host is preselected, since that is the one ssh would use interactively; otherwise the first key is. Keys come before ssh-agent because a key file keeps working after a reboot, while an agent forgets its identities and the tunnel then fails with `Permission denied (publickey)`. Then the SOCKS and HTTP ports, defaulting to 1080 and 8118; a port something already listens on is reported and asked again, so `prx up` cannot fail later for a reason you could have fixed at setup. The ports a running built-in proxy listens on are its own, so a re-run keeps them without complaint. After saving, it offers to start the proxy right away, defaulting to yes, and shows the same report as `prx up`; when the proxy is running and the tunnel or a port changed, it offers a restart instead, since the running processes keep the settings they were started with.

Both paths then ask which hosts bypass the proxy, as one comma-separated line, empty for none. A re-run offers the current list back, so changing proxies never drops it. Entries are checked as they are typed: `.ru` is a whole zone, `ru` is turned down as the host it would otherwise match.

Both paths end by listing the presets with whether each app was found on this machine. Cancelling anywhere leaves the existing config untouched. Re-run the wizard any time to change the proxy: every question offers the current config's answer back, so Enter keeps a setting and only the one you came to change needs typing. Switching the source starts the other one from its defaults.

### `prx up`

Starts the built-in proxy in the background and returns once its endpoints are live. It refuses with `not_builtin` on an external proxy, since there is nothing for prx to start. Before starting anything it checks that `autossh` and `privoxy` are on `PATH`, refusing with `dependency_missing` and the install command when one is not, and that both ports are free, refusing with `port_in_use` otherwise, so the proxy never listens on a port other than the one apps are injected with. Then it writes the privoxy config, starts autossh and privoxy, and waits up to the start timeout, thirty seconds, for both endpoints to be live before printing the same report as `status`. The wait is longer than a single probe because a tunnel that stalls right after connecting takes six to nine seconds of keepalive silence to notice, and autossh needs a reconnect on top:

```
Built-in proxy started
Endpoint http://127.0.0.1:8118 is live (42 ms)
Endpoint socks5://127.0.0.1:1080 is live (31 ms)
```

Exits 0 when both endpoints are live and 1 when they are not in time, with the tunnel failure and the log directory named as `status` does; the processes are left running either way, so autossh can keep retrying while you look at the log. A running proxy is probed once: when both endpoints are live it is reported as already running and `up` exits 0, so scripts can call `up` without checking first. When an endpoint is not live the proxy is stalled, and `up` stops both processes, starts them again, and waits as after a first start, reporting `Built-in proxy restarted`. Switching a VPN on or off under a live tunnel is the usual cause: ssh notices the dead connection within seconds and autossh reconnects on its own, but `up` gets there faster than waiting. In `--json` mode the report carries `started` and `restarted`.

### `prx down`

Stops the built-in proxy: sends SIGTERM to autossh and privoxy, waits for them to exit so the ports are free again, and removes their pid files. A proxy that is not running is reported with exit 0. Refuses with `not_builtin` on an external proxy.

### `prx status`

Reports on the proxy without launching anything. For a built-in proxy the first line says whether it is running, meaning both processes exist. Then, for either source, one line per endpoint with the probe result and latency. Exits 0 only when every endpoint is live and 1 otherwise, with the reason on each line. A built-in proxy that is running but not live, a stalled one, also gets the tunnel failure, a line ssh wrote to the autossh log, and the log directory named, which tells a dead tunnel from a stopped one. The newest line prx recognises is the one reported, not simply the newest: autossh retries within seconds, and a server under that hammering answers with a reset or a closed connection that says nothing about why the tunnel never came up, burying the line that does. When prx recognises nothing in the log, the newest line is reported on its own. A rejected key, a changed host key and an unreachable host each end with a hint naming the next command; a keepalive timeout, which is what a VPN toggle leaves behind, says the tunnel is reconnecting; anything else ends with `Run prx up to restart it.`:

```
Built-in proxy is running
Endpoint http://127.0.0.1:8118 is not live: proxy rejected CONNECT with status 500
Endpoint socks5://127.0.0.1:1080 is not live: connection refused (ECONNREFUSED)
Tunnel: me@box.example.com: Permission denied (publickey).
Logs are in /Users/me/.local/state/prx
Authorize ~/.ssh/id_ed25519 on box.example.com, or run prx init to pick another key.
```

On a terminal the same report is a block: the headline carries a green, yellow or dim symbol for live, running but not live, and not running, then one aligned row per endpoint, then the tunnel failure and the log directory as a link, then the hint:

```
▲  Built-in proxy is running
   http    127.0.0.1:8118  not live  proxy rejected CONNECT with status 500
   socks   127.0.0.1:1080  not live  connection refused (ECONNREFUSED)
   tunnel  me@box.example.com: Permission denied (publickey).
   logs    ~/.local/state/prx
   Authorize ~/.ssh/id_ed25519 on box.example.com, or run prx init to pick another key.
```

A stopped proxy prints only the headline and how to start it, since its ports refusing connections is nothing to report. An endpoint that answers anyway, live or silent, gets its line, because something prx does not track is listening on that port:

```
Built-in proxy is not running
Run prx up to start it.
```

### `prx list`

Shows the presets, whether each app is installed, its launch mode, and the endpoint types it can use, most preferred first:

```
claude  found    attached  http
chrome  missing  detached  socks,http
```

### `prx config`

Prints the config path followed by the config contents.

### `prx uninstall`

Lists what it will remove, asks for confirmation, and then removes the binary, the config directory, the state directory, and the marked `PATH` block in `.zshrc`. A running built-in proxy is stopped before its state directory goes, so nothing prx started outlives it. Only the block the installer wrote is touched. `--yes` skips the confirmation for scripts.

### `--json`

`up`, `down`, `status`, `list`, `config`, and `run` accept `--json` for wrappers. In JSON mode a command prints exactly one JSON object to stdout, and for `run` the app's own output follows it. Exit codes are the same as in text mode. An error is `{"error":{"code":...,"message":...}}`, with a `hint` field naming the next command when there is one; the message still contains the hint sentence, so a wrapper can show either.

```sh
prx status --json
# {"source":"external","endpoints":{"http":{"host":"127.0.0.1","port":8118,"live":true,"latencyMs":42},"socks":{"host":"127.0.0.1","port":1080,"live":false,"reason":"refused","message":"connection refused (ECONNREFUSED)"}}}
# {"source":"built-in","running":true,"endpoints":{...}}
# {"source":"built-in","running":true,"endpoints":{...},"tunnelFailure":{"message":"me@box.example.com: Permission denied (publickey).","hint":"..."}}

prx up --json
# {"source":"built-in","running":true,"started":true,"endpoints":{...}}

prx down --json
# {"stopped":true}

prx list --json
# {"presets":[{"name":"claude","found":true,"launch":"attached","endpoints":["http"]},{"name":"chrome","found":false,"launch":"detached","endpoints":["socks","http"]}]}

prx config --json
# {"path":"/Users/me/.config/prx/config.json","config":{"version":1,"proxy":{...}}}

prx run --json chrome
# {"preset":"chrome","endpoint":{"type":"socks","host":"127.0.0.1","port":1080},"latencyMs":31,"bypass":[".sourcecraft.tech",".ru"]}
```

`run --json` prints the launch object before the app starts. With `--no-check`, `latencyMs` is `null`. `bypass` carries the configured hosts in the spelling prx injected, and is left out when the config names none. No PID is reported.

Errors in JSON mode are a JSON object on stdout with a stable code and a message:

```json
{
  "error": {
    "code": "proxy_not_live",
    "message": "Endpoint http://127.0.0.1:8118 is not live: no response from the proxy before the timeout"
  }
}
```

The codes are `config_missing`, `config_invalid`, `proxy_not_live`, `unknown_preset`, `app_not_installed`, `app_already_running`, `endpoint_missing`, `dependency_missing`, `port_in_use`, and `not_builtin`:

| Code                 | Meaning                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `endpoint_missing`   | The proxy has no endpoint of a type the preset can use, or `--via` names one it cannot      |
| `dependency_missing` | `autossh` or `privoxy` is not on `PATH`; the message carries `brew install autossh privoxy` |
| `port_in_use`        | Something already listens on a port the built-in proxy would use                            |
| `not_builtin`        | `up` or `down` was run against an external proxy, which prx does not control                |

## Presets

A preset is a built-in description of how to launch one app through the proxy: where the app lives, which endpoint types it can use, how the endpoint is injected, and how it is launched. Presets are defined in code, one file per app, under `src/presets/`. There are no user-defined presets.

| Preset   | App                                                        | Endpoints       | Injection             | Launch   |
| -------- | ---------------------------------------------------------- | --------------- | --------------------- | -------- |
| `claude` | `claude` on `PATH`                                         | `http`          | environment variables | attached |
| `chrome` | `Google Chrome.app` in `/Applications` or `~/Applications` | `socks`, `http` | command-line argument | detached |

### claude

An attached launch of Claude Code with `HTTP_PROXY`, `HTTPS_PROXY`, and their lowercase variants set to the HTTP endpoint's URL. Claude Code does not support SOCKS proxies, so the preset lists only `http`. `NO_PROXY` and `no_proxy` carry `localhost,127.0.0.1,::1` followed by everything `proxy.bypass` names, so Claude Code still reaches local servers such as MCP servers, and remote ones the proxy cannot serve, without going through the proxy. Before the launch, the probe goes to `https://api.anthropic.com/`, the host Claude Code actually needs. prx exits with Claude Code's exit code.

### chrome

Launches a new Chrome instance through the macOS `open` command with `--proxy-server=<endpoint URL>` and `--proxy-bypass-list=<bypass>` as arguments, followed by any passthrough arguments and then `https://api.ipify.org` as a landing page. The bypass list is the same one Claude Code gets, spelled the way Chrome reads it; Chrome bypasses loopback on its own, so the local entries in it change nothing. The URL is `socks5://host:port` for a SOCKS endpoint, which Chrome prefers when the proxy has one, and `http://host:port` otherwise; with `socks5://` Chrome resolves DNS on the proxy side. The landing page opens as a tab showing the address the proxy exits from, so a glance tells this window apart from an unproxied Chrome; Chrome itself gives no visible sign that a proxy flag is in effect. Chrome keeps your normal profile. The launch is detached, so prx returns immediately and does not capture Chrome's output.

**Chrome must not already be running.** Chrome ignores proxy flags when an instance already exists: the flag would be silently dropped and you would get an unproxied window that looks proxied. prx checks for a running instance before launching and refuses with exit code 3 and an explanation. Quit Chrome and run again.

## The built-in proxy

With `source: built-in`, prx runs the proxy itself from an ssh destination you give it: autossh keeps an ssh dynamic forward open, which is the SOCKS endpoint, and privoxy listens in front of it as the HTTP endpoint, forwarding everything to the tunnel. Both are Homebrew binaries prx expects on `PATH` and never installs; a missing one is reported with `brew install autossh privoxy`. See [ADR-0003](docs/adr/0003-built-in-proxy-runs-autossh-and-privoxy-detached.md).

`prx up` starts both as detached background processes, so your terminal is free and the proxy keeps running across app launches; `prx down` stops them; `prx status` tells running from live. A proxy that is running can still have a dead endpoint, for instance while the tunnel reconnects, which is why `status` reports both.

The tunnel ignores `~/.ssh/config` entirely and runs ssh with `-F /dev/null` and a fixed option set: batch mode, so it never prompts; exit on forward failure; `StrictHostKeyChecking=accept-new`, so a first connection to a new host works in the background and a changed key still fails; and server-alive settings that notice a dropped connection within seconds so autossh can reconnect. A passphrase-protected key must already be in ssh-agent, since batch mode has nobody to ask for the passphrase; when the tunnel is denied, prx reads the key to tell a locked one apart from an unauthorized one and names the `ssh-add` command instead of sending you to the server. Jump hosts, `Host` aliases and other ssh config options are not available; `prx init` reads `~/.ssh/config` only to preselect the key it names for the host. See [ADR-0004](docs/adr/0004-tunnel-ignores-ssh-config.md).

The pid files, the generated privoxy config and both log files live in the state directory, `~/.local/state/prx` or `$XDG_STATE_HOME/prx`, never in the config directory, so `prx config` still prints only what you edit by hand. Each start replaces the log files, so a log only ever describes the current run. A pid file whose process is gone, after a reboot for instance, counts as not running and is removed. The built-in proxy does not survive a reboot; `prx up` starts it again.

## How it works

### Per-app injection, no system proxy

prx never touches macOS network settings, the launchd environment, or any other global proxy mechanism. Instead, the proxy is injected into each app at launch, through environment variables or command-line arguments, depending on the preset. That is the whole point: a few chosen apps go through the proxy while everything else on the Mac keeps using the network directly.

The consequences follow from that choice, and are recorded in [ADR-0001](docs/adr/0001-per-app-injection-not-system-proxy.md):

- An app's traffic is proxied only when it is launched through prx. Launching the same app directly is unproxied by design.
- An app that ignores both environment variables and proxy arguments cannot be supported until a dedicated injection kind exists for it.

### The probe

Before every launch, prx must know the endpoint is live. A TCP connect to the endpoint's port is not enough: the typical setup chains an HTTP proxy on localhost in front of an ssh SOCKS tunnel, and the local port keeps accepting connections after the tunnel behind it has died.

So a probe is a real HTTPS request through the endpoint to a probe URL, with a five-second timeout. An HTTP endpoint gets a CONNECT tunnel, a SOCKS endpoint a SOCKS5 connect without auth; the request through the tunnel is the same. Any HTTP response counts as live. Only these count as not live, and the reason is reported:

| Reason      | Meaning                                                                            |
| ----------- | ---------------------------------------------------------------------------------- |
| `refused`   | The connection to the endpoint failed                                              |
| `rejected`  | The proxy answered the CONNECT with an error status, or refused the SOCKS5 connect |
| `timed_out` | Nothing came back before the timeout                                               |
| `failed`    | Something else went wrong; the message carries the details                         |

The default probe URL is `https://example.com/`, which `prx status` and `prx init` always use. A preset may name its own for `prx run`, so the probe exercises the host the app actually needs; the claude preset probes the Anthropic API host. See [ADR-0002](docs/adr/0002-probe-is-a-full-https-request.md).

## Config

The config lives at `~/.config/prx/config.json`, or under `$XDG_CONFIG_HOME/prx/` when that variable is set. `prx init` writes it, `prx config` prints it, and `prx uninstall` deletes the directory. It is a small JSON file you can also edit by hand:

```json
{
  "version": 1,
  "proxy": {
    "source": "external",
    "endpoints": {
      "http": { "host": "127.0.0.1", "port": 8118 },
      "socks": { "host": "127.0.0.1", "port": 1080 }
    },
    "bypass": [".sourcecraft.tech", ".ru"]
  }
}
```

`version` is always `1` today and exists so a future shape change can be migrated. `source` says who runs the proxy, `external` or `built-in`. An external proxy records `endpoints`, keyed by endpoint type, `http` and `socks`, with at least one required. A built-in proxy records the tunnel and the two ports instead; its endpoints are both on `127.0.0.1`:

```json
{
  "version": 1,
  "proxy": {
    "source": "built-in",
    "tunnel": {
      "user": "me",
      "host": "box.example.com",
      "port": 22,
      "identityFile": "/Users/me/.ssh/id_ed25519"
    },
    "socksPort": 1080,
    "httpPort": 8118
  }
}
```

`identityFile` is optional; without it ssh uses the keys in ssh-agent. A config in the earlier single-address shape is reported as invalid with a pointer to `prx init`. Probe URLs and the timeouts are not stored, they are code-level defaults.

`bypass` is optional and belongs to whichever source the proxy has. It names hosts that go direct instead of through this proxy, which is what a service the proxy's exit cannot reach, or one that must see your own address, needs. It sits under `proxy` because it describes where that proxy exits: change proxies and the list is worth revisiting. An entry is either an exact host, `api.example.com`, or a suffix, `.example.com`, `*.example.com` or a whole zone such as `.ru`; an international zone is stored as punycode, so `.рф` is saved as `.xn--p1ai`. Nothing else is accepted, because prx hands the list to each app rather than matching it itself and only these forms mean the same thing to both `NO_PROXY` and Chrome: ports, address ranges, inner wildcards and a dotless label such as `ru` are refused with `config_invalid` and exit 2. `localhost`, `127.0.0.1` and `::1` are bypassed by every launch and cannot be removed.

A bypass is the one hole in prx's proxying, so a wrong entry sends traffic you meant to hide out through your own address without saying so. See [ADR-0005](docs/adr/0005-configured-bypass-sends-chosen-hosts-direct.md).

## Exit codes

| Code       | Meaning                                                                                                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`        | Success                                                                                                                                                                                         |
| `1`        | An endpoint is not live, from `run`, `up` or `status`, or the init wizard was cancelled                                                                                                         |
| `2`        | Usage error: unknown command or option, unknown preset, app not installed, missing endpoint, missing dependency, busy port, `up` or `down` on an external proxy, or a missing or invalid config |
| `3`        | Chrome is already running                                                                                                                                                                       |
| app's code | An attached launch exits with the app's own exit code, or 128 plus the signal number when a signal killed the app                                                                               |

Exit codes are identical in `--json` mode.

## Roadmap

- **More presets with new injection kinds.** Desktop apps such as ChatGPT and Claude desktop ignore environment variables and proxy flags, so each needs its own injection kind alongside the existing environment and argument kinds.
- **Realtime probing with blocking of unproxied traffic.** Today the proxy is probed once, before launch. The next step is to keep probing while the app runs and block its traffic when the proxy breaks mid-session, so nothing leaks unproxied. How to block without a system-wide mechanism, which ADR-0001 rules out, is an open question.

## Development

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

The shipped artifact is `dist/prx.js`, one bundled file with a node shebang. All OS touchpoints go through a single system adapter, which is the seam the tests substitute. Vocabulary follows [CONTEXT.md](CONTEXT.md).

## License

[MIT](LICENSE)
