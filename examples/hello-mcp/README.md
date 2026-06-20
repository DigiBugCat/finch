# hello-mcp — test finch end to end

A tiny, dependency-free MCP server (tools: `echo`, `add`, `now`, `roll`) you can
expose through finch in three commands. No `pip install`.

## 1. Run the server

```bash
python3 server.py          # → http://127.0.0.1:8000
```

Check it's alive: `curl http://127.0.0.1:8000` → lists the tools.

## 2. Build finch (until releases are cut)

```bash
cd ../../agent && go build -o /tmp/finch . && cd -
alias finch=/tmp/finch
```

## 3. Expose it with finch

Grab a CLI token from the dashboard → **Settings → CLI access → Generate**, then:

```bash
finch login --hub <your-hub> <token>
finch add hello --service http://127.0.0.1:8000 --name "Hello MCP"
finch run
```

`finch run` dials out, auto-approves (you're the admin), and prints the public
URL — e.g. `https://<your-slug>.finchmcp.com/hello/mcp`. Nothing listens on your
box; no ports were opened.

## 4. Call it from anywhere

Point any MCP client (Claude, Cursor, …) at the printed URL with your `finch_`
key as a bearer token. Or test with curl:

```bash
URL=https://<your-slug>.finchmcp.com/hello/mcp
KEY=finch_...            # mint one in the dashboard → Keys

curl -s -X POST "$URL" -H "Authorization: Bearer $KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

curl -s -X POST "$URL" -H "Authorization: Bearer $KEY" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"roll","arguments":{"sides":20}}}'
```

That round-trip — client → hub (auth + routing) → your box → this server → back —
is the whole point of finch.

## Real servers

`server.py` hand-rolls just enough MCP to be self-contained. For real tools, use
an SDK like [FastMCP](https://github.com/jlowin/fastmcp) and point `--service` at
its HTTP port — finch relays it unchanged.
