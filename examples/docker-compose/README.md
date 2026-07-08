# finch + docker compose

Run the finch agent as a **tunnel sidecar** in a compose stack: your MCP
server in one container, the agent in another, one named volume for the
agent's state. No ports are published to the host — the agent dials out.

## Quick start

```bash
cd examples/docker-compose

# 1. log in (CLI token: dashboard → Settings → CLI access → Generate)
docker compose run --rm finch login --hub https://finchmcp.com <token>

# 2. enroll the demo server — note the URL is the compose service name
docker compose run --rm finch add hello --service http://hello-mcp:8000 --name "Hello MCP"

# 3. serve
docker compose up -d
docker compose logs -f finch     # prints the public URL

# 4. verify through the hub
docker compose run --rm finch test hello
```

Everything the agent needs (`cli.json`, per-service credentials, `finch.yml`)
lives under `/data` in the `finch-data` volume, so steps 1–2 are one-time;
`docker compose up` resumes ticketless forever after, across restarts and
reboots (`restart: unless-stopped`).

## Using your own MCP server

Replace the `hello-mcp` service with your own container and enroll it by its
compose DNS name:

```bash
docker compose run --rm finch add myapp --service http://myapp:9000
```

The agent's SSRF confinement pins forwarding to exactly the upstream you
enrolled, so container-to-container URLs work the same as loopback ones.

To tunnel a server running **on the host** instead, use
`http://host.docker.internal:8000` (on Linux add
`extra_hosts: ["host.docker.internal:host-gateway"]` to the finch service).

## Other CLI commands

Any `finch` subcommand works through `docker compose run --rm finch …`:
`status`, `fleet`, `keys mint`, `call`, `rm`, … The entrypoint is the binary
itself; the default command is `run`.

## Updating

`finch update` self-swaps a binary — that's the wrong model in a container.
Upgrade by rebuilding the image (`docker compose build --pull finch`) or
pulling a newer published image, then `docker compose up -d`.
