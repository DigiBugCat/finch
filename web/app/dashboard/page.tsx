import { UserButton } from "@clerk/nextjs";
import { currentUser } from "@clerk/nextjs/server";
import Link from "next/link";

export default async function Dashboard() {
  const user = await currentUser();
  const name = user?.firstName ?? null;

  return (
    <main style={{ minHeight: "100vh" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "18px 30px",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <Link className="logo" href="/">
          <span className="logo-mark">🐦</span> Finch
        </Link>
        <span style={{ flex: 1 }} />
        <UserButton />
      </header>

      <div className="wrap" style={{ padding: "64px 28px" }}>
        <span className="sec-tag">THE ROOST</span>
        <h1 style={{ fontSize: 34, fontWeight: 900, marginTop: 8 }}>
          {name ? `Welcome back, ${name}.` : "Welcome to your roost."}
        </h1>
        <p style={{ color: "var(--dim)", fontSize: 18, marginTop: 12, maxWidth: "52ch" }}>
          Your flock will live here — every device, its MCP URL, and who&apos;s
          chirping. Nothing&apos;s enrolled yet.
        </p>
        <div style={{ marginTop: 28 }}>
          <a className="btn btn-lg btn-amber" href="#">
            Add your first device →
          </a>
        </div>
      </div>
    </main>
  );
}
