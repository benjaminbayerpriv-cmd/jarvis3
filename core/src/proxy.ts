// Direkter Browser, Teil 1: Jarvis lädt Webseiten selbst und liefert sie so aus, dass sie in einem Rahmen der Oberfläche laufen
// (echtes HTML, scharf, mit eigenem Scrollen und markierbarem Text, kein Videostrom).
//
// Jede fremde Herkunft (Schema, Host, Port) bekommt eine eigene Unterdomain `p<10 Hex>.localhost:<Port>`. Relative und Root-Adressen
// der Seite landen damit von selbst wieder beim Proxy, Cookies und Speicher bleiben je Seite getrennt. Die Zufallsnamen entstehen
// nur auf Wunsch der Oberfläche; unbekannte Namen werden abgewiesen (eine fremde Webseite kann den Proxy so nicht ansprechen).
//
// Der Proxy entfernt Sperren gegen das Einbetten (X-Frame-Options, CSP), schreibt Umleitungen, Cookies und Links um und setzt
// einen kleinen Agenten in jede Seite (proxy-agent.ts), der Navigation meldet und Jarvis die Bedienung der Seite erlaubt.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Origin { scheme: "http" | "https"; host: string; port: number }
const LABEL = /^(p[0-9a-f]{10})\.localhost(?::\d+)?$/;
const DROP_RESPONSE = new Set(["content-security-policy", "content-security-policy-report-only", "x-frame-options", "cross-origin-opener-policy",
  "cross-origin-embedder-policy", "cross-origin-resource-policy", "permissions-policy", "strict-transport-security", "content-encoding",
  "content-length", "transfer-encoding", "connection", "keep-alive", "set-cookie", "report-to", "nel", "clear-site-data", "alt-svc"]);
const DROP_REQUEST = new Set(["if-none-match", "if-modified-since", "host", "connection", "content-length", "origin", "referer", "accept-encoding", "sec-fetch-site", "sec-fetch-mode",
  "sec-fetch-dest", "sec-fetch-user", "upgrade-insecure-requests", "x-forwarded-for"]);
const MAX_REWRITE = 6_000_000;

