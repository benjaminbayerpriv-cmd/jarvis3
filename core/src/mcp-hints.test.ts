import { test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { hintFor } from "./mcp-hints";

const MCP = join(import.meta.dir, "mcp.ts");

test("Hinweise: Lesen ist readOnly, Löschen destructive, Programme und Seiten openWorld", () => {
  expect(hintFor("browser_scan")).toEqual({ readOnlyHint: true, openWorldHint: true });
  expect(hintFor("skill_list")).toEqual({ readOnlyHint: true, openWorldHint: false });
  expect(hintFor("desktop_click")).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
  expect(hintFor("project_delete").destructiveHint).toBe(true);
  expect(hintFor("browser_tab_close").destructiveHint).toBe(true);
});

/** Stub für jarvisd: merkt sich Aufrufe, hält /tool auf Wunsch lange fest. */
function stub() {
  const seen = { tool: [] as any[], stop: 0, aborted: 0 };
  let delay = 0, failing = false;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/stop") { seen.stop++; return Response.json({ ok: true }); }
    if (u.pathname === "/tool") {
      seen.tool.push(await req.json());
      req.signal.addEventListener("abort", () => { seen.aborted++; });
      if (delay) await Bun.sleep(delay);
      return Response.json(failing ? { ok: false, error: "Computer-Steuerung ist aus" } : { ok: true, text: "stub-antwort", tabs: [] });
    }
    return new Response("nicht da", { status: 404 });
  } });
  return { seen, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true), setDelay: (ms: number) => { delay = ms; }, setFailing: (f: boolean) => { failing = f; } };
}

async function connect(env: Record<string, string>, name = "test") {
  const transport = new StdioClientTransport({ command: process.execPath, args: [MCP], env: { ...process.env as Record<string, string>, ...env }, stderr: "ignore" });
  const client = new Client({ name, version: "0" });
  await client.connect(transport);
  return client;
}

test("MCP-Server: Annotationen kommen beim Client an und ein Aufruf erreicht jarvisd", async () => {
  const d = stub();
  const client = await connect({ JARVISD_URL: d.url });
  try {
    const { tools } = await client.listTools();
    const by = Object.fromEntries(tools.map(t => [t.name, t.annotations]));
    expect(tools.length).toBeGreaterThan(30);
    expect(by.browser_scan?.readOnlyHint).toBe(true);
    expect(by.desktop_read?.readOnlyHint).toBe(true);
    expect(by.desktop_click?.readOnlyHint).toBe(false);
    expect(by.desktop_type_text?.readOnlyHint).toBe(false);
    expect(by.project_delete?.destructiveHint).toBe(true);
    expect(tools.every(t => t.annotations && typeof t.annotations.readOnlyHint === "boolean")).toBe(true);
    const r: any = await client.callTool({ name: "desktop_scan", arguments: { display: 0 } });
    expect(r.content[0].text).toBe("stub-antwort");
    expect(d.seen.tool[0]).toMatchObject({ target: "desktop", cmd: { cmd: "scan" } });
  } finally { await client.close(); d.stop(); }
}, 30_000);

test("Abbruch durch den Client bricht die Anfrage an jarvisd ab; mit JARVIS_STOP_ON_CANCEL=1 folgt der gemeinsame Not-Aus", async () => {
  for (const stopOnCancel of [false, true]) {
    const d = stub(); d.setDelay(5000);
    const client = await connect({ JARVISD_URL: d.url, ...(stopOnCancel ? { JARVIS_STOP_ON_CANCEL: "1" } : {}) });
    try {
      const abort = new AbortController();
      const pending = client.callTool({ name: "desktop_scan", arguments: {} }, undefined, { signal: abort.signal }).catch(e => e);
      await Bun.sleep(400);
      abort.abort();
      await pending;
      await Bun.sleep(500);
      expect(d.seen.aborted).toBe(1);                       // die Anfrage an jarvisd wurde abgebrochen
      expect(d.seen.stop).toBe(stopOnCancel ? 1 : 0);       // Not-Aus nur auf Wunsch
    } finally { await client.close(); d.stop(); }
  }
}, 40_000);

test("Fehler: für Hermes als normaler Text (kein Strike im Circuit Breaker), für andere Clients als isError", async () => {
  const d = stub(); d.setFailing(true);
  try {
    for (const [name, env, expectFlag] of [["hermes-agent", {}, false], ["test", {}, true], ["hermes-agent", { JARVIS_MCP_ERRORS: "flag" }, true], ["test", { JARVIS_MCP_ERRORS: "text" }, false]] as const) {
      const client = await connect({ JARVISD_URL: d.url, ...env }, name);
      try {
        const r: any = await client.callTool({ name: "desktop_click", arguments: { id: 1 } });
        expect(r.content[0].text).toBe("Fehler: Computer-Steuerung ist aus");      // die Meldung kommt immer an
        expect(!!r.isError).toBe(expectFlag);
      } finally { await client.close(); }
    }
  } finally { d.stop(); }
}, 60_000);
