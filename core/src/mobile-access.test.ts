import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MobileDevices, privateAddress } from "./mobile-access";
import { MobileHttp, mobileMessage } from "./mobile-http";

describe("Handy-Kopplung", () => {
  test("erlaubt nur den angegebenen privaten Adressraum", () => {
    for (const address of ["10.5.12.1", "172.27.182.50", "192.168.5.55", "169.254.2.1", "fd00::2", "fe80::1%en0", "::1", "::ffff:192.168.1.2", "127.0.0.1"])
      expect(privateAddress(address)).toBe(true);
    for (const address of ["8.8.8.8", "172.32.0.0", "100.64.0.1", "2001:4860::1", "::ffff:8.8.8.8", "localhost", "172.16.1.1.evil.test", "not-an-ip"])
      expect(privateAddress(address)).toBe(false);
  });

  test("versucht die PIN höchstens fünfmal und lässt sie nach zwei Minuten ablaufen", () => {
    const directory = mkdtempSync(join(tmpdir(), "jarvis-kopplung-"));
    try {
      let now = 100;
      const store = new MobileDevices(directory, () => now);
      const code = store.start();
      const wrong = code.pin === "000000" ? "000001" : "000000";
      expect(store.complete({ pin: code.pin }, "8.8.8.8")).toHaveProperty("status", 403);
      for (let attempt = 0; attempt < 5; attempt++)
        expect(store.complete({ pin: wrong }, "192.168.1.3")).toHaveProperty("status", 401);
      expect(store.complete({ pin: code.pin }, "192.168.1.3")).toHaveProperty("status", 429);
      const expired = store.start();
      now += 120_000;
      expect(store.complete({ pin: expired.pin }, "192.168.1.3")).toHaveProperty("status", 410);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("speichert nur Token-Hashes und widerruft ein Gerät dauerhaft", () => {
    const directory = mkdtempSync(join(tmpdir(), "jarvis-geraet-"));
    try {
      const store = new MobileDevices(directory);
      const code = store.start();
      const paired = store.complete({ secret: code.secret, name: "Pixel" }, "::1");
      if (!("token" in paired) || !paired.token) throw new Error("Kopplung fehlgeschlagen");
      const path = join(directory, "devices.json");
      expect(readFileSync(path, "utf8")).not.toContain(paired.token);
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(new MobileDevices(directory).authenticate(paired.token)).toBe(paired.id);
      expect(store.complete({ secret: code.secret }, "::1")).toHaveProperty("status", 410);
      expect(store.revoke(paired.id)).toBe(true);
      expect(new MobileDevices(directory).authenticate(paired.token)).toBeUndefined();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("verwaltet Geräte nur am Computer und begrenzt die mobilen UI-Nachrichten", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jarvis-mobil-admin-"));
    try {
      const api = new MobileHttp(directory, directory, 7787, { message() {} },
        () => new Response(""), async () => {}, new Set());
      const url = new URL("http://127.0.0.1:7787/devices");
      expect((await api.admin(new Request(url), url, "192.168.1.3"))?.status).toBe(403);
      expect((await api.admin(new Request(url, { headers: { origin: "https://fremd.invalid" } }), url, "127.0.0.1"))?.status).toBe(403);
      expect((await api.admin(new Request(url), url, "127.0.0.1"))?.status).toBe(200);
      expect(mobileMessage({ type: "run_command" })).toBeNull();
      expect(mobileMessage({ type: "ext_import" })).toBeNull();
      expect(mobileMessage({ type: "settings", settings: { lanAccess: true, mode: "browser" } }))
        .toEqual({ type: "settings", settings: { mode: "browser" } });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
