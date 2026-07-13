import { describe, it, expect, vi } from "vitest";
const authMock=vi.fn();
vi.mock("@clerk/nextjs/server",()=>({auth:()=>authMock(),clerkClient:vi.fn()}));
vi.mock("next/headers",()=>({cookies:async()=>({get:()=>undefined,delete:vi.fn(),set:vi.fn()})}));
import {resolveTenant,HttpError} from "@/lib/hub";
describe("native tenant authorization",()=>{it("rejects unauthenticated requests without consulting organization claims",async()=>{authMock.mockResolvedValue({userId:null,orgId:"org_ignored",orgRole:"org:admin"});await expect(resolveTenant()).rejects.toBeInstanceOf(HttpError);await expect(resolveTenant()).rejects.toMatchObject({status:401});});});
