import {describe,it,expect,vi,beforeEach} from "vitest";
const authMock=vi.fn();vi.mock("@clerk/nextjs/server",()=>({auth:()=>authMock()}));
process.env.HUB_URL="https://hub.example.com";process.env.FINCH_SERVICE_SECRET="test-service-secret";
import {POST} from "@/app/api/finch/keys/route";
const req=()=>new Request("https://app.example.com/api/finch/keys",{method:"POST",body:JSON.stringify({label:"laptop",owner:"owner@example.com",scope:{all:true}})});
beforeEach(()=>{authMock.mockReset();vi.restoreAllMocks()});
describe("POST /api/finch/keys native role gate",()=>{
it("rejects a live Finch member before mutation",async()=>{authMock.mockResolvedValue({userId:"user_1"});const fetchSpy=vi.spyOn(globalThis,"fetch").mockResolvedValueOnce(Response.json({member:{id:"m_1",role:"member",state:"active",email:"m@example.com"},tenantMeta:{id:"user_1"}}));expect((await POST(req())).status).toBe(403);expect(fetchSpy).toHaveBeenCalledTimes(1)});
it("returns 401 unauthenticated",async()=>{authMock.mockResolvedValue({userId:null});const spy=vi.spyOn(globalThis,"fetch");expect((await POST(req())).status).toBe(401);expect(spy).not.toHaveBeenCalled()});
it("forwards after a live Finch owner context",async()=>{authMock.mockResolvedValue({userId:"user_owner"});const fetchSpy=vi.spyOn(globalThis,"fetch").mockResolvedValueOnce(Response.json({member:{id:"m_1",role:"owner",state:"active",email:"owner@example.com"},tenantMeta:{id:"user_1"}})).mockResolvedValueOnce(Response.json({key:"finch_secret",label:"laptop",scope:{all:true}}));const res=await POST(req());expect(res.status).toBe(200);expect(fetchSpy).toHaveBeenCalledTimes(2);expect(fetchSpy.mock.calls[1][0]).toBe("https://hub.example.com/api/keys")});
});
