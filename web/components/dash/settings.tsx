"use client";
// Roost — Settings: tenant-wide defaults.
import { Card, InlineConfirm, SectionLabel, Toggle } from '@/components/dash/primitives';

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

export function SettingsView({ settings, onChange }: any) {
  const s = settings;
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
            {["sfo · us-west", "ord · us-central", "ams · eu-west", "nyc · us-east"].map((r) => <option key={r}>{r}</option>)}
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
            {["Home lab", "Studio", "Acme · prod"].map((g) => <option key={g}>{g}</option>)}
          </select>
        </SetRow>
        <SetRow label="Default key expiry">
          <select className="acl-select" value={s.keyExpiry} onChange={(e) => onChange("keyExpiry", e.target.value)}>
            {["30 days", "90 days", "180 days", "never"].map((k) => <option key={k}>{k}</option>)}
          </select>
        </SetRow>
        <SetRow label="Enforce key expiry" hint="auto-revoke keys once they pass their expiry">
          <Toggle on={s.enforceExpiry} onChange={(v: any) => onChange("enforceExpiry", v)} />
        </SetRow>
        <SetRow label="Require 2FA for admins">
          <Toggle on={s.require2fa} onChange={(v: any) => onChange("require2fa", v)} />
        </SetRow>
      </Card>

      <Card className="set-card danger-card">
        <SectionLabel>danger zone</SectionLabel>
        <div className="danger-row">
          <div>
            <div className="danger-title">Rotate all keys</div>
            <div className="dim danger-sub">Invalidate every key in the tenant. Devices reconnect on their next handshake.</div>
          </div>
          <InlineConfirm prompt="rotate all?" trigger="rotate" onConfirm={() => {}} />
        </div>
      </Card>
    </div>
  );
}
