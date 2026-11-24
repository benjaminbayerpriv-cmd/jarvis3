import { afterEach, expect, test } from "bun:test";
import { Hermes, hermesUrl } from "./hermes";
import type { BrainEvent } from "./opencode";
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.stop(true); });
function serve(handler: (req: Request) => Response | Promise<Response>) {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler }); servers.push(s); return `http://127.0.0.1:${s.port}`;
}
const sse = (events: object[]) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
test("nur feste Loopback-Adressen", () => {
  expect(hermesUrl("http://127.0.0.1:8642/")).toBe("http://127.0.0.1:8642");
  for (const u of ["http://localhost", "http://example.com", "http://user:pass@127.0.0.1", "http://127.0.0.1/?key=x"]) expect(() => hermesUrl(u)).toThrow();
});
test("Kontext, Text und Werkzeugereignisse", async () => {
  let body: any, auth = "";
  const url = serve(async req => {
    auth = req.headers.get("authorization") ?? "";
    if (req.method === "POST") { body = await req.json(); return Response.json({ run_id: "r" }); }
    return sse([{ event: "message.delta", delta: "Hallo" }, { event: "tool.started", tool: "search", tool_call_id: "t" }, { event: "tool.completed", tool: "search", tool_call_id: "t" }, { event: "run.completed", output: "Hallo" }]);
  });
  const events: BrainEvent[] = [];
  await new Hermes({ url, apiKey: "private", provider: "local", model: "m" }).prompt("s", "Frage", "Regeln", e => events.push(e));
  expect(auth).toBe("Bearer private"); expect(body).toEqual({ input: "Frage", session_id: "s", instructions: "Regeln", provider: "local", model: "m" });
  expect(events).toEqual([{ kind: "text", delta: "Hallo" }, { kind: "tool", id: "t", name: "search", status: "running" }, { kind: "tool", id: "t", name: "search", status: "completed" }, { kind: "done" }]);
});
test("HTTP-Fehler geben keine geheimen Antwortdaten preis", async () => {
  const events: BrainEvent[] = [];
  await new Hermes({ url: serve(() => new Response("secret", { status: 401 })), apiKey: "private" }).prompt("s", "x", "", e => events.push(e));
  expect(events).toEqual([{ kind: "error", message: "Hermes-Anfrage fehlgeschlagen (HTTP 401)" }]);
});
test("Stream ohne Laufende meldet Fehler", async () => {
  const events: BrainEvent[] = [];
  const url = serve(req => req.method === "POST" ? Response.json({ run_id: "r" }) : sse([{ event: "message.delta", delta: "unfertig" }]));
  await new Hermes({ url, apiKey: "" }).prompt("s", "x", "", e => events.push(e));
  expect(events.at(-1)).toEqual({ kind: "error", message: "Hermes-Ereignisstrom ohne Laufende beendet" });
});
test("Stopp vor Lauf-ID wird nachgeholt", async () => {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let stopped = false;
  const url = serve(async req => {
    if (req.url.endsWith("/v1/runs")) { await gate; return Response.json({ run_id: "r" }); }
    if (req.url.endsWith("/stop")) { stopped = true; return Response.json({ status: "stopping" }); }
    return sse([{ event: "run.cancelled" }]);
  });
  const h = new Hermes({ url, apiKey: "" }); const events: BrainEvent[] = [];
  const prompt = h.prompt("s", "x", "", e => events.push(e)); const stop = h.abort("s"); release(); await Promise.all([prompt, stop]);
  expect(stopped).toBe(true); expect(events).toEqual([{ kind: "done", aborted: true }]);
});
