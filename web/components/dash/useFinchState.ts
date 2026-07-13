"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TenantState, TenantsResponse } from "./data";

export function useFinchState() {
  const [state,setState]=useState<TenantState|null>(null);
  const [tenants,setTenants]=useState<TenantsResponse|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState<string|null>(null);
  const alive=useRef(true);
  const verificationBlocked=useRef(false);
  const bootstrap=useCallback(async()=>{const res=await fetch("/api/finch/tenants",{cache:"no-store"});const body=await res.json().catch(()=>({}));if(!res.ok)throw new Error(body.error||`HTTP ${res.status}`);verificationBlocked.current=body.needsVerifiedEmail===true;if(alive.current)setTenants(body);return body as TenantsResponse;},[]);
  const refetch=useCallback(async()=>{if(verificationBlocked.current){if(alive.current){setError(null);setLoading(false);}return;}try{const res=await fetch("/api/finch/state",{headers:{accept:"application/json"},cache:"no-store"});const body=await res.json().catch(()=>({}));if(!res.ok){if(res.status===403){const refreshed=await bootstrap();const personal=refreshed.tenants.find(t=>t.kind==="personal"&&t.state==="active")?.tenantId;if(personal){const selected=await fetch("/api/finch/tenants/select",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({tenantId:personal})});if(selected.ok){window.location.reload();return;}}}throw new Error(body.error||`HTTP ${res.status}`);}if(alive.current){setState(body);setError(null);}}catch(e){if(alive.current)setError(e instanceof Error?e.message:"failed to load state");}finally{if(alive.current)setLoading(false);}},[bootstrap]);
  useEffect(()=>{alive.current=true;(async()=>{try{const initial=await bootstrap();if(initial.needsVerifiedEmail){if(alive.current){setError(null);setLoading(false);}return;}await refetch();}catch(e){if(alive.current){setError(e instanceof Error?e.message:"failed to bootstrap");setLoading(false);}}})();return()=>{alive.current=false};},[bootstrap,refetch]);
  useEffect(()=>{const timer=setInterval(()=>{if(!document.hidden&&!verificationBlocked.current)void refetch()},7000);return()=>clearInterval(timer);},[refetch]);
  return {state,tenants,loading,error,refetch,refetchTenants:bootstrap};
}
