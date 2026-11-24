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
test("Sitzungsverwaltung nutzt ausschließlich Hermes-API und kodiert IDs", async () => {
  const requests: { path: string; method: string; body?: any }[] = [];
  const url = serve(async req => {
    const path = new URL(req.url).pathname;
    requests.push({ path, method: req.method, ...(req.method === "POST" || req.method === "PATCH" ? { body: await req.json() } : {}) });
    if (req.method === "POST") return Response.json({ session: { id: "h/a" } });
    if (path.endsWith("/messages")) return Response.json({ data: [{ role: "user", content: "Frage" }] });
    return Response.json({ ok: true });
  });
  const h = new Hermes({ url, apiKey: "" }); const id = await h.createSession("Titel");
  expect(id).toBe("h/a"); expect(await h.messages(id)).toEqual([{ role: "user", content: "Frage" }]);
  await h.renameSession(id, "Neu"); await h.deleteSession(id);
  expect(requests).toEqual([{ path: "/api/sessions", method: "POST", body: { title: "Titel" } },
    { path: "/api/sessions/h%2Fa/messages", method: "GET" }, { path: "/api/sessions/h%2Fa", method: "PATCH", body: { title: "Neu" } },
    { path: "/api/sessions/h%2Fa", method: "DELETE" }]);
});
test("ausbleibende Stoppbestätigung wird gemeldet, Lauf bleibt beobachtet", async () => {
  let started!: () => void; const ready = new Promise<void>(r => { started = r; });
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const url = serve(req => {
    if (req.url.endsWith("/v1/runs")) return Response.json({ run_id: "r" });
    if (req.url.endsWith("/stop")) return Response.json({ status: "stopping" });
    return new Response(new ReadableStream<Uint8Array>({ start(c) { streamController = c; c.enqueue(new TextEncoder().encode(": open\n\n")); started(); } }));
  });
  const h = new Hermes({ url, apiKey: "" }, 30), events: BrainEvent[] = [];
  const running = h.prompt("s", "x", "", e => events.push(e)); await ready;
  await expect(h.abort("s")).rejects.toThrow("Stopp noch nicht bestätigt");
  streamController.enqueue(new TextEncoder().encode('data: {"event":"run.cancelled"}\n\n'));
  await running; expect(events).toEqual([{ kind: "done", aborted: true }]);
});
