/// <reference types="@cloudflare/workers-types" />
//
// chat.ts — a tiny test chat that drives an appliance's MCP tools through a
// Workers AI model. Purely a "does my MCP endpoint actually work" check:
//
//   GET  /chat               → a self-contained chat page (appliance + finch_ key)
//   POST /chat/completions   → one turn: the model may call the appliance's tools
//
// Tool use is PROMPT-BASED (the model emits a {"tool","args"} JSON line) so it
// works regardless of a model's native function-calling support. Tool calls are
// executed by relaying tools/call to the appliance over the SAME public path a
// real client uses — so a green answer means the whole finch loop works.

import type { Env } from "./index";
import { serviceOk, verifyAssertion } from "./auth";
import { rateLimitOk, clientIp } from "./index";

const MODEL = "@cf/google/gemma-4-26b-a4b-it";
const CONTEXT_CHAR_BUDGET = 8000 * 3; // ~8k tokens, roughly 3 chars/token
const MAX_TOOL_HOPS = 3;
const MAX_BODY_BYTES = 256 * 1024; // cap the request body (no streamed uploads here)
const MAX_MESSAGES = 30; // keep only the most recent turns
const MAX_MSG_CHARS = 8000; // clamp any single message

export async function handleChat(req: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/chat" && req.method === "GET") {
    return new Response(CHAT_HTML, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }
  if (url.pathname === "/chat/completions" && req.method === "POST") {
    return chatCompletion(req, env, url.origin);
  }
  return new Response("not found", { status: 404 });
}

type Msg = { role: "system" | "user" | "assistant"; content: string };

async function chatCompletion(req: Request, env: Env, origin: string): Promise<Response> {
  // Cap inference fan-out: this drives up to MAX_TOOL_HOPS+1 AI calls per request.
  if (!(await rateLimitOk(env.RELAY_LIMIT, `chat:${clientIp(req)}`))) {
    return json(429, { error: "rate limited" });
  }
  // Enforce the body cap on the ACTUAL bytes (content-length is client-controlled
  // and absent for chunked) — buffer then check, like relayMcp does.
  let raw: ArrayBuffer;
  try {
    raw = await req.arrayBuffer();
  } catch {
    return json(400, { error: "invalid body" });
  }
  if (raw.byteLength > MAX_BODY_BYTES) {
    return json(413, { error: "request body too large" });
  }
  let body: any;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return json(400, { error: "invalid JSON" });
  }
  const appliance = String(body.appliance || "").trim();
  // Keep only the most recent turns, each length-clamped, so a giant history
  // can't blow up the model context / cost.
  const userMessages: Msg[] = (Array.isArray(body.messages) ? body.messages : [])
    .slice(-MAX_MESSAGES)
    .map((m: any) => ({
      role: m && m.role === "assistant" ? "assistant" : "user",
      content: String((m && m.content) || "").slice(0, MAX_MSG_CHARS),
    }));
  if (!appliance || !userMessages.length) {
    return json(400, { error: "service and messages are required" });
  }

  // Two ways to authorize the relay this chat performs:
  //   • the dashboard forwards the web's service secret + tenant assertion
  //     (no key juggling) — we relay those headers through;
  //   • the standalone page provides a finch_ key.
  let authHeaders: Record<string, string>;
  const svcOk =
    serviceOk(req, env) && !!(await verifyAssertion(req.headers.get("x-finch-auth") || "", env.FINCH_SERVICE_SECRET));
  if (svcOk) {
    authHeaders = {
      "x-finch-service": req.headers.get("x-finch-service") || "",
      "x-finch-auth": req.headers.get("x-finch-auth") || "",
    };
  } else {
    const key = String(body.key || "").trim();
    if (!key) return json(401, { error: "a finch_ key (or first-party auth) is required" });
    authHeaders = { authorization: `Bearer ${key}` };
  }

  // Discover the appliance's tools (this also proves the relay works).
  let tools: any[];
  try {
    const listed = await mcp(env, origin, appliance, authHeaders, "tools/list", {});
    tools = listed?.tools || [];
  } catch (e: any) {
    return json(502, { error: `couldn't reach ${appliance}: ${e.message || e}` });
  }
  const toolNames = new Set(tools.map((t) => t.name));

  const sys: Msg = {
    role: "system",
    content:
      `You are a concise assistant connected to the user's finch service "${appliance}". ` +
      `You can call these tools:\n` +
      tools.map((t) => `- ${t.name}: ${t.description || ""}  schema=${JSON.stringify(t.inputSchema || {})}`).join("\n") +
      `\n\nTo call a tool, reply with ONE line of JSON and nothing else: {"tool":"<name>","args":{...}}. ` +
      `After you get the tool result, answer the user in plain language. If no tool is needed, just answer.`,
  };

  const trace: any[] = [];
  let msgs: Msg[] = [sys, ...userMessages];
  for (let hop = 0; hop <= MAX_TOOL_HOPS; hop++) {
    msgs = trim(msgs);
    let out: any;
    try {
      out = await env.AI.run(MODEL as any, { messages: msgs, max_tokens: 512 });
    } catch (e: any) {
      return json(500, { error: `model error: ${e.message || e}`, trace });
    }
    const text = String(
      out?.choices?.[0]?.message?.content ?? out?.response ?? out?.result?.response ?? "",
    ).trim();
    const call = parseToolCall(text);
    if (hop < MAX_TOOL_HOPS && call && toolNames.has(call.tool)) {
      let result: string;
      try {
        const r = await mcp(env, origin, appliance, authHeaders, "tools/call", { name: call.tool, arguments: call.args || {} });
        result = r?.content?.[0]?.text ?? JSON.stringify(r);
      } catch (e: any) {
        result = `tool error: ${e.message || e}`;
      }
      trace.push({ tool: call.tool, args: call.args, result });
      msgs.push({ role: "assistant", content: text });
      msgs.push({ role: "user", content: `[result of ${call.tool}]: ${result}` });
      continue;
    }
    return json(200, { reply: text, trace });
  }
  return json(200, { reply: "(stopped after tool loop)", trace });
}

