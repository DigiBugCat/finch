"use client";
// Roost — Settings: tenant-wide defaults.
import { Card, SectionLabel, Toggle } from '@/components/dash/primitives';

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
  const regionOptions = withCurrent(
    ["sfo · us-west", "ord · us-central", "ams · eu-west", "nyc · us-east"],
    s.region,
  );
  const expiryOptions = withCurrent(["30 days", "90 days", "180 days", "never"], s.keyExpiry);
  return (
    <div className="view view-narrow">
      <h1 className="page-title">Settings <span className="admin-badge">admin</span></h1>
      <p className="page-lede">Tenant-wide defaults. Changes apply across every device and teammate.</p>

      <Card className="set-card">
        <SectionLabel>organization</SectionLabel>
        <SetRow label="Tenant name">
          <input className="set-input" value={s.org} onChange={(e) => onChange("org", e.target.value)} />
        </SetRow>
        <SetRow label="Hub domain" hint="where your MCP endpoints live">
          <div className="set-domain mono">
            <input className="set-input" value={s.subdomain} onChange={(e) => onChange("subdomain", e.target.value)} style={{ width: 120 }} />
            <span>.finchmcp.com</span>
          </div>
        </SetRow>
        <SetRow label="Home region">
          <select className="acl-select" value={s.region} onChange={(e) => onChange("region", e.target.value)}>
            {regionOptions.map((r) => <option key={r}>{r}</option>)}
          </select>
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
