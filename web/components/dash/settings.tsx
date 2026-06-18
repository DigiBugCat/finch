"use client";
// Roost — Settings: tenant-wide defaults.
import { useEffect, useRef, useState } from 'react';
import { Card, SectionLabel, Toggle } from '@/components/dash/primitives';

// Finch-themed pet-name slug generator (adjective + bird), e.g. "sunny-wren".
const SLUG_ADJ = ['sunny', 'amber', 'dusk', 'quiet', 'brave', 'lucky', 'misty', 'cozy', 'swift', 'fern', 'maple', 'ember', 'cedar', 'wren', 'pebble', 'noble'];
const SLUG_BIRD = ['finch', 'wren', 'robin', 'sparrow', 'lark', 'swift', 'martin', 'thrush', 'siskin', 'tanager', 'plover', 'kestrel'];
function petSlug(): string {
  const a = SLUG_ADJ[Math.floor(Math.random() * SLUG_ADJ.length)];
  const b = SLUG_BIRD[Math.floor(Math.random() * SLUG_BIRD.length)];
  const n = Math.floor(Math.random() * 90) + 10; // 2 digits, keeps it single-label + unlikely to collide
  return `${a}-${b}-${n}`;
}

// Hub-domain picker: edit/suggest a slug, live-check availability against the
// hub (claim-free), then claim it. The slug is the load-bearing routing key —
// it resolves <slug>.finchmcp.com to this tenant.
function HubDomain({ current, onClaim }: { current: string; onClaim: (slug: string) => void }) {
  const [draft, setDraft] = useState(current || '');
  const [status, setStatus] = useState<'idle' | 'checking' | 'available' | 'taken' | 'invalid'>('idle');
  const seq = useRef(0);

  // Normalize to a host-safe single label as the user types.
  const clean = (v: string) => v.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+/, '').slice(0, 40);

  useEffect(() => {
    const slug = clean(draft);
    if (!slug) { setStatus('idle'); return; }
    if (slug === current) { setStatus('idle'); return; }
    if (slug.length < 3) { setStatus('invalid'); return; }
    setStatus('checking');
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/finch/slug-check?slug=${encodeURIComponent(slug)}`);
        const j = await r.json();
        if (mine !== seq.current) return; // a newer keystroke won
        setStatus(j.available ? 'available' : 'taken');
      } catch {
        if (mine === seq.current) setStatus('idle');
      }
    }, 350);
    return () => clearTimeout(t);
  }, [draft, current]);

  const slug = clean(draft);
  const canClaim = status === 'available' && slug && slug !== current;
  const msg: Record<string, string> = {
    checking: 'checking…', available: '✓ available', taken: '✗ taken', invalid: 'at least 3 characters', idle: '',
  };

  return (
    <div>
      <div className="set-domain mono" style={{ alignItems: 'center', gap: 8 }}>
        <input
          className="set-input"
          value={draft}
          placeholder="your-slug"
          onChange={(e) => setDraft(clean(e.target.value))}
          style={{ width: 160 }}
        />
        <span>.finchmcp.com</span>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDraft(petSlug())}>Suggest</button>
        <button type="button" className="btn btn-sm btn-amber" disabled={!canClaim} onClick={() => onClaim(slug)}>Claim</button>
      </div>
      <div className="set-hint dim" style={{ marginTop: 6 }}>
        {current
          ? <>Live at <a href={`https://${current}.finchmcp.com`} target="_blank" rel="noreferrer">{current}.finchmcp.com</a>. </>
          : <>No domain claimed yet — clients can’t reach your boxes by name until you claim one. </>}
        <span className={status === 'taken' || status === 'invalid' ? 'red' : status === 'available' ? 'green' : ''}>{msg[status]}</span>
      </div>
    </div>
  );
}

function SetRow({ label, hint, children }: any) {
  return (
    <div className="set-row">
      <div className="set-l">
        <div className="set-label">{label}</div>
        {hint && <div className="set-hint dim">{hint}</div>}
      </div>
      <div className="set-c">{children}</div>
    </div>
  );
}

// Union a persisted value into a fixed option list so the <select> never
// silently displays the first option when the real value is custom (which
// would also write the wrong value if the user then interacts).
function withCurrent(options: string[], current: string | undefined): string[] {
  return current && !options.includes(current) ? [current, ...options] : options;
}

export function SettingsView({ settings, groups, onChange }: any) {
  const s = settings;
  const groupOptions = withCurrent(
    (groups && groups.length ? groups.map((g: any) => g.name) : ["Home lab", "Studio", "Acme · prod"]),
    s.defaultGroup,
  );
  const expiryOptions = withCurrent(["30 days", "90 days", "180 days", "never"], s.keyExpiry);
  return (
    <div className="view view-narrow">
      <h1 className="page-title">Settings <span className="admin-badge">admin</span></h1>
      <p className="page-lede">Tenant-wide defaults. Changes apply across every device and teammate.</p>

      <Card className="set-card">
        <SectionLabel>organization</SectionLabel>
        <SetRow label="Organization" hint="your account identity — boxes, keys, and teammates all belong to it">
          <code className="set-input mono" style={{ display: 'inline-block', opacity: 0.85, userSelect: 'all' }}>{s.org}</code>
        </SetRow>
        <SetRow label="Hub domain" hint="the name clients use to reach your boxes">
          <HubDomain current={s.subdomain || ''} onClaim={(slug) => onChange('subdomain', slug)} />
        </SetRow>
      </Card>

      <Card className="set-card">
        <SectionLabel>devices &amp; access</SectionLabel>
        <SetRow label="Require approval for new devices" hint="new devices wait for an admin before they can serve">
          <Toggle on={s.requireApproval} onChange={(v: any) => onChange("requireApproval", v)} />
        </SetRow>
        <SetRow label="Default group" hint="where newly enrolled devices land">
          <select className="acl-select" value={s.defaultGroup} onChange={(e) => onChange("defaultGroup", e.target.value)}>
            {groupOptions.map((g) => <option key={g}>{g}</option>)}
          </select>
        </SetRow>
        <SetRow label="Default key expiry">
          <select className="acl-select" value={s.keyExpiry} onChange={(e) => onChange("keyExpiry", e.target.value)}>
            {expiryOptions.map((k) => <option key={k}>{k}</option>)}
          </select>
        </SetRow>
        <SetRow label="Enforce key expiry" hint="auto-revoke keys once they pass their expiry">
          <Toggle on={s.enforceExpiry} onChange={(v: any) => onChange("enforceExpiry", v)} />
        </SetRow>
        <SetRow label="Require 2FA for admins">
          <Toggle on={s.require2fa} onChange={(v: any) => onChange("require2fa", v)} />
        </SetRow>
      </Card>

      {/* "Rotate all keys" intentionally omitted: there's no hub endpoint for it
          yet, so shipping a button would be a no-op that lies. Revoke individual
          keys from the Keys view instead. */}
    </div>
  );
}
