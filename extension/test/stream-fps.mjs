// Tab-Vorschau: Bildrate und Qualität aus einem Hintergrund-Tab (Anforderung: mindestens 24 Bilder/s).
// Aufruf: bun extension/test/stream-fps.mjs
import assert from "node:assert/strict";
import { startBrowser } from "./harness.mjs";
const page = `<!doctype html><title>Anim</title><style>body{margin:0;background:#111}canvas{display:block}</style>
<canvas id=c width=1280 height=720></canvas><script>
const c=document.getElementById('c'),x=c.getContext('2d');let t=0;
function d(){t++;x.fillStyle='#111';x.fillRect(0,0,1280,720);for(let i=0;i<60;i++){x.fillStyle='hsl('+((i*6+t*3)%360)+' 70% 55%)';x.fillRect((i*21+t*7)%1280,(i*11+t*3)%720,90,40)}
x.fillStyle='#fff';x.font='48px sans-serif';x.fillText('Frame '+t,40,80);}
setInterval(d,16);d();</script>`;
const { base, extension, connections, frames, devtools, until, ok, close } = await startBrowser(
  async path => new Response(path === "/anim" ? page : "<title>s</title>", { headers: { "Content-Type": "text/html" } }));
try {
  await devtools("Extensions.loadUnpacked", { path: extension });
  await until(() => connections.length, "Erweiterung verbindet nicht");
  const { tab } = await ok("tab_open", { url: base + "/anim" });
  assert.equal((await ok("tab_list")).tabs.find(t => t.tab === tab).active, false, "Tab muss im Hintergrund laufen");
  await Bun.sleep(1000);
  await ok("stream_start", { tab });
  await Bun.sleep(500);
  frames.length = 0;
  const secs = 4;
  await Bun.sleep(secs * 1000);
  const got = frames.filter(f => f.type === "frame" && f.tab === tab);
  await ok("stream_stop", { tab });
  const fps = got.length / secs;
  const kb = got.reduce((n, f) => n + f.data.length * 0.75, 0) / got.length / 1024;
  console.log(`Bildrate ${fps.toFixed(1)} fps, ${Math.round(kb)} KB je Bild, ${got[0]?.w}x${got[0]?.h}`);
  assert(fps >= 24, `Bildrate ${fps.toFixed(1)} fps liegt unter 24`);
  assert(got[0].w >= 600 && got[0].h >= 400, "Bild zu klein");
  assert(got[0].data.startsWith("/9j/"), "kein JPEG");
  console.log("OK: Hintergrund-Tab wird mit mindestens 24 Bildern/s übertragen.");
} finally { await close(); }
