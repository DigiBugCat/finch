import { beforeEach, describe, expect, it, vi } from "vitest";
const getUser=vi.fn(), getMemberships=vi.fn();
vi.mock("@clerk/nextjs/server",()=>({clerkClient:async()=>({users:{getUser,getOrganizationMembershipList:getMemberships}})}));
import { syncIdentity } from "@/lib/identity";

describe("syncIdentity verified canonical email",()=>{
  beforeEach(()=>vi.clearAllMocks());
  it("falls back to the first verified address when Clerk primary is unverified",async()=>{
    getUser.mockResolvedValue({primaryEmailAddressId:"e_primary",emailAddresses:[{id:"e_primary",emailAddress:"NO@example.com",verification:{status:"unverified"}},{id:"e_secondary",emailAddress:"Verified@Example.com",verification:{status:"verified"}}]});
    const out=await syncIdentity("u_1");
    expect(out.emails).toEqual(["verified@example.com"]);
    expect(out.primaryEmail).toBe("verified@example.com");
  });
});
