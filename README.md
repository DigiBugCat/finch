# finch

finch gives the MCP server on your Mac or Linux machine a stable `https://`
address, with keys or OAuth sign-in at the door. Your machine dials out to
finch, so no port is opened and nothing on it listens to the internet. It works
for any local HTTP app, not just MCP. The hosted version at
[finchmcp.com](https://finchmcp.com) is free, and everything here is MIT
licensed so you can [run your own](docs/self-host.md).

```text
  MCP client                      finch hub (Cloudflare)                     your machine
 ┌───────────┐  HTTPS    ┌───────────────────────────────┐   WSS, dialed   ┌──────────────────┐
 │ Claude,   │ ────────▶ │ checks the key or OAuth token │ ◀────────────── │ finch            │
 │ Cursor,   │  finch_   │ strips it, picks the machine  │  out from your  │   │              │
 │ Codex, …  │  key or   │ streams the answer back       │  machine; no    │   ▼              │
 └───────────┘  OAuth    └───────────────────────────────┘  open ports     │ your MCP server  │
                                                                           │ 127.0.0.1:8000   │
                                                                           └──────────────────┘
```

## Quickstart

On macOS or Linux, with an MCP server already running on
`http://127.0.0.1:8000`:

```sh
curl -fsSL https://finchmcp.com/install | sh    # no sudo; installs to ~/.local/bin if needed
finch login                                      # opens your browser; approve and it carries on
finch add notes --service http://127.0.0.1:8000  # prints https://<your-slug>.finchmcp.com/notes/mcp
finch service install                            # keeps it running (launchd or systemd --user)
finch test notes                                 # lists the server's tools through finch
finch connect notes --client claude-code         # or cursor, codex, json
```

`<your-slug>` is your **account address**: a name like `amber-wren-42` that
finch gives your account the first time you use it. Every service you add lives
under it, at `https://<your-slug>.finchmcp.com/<service>/mcp`.

`finch connect` mints a key for that one service and writes it into the
client's configuration without printing it. From there:

| To | Run |
|---|---|
| See your services and their URLs | `finch status` or `finch fleet` |
| See recent calls (time, route, caller, status, duration) | `finch logs notes` |
| Point a service at a different local port | `finch add notes --service http://127.0.0.1:9000` (re-running `add` updates it) |
| Publish a web app or REST API, not just `/notes/mcp` | `finch add site --service http://127.0.0.1:3000 --forward-all` |
| Open a service to anyone with the URL | add `--public` to `finch add` |
| Remove a service, here and on the hub | `finch rm notes` |
| Update finch | `finch update` |
| Remove finch from this machine | `finch uninstall` (it prints how to delete the binary) |
| Read a command's help | `finch help <command>` or `finch <command> -h` |

Every command takes `--json` and uses fixed exit codes (0 ok, 1 error,
2 usage, 10 waiting for approval, 11 expired, 12 not logged in), so scripts
and agents can branch on them. A runnable example server lives in
[`examples/hello-mcp/`](examples/hello-mcp/).

### Or have your agent do it

Paste this into Claude Code, Cursor, Codex or another coding agent:

> Read https://finchmcp.com/agents.md and use finch to publish my MCP server on
> http://127.0.0.1:8000 as notes. Show me the sign-in link when you get it. Run
> it as a background service, check it with finch test, then connect it to this
> agent.

The agent installs finch, shows you a sign-in link to approve, and does the
rest. [`web/public/agents.md`](web/public/agents.md) is the guide it follows.

## How it works

The hub is a Cloudflare Worker with three Durable Objects: a global index from
account address to account, one object per account (services, machines, key
hashes, call records), and one per service per machine that holds the
machine's WebSocket.

```text
client ─ POST /notes/mcp (Bearer finch_…) ─▶ Worker
   rate limit → check the key or OAuth token → strip it → pick a machine
      └─▶ Durable Object ── req ──▶ finch on your machine ── HTTP ──▶ local server
                         ◀─ head ──  (status and headers, as soon as they exist)
                         ◀─ chunk ─  chunk … (the body streams)
                         ◀─ end ───
   the Worker streams the response straight back to the client
```

- **Your machine to finch.** `finch login` is a device-code sign-in you approve
  in the browser. `finch add` enrolls a service and saves a long-lived
  credential for it; `finch run` trades that for a two-minute connect token each
  time it dials. Nothing is exposed on your machine.
- **Callers to your service.** A service needs a `finch_` key (hashed at rest,
  scoped to services) or a Clerk OAuth sign-in by you, unless you made it
  public. finch removes the credential before relaying, so your server never
  sees it; for signed-in callers it adds a signed `X-Finch-Assertion` your
  server can verify ([`worker/CALLER_ASSERTIONS.md`](worker/CALLER_ASSERTIONS.md)).
- **The relay does not parse MCP.** It moves HTTP bytes, so unmodified
  Streamable-HTTP servers (FastMCP, the MCP SDKs) work, including SSE, progress
  notifications and long-running tools. By default only `/<service>/mcp` is
  forwarded; `--forward-all` forwards the whole service.

The wire format is in [`docs/relay-protocol.md`](docs/relay-protocol.md), and
the full security model in
[`docs/security-and-deploy.md`](docs/security-and-deploy.md).

## Security and privacy

Traffic is encrypted in transit: HTTPS from the client to finch, WSS from finch
to your machine. finch is **not** end-to-end encrypted. Cloudflare terminates
TLS, and the relay handles request and response bodies in plaintext while it
forwards them. It does not log or store those bodies, and it sends nothing to an
AI model. It keeps call metadata (time, route, caller label, status, duration)
and your account's configuration. The hop from finch to your local server is
yours: loopback stays on your machine, and anything else should use `https://`.
The complete boundary is in [`docs/privacy.md`](docs/privacy.md).

To report a vulnerability, see [`SECURITY.md`](SECURITY.md).

## Run your own

The hub, website and CLI in this repository are what runs finchmcp.com.
[`docs/self-host.md`](docs/self-host.md) walks through deploying them on your
own Cloudflare account with your own Clerk sign-in, and pointing the CLI at them
with `finch login --hub https://your-hub`. Today a self-hosted hub serves one
account under one hostname; per-account subdomains on your own domain need the
code changes listed in [`docs/self-host-coupling.md`](docs/self-host-coupling.md).

## Repository layout

| Path | What |
|---|---|
| [`agent/`](agent/) | The `finch` CLI and relay agent (Go). macOS and Linux, amd64 and arm64, plus 32-bit ARM Linux. |
| [`worker/`](worker/) | The hub: Cloudflare Worker and Durable Objects (TypeScript). |
| [`web/`](web/) | The website: landing page, docs, sign-in and the `finch login` approval page (Next.js on Cloudflare via OpenNext). |
| [`docs/`](docs/) | Specs, the self-hosting guide, and archived design history ([index](docs/README.md)). |
| [`examples/`](examples/) | A dependency-free MCP server to test with, and a Docker Compose setup. |
| [`scripts/`](scripts/) | Repository checks: version sync, the installer, and assertion test vectors. |

## Contributing

Issues and pull requests are welcome. [`CONTRIBUTING.md`](CONTRIBUTING.md)
covers the development setup for each part, the tests to run, and how releases
are cut. Changes are listed in [`CHANGELOG.md`](CHANGELOG.md).

## License

[MIT](LICENSE).
