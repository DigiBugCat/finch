# finch — device protocol

> How a device (a Mac mini, a Raspberry Pi, an **ESP32**) talks to the finch
> hub. The design goal: **thin device, smart hub.** The hub does all the MCP
> protocol work; the device speaks one tiny, language-agnostic frame contract
> that a microcontroller can implement in C.

## The one rule: the hub never pushes — it holds a mailbox the device syncs

A device is never *reached*. The hub keeps a **durable, per-device mailbox**
(it lives in that device's Durable Object) and the device **drains it whenever
it's online.** That's the whole model. The transport (WebSocket, long-poll) is
just *how fast* the device drains — not a different mechanism.

- **Always-on device** → connected continuously → drains the instant a command
  lands → looks like live push.
- **Sleeping device** → connects briefly on wake → drains in a burst → looks
  like polling.

Same protocol, different duty cycle. This is how APNs/FCM/email/git already
work: durable store + a client that syncs when able.

### Delivery = append + doorbell (so it's both durable *and* fast)

When a command arrives at a device's DO:

1. **If a connection is live, send it down the open socket immediately** — the
   "doorbell." This is the latency path: no storage read, no poll. Total
   latency ≈ caller→edge + the device round-trip.
2. **Persist to the durable log only as the offline fallback**, and keep that
   write *off* the connected hot path.

Two delivery modes make this explicit per command:

| mode | semantics | persisted? | use |
|---|---|---|---|
| `call` | request/response; a caller is waiting for the reply | no (in-memory while connected) | "read the sensor", "print this" |
| `enqueue` | fire-and-forget; at-least-once; device must `ack` | yes (durable log, monotonic `seq`) | "toggle the relay", "kick off backup" |

A `call` to a device that isn't reachable within its `deadline` fails fast
(`resting`). An `enqueue` to an offline device just sits in the log and is
replayed on next sync. **Connected `call`s never touch storage** — that's what
keeps the hot path at memory speed (it's exactly today's relay).

## Two payload profiles (same envelope)

Every frame shares one envelope; the payload differs by device class.

```jsonc
// envelope — every frame
{ "v": 1, "type": "...", "id": "01J...", "seq": 42, "ts": 1781400000 }
```

- **Proxy profile** — for a *computer* (Pi, mac mini, laptop) that runs a real
  local MCP server. The invoke carries an HTTP request to relay to it. This is
  the current Go agent.
  ```jsonc
  { "type": "invoke", "id": "01J...", "mode": "call",
    "http": { "method": "POST", "path": "/mcp", "headers": {...}, "body": "..." } }
  ```
- **Handler profile** — for a *microcontroller* (ESP32) with no room for a
  separate server. The invoke names a tool; the device runs a registered C
  handler. **The hub synthesizes the whole MCP protocol** (initialize,
  session-id, capability list, SSE) so the device never sees it.
  ```jsonc
  { "type": "invoke", "id": "01J...", "mode": "enqueue", "seq": 42,
    "tool": "toggle_relay", "args": { "on": true } }
  ```

A device declares its profile in `hello`; the hub adapts. Both are the same
envelope, so the relay, correlation, and mailbox code are shared.

## Frames

**device → hub**
| type | fields | meaning |
|---|---|---|
| `hello` | `device_id`, `token`, `profile` (`proxy`\|`handler`), `power` (`always_on`\|`low_power`\|`deep_sleep`), `since_seq`, `tools?`, `ping_interval?` | sync handshake on (re)connect. `token` is the enrollment credential (hashed in the registry). |
| `result` | `id`, `ok`, `body?`/`result?`, `error?` | reply to an `invoke` (carries the same `id`). |
| `ack` | `seq` | durable command processed up to `seq`; hub prunes the log ≤ `seq`. |
| `ping` | — | keepalive (also NAT-hold). Hub auto-pongs without waking the DO. |

**hub → device**
| type | fields | meaning |
|---|---|---|
| `welcome` | `assigned_seq`, `config` | handshake reply; tells the device the current high-water `seq`. |
| `invoke` | `id`, `mode`, payload (profile-specific), `seq?` (enqueue only), `deadline?` | a command. |
| `pong` | — | keepalive reply. |

### The sync handshake (the heart of it)

On every connect/wake the device sends `hello { since_seq: N }`. The hub replays
every `enqueue` command with `seq > N`, in order, down the connection. A
connected device drains instantly; a waking device drains its backlog. **One
operation serves both** — there is no separate "poll" path.

### At-least-once + idempotency (so actuation is safe)

`enqueue` is at-least-once: a device that processes a command but sleeps before
`ack` will get it again on reconnect. So:
- The device persists `last_acked_seq` (NVS on an ESP32) and **dedupes any
  redelivered `seq ≤ last_acked_seq`** → effectively-once for idempotent
  handlers.
- `id` doubles as an idempotency key for `call`s (small ring buffer of recent
  ids) — important so "toggle relay" never double-fires on a flaky link.

## Power profiles (a duty-cycle dial, not a protocol change)

The device declares `power` in `hello`; the hub serves all three behind the
same mailbox.

| profile | radio | hub behavior | latency | battery (ESP32, ~2000mAh) |
|---|---|---|---|---|
| `always_on` | WiFi active | live doorbell; DO may keep warm | ~network RTT | n/a (plugged in) |
| `low_power` | modem-sleep (DTIM) | live doorbell; connection held; longer ping | ~DTIM (0.1–1s) | days–weeks |
| `deep_sleep` | off between wakes | **queue only** (`enqueue`); device drains on wake; `call`s fail-fast `resting` or wait for a wake window | = wake interval | months–years |

Why this works: **the WebSocket is nearly free — it's one idle TCP socket.**
What costs power is keeping the WiFi radio listening, and modem-sleep (the radio
dozes between AP beacons, waking ~ms each DTIM) drops a *connected, still-pushable*
device into the single-digit-mA range. The two real knobs:

1. **Sleep mode** — the big lever (10–50×).
2. **Ping interval** — every keepalive ping is a forced radio wake, *but* NAT
   gateways drop idle mappings after ~30s–5min, so you must ping to stay
   reachable. Pick the longest interval the NAT tolerates (~60s start). Avoid
   **reconnect storms** — each reconnect is a TLS handshake (CPU + radio burst);
   a stable modem-sleep connection beats constant re-handshaking.

### Latency knobs the hub exposes
- `power` profile drives whether the DO hibernates. The one latency tax is the
  **cold-wake**: the first `call` after the DO hibernates pays a few ms to
  rehydrate. For latency-critical devices, a per-device **`keep_warm`** flag
  prevents hibernation (costs a little duration $). Latency becomes a dial.
- Place the DO **near the device** (`locationHint` on first contact) — the
  unavoidable leg is hub→device, so make that short.

## Online / offline ("chirping" / "resting")

Derived, not asserted:
- `always_on`/`low_power`: online = connection present (last ping within
  ~2× `ping_interval`).
- `deep_sleep`: online = last sync within ~1.5× its wake interval; otherwise
  "resting" — but `enqueue`d commands are still safely waiting.

## What a device MUST implement (the whole MCU job)

This is deliberately tiny — an ESP32 in C:

1. Open one **WSS/TLS** connection to `wss://<hub>/<id>/_connect` (`esp_websocket_client` + mbedTLS).
2. Send `hello { device_id, token, profile:"handler", power, since_seq, tools }`.
3. Loop: on an `invoke` frame → parse JSON (cJSON) → dispatch `tool` to a C
   handler → send `result { id, ok, result }`; for `enqueue`, also `ack { seq }`.
4. Dedupe `seq ≤ last_acked_seq` (stored in NVS).
5. Send `ping` at `ping_interval`; reconnect with backoff on drop.

Everything else — MCP `initialize`, session-id, SSE, capability negotiation,
auth at the door, identity (`X-Finch-User`), the public URL — is the **hub's**
job. The device only ever sees `{tool, args} → {result}`.

## Provisioning (the genuinely hard part — flagged, not solved)

The protocol assumes the device already holds `device_id` + `token` + WiFi
creds. Getting those onto a *headless* board is the real UX problem (no screen,
no keyboard). Options, in rough order of "bam it works":
- **Flash-time config** — bake creds into the firmware image at flash (simplest; least flexible).
- **BLE provisioning** — phone app hands WiFi + token over BLE (ESP-IDF has this).
- **Captive-portal AP** — board boots an AP, you join it and submit creds in a browser.

This is where "just plug it in" lives or dies; treat it as a first-class
product surface, not an afterthought.

## Relationship to the current implementation

Today's Go agent (`agent/main.go`) is exactly the **proxy profile, `call` mode,
`always_on`** subset: its `{id, type:"req", method, path, headers, body}` →
`{id, type:"res", status, body}` is `invoke{mode:call, http:{...}}` →
`result`. Generalizing to this spec is additive:
1. add `hello`/`welcome` (today it connects implicitly);
2. add `enqueue` + the durable mailbox in the DO + `ack`;
3. add the `handler` profile (for MCUs);
4. add `power` + `keep_warm`.

Nothing here breaks the request/response hot path we already have — the mailbox
is the offline layer added *behind* it.
