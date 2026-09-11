# prx

A macOS command-line launcher that starts one app at a time through a configured proxy, so a system-wide proxy is never needed.

prx remembers one proxy, which exposes an HTTP endpoint, a SOCKS endpoint, or both. For each supported app it knows how to inject an endpoint at launch. `prx run claude` probes the endpoint, refuses to continue if it is not live, and otherwise launches Claude Code with the endpoint injected. Chrome works the same way through its own preset. Everything else on the Mac keeps talking to the network directly.

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
prx status [--json]
prx list [--json]
prx config [--json]
prx uninstall [--yes]
```

Bare `prx` prints help. `--help` and `--version` work as usual.

### `prx run <preset> [passthrough...]`

Picks the endpoint for the app, probes it, then launches the app named by the preset with that endpoint injected. Each preset lists the endpoint types it can use in order of preference, and `run` takes the first one the proxy has: Chrome goes through the SOCKS endpoint when the proxy has one and falls back to HTTP, Claude Code always uses HTTP. `--via <type>` overrides the choice for one launch, so `prx run --via http chrome` sends Chrome through the HTTP endpoint. When the preset cannot use the type, or the proxy has no endpoint of a type the preset can use, the launch fails with `endpoint_missing` and exit 2 before anything starts.

The probe goes through the chosen endpoint, so a live HTTP endpoint never hides a dead SOCKS one. Before the launch, one line on stderr names the endpoint with its type, the probe latency, and the app:

```
prx: http endpoint http://127.0.0.1:8118 is live (42 ms), launching claude
prx: socks endpoint socks5://127.0.0.1:1080 is live (31 ms), launching chrome
```

Everything after the preset name is passed to the app verbatim as passthrough arguments, so `prx run claude --resume` runs exactly like `claude --resume`. prx's own options go before the preset name:

```sh
prx run --no-check claude --resume
```

`--no-check` skips the probe and launches anyway. When no config exists yet, `run` starts the init wizard first, so a first run is never a dead end. In `--json` mode the wizard is skipped and a missing config is an error, since a wrapper cannot answer prompts.

An attached launch, such as `claude`, shares your terminal and exits with the app's exit code. A detached launch, such as `chrome`, returns as soon as the app has been handed off.

### `prx init`

Sets up the proxy interactively. The wizard asks for the proxy source (only an external proxy exists today), then for each endpoint type whether to record one and its address: `host:port` or `http://host:port` for the HTTP endpoint, defaulting to `127.0.0.1:8118`, and `host:port` or `socks5://host:port` for the SOCKS endpoint, defaulting to `127.0.0.1:1080`. At least one endpoint is required. It probes each endpoint right away and shows the results. If a probe fails it asks whether to save anyway, so prx can be set up before the proxy is running. It ends by saving the config and listing the presets with whether each app was found on this machine. Re-run it any time to change the proxy.

### `prx status`

Probes every endpoint of the proxy and prints one line per endpoint with the result and latency, without launching anything. Exits 0 only when every endpoint is live and 1 otherwise, with the reason on each line.

```
Endpoint http://127.0.0.1:8118 is live (42 ms)
Endpoint socks5://127.0.0.1:1080 is not live: connection refused (ECONNREFUSED)
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

Lists what it will remove, asks for confirmation, and then removes the binary, the config directory, and the marked `PATH` block in `.zshrc`. Only the block the installer wrote is touched. `--yes` skips the confirmation for scripts.

### `--json`

`status`, `list`, `config`, and `run` accept `--json` for wrappers. In JSON mode a command prints exactly one JSON object to stdout, and for `run` the app's own output follows it. Exit codes are the same as in text mode.

```sh
prx status --json
# {"source":"external","endpoints":{"http":{"host":"127.0.0.1","port":8118,"live":true,"latencyMs":42},"socks":{"host":"127.0.0.1","port":1080,"live":false,"reason":"refused","message":"connection refused (ECONNREFUSED)"}}}

