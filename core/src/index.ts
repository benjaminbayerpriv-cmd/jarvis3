import { listModels, startServer } from "./opencode";
const PORT = Number(process.env.JARVIS_PORT ?? 7777);
const oc = startServer(4096);
Bun.serve({ port: PORT, hostname: "127.0.0.1", async fetch(req) {
  const u = new URL(req.url);
  if (u.pathname === "/models") return Response.json(await listModels());
  if (u.pathname === "/health") return Response.json({ ok: true });
  return new Response("jarvisd", { status: 404 });
}});
process.on("SIGINT", () => { oc.kill(); process.exit(0); });
console.log(`jarvisd auf http://127.0.0.1:${PORT}`);
