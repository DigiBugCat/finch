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

```bash
finch login                              # approve a short code, once
finch add hello --service http://127.0.0.1:8000
finch run
```

No browser on this box? `finch login --headless` prints the link and code so
you can approve on your phone. Or, from a box that is already logged in, pipe
it a fresh token — it rides in on stdin, so it never becomes an argv word
(argv is world-readable via `/proc/<pid>/cmdline`) or lands in shell history:

```bash
finch token | ssh box 'finch login --token -'
```

`finch run` dials out, auto-approves (you're the admin), and prints the public
URL — e.g. `https://<your-slug>.finchmcp.com/hello/mcp`. Nothing listens on your
box; no ports were opened.

## 4. Call it from anywhere

Point any MCP client (Claude, Cursor, …) at the printed URL with your `finch_`
key as a bearer token. Or test with curl:

```bash
URL=https://<your-slug>.finchmcp.com/hello/mcp
KEY=$(finch keys mint hello-client --service hello)   # shown once

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