prx list --json
# {"presets":[{"name":"claude","found":true,"launch":"attached","endpoints":["http"]},{"name":"chrome","found":false,"launch":"detached","endpoints":["socks","http"]}]}

prx config --json
# {"path":"/Users/me/.config/prx/config.json","config":{"version":1,"proxy":{...}}}

prx run --json chrome
# {"preset":"chrome","endpoint":{"type":"socks","host":"127.0.0.1","port":1080},"latencyMs":31}
```

`run --json` prints the launch object before the app starts. With `--no-check`, `latencyMs` is `null`. No PID is reported.

Errors in JSON mode are a JSON object on stdout with a stable code and a message:

```json
{
  "error": {
    "code": "proxy_not_live",
    "message": "Endpoint http://127.0.0.1:8118 is not live: no response from the proxy before the timeout"
  }
}
```

The codes are `config_missing`, `config_invalid`, `proxy_not_live`, `unknown_preset`, `app_not_installed`, `app_already_running`, and `endpoint_missing`, the last one when the proxy has no endpoint of a type the preset can use, or `--via` names one it cannot.

## Presets

A preset is a built-in description of how to launch one app through the proxy: where the app lives, which endpoint types it can use, how the endpoint is injected, and how it is launched. Presets are defined in code, one file per app, under `src/presets/`. There are no user-defined presets.

| Preset   | App                                                        | Endpoints       | Injection             | Launch   |
| -------- | ---------------------------------------------------------- | --------------- | --------------------- | -------- |
| `claude` | `claude` on `PATH`                                         | `http`          | environment variables | attached |
| `chrome` | `Google Chrome.app` in `/Applications` or `~/Applications` | `socks`, `http` | command-line argument | detached |

### claude

An attached launch of Claude Code with `HTTP_PROXY`, `HTTPS_PROXY`, and their lowercase variants set to the HTTP endpoint's URL. Claude Code does not support SOCKS proxies, so the preset lists only `http`. `NO_PROXY` and `no_proxy` carry the bypass `localhost,127.0.0.1,::1`, so Claude Code can still reach local servers such as MCP servers without going through the proxy. Before the launch, the probe goes to `https://api.anthropic.com/`, the host Claude Code actually needs. prx exits with Claude Code's exit code.

### chrome

Launches a new Chrome instance through the macOS `open` command with `--proxy-server=<endpoint URL>` as an argument, followed by any passthrough arguments. The URL is `socks5://host:port` for a SOCKS endpoint, which Chrome prefers when the proxy has one, and `http://host:port` otherwise; with `socks5://` Chrome resolves DNS on the proxy side. Chrome keeps your normal profile. The launch is detached, so prx returns immediately and does not capture Chrome's output.

**Chrome must not already be running.** Chrome ignores proxy flags when an instance already exists: the flag would be silently dropped and you would get an unproxied window that looks proxied. prx checks for a running instance before launching and refuses with exit code 3 and an explanation. Quit Chrome and run again.

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
    }
  }
}
```

`version` is always `1` today and exists so a future shape change can be migrated. `source` says who runs the proxy; only `external` exists today. `endpoints` is keyed by endpoint type, `http` and `socks`, and needs at least one. A config in the earlier single-address shape is reported as invalid with a pointer to `prx init`. Probe URLs and the timeout are not stored, they are code-level defaults.

## Exit codes

| Code       | Meaning                                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| `0`        | Success                                                                                                                     |
| `1`        | The proxy is not live, or the init wizard was cancelled                                                                     |
| `2`        | Usage error: unknown command or option, unknown preset, app not installed, missing endpoint, or a missing or invalid config |
| `3`        | Chrome is already running                                                                                                   |
| app's code | An attached launch exits with the app's own exit code, or 128 plus the signal number when a signal killed the app           |

Exit codes are identical in `--json` mode.

## Roadmap

- **Built-in ssh SOCKS tunnel.** prx opens the ssh dynamic forward itself and runs an HTTP endpoint in front of it, so no separate proxy needs to run. The `source` field on the proxy config is the hook for this second source.
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
