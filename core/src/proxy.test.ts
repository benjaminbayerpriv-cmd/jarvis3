import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebProxy } from "./proxy";

function setup() {
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: "/ziel" } });
    if (u.pathname === "/other") return new Response(null, { status: 301, headers: { location: "http://example.org/x" } });
    if (u.pathname === "/data.json") return new Response(`{"self":"http://127.0.0.1:${upstream.port}/api","esc":"http:\\/\\/127.0.0.1:${upstream.port}\\/x"}`, { headers: { "content-type": "application/json" } });
    if (u.pathname === "/gesperrt") return new Response(null, { status: 302, headers: { location: `http://www.google.com/sorry/index?continue=${encodeURIComponent("https://www.google.com/search?q=x")}` } });
    if (u.pathname === "/bild.png") return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
    return new Response(`<!doctype html><html><head><title>T</title></head><body>
      <a href="http://127.0.0.1:${upstream.port}/seite">eigene</a> <a href="https://example.org/a">fremd</a> <a href="/rel">relativ</a>
      <script integrity="sha384-x" src="http://127.0.0.1:${upstream.port}/s.js"></script></body></html>`,
      { headers: { "content-type": "text/html", "content-security-policy": "frame-ancestors 'none'", "x-frame-options": "DENY",
        "set-cookie": "a=1; Domain=127.0.0.1; Secure; SameSite=None; Path=/" } });
  } });
  const proxy = new WebProxy(7777, () => "/*agent*/", join(mkdtempSync(join(tmpdir(), "jv-proxy-")), "origins.json"));
  const label = proxy.labelFor({ scheme: "http", host: "127.0.0.1", port: upstream.port });
  const get = (path: string, init: RequestInit = {}) => proxy.handle(new Request(`http://${label}.localhost:7777${path}`, { ...init, headers: { host: `${label}.localhost:7777`, ...(init.headers as any) } }), label);
  return { upstream, proxy, label, get };
}

test("Seite: Sperren weg, Agent drin, eigene Adressen und Links umgeschrieben, Cookies entschärft", async () => {
  const { upstream, proxy, label, get } = setup();
  try {
    const r = await get("/");
    expect(r.status).toBe(200);
    expect(r.headers.get("x-frame-options")).toBeNull();
    expect(r.headers.get("content-security-policy")).toBeNull();
    expect(r.headers.get("set-cookie")).toBe("a=1; Path=/");
    const html = await r.text();
    expect(html).toContain('<script src="/__jarvis__/agent.js"></script>');
    expect(html).toContain(`"real":"http://127.0.0.1:${upstream.port}/"`);
    expect(html).toContain(`http://${label}.localhost:7777/seite`);                  // eigene absolute Adresse -> Proxy
    expect(html).not.toContain("integrity=");
    const other = proxy.proxify("https://example.org/a")!;
    expect(html).toContain(`href="${other}" data-jv-href="https://example.org/a"`);  // fremde Herkunft -> eigener Proxy-Name
    expect(html).toContain('href="/rel"');                                            // relative bleiben
    expect(proxy.realOf(other)).toBe("https://example.org/a");
  } finally { upstream.stop(true); }
});

test("Umleitungen, JSON, Binärdaten und Agent-Skript", async () => {
  const { upstream, proxy, label, get } = setup();
  try {
    expect((await get("/redirect")).headers.get("location")).toBe(`http://${label}.localhost:7777/ziel`);
    expect((await get("/other")).headers.get("location")).toBe(proxy.proxify("http://example.org/x"));
    const json = await (await get("/data.json")).text();
    expect(json).toContain(`"self":"http://${label}.localhost:7777/api"`);
    expect(json).toContain(`"esc":"http:\\/\\/${label}.localhost:7777\\/x"`);
    const png = new Uint8Array(await (await get("/bild.png")).arrayBuffer());
    expect([...png]).toEqual([137, 80, 78, 71]);
    expect(await (await get("/__jarvis__/agent.js")).text()).toBe("/*agent*/");
    expect(proxy.labelOf("pzzzzzzzzzz.localhost:7777")).toBeUndefined();            // unbekannte Namen werden abgewiesen
    expect(proxy.labelOf(`${label}.localhost:7777`)).toBe(label);
    expect((await get("/", { headers: { host: "x" } })).status).toBe(200);
  } finally { upstream.stop(true); }
});

test("Bot-Sperre (Google /sorry) wird als Hinweis für die Oberfläche gemeldet", async () => {
  const { upstream, get } = setup();
  try {
    const r = await get("/gesperrt");
    expect(r.status).toBe(403);
    const html = await r.text();
    expect(html).toContain('kind:"blocked"');
    expect(html).toContain("https://www.google.com/search?q=x");     // ursprünglich gewünschte Adresse
  } finally { upstream.stop(true); }
});

test("Nicht erreichbare Seite liefert eine Fehlerseite statt abzustürzen", async () => {
  const proxy = new WebProxy(7777, () => "", join(mkdtempSync(join(tmpdir(), "jv-proxy-")), "origins.json"));
  const label = proxy.labelFor({ scheme: "http", host: "127.0.0.1", port: 1 });
  const r = await proxy.handle(new Request(`http://${label}.localhost:7777/`), label);
  expect(r.status).toBe(502);
  expect(await r.text()).toContain("Seite nicht erreichbar");
});
