import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendStore, parseBackendConfig } from "./backend-config";
const roots: string[] = [];
const setup = () => { const p = mkdtempSync(join(tmpdir(), "jarvis-backend-")); roots.push(p); return p; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test("Gateway und Modellanbieter akzeptieren Netzwerkadressen ohne Zugangsdaten", () => {
  const cfg = { provider: "default", model: "m", baseUrl: "http://127.0.0.1:8642/" };
  expect(parseBackendConfig(cfg).baseUrl).toBe("http://127.0.0.1:8642");
  expect(parseBackendConfig({ ...cfg, baseUrl: "http://192.168.1.1:8642", modelBaseUrl: "http://192.168.1.5:1234/v1" }).modelBaseUrl).toBe("http://192.168.1.5:1234/v1");
  for (const baseUrl of ["ftp://127.0.0.1", "http://u:p@127.0.0.1"]) expect(() => parseBackendConfig({ ...cfg, baseUrl })).toThrow();
  expect(() => parseBackendConfig({ ...cfg, modelBaseUrl: "http://user:pass@192.168.1.5" })).toThrow();
});
test.if(process.platform !== "win32")("Schlüssel getrennt und nur für Besitzer lesbar", () => {
  const root = setup(), store = new BackendStore(root); store.saveConfig({ provider: "default", model: "m", baseUrl: "http://127.0.0.1:8642" }); store.setKey("secret"); store.setKey("provider-secret", "provider");
  expect(store.getKey("provider")).toBe("provider-secret");
  expect(store.getKey()).toBe("secret"); expect(statSync(join(root, "backend", "hermes.key")).mode & 0o777).toBe(0o600); expect(statSync(join(root, "backend")).mode & 0o777).toBe(0o700);
  expect(readFileSync(join(root, "backend", "hermes.json"), "utf8")).not.toContain("secret"); store.setKey(null); expect(store.getKey()).toBeNull(); expect(store.getKey("provider")).toBe("provider-secret");
});
test.if(process.platform !== "win32")("unsichere Rechte und symbolische Links werden abgelehnt", () => {
  const root = setup(), store = new BackendStore(root); store.setKey("x"); chmodSync(join(root, "backend", "hermes.key"), 0o644); expect(() => store.getKey()).toThrow();
  rmSync(join(root, "backend", "hermes.key")); symlinkSync("/etc/passwd", join(root, "backend", "hermes.key")); expect(() => store.getKey()).toThrow();
});
