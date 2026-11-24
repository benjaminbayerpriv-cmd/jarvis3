// Optional: verwendet die vorhandene Hermes-Installation und einen lokalen Modell-Mock.
// Start: JARVIS_TEST_REAL_HERMES=1 bun test src/backend-real-integration.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const freePort = () => { const s = Bun.serve({port:0,hostname:"127.0.0.1",fetch:()=>new Response()}); const n=s.port!; s.stop(); return n; };
test.if(process.env.JARVIS_TEST_REAL_HERMES === "1")("Daemon und echtes Hermes mit lokalem Modell-Mock", async () => {
  const root=mkdtempSync(join(tmpdir(),"jarvis-real-")), bin=join(root,"bin"); mkdirSync(bin);
  writeFileSync(join(bin,"opencode"), '#!/bin/sh\n[ "$1" = models ] && echo opencode/test\n', {mode:0o755});
  const oc=Bun.serve({hostname:"127.0.0.1",port:0,fetch(req) { const p=new URL(req.url).pathname;
    if(p==="/global/health")return Response.json({healthy:true}); if(p==="/event")return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(": open\n\n"));}})); return Response.json(p==="/session"?[]:{}); }});
  let sawImage=false, authCorrect=false, calls=0;
  const model=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req) {
    if(!new URL(req.url).pathname.endsWith("/chat/completions")) return Response.json({data:[]});
    const b:any=await req.json(); calls++; sawImage ||= JSON.stringify(b.messages).includes("data:image/png;base64"); authCorrect ||= req.headers.get("authorization")==="Bearer provider-key-test-12345678";
    const answer="Lokale Testantwort";
    if(b.stream) return new Response(`data: ${JSON.stringify({id:"cmpl-test",object:"chat.completion.chunk",created:1,model:"test",choices:[{index:0,delta:{role:"assistant",content:answer},finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:"cmpl-test",object:"chat.completion.chunk",created:1,model:"test",choices:[{index:0,delta:{},finish_reason:"stop"}]})}\n\ndata: [DONE]\n\n`,{headers:{"content-type":"text/event-stream"}});
    return Response.json({id:"cmpl-test",object:"chat.completion",created:1,model:"test",choices:[{index:0,message:{role:"assistant",content:answer},finish_reason:"stop"}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});
  }});
  const gateway=freePort(), port=freePort();
  const proc=Bun.spawn([process.execPath,"run","src/index.ts"],{cwd:import.meta.dir+"/..",stdout:"ignore",stderr:"ignore",env:{...process.env,HOME:root,PATH:`${bin}:${process.env.PATH}`,JARVIS_HERMES_HOME:join(root,"hermes"),JARVIS_NO_SIDECAR:"1",JARVIS_PORT:String(port),JARVIS_OPENCODE_PORT:String(oc.port),HTTP_PROXY:"http://127.0.0.1:1",HTTPS_PROXY:"http://127.0.0.1:1",ALL_PROXY:"http://127.0.0.1:1",NO_PROXY:"localhost,127.0.0.1,::1"}});
  let ws:WebSocket|undefined;
  try {
    for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)break;}catch{} await Bun.sleep(50);}
    ws=new WebSocket(`ws://127.0.0.1:${port}/ui`); const events:any[]=[]; ws.onmessage=e=>events.push(JSON.parse(String(e.data)));
    await new Promise<void>((resolve,reject)=>{ws!.onopen=()=>resolve();ws!.onerror=()=>reject(Error("WS"));});
    const send=(v:object)=>ws!.send(JSON.stringify(v));
    async function wait(fn:(m:any)=>boolean){for(let i=0;i<500;i++){const n=events.findIndex(fn);if(n>=0)return events.splice(n,1)[0];await Bun.sleep(50);}throw Error(`Timeout: ${JSON.stringify(events.slice(-8))}`);}
    send({type:"backend_config",backend:"hermes",config:{serverUrl:`http://127.0.0.1:${gateway}`,provider:"custom",model:"openai/gpt-4o",modelBaseUrl:`http://127.0.0.1:${model.port}/v1`,modelSupportsVision:true}}); expect((await wait(x=>x.type==="backend_saved")).ok).toBe(true);
    send({type:"backend_secret",backend:"hermes",target:"server",apiKey:"server-key-test-12345678"}); expect((await wait(x=>x.type==="backend_saved")).ok).toBe(true);
    send({type:"backend_secret",backend:"hermes",target:"provider",apiKey:"provider-key-test-12345678"}); expect((await wait(x=>x.type==="backend_saved")).ok).toBe(true);
    send({type:"backend_set",backend:"hermes"}); await wait(x=>x.type==="backend"&&x.active==="hermes");
    send({type:"chat",session:null,text:"Hallo"}); const sid=(await wait(x=>x.type==="session"&&x.id)).id;
    await wait(x=>x.type==="delta"&&x.text==="Lokale Testantwort"); await wait(x=>x.type==="done"&&x.session===sid);
    send({type:"chat",session:sid,text:"Was ist zu sehen?",attachments:[{name:"bild.png",mime:"image/png",data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1p4AAAAASUVORK5CYII="}]});
    await wait(x=>x.type==="delta"&&x.text==="Lokale Testantwort"); await wait(x=>x.type==="done"&&x.session===sid);
    expect(calls).toBeGreaterThanOrEqual(2); expect(sawImage).toBe(true); expect(authCorrect).toBe(true);
  } finally {ws?.close();proc.kill();await proc.exited;oc.stop(true);model.stop(true);await Bun.sleep(500);rmSync(root,{recursive:true,force:true});}
}, 40000);
