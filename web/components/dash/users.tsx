"use client";
// Roost — Users & roles: tenant members, invite, role management.
import { useState } from 'react';
import { Button, Card, InlineConfirm, SectionLabel } from '@/components/dash/primitives';

const U_PALETTE = ["#f2b443", "#79d995", "#c4a8ef", "#e8848f", "#7fb2e8"];
function UserAvatar({ name }: any) {
  const ch = (name || "?")[0].toUpperCase();
  const c = U_PALETTE[(name.charCodeAt(0) || 0) % U_PALETTE.length];
  return <span className="uav" style={{ background: c + "22", color: c, boxShadow: `inset 0 0 0 1px ${c}55` }}>{ch}</span>;
}
function RolePill({ role }: any) {
  return <span className={`role role-${role.toLowerCase()}`}>{role}</span>;
}

export function UsersView({ users, onInvite, onRole, onRemove }: any) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("Member");
  const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
  const invite = () => { if (!valid) return; onInvite({ email: email.trim(), role }); setEmail(""); };

  return (
    <div className="view">
      <h1 className="page-title">Users <span className="admin-badge">admin</span></h1>
      <p className="page-lede">Everyone in your tenant. Roles decide who can approve devices, edit access rules, and manage keys.</p>

      <Card className="invite-card">
        <SectionLabel hint="they'll get an email to join this tenant">invite a teammate</SectionLabel>
        <div className="invite-row">
          <div className={`dusk-input ${email && !valid ? "dusk-input-err" : ""}`} style={{ flex: 1 }}>
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@acme.com"
              onKeyDown={(e) => { if (e.key === "Enter") invite(); }} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
          </div>
          <select className="acl-select" value={role} onChange={(e) => setRole(e.target.value)}>
            <option>Admin</option><option>Member</option>
          </select>
          <Button kind="accent" onClick={invite} disabled={!valid}>Send invite</Button>
        </div>
      </Card>

      <Card className="table-card">
        <div className="urow urow-head">
          <span>user</span><span>role</span><span>devices</span><span>last active</span><span></span>
        </div>
        {users.map((u: any) => (
          <div key={u.id} className="urow">
            <span className="u-user">
              <UserAvatar name={u.name} />
              <span className="u-id">
                <span className="u-name">{u.name}{u.status === "invited" && <span className="u-pending">invited</span>}</span>
                <span className="u-email dim">{u.email}</span>
              </span>
            </span>
            <span className="u-role">
              {u.role === "Owner"
                ? <RolePill role="Owner" />
                : <select className="role-select" value={u.role} onChange={(e) => onRole(u.id, e.target.value)}>
                    <option>Admin</option><option>Member</option>
                  </select>}
            </span>
            <span className="u-dev mono">{u.devices}</span>
            <span className="u-seen mono dim">{u.lastActive}</span>
            <span className="u-act">
              {u.role === "Owner"
                ? <span className="dim mono" style={{ fontSize: 12 }}>owner</span>
                : <InlineConfirm prompt="remove?" trigger="remove" onConfirm={() => onRemove(u.id)} />}
            </span>
          </div>
        ))}
      </Card>
    </div>
  );
}