/** Relay a JSON-RPC call to the appliance over our own MCP path. Uses the SELF
 *  service binding — a plain fetch to our own hostname is blocked (error 1042). */
async function mcp(env: Env, origin: string, appliance: string, authHeaders: Record<string, string>, method: string, params: any): Promise<any> {
  const res = await env.SELF.fetch(`${origin}/${encodeURIComponent(appliance)}/mcp`, {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 120)}`);
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON from service: ${text.slice(0, 120)}`);
  }
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result;
}

/** Find a {"tool":...,"args":{...}} object in the model's text (handles nested
 *  braces in args and ```json fences). */
function parseToolCall(text: string): { tool: string; args: any } | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  for (const cand of [cleaned, extractBalanced(cleaned)]) {
    if (!cand) continue;
    try {
      const o = JSON.parse(cand);
      if (o && typeof o.tool === "string") return { tool: o.tool, args: o.args ?? {} };
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** The first brace-balanced {...} substring, or null. */
function extractBalanced(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

/** Keep the system message + most-recent turns under the context budget. */
function trim(msgs: Msg[]): Msg[] {
  const sys = msgs[0];
  let rest = msgs.slice(1);
  const size = (m: Msg[]) => m.reduce((n, x) => n + x.content.length, 0);
  while (rest.length > 2 && size([sys, ...rest]) > CONTEXT_CHAR_BUDGET) rest = rest.slice(1);
  return [sys, ...rest];
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CHAT_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>finch · chat</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap" rel="stylesheet"/>
<style>
:root{
  --bg:#231e16;--card:#2d271c;--card2:#251f15;--card-hi:#352d20;--line:#3f3725;--line2:#4b4129;
  --ink:#f1e9d8;--dim:#a89d85;--amber:#f2b443;--amber2:#f6c66a;--amber-soft:#41351c;
  --green:#79d995;--green-soft:#283a2a;--violet:#c4a8ef;--violet-soft:#2e2740;
  --mono:ui-monospace,"SF Mono",Menlo,monospace;--r:16px;--r-lg:18px;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font-family:"Nunito",system-ui,sans-serif;font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased;
  background-image:radial-gradient(900px 460px at 80% -8%,rgba(242,180,67,.10),transparent 64%),radial-gradient(700px 520px at 5% 0%,rgba(196,168,239,.06),transparent 62%)}
.wrap{max-width:760px;margin:0 auto;padding:26px 18px 18px;display:flex;flex-direction:column;min-height:100vh}
a{color:var(--amber);text-decoration:none}
.mono{font-family:var(--mono);font-size:.9em}
.back{color:var(--dim);font-weight:700;font-size:14px;margin-bottom:16px;display:inline-block}
.card{background:linear-gradient(180deg,#2f2819,var(--card));border:1px solid var(--line2);border-radius:var(--r-lg);
  box-shadow:0 28px 64px -34px rgba(0,0,0,.7);margin-bottom:16px}
.seclabel{display:flex;align-items:baseline;gap:10px;font-weight:800;font-size:12px;text-transform:uppercase;
  letter-spacing:.07em;color:var(--dim);margin-bottom:13px}
.seclabel small{text-transform:none;letter-spacing:0;font-weight:600;opacity:.7}
/* header card */
.head{display:flex;align-items:center;gap:16px;padding:20px 22px}
.avatar{width:48px;height:48px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;
  font-size:22px;background:var(--amber-soft);box-shadow:0 0 0 1px rgba(242,180,67,.25),0 0 14px rgba(242,180,67,.18);flex-shrink:0}
.head-mid{flex:1;min-width:0}
.head-id{display:flex;align-items:center;gap:11px}
.head-id h1{font-size:22px;font-weight:900;margin:0;font-family:var(--mono);color:var(--amber);letter-spacing:-0.01em}
.head-sub{font-size:13px;color:var(--dim);margin-top:5px}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:800;padding:4px 11px;border-radius:999px;white-space:nowrap}
.pill-live{background:var(--green-soft);color:var(--green)}
.pill-off{background:#2b2519;color:var(--dim)}
.pill-dot{width:7px;height:7px;border-radius:50%;background:var(--green);animation:pulse 2s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(121,217,149,.5)}70%{box-shadow:0 0 0 6px rgba(121,217,149,0)}100%{box-shadow:0 0 0 0 rgba(121,217,149,0)}}
/* connect card */
.body{padding:18px 22px 20px}
.fields{display:flex;gap:10px}
.field{flex:1;background:#191309;border:1px solid var(--line2);border-radius:11px;color:var(--ink);
  padding:11px 13px;font-family:var(--mono);font-size:13px}
.field:focus{outline:none;border-color:var(--amber)}
.hint{color:var(--dim);font-size:12.5px;margin-top:11px}
/* chat card */
.chat{flex:1;display:flex;flex-direction:column;min-height:340px}
.log{flex:1;display:flex;flex-direction:column;gap:11px;overflow:auto;padding:2px}
.empty{margin:auto;text-align:center;color:var(--dim);font-size:14px;max-width:34ch}
.empty .chips{margin-top:14px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
.chip{background:#191309;border:1px solid var(--line2);border-radius:999px;padding:7px 13px;font-size:12.5px;cursor:pointer;color:var(--ink)}
.chip:hover{border-color:var(--amber);color:var(--amber)}
.msg{padding:11px 14px;border-radius:15px;max-width:84%;white-space:pre-wrap;word-wrap:break-word;font-size:14.5px}
.u{align-self:flex-end;background:var(--amber);color:#2a200c;font-weight:700;border-bottom-right-radius:5px}
.a{align-self:flex-start;background:var(--card-hi);border:1px solid var(--line);border-bottom-left-radius:5px}
.a.err{border-color:rgba(232,132,143,.4);color:#e8848f}
.tool{align-self:flex-start;display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12px;
  color:var(--green);background:var(--green-soft);border:1px solid #2f4733;border-radius:11px;padding:8px 12px;max-width:84%}
.tool b{color:var(--amber2);font-weight:700}
.dots{display:inline-block}.dots::after{content:'';animation:dots 1.2s steps(4,end) infinite}
@keyframes dots{0%{content:''}25%{content:'.'}50%{content:'..'}75%{content:'...'}}
.bar{display:flex;gap:10px;margin-top:14px}
.bar .field{font-family:"Nunito",sans-serif;font-size:14.5px}
.send{background:var(--amber);color:#2a200c;border:0;border-radius:999px;padding:0 22px;font-weight:800;font-size:15px;cursor:pointer;
  box-shadow:0 10px 26px -10px rgba(242,180,67,.5)}
.send:hover{background:var(--amber2)}.send:disabled{opacity:.5;box-shadow:none;cursor:default}
.logo{display:flex;align-items:center;gap:9px;font-weight:900;font-size:19px;margin-bottom:18px}
.logo-mark{width:28px;height:28px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;
  background:radial-gradient(circle at 35% 30%,#4a3a1c,#2a2113);box-shadow:0 0 0 1px var(--line);font-size:15px}
</style></head><body><div class="wrap">
<div class="logo"><span class="logo-mark">🐦</span> Finch <span style="color:var(--dim);font-weight:700;font-size:14px">· chat</span></div>

<div class="card head">
  <span class="avatar">🐦</span>
  <div class="head-mid">
    <div class="head-id"><h1 id="hId">chat</h1><span class="pill pill-off" id="hPill">not connected</span></div>
    <div class="head-sub">Chat with an LLM that calls your service's MCP tools — a quick "does my endpoint work" check.</div>
  </div>
</div>

<div class="card">
  <div class="body">
    <div class="seclabel">connect <small>your service + a finch_ key (stored in this browser only)</small></div>
    <div class="fields">
      <input class="field" id="app" placeholder="service — e.g. hello" style="max-width:200px"/>
      <input class="field" id="key" placeholder="finch_… key" type="password"/>
    </div>
    <div class="hint">Mint a key in the dashboard → <b>Keys</b>. The model runs on Cloudflare Workers AI.</div>
  </div>
</div>

<div class="card chat"><div class="body" style="flex:1;display:flex;flex-direction:column">
  <div class="seclabel">chat <small>gemma · workers ai</small></div>
  <div class="log" id="log"></div>
  <div class="bar">
    <input class="field" id="msg" placeholder="Ask something that uses a tool…"/>
    <button class="send" id="send">Send</button>
  </div>
</div></div>

</div><script>
const $=s=>document.querySelector(s), log=$('#log');
$('#app').value=localStorage.fchApp||''; $('#key').value=localStorage.fchKey||'';
const hist=[]; let empty;
function syncHead(){const a=$('#app').value.trim();$('#hId').textContent=a||'chat';
  const p=$('#hPill');if(a){p.className='pill pill-live';p.innerHTML='<span class=pill-dot></span>'+a;}else{p.className='pill pill-off';p.textContent='not connected';}}
$('#app').addEventListener('input',syncHead); syncHead();
function showEmpty(){empty=document.createElement('div');empty.className='empty';
  empty.innerHTML='Try one of these — the model will call your tool to answer:<div class=chips></div>';
  ['roll a d20','what is 40 + 2?','echo hello finch'].forEach(t=>{const c=document.createElement('div');c.className='chip';c.textContent=t;c.onclick=()=>{$('#msg').value=t;send();};empty.querySelector('.chips').appendChild(c);});
  log.appendChild(empty);}
showEmpty();
function add(cls,text){if(empty){empty.remove();empty=null;}const d=document.createElement('div');d.className='msg '+cls;d.textContent=text;log.appendChild(d);log.scrollTop=log.scrollHeight;return d;}
function addTool(t){if(empty){empty.remove();empty=null;}const d=document.createElement('div');d.className='tool';
  d.innerHTML='🔧 <b>'+t.tool+'</b>('+escapeHtml(JSON.stringify(t.args||{}))+') → '+escapeHtml(t.result);log.appendChild(d);log.scrollTop=log.scrollHeight;}
function escapeHtml(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
async function send(){
  const app=$('#app').value.trim(), key=$('#key').value.trim(), text=$('#msg').value.trim();
  if(!text)return;
  if(!app||!key){add('a err','Enter your service and a finch_ key above first.');return;}
  localStorage.fchApp=app; localStorage.fchKey=key;
  $('#msg').value=''; add('u',text); hist.push({role:'user',content:text});
  $('#send').disabled=true; const thinking=add('a','');thinking.innerHTML='<span class=dots></span>';
  try{
    const r=await fetch('/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({appliance:app,key,messages:hist})});
    const j=await r.json();
    thinking.remove();
    (j.trace||[]).forEach(addTool);
    if(j.error){add('a err','⚠️ '+j.error);}
    else{add('a',j.reply||'(no reply)'); hist.push({role:'assistant',content:j.reply||''});}
  }catch(e){thinking.remove();add('a err','⚠️ '+e.message);}
  $('#send').disabled=false; $('#msg').focus();
}
$('#send').onclick=send; $('#msg').addEventListener('keydown',e=>{if(e.key==='Enter')send();});
</script></body></html>`;
