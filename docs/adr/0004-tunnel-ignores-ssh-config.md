# The tunnel ignores ssh config entirely

The tunnel runs ssh in the background with no one to answer a prompt, so every option that decides whether it connects reliably must be known to prx. We store the ssh details in prx's own config, user, host, port and an optional identity file, and run ssh with `-F /dev/null` plus a fixed minimal option set: batch mode, exit on forward failure, accept-new host keys, and server-alive settings. Pointing prx at a `Host` alias would have been shorter to type, but any `~/.ssh/config` line could then change the tunnel's behaviour, or break it, without prx being able to see or report why.

## Consequences

- A passphrase-protected key must already be in ssh-agent, since batch mode never prompts.
- Jump hosts, custom ciphers and other per-host ssh options are not available to the tunnel.
- A `Host` alias cannot be used as the tunnel host; the real hostname is required.
