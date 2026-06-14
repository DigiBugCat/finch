"use client";
// Roost — Enroll, Keys, Activity panels.
import { useState } from 'react';
import { Button, Card, CopyChip, DuskInput, InlineConfirm, MaskedSecret, SectionLabel } from '@/components/dash/primitives';
import { ROOST_DATA } from '@/components/dash/data';

// Deterministic, SSR-safe hex generator. Seeded from `seed` so output is stable
// across renders/server+client while still looking random. Small LCG over the
// hex alphabet — `n` hex chars out.
function randHex(n: number, seed: number = 0) {
  const c = "0123456789abcdef";
  let s = "";
  let state = (seed ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < n; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    s += c[(state >>> 24) & 15];
  }
  return s;
}

const PLATS = [
  ["macos", "macOS", "🍎"],
  ["debian", "Debian / Ubuntu", "🐧"],
  ["pi", "Raspberry Pi", "🍓"],
  ["docker", "Docker", "🐳"],
  ["windows", "Windows", "🪟"],
];
function installFor(plat: any, host: any, id: any, ticket: any) {
  if (plat === "windows")
    return `iwr -useb https://${host}/install.ps1 | iex\nfinch join --id ${id} --ticket ${ticket}`;
  if (plat === "docker")
    return `docker run -d --name finch-${id} \\\n  -e FINCH_TICKET=${ticket} \\\n  finch/agent:latest join --id ${id}`;
  return `curl -fsSL https://${host}/install | sh\nfinch join --id ${id} --ticket ${ticket}`;
}

// helper: derive a stable numeric seed from a string id
function seedFromStr(str: string) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h;
}

// ============ ENROLL ==============================================
export function EnrollView({ host, existingIds, groups, onEnrolled, onWatch }: any) {
  const [id, setId] = useState("");
  const [phase, setPhase] = useState("idle"); // idle | minting | minted
  const [ticket, setTicket] = useState("");
  const [plat, setPlat] = useState("macos");
  const [group, setGroup] = useState((groups && groups[0]) || "Home lab");

  const clean = id.trim().toLowerCase();
  let error = "";
  if (clean) {
    if (!/^[a-z0-9-]+$/.test(clean)) error = "lowercase letters, digits and dashes only";
    else if (clean.length > 40) error = "40 characters max";
    else if (existingIds.includes(clean)) error = "an appliance with this id already exists";
  }
  const canMint = clean && !error && phase !== "minting";

  const mint = () => {
    if (!canMint) return;
    setPhase("minting");
    setTimeout(() => {
      setTicket(`tk_${randHex(24, seedFromStr(clean))}`);
      setPhase("minted");
      onEnrolled(clean, group); // adds an 'invited' appliance to the roost
    }, 900);
  };

  const command = installFor(plat, host, clean, ticket);

  return (
    <div className="view view-narrow">
      <h1 className="page-title">Add a device <span className="page-emoji">🐣</span></h1>
      <p className="page-lede">Name the capability, mint a one-time ticket, and paste a single command on the box. It'll fly home and join the roost.</p>

      <Card className="enroll-card">
        <SectionLabel hint="lowercase · digits · dashes · ≤40">appliance id</SectionLabel>
        <div className="enroll-input-row">
          <DuskInput value={id} onChange={(v: any) => { setId(v); if (phase === "minted") setPhase("idle"); }}
            placeholder="calendar-sync" prefix={`${host}/`} error={!!error} autoFocus />
          <Button kind="accent" onClick={mint} disabled={!canMint}>
            {phase === "minting" ? "minting…" : phase === "minted" ? "mint another" : "Mint ticket"}
          </Button>
        </div>
        {error && <div className="field-err">⚠ {error}</div>}
        {clean && !error && (
          <div className="enroll-preview mono dim">→ {`https://${host}/${clean}/mcp`}</div>
        )}
        <div className="enroll-group">
          <span className="dim" style={{ fontSize: 13, fontWeight: 700 }}>group</span>
          {(groups || ["Home lab"]).map((g: any) => (
            <button key={g} className={`owner-btn ${group === g ? "owner-on" : ""}`} onClick={() => setGroup(g)}>{g}</button>
          ))}
        </div>
      </Card>

      {phase === "minted" && (
        <Card className="ticket-card">
          <SectionLabel hint="pick the box's platform — the same ticket works on any">one paste, and it's live</SectionLabel>
          <div className="plat-tabs">
            {PLATS.map(([k, lbl, ic]) => (
              <button key={k} className={`plat-tab ${plat === k ? "plat-on" : ""}`} onClick={() => setPlat(k)}>
                <span>{ic}</span> {lbl}
              </button>
            ))}
          </div>
          <div className="command-block" style={{ marginTop: 12 }}>
            <pre className="mono">{command}</pre>
            <CopyChip value={command} className="command-copy" />
          </div>
          <div className="ticket-foot">
            <MaskedSecret value={ticket} prefix="tk_" note={null} />
            <span className="ticket-msg">🎟 one-time ticket — <b className="mono">{clean}</b> has one hour to fly home.</span>
          </div>
          <div className="listening">
            <span className="listening-pulse" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700 }}>Listening for <b className="mono own-you">{clean}</b> to phone home<span className="dots">…</span></div>
              <div className="dim" style={{ fontSize: 12.5 }}>Run the command on the box — it appears here the moment it connects.</div>
            </div>
            <Button kind="ghost" onClick={onWatch}>Watch it fly home →</Button>
          </div>
        </Card>
      )}
    </div>
  );
}

