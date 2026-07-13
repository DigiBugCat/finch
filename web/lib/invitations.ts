import "server-only";
import { clerkClient } from "@clerk/nextjs/server";
export type InvitationDelivery = "sent" | "existing-user" | "failed";
export async function deliverApplicationInvite(email:string,origin:string):Promise<InvitationDelivery>{
  try { const clerk=await clerkClient(); await clerk.invitations.createInvitation({emailAddress:email,redirectUrl:`${origin.replace(/\/$/,"")}/dashboard`,ignoreExisting:true,notify:true}); return "sent"; }
  catch(err:any){const code=String(err?.errors?.[0]?.code??err?.code??"").toLowerCase();if(code.includes("exists")||code.includes("duplicate")||code.includes("already"))return "existing-user";console.error("Finch invitation delivery failed",err);return "failed";}
}
