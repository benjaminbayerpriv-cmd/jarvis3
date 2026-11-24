import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendStore, parseBackendConfig } from "./backend-config";
const roots: string[] = [];
const setup = () => { const p = mkdtempSync(join(tmpdir(), "jarvis-backend-")); roots.push(p); return p; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test("Konfiguration erlaubt nur feste Loopback-Adressen", () => {
  const cfg = { provider: "default", model: "m", baseUrl: "http://127.0.0.1:8642/" };
  expect(parseBackendConfig(cfg).baseUrl).toBe("http://127.0.0.1:8642");
  for (const baseUrl of ["http://localhost:8642", "http://192.168.1.1", "http://u:p@127.0.0.1", "https://example.com"]) expect(() => parseBackendConfig({ ...cfg, baseUrl })).toThrow();
});
test.if(process.platform !== "win32")("Schlüssel getrennt und nur für Besitzer lesbar", () => {
  const root = setup(), store = new BackendStore(root); store.saveConfig({ provider: "default", model: "m", baseUrl: "http://127.0.0.1:8642" }); store.setKey("secret");
  expect(store.getKey()).toBe("secret"); expect(statSync(join(root, "backend", "hermes.key")).mode & 0o777).toBe(0o600); expect(statSync(join(root, "backend")).mode & 0o777).toBe(0o700);
  expect(readFileSync(join(root, "backend", "hermes.json"), "utf8")).not.toContain("secret"); store.setKey(null); expect(store.getKey()).toBeNull();
});
test.if(process.platform !== "win32")("unsichere Rechte und symbolische Links werden abgelehnt", () => {
  const root = setup(), store = new BackendStore(root); store.setKey("x"); chmodSync(join(root, "backend", "hermes.key"), 0o644); expect(() => store.getKey()).toThrow();
  rmSync(join(root, "backend", "hermes.key")); symlinkSync("/etc/passwd", join(root, "backend", "hermes.key")); expect(() => store.getKey()).toThrow();
});
