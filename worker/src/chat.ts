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

const MODEL = "@cf/google/gemma-4-26b-a4b-it";
const CONTEXT_CHAR_BUDGET = 8000 * 3; // ~8k tokens, roughly 3 chars/token
const MAX_TOOL_HOPS = 4;

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
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid JSON" });
  }
  const appliance = String(body.appliance || "").trim();
  const key = String(body.key || "").trim();
  const userMessages: Msg[] = Array.isArray(body.messages) ? body.messages : [];
  if (!appliance || !key || !userMessages.length) {
    return json(400, { error: "appliance, key and messages are required" });
  }

  // Discover the appliance's tools (this also proves the relay works).
  let tools: any[];
  try {
    const listed = await mcp(env, origin, appliance, key, "tools/list", {});
    tools = listed?.tools || [];
  } catch (e: any) {
    return json(502, { error: `couldn't reach ${appliance}: ${e.message || e}` });
  }
  const toolNames = new Set(tools.map((t) => t.name));

  const sys: Msg = {
    role: "system",
    content:
      `You are a concise assistant connected to the user's finch appliance "${appliance}". ` +
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
        const r = await mcp(env, origin, appliance, key, "tools/call", { name: call.tool, arguments: call.args || {} });
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
async function mcp(env: Env, origin: string, appliance: string, key: string, method: string, params: any): Promise<any> {
  const res = await env.SELF.fetch(`${origin}/${encodeURIComponent(appliance)}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 120)}`);
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON from appliance: ${text.slice(0, 120)}`);
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

const CHAT_HTML = `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>finch · chat check</title>
<style>
:root{--bg:#231e16;--card:#2d271c;--line:#3f3725;--line2:#4b4129;--ink:#f1e9d8;--dim:#a89d85;--amber:#f2b443;--green:#79d995;--mono:ui-monospace,Menlo,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}
.wrap{max-width:720px;margin:0 auto;padding:22px 16px;display:flex;flex-direction:column;min-height:100vh}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--dim);font-size:13px;margin-bottom:16px}
.cfg{display:flex;gap:8px;margin-bottom:14px}
input{flex:1;background:#191309;border:1px solid var(--line2);border-radius:9px;color:var(--ink);padding:10px 12px;font:14px var(--mono)}
input:focus{outline:none;border-color:var(--amber)}
.log{flex:1;display:flex;flex-direction:column;gap:10px;overflow:auto;padding:6px 2px}
.msg{padding:10px 13px;border-radius:13px;max-width:85%;white-space:pre-wrap;word-wrap:break-word}
.u{align-self:flex-end;background:var(--amber);color:#2a200c;font-weight:600}
.a{align-self:flex-start;background:var(--card);border:1px solid var(--line)}
.tool{align-self:flex-start;font:12px var(--mono);color:var(--green);background:#1d2a1f;border:1px solid #2f4733;border-radius:9px;padding:7px 11px;max-width:85%;white-space:pre-wrap}
.bar{display:flex;gap:8px;margin-top:12px}
button{background:var(--amber);color:#2a200c;border:0;border-radius:999px;padding:11px 20px;font-weight:800;cursor:pointer}
button:disabled{opacity:.5}
.hint{color:var(--dim);font-size:12px;margin-top:8px}
a{color:var(--amber)}
</style></head><body><div class="wrap">
<h1>🐦 finch · chat check</h1>
<div class="sub">Chat with an LLM (Workers AI · gemma) that calls your appliance's MCP tools. If it can roll a die or add numbers, your endpoint works.</div>
<div class="cfg">
  <input id="app" placeholder="appliance (e.g. hello)"/>
  <input id="key" placeholder="finch_… key" type="password"/>
</div>
<div class="log" id="log"></div>
<div class="bar"><input id="msg" placeholder="try: roll a d20  ·  what is 40 + 2?" /><button id="send">Send</button></div>
<div class="hint">Mint a finch_ key in the dashboard → Keys. Stored locally in your browser only.</div>
</div><script>
const $=s=>document.querySelector(s), log=$('#log');
$('#app').value=localStorage.fchApp||''; $('#key').value=localStorage.fchKey||'';
const hist=[];
function add(cls,text){const d=document.createElement('div');d.className='msg '+cls;d.textContent=text;log.appendChild(d);log.scrollTop=log.scrollHeight;return d;}
function addTool(t){const d=document.createElement('div');d.className='tool';d.textContent='🔧 '+t.tool+'('+JSON.stringify(t.args||{})+') → '+t.result;log.appendChild(d);log.scrollTop=log.scrollHeight;}
async function send(){
  const app=$('#app').value.trim(), key=$('#key').value.trim(), text=$('#msg').value.trim();
  if(!app||!key||!text)return;
  localStorage.fchApp=app; localStorage.fchKey=key;
  $('#msg').value=''; add('u',text); hist.push({role:'user',content:text});
  $('#send').disabled=true; const thinking=add('a','…');
  try{
    const r=await fetch('/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({appliance:app,key,messages:hist})});
    const j=await r.json();
    thinking.remove();
    (j.trace||[]).forEach(addTool);
    if(j.error){add('a','⚠️ '+j.error);}
    else{add('a',j.reply||'(no reply)'); hist.push({role:'assistant',content:j.reply||''});}
  }catch(e){thinking.remove();add('a','⚠️ '+e.message);}
  $('#send').disabled=false; $('#msg').focus();
}
$('#send').onclick=send; $('#msg').addEventListener('keydown',e=>{if(e.key==='Enter')send();});
</script></body></html>`;
