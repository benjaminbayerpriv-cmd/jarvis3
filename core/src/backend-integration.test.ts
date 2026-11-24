import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const freePort = () => { const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() }); const p = s.port!; s.stop(); return p; };

test("isolierter Daemon: Backend, Hermes-Stream, Sitzung und Not-Aus", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-int-")), bin = join(root, "bin"); mkdirSync(bin);
  const oc = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/global/health") return Response.json({ healthy: true });
    if (path === "/event") return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(": connected\n\n")); } }));
    if (path === "/session") return Response.json([]);
    if (path === "/session/status") return Response.json({});
    return Response.json({});
  } });
  const hermesPort = freePort(), daemonPort = freePort();
  writeFileSync(join(bin, "opencode"), '#!/bin/sh\n[ "$1" = models ] && echo opencode/test\n', { mode: 0o755 });
  const fake = join(root, "fake-hermes.ts");
  writeFileSync(fake, `
const streams = new Map(); let n = 0; const sessions = new Map();
Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.API_SERVER_PORT), async fetch(req) {
 const u = new URL(req.url), p = u.pathname;
 if (req.headers.get('authorization') !== 'Bearer test-secret-1234567890') return new Response('', {status: 401});
 if (p === '/v1/capabilities') return Response.json({features:{run_submission:true,run_events_sse:true,run_stop:true}});
 if (p === '/api/sessions' && req.method === 'POST') { const id = 'api_' + (++n); sessions.set(id, []); return Response.json({session:{id}}); }
 if (p.startsWith('/api/sessions/') && p.endsWith('/messages')) {const id = decodeURIComponent(p.split('/')[3]); return Response.json({data:sessions.get(id) || []});}
 if (p.startsWith('/api/sessions/') && req.method === 'PATCH') return Response.json({});
 if (p === '/v1/runs' && req.method === 'POST') {const b = await req.json(), id='run_'+(++n); sessions.get(b.session_id).push({id:'m'+n,role:'user',content:b.input}); streams.set(id,{input:b.input, session:b.session_id}); return Response.json({run_id:id});}
 if (p.endsWith('/events')) {const id=p.split('/')[3], run=streams.get(id); return new Response(new ReadableStream({start(c) {run.controller=c; if(run.input !== 'warte') {sessions.get(run.session).push({id:'a'+n,role:'assistant',content:'Hallo'}); c.enqueue(new TextEncoder().encode('data: {"event":"message.delta","delta":"Hallo"}\\n\\ndata: {"event":"run.completed","output":"Hallo"}\\n\\n')); c.close();}}}));}
 if (p.endsWith('/stop')) { const run=streams.get(p.split('/')[3]); run.controller.enqueue(new TextEncoder().encode('data: {"event":"run.cancelled"}\\n\\n')); run.controller.close(); return Response.json({status:'stopping'}); }
 return new Response('',{status:404});
}});`);
  writeFileSync(join(bin, "hermes"), `#!/bin/sh\nexec '${process.execPath}' '${fake}'\n`, { mode: 0o755 });
  const proc = Bun.spawn([process.execPath, "run", "src/index.ts"], { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}`, JARVIS_NO_SIDECAR: "1", JARVIS_PORT: String(daemonPort), JARVIS_OPENCODE_PORT: String(oc.port), JARVIS_HERMES_HOME: join(root, "hermes") } });
  let ws: WebSocket | undefined;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${daemonPort}/health`)).ok) break; } catch {} await Bun.sleep(50); }
    ws = new WebSocket(`ws://127.0.0.1:${daemonPort}/ui`);
    const messages: any[] = []; ws.onmessage = e => { try { messages.push(JSON.parse(String(e.data))); } catch {} };
    await new Promise<void>((resolve, reject) => { ws!.onopen = () => resolve(); ws!.onerror = () => reject(new Error("WS-Start fehlgeschlagen")); });
    const send = (x: object) => ws!.send(JSON.stringify(x));
    async function wait(pred: (x: any) => boolean) { for (let i = 0; i < 150; i++) { const index = messages.findIndex(pred); if (index >= 0) return messages.splice(index, 1)[0]; await Bun.sleep(40); } throw new Error(`Ereignis fehlt: ${JSON.stringify(messages.slice(-8))}`); }
    send({type:"backend_get"}); expect((await wait(m=>m.type==="backend")).active).toBe("opencode");
    send({type:"backend_config",backend:"hermes",config:{provider:"default",model:"hermes-agent",baseUrl:"http://127.0.0.1:1234/v1"}});
    const legacy = await wait(m=>m.type==="backend_saved"); expect(legacy.ok).toBe(false); expect(legacy.error).toContain("serverUrl");
    send({type:"backend_config",backend:"hermes",config:{provider:"default",model:"hermes-agent",serverUrl:`http://127.0.0.1:${hermesPort}`}}); expect((await wait(m=>m.type==="backend_saved")).ok).toBe(true);
    send({type:"backend_secret",backend:"hermes",apiKey:"test-secret-1234567890"}); expect((await wait(m=>m.type==="backend_saved")).ok).toBe(true);
    send({type:"backend_test",backend:"hermes"}); expect((await wait(m=>m.type==="backend_test")).ok).toBe(true);
    send({type:"backend_set",backend:"hermes"}); await wait(m=>m.type==="backend" && m.active==="hermes");
    send({type:"chat",text:"Hallo",session:null}); const sid = (await wait(m=>m.type==="session" && m.id)).id;
    expect(sid.startsWith("hermes_")).toBe(true); expect((await wait(m=>m.type==="delta" && m.session===sid)).text).toBe("Hallo"); await wait(m=>m.type==="done" && m.session===sid);
    send({type:"backend_set",backend:"opencode"}); await wait(m=>m.type==="backend" && m.active==="opencode");
    send({type:"open",id:sid}); expect((await wait(m=>m.type==="messages" && m.session===sid)).messages.map((m:any)=>m.text)).toEqual(["Hallo","Hallo"]);
    send({type:"chat",text:"warte",session:sid}); await wait(m=>m.type==="state" && m.busySessions?.includes(sid));
    await Bun.sleep(200); send({type:"stop",session:sid}); await wait(m=>m.type==="stopped" && m.session===sid);
    expect(JSON.stringify(messages)).not.toContain("test-secret-1234567890");
  } finally { ws?.close(); proc.kill(); await proc.exited; oc.stop(true); rmSync(root, {recursive:true,force:true}); }
}, 25000);
