// lib/entitlements.ts — the plan/entitlement seam.
//
// Sharing (inviting org teammates + editing ACL access rules) is a paid "Team"
// capability. During the beta EVERY tenant is entitled — this file is the single
// place that changes when real billing lands. Nothing else in the app decides
// entitlement; call sites only see the boolean.
//
// When billing ships, give `hasFeature` a real body — read a Clerk Billing
// subscription, a `plan` field on the hub's TenantState, or a Stripe-fed
// entitlement. The source is deliberately left abstract; the signature
// (tenant + feature -> Promise<boolean>) is all any call site depends on.

import "server-only";

/** Gated capabilities. "sharing" = invite teammates + manage ACL access. */
export type Feature = "sharing";

/**
 * Whether `tenant` is entitled to `feature`.
 *
 * BETA: everyone is entitled to everything. Flip this to a real plan lookup to
 * turn the seam on — no call site needs to change.
 */
export async function hasFeature(
  _tenant: string,
  _feature: Feature,
): Promise<boolean> {
  return true; // BETA: all tenants entitled. Replace with a real plan lookup.
}
