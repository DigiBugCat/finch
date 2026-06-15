// Empty stub aliased in place of the `server-only` marker package under test.
// In production the package's `react-server` export condition already resolves
// to an empty module inside a Server Component; here we make it a no-op so
// lib/hub.ts (which imports "server-only") loads in the Node test runtime.
export {};
