// Testclient: bun scripts/ask.ts "Frage" [modell]
const ws = new WebSocket("ws://127.0.0.1:7777/ui?fresh=1");
const t0 = performance.now();
let out = "";
ws.onopen = () => ws.send(JSON.stringify({ type: "chat", text: process.argv[2], model: process.argv[3] }));
ws.onmessage = ev => {
  const m = JSON.parse(String(ev.data));
  if (m.type === "delta") { if (!out.length || out.endsWith("\u200b")) console.log(`[text @${Math.round(performance.now() - t0)} ms] ${m.text.slice(0, 80)}`); out += m.text; }
  else if (m.type === "tool") { if (out.length && !out.endsWith("\u200b")) out += "\u200b"; console.log(`[tool] ${m.name} ${m.status} ${m.title ?? ""}`); }
  else if (m.type === "action") console.log(`[aktion] ${m.target}.${m.cmd} ${m.detail}`);
  else if (m.type === "latency") console.log(`[erstes Token] ${m.firstTokenMs} ms`);
  else if (m.type === "error") console.log(`[fehler] ${m.message}`);
  if (m.type === "state" && !m.busy && out) { console.log(`\nJarvis: ${out}\n(${Math.round(performance.now() - t0)} ms)`); process.exit(0); }
};
setTimeout(() => { console.log("Zeitüberschreitung", out); process.exit(1); }, 120000);
