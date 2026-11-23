import { join } from "node:path";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import QRCode from "qrcode";
import { announceMobile, MobileDevices, mobileAddresses, mobileCertificate, mobileOrigin, privateAddress } from "./mobile-access";
import { recordError } from "./errorlog";

export type UiSocket = { kind: string; fresh?: boolean; device?: string; mobileAdmin?: boolean };
const cookieName = "__Host-jarvis-device";
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const denied = () => json({ error: "Kopplung erforderlich." }, 401);
const mobilePages = new Map([
  ["/", "index.html"], ["/mobile.css", "mobile.css"], ["/mobile.js", "mobile.js"],
]);
const mobileMethods = new Set(["chat", "open", "new", "history", "message_ids", "stop", "replace", "resend", "tabs",
  "viewer_tab", "viewer_window", "settings", "liveview", "projects", "project_action", "chat_action", "usage", "client_error"]);
const mobileSettings = new Set(["model", "voiceModel", "mode", "liveView", "autoChatTitles", "autoProjects", "actionAnnouncements",
  "previewAuto", "previewIdleSeconds"]);
const mobileCsp = "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const webAsset = /^(?:[a-z-]+\.(?:js|css)|(?:icons|fonts)\/[\w.-]+\.(?:svg|png|ico|woff2))$/;

