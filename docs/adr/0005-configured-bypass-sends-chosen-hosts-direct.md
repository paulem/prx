# A configured bypass sends chosen hosts direct

Some services must see the machine's real address while the same app's main traffic must not, and no choice of exit node satisfies both. So the split is configurable: prx builds `NO_PROXY` and `--proxy-bypass-list` from `proxy.bypass`, and traffic to those hosts leaves a proxied app unproxied on purpose. The list sits under `proxy` because it describes where that particular proxy exits. An inherited `NO_PROXY` is discarded rather than merged, so a launch cannot be altered by the shell it started from and `prx config` always shows the whole truth.

## Consequences

- An app launched through prx is proxied except for the hosts the config names, so a wrong entry is a silent leak rather than a reported error.
- Only exact hostnames and suffixes are accepted, including single-label zones such as `.ru`; ports, CIDR and wildcards beyond `*.host` are refused at config load, because prx delegates the matching to each app and can only promise what both dialects honour.
- The local machine is always bypassed and cannot be removed from the list.
