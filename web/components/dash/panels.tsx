"use client";
// Roost — Enroll, Keys, Activity panels.
import { useState } from 'react';
import { Button, Card, CopyChip, DuskInput, InlineConfirm, MaskedSecret, SectionLabel } from '@/components/dash/primitives';

const PLATS = [
  ["macos", "macOS", "🍎"],
  ["debian", "Debian / Ubuntu", "🐧"],
  ["pi", "Raspberry Pi", "🍓"],
  ["docker", "Docker", "🐳"],
  ["windows", "Windows", "🪟"],
];

// Per-platform install command, built from the hub's REAL signed ticket. The
// hub already returns the canonical curl|sh command (resp.install) for the
// posix path; the other platforms reuse the same ticket — only the fetch/run
// wrapper differs. We never fabricate a ticket client-side.
function installFor(plat: any, host: any, install: string, ticket: string) {
  const scheme = host && (host.startsWith("localhost") || host.startsWith("127.0.0.1")) ? "http" : "https";
  if (plat === "windows")
    return `iwr -useb ${scheme}://${host}/install.ps1 | iex; finch join --ticket ${ticket}`;
  if (plat === "docker")
    return `docker run -d --name finch-agent \\\n  -e FINCH_TICKET=${ticket} \\\n  finch/agent:latest`;
  // macOS / Debian / Pi all use the canonical posix one-liner the hub minted.
  return install;
}

