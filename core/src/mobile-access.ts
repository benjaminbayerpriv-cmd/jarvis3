import { createHash, randomBytes, randomInt, timingSafeEqual, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, hostname } from "node:os";
import { join } from "node:path";
import { isIP } from "node:net";
import forge from "node-forge";
import { Bonjour } from "bonjour-service";

export function privateAddress(address: string): boolean {
  const ip = address.toLowerCase().split("%")[0] ?? "";
  if (ip.startsWith("::ffff:")) return isIP(ip.slice(7)) === 4 && privateAddress(ip.slice(7));
  if (isIP(ip) === 4) {
    const [first, second] = ip.split(".").map(Number);
    return first === 10 || first === 127 || (first === 172 && second! >= 16 && second! <= 31)
      || (first === 192 && second === 168) || (first === 169 && second === 254);
  }
  return isIP(ip) === 6 && (ip === "::1" || ip === "0:0:0:0:0:0:0:1" || /^(fc|fd|fe[89ab])/.test(ip));
}

export function mobileAddresses() {
  return Object.values(networkInterfaces()).flatMap(devices => devices ?? [])
    .filter(device => !device.internal && privateAddress(device.address))
    .sort((a, b) => Number(a.family !== "IPv4") - Number(b.family !== "IPv4"))
    .map(device => device.address)
    .filter((address, index, all) => all.indexOf(address) === index);
}

export const mobileOrigin = (address: string, port: number) =>
  `https://${address.includes(":") ? `[${address}]` : address}:${port}`;

type Device = { id: string; name: string; hash: string; pairedAt: string };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const equal = (left: string, right: string) => timingSafeEqual(Buffer.from(hash(left), "hex"), Buffer.from(hash(right), "hex"));

function writePrivate(path: string, text: string) {
  const temporary = path + "." + randomBytes(8).toString("hex");
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export class MobileDevices {
  private pending?: { pin: string; secret: string; expires: number; attempts: number };
  private readonly path: string;
  private devices: Device[];
  constructor(directory: string, private now = Date.now) {
    mkdirSync(directory, { recursive: true });
    this.path = join(directory, "devices.json");
    this.devices = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : [];
  }

  start() {
    this.pending = { pin: String(randomInt(1_000_000)).padStart(6, "0"),
      secret: randomBytes(32).toString("hex"), expires: this.now() + 120_000, attempts: 0 };
    return { pin: this.pending.pin, secret: this.pending.secret, expires: this.pending.expires };
  }

  cancel() { this.pending = undefined; }

  complete(input: { pin?: unknown; secret?: unknown; name?: unknown }, address: string) {
    if (!privateAddress(address)) return { error: "Zugriff nur im privaten Netz.", status: 403 } as const;
    const pending = this.pending;
    if (!pending || pending.expires <= this.now()) return { error: "Kopplung ist abgelaufen. Erzeuge einen neuen Code.", status: 410 } as const;
    if (pending.attempts >= 5) return { error: "Zu viele Versuche. Erzeuge einen neuen Code.", status: 429 } as const;
    pending.attempts++;
    const pinOK = typeof input?.pin === "string" && /^[0-9]{6}$/.test(input.pin) && equal(input.pin, pending.pin);
    const qrOK = typeof input?.secret === "string" && /^[0-9a-f]{64}$/.test(input.secret) && equal(input.secret, pending.secret);
    if (!pinOK && !qrOK) return { error: "Der Kopplungscode ist falsch.", status: 401 } as const;
    const token = randomBytes(32).toString("hex");
    const device = { id: randomBytes(12).toString("hex"), name: String(input.name ?? "").trim().slice(0, 80) || "Handy",
      hash: hash(token), pairedAt: new Date(this.now()).toISOString() };
    this.persist([...this.devices, device]);
    this.cancel();
    return { token, id: device.id } as const;
  }

  authenticate(token: string | undefined) {
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return;
    const digest = hash(token);
    return this.devices.find(device => timingSafeEqual(Buffer.from(device.hash, "hex"), Buffer.from(digest, "hex")))?.id;
  }

  list() { return this.devices.map(({ id, name, pairedAt }) => ({ id, name, pairedAt })); }

  revoke(id: string) {
    const next = this.devices.filter(device => device.id !== id);
    if (next.length === this.devices.length) return false;
    this.persist(next);
    return true;
  }

  private persist(devices: Device[]) {
    writePrivate(this.path, JSON.stringify(devices, null, 2));
    this.devices = devices;
  }
}

export function mobileCertificate(directory: string) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "mobile-tls.json");
  let saved: { key: string; cert: string } | undefined = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
  if (!saved || Date.parse(new X509Certificate(saved.cert).validTo) < Date.now() + 86400_000) {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = "01" + randomBytes(16).toString("hex");
    cert.validity.notBefore = new Date(Date.now() - 300_000);
    cert.validity.notAfter = new Date(Date.now() + 365 * 86400_000);
    const subject = [{ name: "commonName", value: "Jarvis im lokalen Netz" }];
    cert.setSubject(subject);
    cert.setIssuer(subject);
    cert.setExtensions([
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: mobileAddresses().filter(ip => !ip.includes("%")).map(ip => ({ type: 7, ip })) },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    saved = { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) };
    writePrivate(path, JSON.stringify(saved));
  }
  return { ...saved, fingerprint: hashCertificate(saved.cert) };
}

function hashCertificate(cert: string) {
  return createHash("sha256").update(new X509Certificate(cert).raw).digest("hex");
}

export function announceMobile(port: number, onError: (error: Error) => void) {
  const bonjour = new Bonjour({}, onError);
  const service = bonjour.publish({ name: hostname().split(".")[0] || "Jarvis", type: "jarvis3", protocol: "tcp", port });
  service.on("error", onError);
  return () => { service.stop(() => bonjour.destroy()); };
}
