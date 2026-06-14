// The dashboard is its own visual world (the "Dusk Roost" admin surface).
// Its stylesheet loads here, scoped to /dashboard/* — it loads after the
// landing's globals.css so any shared class names resolve to the dashboard's.
import "./dashboard.css";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
