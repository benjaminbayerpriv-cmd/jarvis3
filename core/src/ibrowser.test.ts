import { test, expect } from "bun:test";
import { InternalBrowser, findChrome, urlFor } from "./ibrowser";

test("Adressleiste: Adresse, localhost, Domain oder Suche", () => {
  expect(urlFor("https://a.de/x")).toBe("https://a.de/x");
  expect(urlFor("localhost:3000/app")).toBe("http://localhost:3000/app");
  expect(urlFor("127.0.0.1:7777")).toBe("http://127.0.0.1:7777");
  expect(urlFor("wetter.de")).toBe("https://wetter.de");
  expect(urlFor("wetter in berlin")).toBe("https://www.google.com/search?q=wetter%20in%20berlin");
  expect(urlFor("")).toBe("about:blank");
});

const page = `<!doctype html><title>Testseite</title><body style="margin:0;font:16px sans-serif">
<h1>Hallo Welt</h1><input id=q placeholder="Suche" style="width:200px"><button id=go onclick="document.getElementById('out').textContent='Klick:'+document.getElementById('q').value">Los</button>
<input type=password placeholder="Passwort"><select id=s><option>Rot</option><option>Blau</option></select><p id=out>leer</p><div style="height:3000px"></div>`;

test.skipIf(!findChrome())("Eingebauter Browser: öffnen, scannen, tippen, klicken, lesen, Screenshot, Bildstrom", async () => {
  const ib = new InternalBrowser(19333, `/tmp/jarvis-ib-test-${process.pid}`);
  try {
    const frames: any[] = [];
    ib.onFrame = m => frames.push(m);
    const opened = await ib.call({ cmd: "tab_open", url: "data:text/html," + encodeURIComponent(page) });
    expect(opened.ok).toBe(true);
    const tab = opened.tab as number;
    expect((await ib.call({ cmd: "tab_list" })).tabs.length).toBe(1);

    const scan = await ib.call({ cmd: "scan", tab, text: true });
    expect(scan.ok).toBe(true);
    expect(scan.text).toContain("Los");
    const field = scan.targets.find((t: any) => t.label === "Suche");
    const button = scan.targets.find((t: any) => t.label === "Los");
    const secret = scan.targets.find((t: any) => /Passwort/.test(t.label));
    expect(field && button && secret).toBeTruthy();
    expect(secret.enabled).toBe(false);

    expect((await ib.call({ cmd: "type", tab, id: secret.id, text: "x" })).error).toContain("Passwort");
    expect((await ib.call({ cmd: "type", tab, id: field.id, text: "Jarvis" })).ok).toBe(true);
    expect((await ib.call({ cmd: "click", tab, id: button.id })).ok).toBe(true);
    expect((await ib.call({ cmd: "read", tab })).text).toContain("Klick:Jarvis");
    const select = scan.targets.find((t: any) => t.axRole === "AXComboBox");
    expect((await ib.call({ cmd: "type", tab, id: select.id, text: "Blau" })).chose).toBe("Blau");

    const shot = await ib.call({ cmd: "shot", tab, marks: true });
    expect(shot.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect((await ib.call({ cmd: "scroll", tab, dy: 3 })).ok).toBe(true);
    expect((await ib.call({ cmd: "scan", tab, text: true })).text).toMatch(/gescrollt [1-9]/);

    await ib.call({ cmd: "resize", tab, w: 700, h: 500, dpr: 2 });
    expect((await ib.call({ cmd: "stream_start", tab })).ok).toBe(true);
    await Bun.sleep(1200);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.at(-1)).toMatchObject({ tab, w: 700, h: 500, dpr: 2, internal: true });
    expect((await ib.call({ cmd: "input", tab, event: { kind: "mouse", type: "mouseMoved", x: 10, y: 10 } })).ok).toBe(true);
    await ib.call({ cmd: "stream_stop", tab });

    expect((await ib.call({ cmd: "tab_close", tab })).ok).toBe(true);
    expect((await ib.call({ cmd: "tab_list" })).tabs.length).toBe(0);
  } finally { ib.stop(); }
}, 90_000);
