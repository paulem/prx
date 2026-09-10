# A probe is a full HTTPS request through the proxy

Before launching an app, prx must know the proxy is live. A TCP connect to the proxy port is not enough: the typical setup chains an HTTP proxy on localhost in front of an ssh SOCKS tunnel, and the local port keeps accepting connections after the tunnel behind it has died. So a probe sends a real HTTPS request through the proxy to a probe URL and treats any HTTP response as live. Only a connection failure, a rejected CONNECT, or a timeout means the proxy is down.

## Consequences

- A probe takes a network round trip, so it has a timeout of a few seconds rather than milliseconds.
- Each preset may name its own probe URL so the check exercises the host the app actually needs.