export function mobileAdminOrigin(request: Request, url: URL) {
  const origin = request.headers.get("origin");
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    (!origin || origin === url.origin || ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"].includes(origin));
}

export function mobileMessage(message: any) {
  if (!message || !mobileMethods.has(message.type)) return null;
  if (message.type === "settings") {
    return { type: "settings", settings: Object.fromEntries(Object.entries(message.settings ?? {})
      .filter(([key]) => mobileSettings.has(key))) };
  }
  return message;
}

export class MobileHttp {
  private listener?: Server<UiSocket>;
  private unannounce?: () => void;
  private fingerprint?: string;
  private deviceStore?: MobileDevices;
  private readonly downloads: string;
  private readonly port: number;
  constructor(private home: string, private webRoot: string, loopbackPort: number,
    private websocket: WebSocketHandler<UiSocket>, private visual: (path: string) => Response,
    private emergencyStop: () => Promise<unknown>, private connections: Set<ServerWebSocket<UiSocket>>) {
    this.downloads = process.env.JARVIS_MOBILE_DOWNLOADS ?? join(home, "mobile-downloads");
    this.port = Number(process.env.JARVIS_LAN_PORT ?? loopbackPort + 10);
  }

  get enabled() { return !!this.listener; }
  private get devices() { return this.deviceStore ??= new MobileDevices(this.home); }

  setEnabled(enabled: boolean) {
    if (enabled === this.enabled) return;
    if (!enabled) {
      this.devices.cancel();
      this.unannounce?.();
      this.unannounce = undefined;
      this.listener?.stop(true);
      this.listener = undefined;
      return;
    }
    this.devices.list();
    const { cert, key, fingerprint } = mobileCertificate(this.home);
    this.listener = Bun.serve<UiSocket>({
      hostname: "::", ipv6Only: false, port: this.port, tls: { cert, key },
      maxRequestBodySize: 2 * 1024 * 1024,
      fetch: (request, server) => this.route(request, server),
      websocket: this.websocket,
    });
    this.fingerprint = fingerprint;
    if (!process.env.JARVIS_NO_MDNS) {
      try { this.unannounce = announceMobile(this.port, error => this.report(error)); }
      catch (error) { this.report(error); }
    }
  }

  private report(error: unknown) {
    recordError({ category: "daemon", source: "jarvisd/mobil", message: (error as Error).message, error });
  }

  private async downloadsAvailable() {
    return { android: await Bun.file(join(this.downloads, "Jarvis.apk")).exists() };
  }

  async admin(request: Request, url: URL, address: string): Promise<Response | undefined> {
    if (url.pathname !== "/pair/start" && !/^\/devices(?:\/[0-9a-f]{24})?$/.test(url.pathname)) return;
    const origin = request.headers.get("origin");
    if (!mobileAdminOrigin(request, url) || !privateAddress(address) || !(address === "::1" || address.startsWith("127.")))
      return json({ error: "Nur am Computer verfügbar." }, 403);
    const cors: Record<string, string> = origin
      ? { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, DELETE, OPTIONS", "access-control-allow-headers": "content-type" } : {};
    let response: Response;
    if (request.method === "OPTIONS") response = new Response(null, { status: 204 });
    else if (url.pathname === "/pair/start" && request.method === "POST") {
      const addresses = mobileAddresses().map(ip => mobileOrigin(ip, this.port));
      if (!this.enabled || !addresses.length) response = json({ error: "Aktiviere den Handy-Zugriff in einem lokalen Netzwerk." }, 409);
      else {
        const { secret, ...code } = this.devices.start();
        const qr = { url: addresses[0], fingerprint: this.fingerprint!, secret };
        response = json({ ...code, addresses, fingerprint: qr.fingerprint, qr: await QRCode.toDataURL(JSON.stringify(qr), { margin: 2, width: 320 }) });
      }
    } else if (url.pathname === "/devices" && request.method === "GET") {
      response = json({ devices: this.devices.list(), addresses: this.enabled ? mobileAddresses().map(ip => mobileOrigin(ip, this.port)) : [] });
    } else if (url.pathname.startsWith("/devices/") && request.method === "DELETE") {
      const id = url.pathname.split("/").at(-1)!;
      const revoked = this.devices.revoke(id);
      for (const ws of this.connections) if (ws.data.device === id) ws.close(1008, "Kopplung widerrufen");
      if (revoked) this.notifyDesktop();
      response = json({ ok: revoked }, revoked ? 200 : 404);
    } else response = json({ error: "Unbekannte Aktion." }, 405);
    for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
    return response;
  }

  private notifyDesktop() {
    const update = JSON.stringify({ type: "mobile_devices" });
    for (const ws of this.connections) if (!ws.data.device) ws.send(update);
  }

  private async route(request: Request, server: Server<UiSocket>): Promise<Response | undefined> {
    const url = new URL(request.url);
    const address = server.requestIP(request)?.address ?? "";
    const origin = request.headers.get("origin");
    if (!privateAddress(address) || (origin && origin !== url.origin)) return json({ error: "Zugriff nur im privaten Netz." }, 403);
    const path = url.pathname;
    const token = request.headers.get("authorization")?.match(/^Bearer ([0-9a-f]{64})$/i)?.[1]
      ?? request.headers.get("cookie")?.match(/(?:^|;\s*)__Host-jarvis-device=([0-9a-f]{64})(?:;|$)/)?.[1];
    const device = this.devices.authenticate(token);
    try {
      if (path === "/pair/complete" && request.method === "POST") {
        const input = await request.json().catch(() => null) as Parameters<MobileDevices["complete"]>[0] | null;
        if (!input || typeof input !== "object") return json({ error: "Ungültige Kopplungsanfrage." }, 400);
        const result = this.devices.complete(input, address);
        if ("error" in result) return json({ error: result.error }, result.status);
        const response = json(input && "browser" in input && input.browser === true ? { id: result.id } : result);
        if ("browser" in input && input.browser === true)
          response.headers.set("set-cookie", `${cookieName}=${result.token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
        this.notifyDesktop();
        return response;
      }
      if (request.method === "GET") {
        if (path === "/mobile/downloads") return json(await this.downloadsAvailable());
        const download = path === "/download/Jarvis.apk" ? "Jarvis.apk" : undefined;
        if (download) {
          const file = Bun.file(join(this.downloads, download));
          if (await file.exists()) {
            const headers = new Headers({ "x-content-type-options": "nosniff", "cache-control": "no-store" });
            headers.set("content-type", "application/vnd.android.package-archive");
            headers.set("content-disposition", `attachment; filename="${download}"`);
            return new Response(file, { headers });
          }
          return json({ error: "Installationspaket noch nicht bereitgestellt." }, 404);
        }
        if (path === "/app") return Response.redirect(new URL("/app/", url), 302);
        const headers = {
          "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
          "content-security-policy": mobileCsp,
        };
        const page = mobilePages.get(path);
        if (page) return new Response(Bun.file(join(this.webRoot, page)), { headers });
        if (path.startsWith("/app/")) {
          const asset = path.slice("/app/".length);
          if (!asset && !device) return Response.redirect(new URL("/?pair=1", url), 302);
          if (!asset || webAsset.test(asset)) {
            const file = Bun.file(join(this.webRoot, "../ui", asset || "index.html"));
            if (await file.exists()) return new Response(file, { headers });
          }
        }
        if (path === "/mobile/session") return device ? json({ ok: true }) : denied();
        if (path === "/ui") {
          if (!device) return denied();
          return server.upgrade(request, { data: { kind: "ui", device } }) ? undefined : json({ error: "WebSocket erwartet." }, 400);
        }
        if (/^\/visual\/v[a-z0-9]{6,20}\/[\w.-]+\.(png|jpg|jpeg|webp|svg)$/i.test(path)) {
          if (!device) return denied();
          const response = this.visual(path);
          response.headers.set("cache-control", "no-store");
          response.headers.delete("access-control-allow-origin");
          return response;
        }
      }
      if (request.method === "POST" && (path === "/stop" || path === "/errors")) {
        if (!device) return denied();
        if (path === "/stop") await this.emergencyStop();
        else {
          const input = await request.json().catch(() => null) as { message?: unknown; platform?: unknown } | null;
          if (typeof input?.message !== "string" || !input.message.trim()) return json({ error: "Fehlermeldung fehlt." }, 400);
          recordError({ category: "app", source: input.platform === "android" ? "mobil/android" : "mobil/web",
            message: input.message.slice(0, 500) });
        }
        return json({ ok: true });
      }
      return json({ error: "Nicht gefunden." }, 404);
    } catch (error) {
      this.report(error);
      return json({ error: "Der Dienst konnte die Anfrage nicht bearbeiten." }, 500);
    }
  }
}
