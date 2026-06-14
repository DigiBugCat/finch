"use client";
// useFinchState — client hook that loads the live TenantState from the Next
// bridge (/api/finch/state -> hub /api/state + Clerk users). Returns the state
// plus loading/error flags and a `refetch` the dashboard calls after every
// mutation so the UI reflects real hub state.

import { useCallback, useEffect, useRef, useState } from "react";
import type { TenantState } from "@/components/dash/data";

export interface UseFinchState {
  state: TenantState | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function useFinchState(): UseFinchState {
  const [state, setState] = useState<TenantState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // guards against setState after unmount (StrictMode double-mount / nav away)
  const alive = useRef(true);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch("/api/finch/state", {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      const body = (await res.json().catch(() => ({}))) as
        | TenantState
        | { error?: string };
      if (!res.ok) {
        const msg = (body as { error?: string })?.error || `HTTP ${res.status}`;
        if (alive.current) setError(msg);
        return;
      }
      if (alive.current) {
        setState(body as TenantState);
        setError(null);
      }
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : "failed to load state");
      }
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refetch();
    return () => {
      alive.current = false;
    };
  }, [refetch]);

  return { state, loading, error, refetch };
}
