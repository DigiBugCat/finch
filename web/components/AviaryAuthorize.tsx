"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { UserButton } from "@clerk/nextjs";

type EnrollmentStatus = "pending" | "approved" | "consumed" | "denied" | "expired";

interface AviaryManifest {
  service: string;
  app_path: string;
  routes: string[];
  edge_auth: "key" | "public";
  machine: string;
  machine_fingerprint: string;
}

interface EnrollmentDescription {
  found: boolean;
  status?: EnrollmentStatus;
  manifest?: AviaryManifest;
  manifest_sha256?: string;
  req_ip?: string;
  req_ua?: string;
  age_seconds?: number;
  expires_at?: string;
  public_approval_required?: boolean;
  public_approved?: boolean;
  detail?: string;
}

type PageState =
  | "idle"
  | "loading"
  | "ready"
  | "submitting"
  | "approved"
  | "denied"
  | "error";

function normalizedCode(raw: string): string {
  return raw.trim().toUpperCase();
}

function codeIsComplete(raw: string): boolean {
  return normalizedCode(raw).replace(/[^A-Z0-9]/g, "").length >= 8;
}

function apiErrorMessage(payload: unknown, status: number): string {
  const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const raw = body.error;
  const error = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  const code = String(error?.code || body.code || "");
  const message =
    (typeof error?.message === "string" && error.message) ||
    (typeof raw === "string" && raw) ||
    (typeof body.detail === "string" && body.detail) ||
    "";

  if (code === "app_path_collision") {
    return "That Finch app path is already owned. Nothing was approved; choose another app path and start enrollment again.";
  }
  if (code === "public_approval_required") {
    return "Public Internet access was not confirmed. Review the warning and check the public-access box before approving.";
  }
  if (status === 410 || code === "expired") {
    return "That authorization has expired. Start AviaryMCP again to get a new code.";
  }
  if (status === 404) {
    return "No active AviaryMCP authorization was found for that code.";
  }
  if (status === 409) {
    return message || "This authorization can no longer be changed. Start enrollment again if needed.";
  }
  return message || "Finch could not process this authorization.";
}

