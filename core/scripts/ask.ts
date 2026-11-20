// Testclient: bun scripts/ask.ts "Frage" [modell]
const ws = new WebSocket("ws://127.0.0.1:7777/ui");
const t0 = performance.now();
let out = "";
ws.onopen = () => ws.send(JSON.stringify({ type: "chat", text: process.argv[2], model: process.argv[3] }));
ws.onmessage = ev => {
  const m = JSON.parse(String(ev.data));
  if (m.type === "delta") out += m.text;
  else if (m.type === "tool") console.log(`[tool] ${m.name} ${m.status} ${m.title ?? ""}`);
  else if (m.type === "action") console.log(`[aktion] ${m.target}.${m.cmd} ${m.detail}`);
  else if (m.type === "latency") console.log(`[erstes Token] ${m.firstTokenMs} ms`);
  else if (m.type === "error") console.log(`[fehler] ${m.message}`);
  if (m.type === "state" && !m.busy && out) { console.log(`\nJarvis: ${out}\n(${Math.round(performance.now() - t0)} ms)`); process.exit(0); }
};
setTimeout(() => { console.log("Zeitüberschreitung", out); process.exit(1); }, 120000);
