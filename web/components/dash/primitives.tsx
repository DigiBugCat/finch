"use client";
// Roost — shared primitive components.
import { useState } from 'react';

// ---- Button ------------------------------------------------------
export function Button({ kind = "ghost", size = "md", children, ...rest }: any) {
  return (
    <button className={`btn btn-${kind} btn-${size}`} {...rest}>
      {children}
    </button>
  );
}

// ---- CopyChip ----------------------------------------------------
// Copies `value`; shows "copied ✓" green for 1.2s. Reveals full secret on copy.
export function CopyChip({ value, label = "Copy", className = "" }: any) {
  const [done, setDone] = useState(false);
  const doCopy = (e: any) => {
    e.stopPropagation();
    try {
      navigator.clipboard?.writeText(value);
    } catch (_) {}
    setDone(true);
    setTimeout(() => setDone(false), 1200);
  };
  return (
    <button
      className={`copychip ${done ? "copychip-done" : ""} ${className}`}
      onClick={doCopy}
      title={done ? "Copied" : "Copy to clipboard"}
    >
      {done ? "copied ✓" : label}
    </button>
  );
}

// ---- StatePill ---------------------------------------------------
export function StatePill({ state }: any) {
  const map: any = {
    in_use: { cls: "pill-live", dot: true, text: "in use" },
    chirping: { cls: "pill-live", dot: true, text: "online" },
    resting: { cls: "pill-rest", dot: false, text: "offline" },
    invited: { cls: "pill-invited", dot: false, text: "invited" },
    pending: { cls: "pill-invited", dot: false, text: "pending" },
  };
  const s = map[state] || map.resting;
  return (
    <span className={`pill ${s.cls}`}>
      {s.dot && <span className="pill-dot" />}
      {state === "invited" && <span className="pill-glyph">🎟</span>}
      {state === "pending" && <span className="pill-glyph">⏳</span>}
      {s.text}
    </span>
  );
}

export const isOnline = (st: any) => st === "chirping" || st === "in_use";

// ---- Avatar (🐦, grayscale when resting) -------------------------
export function Avatar({ state, size = 36 }: any) {
  const online = isOnline(state);
  const cls = (state === "invited" || state === "pending") ? "avatar avatar-invited" : online ? "avatar avatar-on" : "avatar avatar-off";
  return (
    <span className={cls} style={{ width: size, height: size, fontSize: size * 0.5 }}>
      🐦
    </span>
  );
}

// ---- PerchMeter --------------------------------------------------
// One bar per service; lit green online, amber invited, dim resting.
export function PerchMeter({ items, big = false }: any) {
  return (
    <div className={`perch ${big ? "perch-big" : ""}`}>
      {items.map((a: any, i: number) => {
        const k = isOnline(a.state) ? "on" : (a.state === "invited" || a.state === "pending") ? "inv" : "off";
        return <span key={i} className={`perch-bar perch-${k}`} title={`${a.id} · ${a.state}`} />;
      })}
    </div>
  );
}

// ---- MonoUrl — truncating URL block with copy chip ---------------
export function MonoUrl({ url, hero = false, onClick }: any) {
  return (
    <div className={`monourl ${hero ? "monourl-hero" : ""}`} onClick={onClick}>
      <span className="monourl-text">{url}</span>
      <CopyChip value={url} />
    </div>
  );
}

// ---- MaskedSecret — masked on screen, full on copy ---------------
export function MaskedSecret({ value, prefix = "", note }: any) {
  const [shown, setShown] = useState(false);
  const tail = value.slice(-4);
  const masked = `${prefix}${"•".repeat(Math.max(10, value.length - prefix.length - 4))}${tail}`;
  return (
    <div className="masked">
      <code className="masked-val">{shown ? value : masked}</code>
      <div className="masked-actions">
        <button className="masked-eye" onClick={() => setShown((s) => !s)} title={shown ? "Hide" : "Reveal"}>
          {shown ? "hide" : "reveal"}
        </button>
        <CopyChip value={value} />
      </div>
      {note && <div className="masked-note">{note}</div>}
    </div>
  );
}

// ---- InlineConfirm — arm/disarm destructive action ---------------
export function InlineConfirm({ prompt = "set free?", onConfirm, trigger = "delete" }: any) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <button className="ghostlink ghostlink-danger" onClick={(e: any) => { e.stopPropagation(); setArmed(true); }}>
        {trigger}
      </button>
    );
  }
  return (
    <span className="confirm" onClick={(e: any) => e.stopPropagation()}>
      <span className="confirm-prompt">{prompt}</span>
      <button className="confirm-yes" onClick={onConfirm}>yes</button>
      <button className="confirm-no" onClick={() => setArmed(false)}>no</button>
    </span>
  );
}

// ---- DuskInput — validated text input ----------------------------
export function DuskInput({ value, onChange, placeholder, prefix, error, mono = true, autoFocus }: any) {
  return (
    <div className={`dusk-input ${error ? "dusk-input-err" : ""}`}>
      {prefix && <span className="dusk-prefix">{prefix}</span>}
      <input
        className={mono ? "mono" : ""}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
      />
    </div>
  );
}

// ---- TagList — tag:foo chips, optionally removable -----------------
export function TagList({ tags, onRemove }: any) {
  if (!tags || !tags.length) return null;
  return (
    <span className="taglist">
      {tags.map((t: any) => (
        <span key={t} className="tag">tag:{t}{onRemove && (
          <button className="tag-x" title="remove" onClick={(e: any) => { e.stopPropagation(); onRemove(t); }}>×</button>
        )}</span>
      ))}
    </span>
  );
}

// ---- EntityChip — a user / group / key / tag / device / all token --
export function EntityChip({ ent }: any) {
  const map: any = {
    user: ["👤", ent.name], group: ["👥", ent.name], key: ["🔑", ent.name],
    tag: ["", "tag:" + ent.name], service: ["🐦", ent.name], all: ["🌐", "all services"],
  };
  const [ic, label] = map[ent.type] || ["", ent.name];
  return (
    <span className={`ent ent-${ent.type}`}>
      {ic && <span className="ent-ic">{ic}</span>}{label}
    </span>
  );
}

// ---- Toggle — on/off switch --------------------------------------
export function Toggle({ on, onChange }: any) {
  return (
    <button className={`toggle ${on ? "on" : ""}`} role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <span className="toggle-knob" />
    </button>
  );
}

// ---- Card --------------------------------------------------------
export function Card({ children, className = "", ...rest }: any) {
  return <div className={`card ${className}`} {...rest}>{children}</div>;
}

// ---- SectionLabel ------------------------------------------------
export function SectionLabel({ children, hint }: any) {
  return (
    <div className="seclabel">
      <span>{children}</span>
      {hint && <span className="seclabel-hint">{hint}</span>}
    </div>
  );
}
