import {describe,it,expect,vi,beforeEach} from "vitest";
const authMock=vi.fn();vi.mock("@clerk/nextjs/server",()=>({auth:()=>authMock()}));process.env.HUB_URL="https://hub.example.com";process.env.FINCH_SERVICE_SECRET="test-service-secret";
import {POST} from "@/app/api/finch/sessions/revoke/route";
beforeEach(()=>{authMock.mockReset();vi.restoreAllMocks()});
describe("session revocation native role gate",()=>{
it("rejects members",async()=>{authMock.mockResolvedValue({userId:"u"});const spy=vi.spyOn(globalThis,"fetch").mockResolvedValueOnce(Response.json({member:{id:"m",role:"member",state:"active",email:"m@x.com"},tenantMeta:{id:"u"}}));expect((await POST()).status).toBe(403);expect(spy).toHaveBeenCalledTimes(1)});
it("forwards owners",async()=>{authMock.mockResolvedValue({userId:"u_owner"});const spy=vi.spyOn(globalThis,"fetch").mockResolvedValueOnce(Response.json({member:{id:"m",role:"owner",state:"active",email:"o@x.com"},tenantMeta:{id:"u"}})).mockResolvedValueOnce(Response.json({ok:true,epoch:2}));expect((await POST()).status).toBe(200);expect(spy.mock.calls[1][0]).toBe("https://hub.example.com/api/sessions-revoke")});
it("rejects unauthenticated callers",async()=>{authMock.mockResolvedValue({userId:null});expect((await POST()).status).toBe(401)});});