// ============ KEYS ================================================
export function KeysView({ keys, onMint, onRevoke }: any) {
  const [label, setLabel] = useState("");
  const [owner, setOwner] = useState("you");
  const [revealed, setRevealed] = useState<any>(null); // {label, value}

  const clean = label.trim().toLowerCase().replace(/\s+/g, "-");
  const canMint = clean && /^[a-z0-9-]+$/.test(clean);

  const mint = () => {
    if (!canMint) return;
    const value = `rk_live_${randHex(22, seedFromStr(clean))}`;
    onMint({ label: clean, owner, value });
    setRevealed({ label: clean, value, owner });
    setLabel("");
  };

  return (
    <div className="view">
      <div className="keys-head">
        <div>
          <h1 className="page-title">Keys <span className="admin-badge">admin</span></h1>
          <p className="page-lede">Identities the hub will accept. Minted here, enforced at the door — before any traffic reaches a box.</p>
        </div>
      </div>

      {/* Reveal-once banner */}
      {revealed && (
        <Card className="reveal-card">
          <SectionLabel hint="you won't see this again">key minted · <b className="mono">{revealed.label}</b></SectionLabel>
          <MaskedSecret value={revealed.value} prefix="rk_live_" />
          <div className="reveal-hand mono">
            on their machine: <span className="reveal-cmd">roost enroll {ROOST_DATA.HOST} {revealed.value.slice(0, 14)}…</span>
          </div>
          <Button kind="ghost" onClick={() => setRevealed(null)}>done, I copied it</Button>
        </Card>
      )}

      {/* Mint form */}
      <Card className="mintkey-card">
        <SectionLabel>mint a key</SectionLabel>
        <div className="mintkey-row">
          <DuskInput value={label} onChange={setLabel} placeholder="laptop-name" mono />
          <div className="owner-pick">
            <span className="dim">owner</span>
            {["you", "priya", "sam"].map((o) => (
              <button key={o} className={`owner-btn ${owner === o ? "owner-on" : ""}`} onClick={() => setOwner(o)}>{o}</button>
            ))}
          </div>
          <Button kind="accent" onClick={mint} disabled={!canMint}>Mint key</Button>
        </div>
      </Card>

      {/* List */}
      <Card className="table-card">
        <div className="krow krow-head">
          <span className="k-label">label</span>
          <span className="k-owner">owner</span>
          <span className="k-scope">scope</span>
          <span className="k-val">value</span>
          <span className="k-created">created</span>
          <span className="k-act"></span>
        </div>
        {keys.map((k: any) => (
          <div key={k.id} className="krow">
            <span className="k-label mono">🔑 {k.label}</span>
            <span className="k-owner mono"><span className={k.owner === "you" ? "own-you" : "own-other"}>{k.owner}</span></span>
            <span className="k-scope mono dim">{k.scope}</span>
            <span className="k-val mono dim">{`rk_live_••••${k.value.slice(-4)}`}</span>
            <span className="k-created mono dim">{k.created}</span>
            <span className="k-act"><InlineConfirm prompt="revoke?" trigger="revoke" onConfirm={() => onRevoke(k.id)} /></span>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ============ ACTIVITY ============================================
export function ActivityView({ activity }: any) {
  const glyph: any = {
    call: "→", online: "●", offline: "○", keymint: "🔑", revoke: "⊘", enroll: "🐣",
  };
  const cls: any = {
    call: "act-call", online: "act-online", offline: "act-offline",
    keymint: "act-key", revoke: "act-revoke", enroll: "act-enroll",
  };
  return (
    <div className="view view-narrow">
      <h1 className="page-title">Activity</h1>
      <p className="page-lede">Enrollments, keys, and online/offline transitions — newest first.</p>
      <Card className="table-card">
        {activity.map((e: any, i: number) => (
          <div key={i} className="arow">
            <span className={`act-glyph ${cls[e.kind]}`}>{glyph[e.kind]}</span>
            <span className="act-text">{e.text}</span>
            <span className="act-who mono dim">{e.who}</span>
            <span className="act-time mono dim">{e.ago}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}