function ageLabel(seconds: number | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "unknown time ago";
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

function digestSuffix(digest: string | undefined): string {
  if (!digest) return "unavailable";
  return `…${digest.slice(-12)}`;
}

export default function AviaryAuthorize() {
  const params = useSearchParams();
  const initialCode = normalizedCode(params.get("code") || "");
  const [code, setCode] = useState(initialCode);
  const [pageState, setPageState] = useState<PageState>("idle");
  const [description, setDescription] = useState<EnrollmentDescription | null>(null);
  const [message, setMessage] = useState("");
  const [publicConfirmed, setPublicConfirmed] = useState(false);
  const sequence = useRef(0);

  useEffect(() => {
    const userCode = normalizedCode(code);
    const requestSequence = ++sequence.current;
    setDescription(null);
    setPublicConfirmed(false);
    setMessage("");

    if (!codeIsComplete(userCode)) {
      setPageState("idle");
      return;
    }

    setPageState("loading");
    const timer = setTimeout(async () => {
      try {
        const response = await fetch("/api/finch/aviary-describe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ user_code: userCode }),
        });
        const payload = await response.json().catch(() => ({}));
        if (requestSequence !== sequence.current) return;
        if (!response.ok) throw new Error(apiErrorMessage(payload, response.status));

        const next = payload as EnrollmentDescription;
        if (!next.found || !next.manifest) {
          throw new Error("No active AviaryMCP authorization was found for that code.");
        }
        setDescription(next);
        if (next.status === "approved" || next.status === "consumed") {
          setPageState("approved");
        } else if (next.status === "denied") {
          setPageState("denied");
        } else if (next.status === "expired") {
          setPageState("error");
          setMessage("That authorization has expired. Start AviaryMCP again to get a new code.");
        } else if (next.status === "pending") {
          setPageState("ready");
        } else {
          setPageState("error");
          setMessage("This authorization is no longer pending. Start enrollment again if needed.");
        }
      } catch (error) {
        if (requestSequence !== sequence.current) return;
        setPageState("error");
        setMessage(error instanceof Error ? error.message : "Could not load this authorization.");
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [code]);

  const manifest = description?.manifest;
  const publicRequested =
    manifest?.edge_auth === "public" || description?.public_approval_required === true;
  const canApprove =
    pageState === "ready" && !!manifest && (!publicRequested || publicConfirmed);

  async function decide(decision: "approve" | "deny") {
    if (!description?.manifest || pageState !== "ready") return;
    if (decision === "approve" && publicRequested && !publicConfirmed) return;

    setPageState("submitting");
    setMessage("");
    try {
      const endpoint = decision === "approve"
        ? "/api/finch/aviary-approve"
        : "/api/finch/aviary-deny";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          user_code: normalizedCode(code),
          ...(decision === "approve" ? { public_approved: publicConfirmed } : {}),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, response.status));
      setPageState(decision === "approve" ? "approved" : "denied");
    } catch (error) {
      setPageState("error");
      setMessage(error instanceof Error ? error.message : "Could not submit this authorization.");
    }
  }

  return (
    <main className="cli-page aviary-authorize-page">
      <div className="cli-nav">
        <Link className="logo" href="/"><span className="logo-mark">🐦</span> Finch</Link>
        <UserButton />
      </div>
      <div className="cli-box aviary-authorize-box">
        <span className="eyebrow">🪶 Connect AviaryMCP</span>
        <h1>Authorize this service</h1>
        <p className="cli-sub">
          Review the exact service, machine, routes, and edge access requested by the device you started.
        </p>

        <label className="aviary-code-label" htmlFor="aviary-user-code">Device code</label>
        <input
          id="aviary-user-code"
          className="cli-code"
          value={code}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
          placeholder="XXXX-XXXX"
          spellCheck={false}
          autoComplete="off"
          autoFocus
        />

        {pageState === "loading" && <div className="aviary-loading">Loading the signed request…</div>}

        {manifest && (
          <section className="aviary-review" aria-label="Requested Aviary service manifest">
            <div className="aviary-review-head">
              <div>
                <span className="aviary-kicker">Service</span>
                <strong>{manifest.service}</strong>
              </div>
              <span className={`aviary-edge ${publicRequested ? "public" : "private"}`}>
                {publicRequested ? "Public" : "Finch authenticated"}
              </span>
            </div>
            <dl className="aviary-manifest">
              <div><dt>App path</dt><dd><code className="mono">/{manifest.app_path}</code></dd></div>
              <div><dt>Machine</dt><dd>{manifest.machine}</dd></div>
              <div className="wide"><dt>Machine fingerprint</dt><dd><code className="mono">{manifest.machine_fingerprint}</code></dd></div>
              <div className="wide"><dt>Allowed routes</dt><dd className="aviary-routes">
                {manifest.routes.map((route) => <code className="mono" key={route}>{route}</code>)}
              </dd></div>
            </dl>
            <div className="aviary-origin">
              <span>Started from</span>
              <code className="mono">{description?.req_ip || "unknown IP"}</code>
              <span className="aviary-ua">{description?.req_ua || "unknown client"}</span>
              <small>{ageLabel(description?.age_seconds)}</small>
            </div>
            <div className="aviary-digest">
              {description?.expires_at && <span>Expires <time dateTime={description.expires_at}>{description.expires_at}</time> · </span>}
              Manifest SHA-256 <code className="mono" title={description?.manifest_sha256}>{digestSuffix(description?.manifest_sha256)}</code>
            </div>
          </section>
        )}

        {manifest && pageState === "ready" && (
          <>
            {publicRequested ? (
              <label className="aviary-public-confirm">
                <input
                  type="checkbox"
                  checked={publicConfirmed}
                  onChange={(event) => setPublicConfirmed(event.target.checked)}
                />
                <span>
                  <strong>Allow unauthenticated public Internet access</strong>
                  Anyone who knows the service URL can reach the routes shown above without a Finch key or login.
                </span>
              </label>
            ) : (
              <div className="aviary-private-note">
                Finch will authenticate callers at the edge before forwarding any request to this service.
              </div>
            )}
            <div className="aviary-actions">
              <button
                type="button"
                className="btn btn-lg btn-amber"
                onClick={() => void decide("approve")}
                disabled={!canApprove}
              >
                Approve exact manifest
              </button>
              <button
                type="button"
                className="btn btn-md btn-ghost aviary-deny"
                onClick={() => void decide("deny")}
              >
                Deny request
              </button>
            </div>
          </>
        )}

        {pageState === "submitting" && <div className="aviary-loading">Recording your decision…</div>}
        {pageState === "approved" && (
          <div className="aviary-result ok" role="status">
            <strong>✓ Service approved</strong>
            The waiting device can finish connecting. You can close this tab.
          </div>
        )}
        {pageState === "denied" && (
          <div className="aviary-result denied" role="status">
            <strong>{description?.detail === "app_path_collision" ? "App path already owned" : "Request denied"}</strong>
            {description?.detail === "app_path_collision"
              ? "Nothing was approved. Choose another app path and start enrollment again."
              : "No service credential was issued. You can close this tab."}
          </div>
        )}
        {pageState === "error" && <div className="cli-err aviary-error" role="alert">{message}</div>}

        <div className="cli-warn">
          Only approve a code created on a machine you control. Finch authorizes exactly the manifest and fingerprint displayed here; this flow never gives the app a tenant-admin CLI token.
        </div>
      </div>
    </main>
  );
}
