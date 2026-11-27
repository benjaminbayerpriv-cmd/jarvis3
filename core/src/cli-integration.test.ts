import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const freePort = () => { const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() }); const p = s.port!; s.stop(); return p; };

// Echter jarvisd (index.ts) mit isoliertem HOME; „claude“ und „codex“ sind Ersatzprogramme im Suchpfad. Kein Konto, kein Netz.
test("isolierter Daemon: Claude Code und Codex als Backends (Chat, Fortsetzen, Verlauf, Stopp, Schlüssel-Ablehnung)", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-cli-")), bin = join(root, "bin"), log = join(root, "calls.log"); mkdirSync(bin);
  const oc = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/global/health") return Response.json({ healthy: true });
    if (path === "/event") return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(": connected\n\n")); } }));
    if (path === "/session") return Response.json([]);
    if (path === "/session/status") return Response.json({});
    return Response.json({});
  } });
  writeFileSync(join(bin, "opencode"), '#!/bin/sh\n[ "$1" = models ] && echo opencode/test\n', { mode: 0o755 });
  writeFileSync(join(bin, "claude"), `#!/bin/sh
echo "claude $*" | tr '\n' ' ' >> "${log}"; echo >> "${log}"
if [ "$1" = auth ]; then echo '{"loggedIn":true}'; exit 0; fi
case "$*" in *"-p /usage"*) printf '%s\\n' '{"type":"result","result":"Current session: 42% used · resets Nov 28 at 2:20am (Europe/Berlin)\\nCurrent week (all models): 11% used · resets Dec 3 at 11am"}'; exit 0;; esac
case "$*" in *WARTE-AUF-STOPP*) echo '{"type":"system","subtype":"init","session_id":"x"}'; sleep 30; exit 0;; esac
SID=x; for a in "$@"; do case "$prev" in --session-id|--resume) SID="$a";; esac; prev="$a"; done
echo '{"type":"system","subtype":"init","session_id":"'$SID'"}'
case "$*" in *VORTEXT*) echo '{"type":"stream_event","api_message_id":"m0","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Ich öffne es."}}}';; esac
echo '{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"mcp__jarvis__desktop_displays","input":{}}]}}'
echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}'
echo '{"type":"stream_event","api_message_id":"m2","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Antwort von Claude"}}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Antwort von Claude"}'
`, { mode: 0o755 });
  writeFileSync(join(bin, "codex"), `#!/bin/sh
echo "codex $*" | tr '\n' ' ' >> "${log}"; echo >> "${log}"
if [ "$1" = login ]; then echo "Logged in using ChatGPT"; exit 0; fi
if [ "$1" = app-server ]; then read a; echo '{"id":1,"result":{}}'; read b; read c; echo '{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":7,"windowDurationMins":300,"resetsAt":1795829552},"secondary":{"usedPercent":45,"windowDurationMins":10080,"resetsAt":1796050412},"planType":"plus"}}}'; sleep 1; exit 0; fi
if [ "$1" = debug ]; then echo '{"models":[{"slug":"gpt-x1","display_name":"GPT X1","visibility":"list","priority":1,"supported_reasoning_levels":[{"effort":"low"},{"effort":"high"}]},{"slug":"gpt-x2","display_name":"GPT X2","visibility":"hide","priority":2}]}'; exit 0; fi
case "$*" in *WARTE-AUF-STOPP*) echo '{"type":"thread.started","thread_id":"T-warte"}'; sleep 30; exit 0;; esac
echo '{"type":"thread.started","thread_id":"THREAD-1"}'
echo '{"type":"item.completed","item":{"id":"a","type":"agent_message","text":"Antwort von Codex"}}'
echo '{"type":"turn.completed"}'
`, { mode: 0o755 });
  const daemonPort = freePort();
  const proc = Bun.spawn([process.execPath, "run", "src/index.ts"], { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}`, JARVIS_NO_SIDECAR: "1", JARVIS_PORT: String(daemonPort), JARVIS_OPENCODE_PORT: String(oc.port), JARVIS_HERMES_HOME: join(root, "hermes") } });
  let ws: WebSocket | undefined;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${daemonPort}/health`)).ok) break; } catch {} await Bun.sleep(50); }
    ws = new WebSocket(`ws://127.0.0.1:${daemonPort}/ui`);
    const messages: any[] = []; ws.onmessage = e => { try { messages.push(JSON.parse(String(e.data))); } catch {} };
    await new Promise<void>((resolve, reject) => { ws!.onopen = () => resolve(); ws!.onerror = () => reject(new Error("WS-Start fehlgeschlagen")); });
    const send = (x: object) => ws!.send(JSON.stringify(x));
    async function wait(pred: (x: any) => boolean) { for (let i = 0; i < 200; i++) { const index = messages.findIndex(pred); if (index >= 0) return messages.splice(index, 1)[0]; await Bun.sleep(40); } throw new Error(`Ereignis fehlt: ${JSON.stringify(messages.slice(-8))}`); }
    const calls = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];

    // Zustand: beide Programme erscheinen, nach der Statusabfrage „ready“, ohne Schlüssel
    send({ type: "backend_get" });
    const first = await wait(m => m.type === "backend");
    expect(first.backends.claude.loginManaged).toBe(true); expect(first.backends.codex.keySet).toBe(false);
    const ready = await wait(m => m.type === "backend" && m.backends.claude.status === "ready" && m.backends.codex.status === "ready");
    expect(ready.backends.claude.config).toEqual({ provider: "claude", model: "", files: "none", effort: "", adopt: false });

    // Limit-Anzeige: beide Programme, ohne Modellaufruf
    send({ type: "limits_get", force: true });
    const lim = (await wait(m => m.type === "limits" && m.limits.claude && m.limits.codex)).limits;
    expect(lim.claude.windows.map((w: any) => [w.label, w.usedPercent, w.resetText])).toEqual([["Sitzung (5 Std.)", 42, "28. Nov., 02:20"], ["Woche (alle Modelle)", 11, "3. Dez., 11:00"]]);
    expect(lim.codex).toMatchObject({ ok: true, plan: "plus", windows: [{ label: "5 Std.", usedPercent: 7 }, { label: "Woche", usedPercent: 45 }] });
    expect(ready.backends.claude.installed).toEqual({ skills: expect.any(Number), plugins: expect.any(Number) });

    // Einstellungen: gültig speichern, ungültig und Schlüssel ablehnen
    send({ type: "backend_config", backend: "claude", config: { model: "sonnet", files: "none" } }); expect((await wait(m => m.type === "backend_saved")).ok).toBe(true);
    send({ type: "backend_config", backend: "claude", config: { model: "a b", files: "none" } }); expect((await wait(m => m.type === "backend_saved")).ok).toBe(false);
    send({ type: "backend_secret", backend: "codex", apiKey: "geheim-123456789" }); const rej = await wait(m => m.type === "backend_saved"); expect(rej.ok).toBe(false); expect(rej.error).toContain("meldet sich selbst an");
    send({ type: "backend_test", backend: "codex" }); expect((await wait(m => m.type === "backend_test")).ok).toBe(true);

    // Claude Code: neuer Chat, Werkzeug, Text, Ende; zweite Nachricht setzt die Sitzung fort
    send({ type: "backend_set", backend: "claude" }); await wait(m => m.type === "backend" && m.active === "claude");
    // Modellwahl im Chat: Liste, Auswahl setzt das Modell des Programms
    const picker = await wait(m => m.type === "state" && m.backend === "claude");
    expect(picker.models.map((m: any) => m.id)).toEqual(expect.arrayContaining(["claude/default", "claude/sonnet", "claude/claude-opus-5-5", "claude/haiku"]));
    send({ type: "settings", settings: { model: "claude/opus" } });
    expect((await wait(m => m.type === "state" && m.backend === "claude" && m.model === "claude/opus")).models.some((m: any) => m.id === "claude/opus")).toBe(true);
    send({ type: "settings", settings: { model: "opencode/big-pickle" } });   // fremdes Modell wird nicht übernommen
    expect((await wait(m => m.type === "notice")).text).toContain("Modellmenü");
    send({ type: "backend_config", backend: "claude", config: { model: "opus", files: "none", effort: "high", adopt: true } }); expect((await wait(m => m.type === "backend_saved")).ok).toBe(true);
    send({ type: "backend_config", backend: "claude", config: { model: "opus", files: "none", effort: "high", adopt: "ja" } }); expect((await wait(m => m.type === "backend_saved")).ok).toBe(false);
    send({ type: "chat", text: "Hallo Claude", session: null });
    const sid = (await wait(m => m.type === "session" && m.id)).id; expect(sid.startsWith("claude_")).toBe(true);
    expect((await wait(m => m.type === "tool" && m.session === sid && m.status === "running")).name).toBe("desktop_displays");
    expect((await wait(m => m.type === "delta" && m.session === sid)).text).toBe("Antwort von Claude");
    await wait(m => m.type === "done" && m.session === sid);
    const stateMsg = await wait(m => m.type === "state" && m.backend === "claude"); expect(stateMsg.model).toBe("claude/opus");
    send({ type: "chat", text: "Noch eine", session: sid }); await wait(m => m.type === "done" && m.session === sid);
    const claudeCalls = calls().filter(c => c.startsWith("claude -p") && !c.startsWith("claude -p /usage"));
    expect(claudeCalls).toHaveLength(2);
    expect(claudeCalls[0]).toContain("--session-id"); expect(claudeCalls[1]).toContain("--resume");
    expect(claudeCalls[0]).toContain("--setting-sources user"); expect(claudeCalls[0]).toContain("disableAllHooks"); expect(claudeCalls[0]).toContain("--allowedTools mcp__jarvis__*,Skill");
    expect(claudeCalls[0]).toContain("--model opus"); expect(claudeCalls[0]).toContain("--effort high"); expect(claudeCalls[0]).toContain("--strict-mcp-config");
    expect(claudeCalls[0]).not.toMatch(/dangerously|Bash/);
    // Text vor und nach einem Werkzeug: neuer Absatz, nicht aneinandergeklebt
    // App-Name: wird gespeichert, kommt im Zustand an und steht in der Anweisung an das Programm
    send({ type: "settings", settings: { appName: "  Hugo  " } });
    expect((await wait(m => m.type === "state" && m.appName === "Hugo")).appName).toBe("Hugo");
    send({ type: "settings", settings: { appName: "x".repeat(40) } }); await Bun.sleep(150);   // zu lang: bleibt „Hugo“
    messages.length = 0;
    send({ type: "chat", text: "Mit VORTEXT", session: sid });
    expect((await wait(m => m.type === "delta" && m.session === sid)).text).toBe("Ich öffne es.");
    expect((await wait(m => m.type === "delta" && m.session === sid)).text).toBe("\n\nAntwort von Claude");
    await wait(m => m.type === "done" && m.session === sid);
    const last = calls().filter(c => c.startsWith("claude -p") && !c.startsWith("claude -p /usage")).at(-1)!;
    expect(last).toContain("Du bist Hugo,"); expect(last).toContain("Dein Name ist Hugo."); expect(last).not.toContain("Du bist Jarvis");
    expect(JSON.parse(readFileSync(join(root, ".jarvis3", "settings.json"), "utf8")).appName).toBe("Hugo");
    send({ type: "open", id: sid });
    expect((await wait(m => m.type === "messages" && m.session === sid)).messages.map((m: any) => m.text)).toEqual(["Hallo Claude", "Antwort von Claude", "Noch eine", "Antwort von Claude", "Mit VORTEXT", "Ich öffne es.\n\nAntwort von Claude"]);

    // Verlauf, Umbenennen, Bearbeiten abgelehnt
    send({ type: "history" }); const hist = await wait(m => m.type === "history" && m.sessions.some((s: any) => s.id === sid)); expect(hist.sessions.find((s: any) => s.id === sid).running).toBe(false);
    send({ type: "chat_action", action: "rename", id: sid, title: "Mein Claude-Chat" });
    expect((await wait(m => m.type === "history" && m.sessions.some((s: any) => s.id === sid && s.title === "Mein Claude-Chat"))).sessions.length).toBeGreaterThan(0);
    send({ type: "rewind", id: sid, messageID: "m1" }); expect((await wait(m => m.type === "error" && m.session === sid)).message).toContain("Claude Code und Codex");

    // Codex: eigener Chat, Thread-ID wird beim zweiten Lauf verwendet
    send({ type: "new" });   // sonst bleibt der geöffnete Claude-Chat der „aktuelle“
    send({ type: "backend_set", backend: "codex" }); await wait(m => m.type === "backend" && m.active === "codex");
    const cxState = await wait(m => m.type === "state" && m.backend === "codex" && m.models.some((x: any) => x.id === "codex/gpt-x1"));
    expect(cxState.models.map((m: any) => [m.id, m.model])).toEqual([["codex/default", "Vorgabe"], ["codex/gpt-x1", "GPT X1"]]);   // versteckte Modelle fehlen
    send({ type: "settings", settings: { model: "codex/gpt-x1" } }); await wait(m => m.type === "backend" && m.backends.codex.config.model === "gpt-x1");
    send({ type: "chat", text: "Hallo Codex", session: null });
    const cid = (await wait(m => m.type === "session" && m.id && m.id.startsWith("codex_"))).id;
    expect((await wait(m => m.type === "delta" && m.session === cid)).text).toBe("Antwort von Codex"); await wait(m => m.type === "done" && m.session === cid);
    send({ type: "backend_config", backend: "codex", config: { model: "gpt-x1", files: "none", effort: "", adopt: true } }); expect((await wait(m => m.type === "backend_saved")).ok).toBe(true);
    send({ type: "chat", text: "Nochmal", session: cid }); await wait(m => m.type === "done" && m.session === cid);
    const codexCalls = calls().filter(c => c.startsWith("codex exec"));
    expect(codexCalls[0]).not.toContain("resume"); expect(codexCalls[1]).toContain("exec resume"); expect(codexCalls[1]).toContain("THREAD-1 Nochmal");
    expect(codexCalls[1]).toContain("--disable hooks"); expect(codexCalls[1]).not.toContain("--ignore-user-config"); expect(codexCalls[1]).not.toContain("shell_tool"); expect(codexCalls[1]).toContain('approval_policy="never"');
    expect(codexCalls[0]).toContain("-m gpt-x1"); expect(codexCalls[0]).toContain("--disable shell_tool"); expect(codexCalls[0]).toContain("--ignore-user-config"); expect(codexCalls[0]).not.toMatch(/danger/);

    // Stopp: laufendes Programm wird beendet
    send({ type: "chat", text: "WARTE-AUF-STOPP", session: cid }); await wait(m => m.type === "state" && m.busySessions?.includes(cid));
    await Bun.sleep(300); send({ type: "stop", session: cid }); await wait(m => m.type === "stopped" && m.session === cid);
    await Bun.sleep(300);
    expect(Bun.spawnSync(["pgrep", "-f", "T-warte|\\bsleep 30"]).stdout.toString().trim()).toBe("");

    // Löschen entfernt Chat und Verlaufsdatei
    messages.length = 0;   // ältere Verlaufsnachrichten dürfen nicht als Antwort zählen
    send({ type: "chat_action", action: "delete", id: cid });
    await wait(m => m.type === "history" && !m.sessions.some((s: any) => s.id === cid));
    expect(readdirSync(join(root, ".jarvis3", "backend")).filter(f => f.includes(cid))).toEqual([]);

    // Logo: hochladen, ausliefern, falsche Daten ablehnen, entfernen
    const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
    expect((await fetch(`http://127.0.0.1:${daemonPort}/logo`)).status).toBe(404);                    // Standard: kein Logo
    messages.length = 0; send({ type: "logo_set", data: Buffer.from("GIF89a" + "x".repeat(60)).toString("base64") });
    const badLogo = await wait(m => m.type === "logo_saved"); expect(badLogo.ok).toBe(false); expect(badLogo.error).toContain("PNG");
    send({ type: "logo_set", data: PIXEL }); expect((await wait(m => m.type === "logo_saved")).ok).toBe(true);
    const withLogo = await wait(m => m.type === "state" && m.logo > 0); expect(withLogo.logo).toBeGreaterThan(0);
    const served = await fetch(`http://127.0.0.1:${daemonPort}/logo?v=${withLogo.logo}`);
    expect(served.status).toBe(200); expect(served.headers.get("content-type")).toBe("image/png"); expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await served.arrayBuffer()).toString("base64")).toBe(PIXEL);
    expect(existsSync(join(root, ".jarvis3", "logo.png"))).toBe(true);
    send({ type: "logo_clear", none: true }); expect((await wait(m => m.type === "logo_saved")).ok).toBe(true);
    expect((await wait(m => m.type === "state" && m.logo === -1)).logo).toBe(-1);                    // ausdrücklich kein Logo (auch kein Tab-Symbol)
    send({ type: "logo_clear" }); expect((await wait(m => m.type === "logo_saved")).ok).toBe(true);
    expect((await wait(m => m.type === "state" && m.logo === 0)).logo).toBe(0);                      // Standard
    expect((await fetch(`http://127.0.0.1:${daemonPort}/logo`)).status).toBe(404); expect(existsSync(join(root, ".jarvis3", "logo.png"))).toBe(false);

    // Geheimnisse: Der Schlüsselversuch taucht nirgends auf
    expect(JSON.stringify(messages)).not.toContain("geheim-123456789");
  } finally { ws?.close(); proc.kill(); await proc.exited; oc.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 60000);