export const originOf = (url: URL): Origin => ({ scheme: url.protocol === "http:" ? "http" : "https", host: url.hostname, port: Number(url.port) || (url.protocol === "http:" ? 80 : 443) });
const originKey = (o: Origin) => `${o.scheme}://${o.host}:${o.port}`;
const originUrl = (o: Origin) => `${o.scheme}://${o.host}${(o.scheme === "https" && o.port === 443) || (o.scheme === "http" && o.port === 80) ? "" : ":" + o.port}`;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class WebProxy {
  private byLabel = new Map<string, Origin>();
  private byKey = new Map<string, string>();

  constructor(private port: number, private agent: () => string, private file = join(homedir(), ".jarvis3", "proxy-origins.json"),
              private look: () => { dark: boolean; forceDark: boolean } = () => ({ dark: false, forceDark: false })) {
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, Origin>;
      for (const [label, o] of Object.entries(saved)) if (LABEL.test(`${label}.localhost`)) { this.byLabel.set(label, o); this.byKey.set(originKey(o), label); }
    } catch { /* erste Benutzung */ }
  }

  private save() {
    try { mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.byLabel))); } catch { /* nicht kritisch */ }
  }

  /** Label einer Herkunft (wird beim ersten Mal angelegt) */
  labelFor(o: Origin): string {
    const key = originKey(o);
    let label = this.byKey.get(key);
    if (!label) {
      label = "p" + randomBytes(5).toString("hex");
      this.byLabel.set(label, o); this.byKey.set(key, label); this.save();
    }
    return label;
  }

  /** Adresse im Proxy für eine echte http(s)-Adresse (null bei anderen Schemata) */
  proxify(url: string | URL, base?: string): string | null {
    let u: URL;
    try { u = new URL(String(url), base); } catch { return null; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `http://${this.labelFor(originOf(u))}.localhost:${this.port}${u.pathname}${u.search}${u.hash}`;
  }

  /** Echte Adresse zu einer Proxy-Adresse (oder die Adresse selbst) */
  realOf(proxyUrl: string): string | null {
    try {
      const u = new URL(proxyUrl);
      const label = this.labelOf(u.host);
      if (!label) return u.protocol.startsWith("http") ? proxyUrl : null;
      const o = this.byLabel.get(label)!;
      return originUrl(o) + u.pathname + u.search + u.hash;
    } catch { return null; }
  }

  /** Label, wenn der Host ein bekannter Proxy-Name ist */
  labelOf(host: string): string | undefined {
    const m = LABEL.exec(host.toLowerCase());
    return m && this.byLabel.has(m[1]) ? m[1] : undefined;
  }
  isProxyHost(host: string | null | undefined) { return !!host && this.labelOf(host) !== undefined; }

  /** Ersetzt in Text die echte Herkunft durch die Proxy-Herkunft (absolute Adressen der Seite auf sich selbst, auch mit \\/-Schreibweise in JSON) */
  private rewriteOrigin(text: string, o: Origin, label: string): string {
    const hostPort = escapeRegex(o.host + (o.port === (o.scheme === "https" ? 443 : 80) ? "" : ":" + o.port));
    const host = `${label}.localhost:${this.port}`;
    return text.replace(new RegExp(`https?:(\\\\?/\\\\?/)${hostPort}(?![\\w.-])`, "g"), (_m, slashes: string) => `http:${slashes}${host}`);
  }

  private rewriteHtml(html: string, o: Origin, label: string, real: string): string {
    // eigene Adresse nur in Tags, Skripten und Stilen umschreiben, nie im sichtbaren Text (dort soll die echte Adresse stehen)
    let out = html.split(/(<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>)/i).map((part, i) => i % 2 ? this.rewriteOrigin(part, o, label) : part).join("");
    // Navigationsziele zu anderen Herkünften über den Proxy führen (Bilder, Skripte und Stile laden direkt von dort)
    out = out.replace(/(\s)(href|action)=("|')((?:https?:)?\/\/[^"'#\s>]+)(\3)/gi, (m, sp, attr, q, raw: string) => {
      const url = raw.startsWith("//") ? `${o.scheme}:${raw}` : raw;                 // //host/pfad übernimmt das Schema der Seite
      const real = this.realOf(url) ?? url;                         // war die Adresse schon die eigene (umgeschrieben), gilt die echte
      const p = this.proxify(real);
      return p ? `${sp}${attr}=${q}${p}${q} data-jv-href=${q}${real}${q}` : m;
    });
    out = out.replace(/\sintegrity=("[^"]*"|'[^']*')/gi, "").replace(/<meta[^>]+http-equiv=["']?content-security-policy[^>]*>/gi, "");
    const inject = `<script>window.__JV=${JSON.stringify({ real, origin: originUrl(o), daemon: `ws://127.0.0.1:${this.port}/page`, dark: this.look().dark, forceDark: this.look().forceDark, open: `http://127.0.0.1:${this.port}/__jarvis__/open?u=` })}</script><script src="/__jarvis__/agent.js"></script>`;
    const head = /<head[^>]*>/i.exec(out);
    return head ? out.slice(0, head.index + head[0].length) + inject + out.slice(head.index + head[0].length)
      : /<html[^>]*>/i.test(out) ? out.replace(/<html[^>]*>/i, m => m + inject) : inject + out;
  }

  private errorPage(message: string, url: string) {
    const safe = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
    return new Response(`<!doctype html><meta charset=utf-8><title>Seite nicht erreichbar</title><body style="font:15px/1.5 system-ui;background:#131314;color:#e3e3e3;display:grid;place-items:center;height:100vh;margin:0"><div style="max-width:420px;padding:24px"><h2 style="font-weight:500">Seite nicht erreichbar</h2><p>${safe(message)}</p><p style="color:#9a9b9c;word-break:break-all">${safe(url)}</p></div>`,
      { status: 502, headers: { "content-type": "text/html; charset=utf-8" } });
  }

  /** Seite, die der Oberfläche meldet, dass die Zielseite den direkten Browser nicht zulässt (Bot-Sperre, CAPTCHA an feste Domains) */
  private blockedPage(url: string) {
    const safe = (x: string) => x.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
    return new Response(`<!doctype html><meta charset=utf-8><title>Seite lässt den direkten Browser nicht zu</title><body style="font:15px/1.5 system-ui;background:#131314;color:#e3e3e3;display:grid;place-items:center;height:100vh;margin:0"><div style="max-width:420px;padding:24px"><h2 style="font-weight:500">Diese Seite lässt den direkten Browser nicht zu</h2><p>Sie hat Jarvis als Roboter eingestuft. Sie wird als Videostrom geöffnet.</p><p style="color:#9a9b9c;word-break:break-all">${safe(url)}</p></div><script>try{parent.postMessage({jv:true,kind:"blocked",url:${JSON.stringify(url)}},"*")}catch(e){}</script>`,
      { status: 403, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }

  async handle(req: Request, label: string): Promise<Response> {
    const origin = this.byLabel.get(label)!;
    const url = new URL(req.url);
    if (url.pathname === "/__jarvis__/agent.js") return new Response(this.agent(), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
    const real = originUrl(origin) + url.pathname + url.search;
    const headers = new Headers();
    req.headers.forEach((value, key) => { if (!DROP_REQUEST.has(key.toLowerCase())) headers.set(key, value); });
    headers.set("sec-ch-prefers-color-scheme", this.look().dark ? "dark" : "light");   // Google & Co. wählen hell/dunkel serverseitig nach diesem Hinweis
    headers.set("accept-language", req.headers.get("accept-language") ?? "de-DE,de;q=0.9,en;q=0.8");
    if (req.method !== "GET" && req.method !== "HEAD") headers.set("origin", originUrl(origin));
    const referer = req.headers.get("referer");
    if (referer) { const r = this.realOf(referer); if (r) headers.set("referer", r); }
    let upstream: Response;
    try {
      upstream = await fetch(real, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(), redirect: "manual", signal: AbortSignal.timeout(30_000) });
    } catch (error) { return this.errorPage(String((error as Error)?.message ?? error), real); }

    const out = new Headers();
    upstream.headers.forEach((value, key) => { if (!DROP_RESPONSE.has(key.toLowerCase())) out.set(key, value); });
    for (const cookie of upstream.headers.getSetCookie?.() ?? [])
      out.append("set-cookie", cookie.replace(/;\s*Domain=[^;]*/gi, "").replace(/;\s*Secure/gi, "").replace(/;\s*Partitioned/gi, "").replace(/;\s*SameSite=None/gi, ""));
    out.set("access-control-allow-origin", req.headers.get("origin") ?? "*");
    out.set("access-control-allow-credentials", "true");
    const location = upstream.headers.get("location");
    const blockedAt = location ? new URL(location, real) : url.pathname.startsWith("/sorry/") ? new URL(real) : undefined;
    if (upstream.status === 429 || (blockedAt && /^\/sorry(\/|$)/.test(blockedAt.pathname) && /google\./.test(blockedAt.hostname))) {
      const wanted = blockedAt?.searchParams.get("continue") || real;                      // bei Google: die ursprünglich gewünschte Adresse
      return this.blockedPage(wanted);
    }
    if (location && upstream.status >= 300 && upstream.status < 400) {
      out.set("location", this.proxify(location, real) ?? location);
      return new Response(null, { status: upstream.status, headers: out });
    }
    const type = (upstream.headers.get("content-type") ?? "").toLowerCase();
    const textual = /text\/html|application\/xhtml|text\/css|javascript|ecmascript|application\/json|text\/xml|application\/xml|image\/svg/.test(type);
    if (!textual || req.method === "HEAD" || upstream.status === 204 || upstream.status === 304) return new Response(upstream.body, { status: upstream.status, headers: out });
    const text = await upstream.text();
    if (text.length > MAX_REWRITE) return new Response(text, { status: upstream.status, headers: out });
    const isHtml = /html|xhtml/.test(type);
    // Die Seite trägt Einstellungen des Augenblicks (hell/dunkel, Agent): nie vom Browser zwischenspeichern oder per 304 wiederverwenden
    if (isHtml) { out.set("cache-control", "no-store"); out.delete("etag"); out.delete("last-modified"); out.delete("expires"); }
    const body = isHtml ? this.rewriteHtml(text, origin, label, real) : this.rewriteOrigin(text, origin, label);
    return new Response(body, { status: upstream.status, headers: out });
  }
}