// ============ ENROLL ==============================================
// Renders the hub's REAL enroll response. `onEnrolled(id, group)` POSTs to the
// hub and resolves to the EnrollResp ({ id, ticket, url, install, expiresAt }).
// We render that verbatim — no client-side ticket fabrication.
export function EnrollView({ host, existingIds, groups, onEnrolled, onWatch }: any) {
  const [id, setId] = useState("");
  const [phase, setPhase] = useState("idle"); // idle | minting | minted
  const [enrolled, setEnrolled] = useState<any>(null); // EnrollResp from the hub
  const [mintErr, setMintErr] = useState("");
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

  const mint = async () => {
    if (!canMint) return;
    setPhase("minting");
    setMintErr("");
    // onEnrolled creates the appliance server-side and returns the hub's real
    // EnrollResp (or null on failure). Render the ticket/install it gives back.
    const resp = await onEnrolled(clean, group);
    if (resp && resp.ticket) {
      setEnrolled(resp);
      setPhase("minted");
    } else {
      setPhase("idle");
      setMintErr("couldn't mint a ticket — try again");
    }
  };

  const ticket: string = enrolled?.ticket ?? "";
  const baseInstall: string = enrolled?.install ?? "";
  const enrolledId: string = enrolled?.id ?? clean;
  const command = installFor(plat, host, baseInstall, ticket);

  return (
    <div className="view view-narrow">
      <h1 className="page-title">Add a device <span className="page-emoji">🐣</span></h1>
      <p className="page-lede">Name the capability, mint a one-time ticket, and paste a single command on the box. It'll fly home and join the roost.</p>

      <Card className="enroll-card">
        <SectionLabel hint="lowercase · digits · dashes · ≤40">appliance id</SectionLabel>
        <div className="enroll-input-row">
          <DuskInput value={id} onChange={(v: any) => { setId(v); if (phase === "minted") { setPhase("idle"); setEnrolled(null); } }}
            placeholder="calendar-sync" prefix={`${host}/`} error={!!error} autoFocus />
          <Button kind="accent" onClick={mint} disabled={!canMint}>
            {phase === "minting" ? "minting…" : phase === "minted" ? "mint another" : "Mint ticket"}
          </Button>
        </div>
        {error && <div className="field-err">⚠ {error}</div>}
        {mintErr && <div className="field-err">⚠ {mintErr}</div>}
        {clean && !error && (
          <div className="enroll-preview mono dim">→ {enrolled?.url ?? `https://${host}/${clean}/mcp`}</div>
        )}
        <div className="enroll-group">
          <span className="dim" style={{ fontSize: 13, fontWeight: 700 }}>group</span>
          {(groups || ["Home lab"]).map((g: any) => (
            <button key={g} className={`owner-btn ${group === g ? "owner-on" : ""}`} onClick={() => setGroup(g)}>{g}</button>
          ))}
        </div>
      </Card>

      {phase === "minted" && enrolled && (
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
            <MaskedSecret value={ticket} note={null} />
            <span className="ticket-msg">🎟 one-time ticket — <b className="mono">{enrolledId}</b> has one hour to fly home.</span>
          </div>
          <div className="listening">
            <span className="listening-pulse" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700 }}>Listening for <b className="mono own-you">{enrolledId}</b> to phone home<span className="dots">…</span></div>
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
// The ONLY finch_ key-minting surface. `onMint({label, owner})` POSTs to the
// hub and resolves to the MintKeyResp ({ key, label, scope }) — the plaintext
// finch_ key is shown ONCE here and never again. `onRevoke(key)` revokes by the
// key's stable id (not its mutable label). `users` are the real Clerk members.
export function KeysView({ keys, users, onMint, onRevoke }: any) {
  const [label, setLabel] = useState("");
  // Default the owner to the signed-in user (first member is the owner row).
  const ownerOptions: string[] = (users || []).map((u: any) => u.name).filter(Boolean);
  const [owner, setOwner] = useState(ownerOptions[0] || "you");
  const [revealed, setRevealed] = useState<any>(null); // { label, value }
  const [busy, setBusy] = useState(false);

  const clean = label.trim().toLowerCase().replace(/\s+/g, "-");
  const canMint = !!clean && /^[a-z0-9-]+$/.test(clean) && !busy;

  const mint = async () => {
    if (!canMint) return;
    setBusy(true);
    // The hub mints the real finch_ key; reveal the returned plaintext once.
    const resp = await onMint({ label: clean, owner });
    setBusy(false);
    if (resp && resp.key) {
      setRevealed({ label: resp.label ?? clean, value: resp.key });
      setLabel("");
    }
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
          <MaskedSecret value={revealed.value} />
          <div className="reveal-hand mono">
            give this to the caller as <span className="reveal-cmd">Authorization: Bearer {revealed.value.slice(0, 12)}…</span>
          </div>
          <Button kind="ghost" onClick={() => setRevealed(null)}>done, I copied it</Button>
        </Card>
      )}

      {/* Mint form */}
      <Card className="mintkey-card">
        <SectionLabel>mint a key</SectionLabel>
        <div className="mintkey-row">
          <DuskInput value={label} onChange={setLabel} placeholder="laptop-name" mono />
          {ownerOptions.length > 0 && (
            <div className="owner-pick">
              <span className="dim">owner</span>
              {ownerOptions.map((o) => (
                <button key={o} className={`owner-btn ${owner === o ? "owner-on" : ""}`} onClick={() => setOwner(o)}>{o}</button>
              ))}
            </div>
          )}
          <Button kind="accent" onClick={mint} disabled={!canMint}>{busy ? "minting…" : "Mint key"}</Button>
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
        {keys.length === 0 && (
          <div className="krow"><span className="dim" style={{ padding: "8px 0" }}>No keys yet — mint one above.</span></div>
        )}
        {keys.map((k: any) => (
          <div key={k.id} className="krow">
            <span className="k-label mono">🔑 {k.label}</span>
            <span className="k-owner mono"><span className={k.owner === "you" ? "own-you" : "own-other"}>{k.owner}</span></span>
            <span className="k-scope mono dim">{k.scope}</span>
            <span className="k-val mono dim">{`finch_••••${k.last4}`}</span>
            <span className="k-created mono dim">{k.created}</span>
            <span className="k-act"><InlineConfirm prompt="revoke?" trigger="revoke" onConfirm={() => onRevoke(k)} /></span>
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
