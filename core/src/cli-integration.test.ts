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
case "$*" in *WARTE-AUF-STOPP*) echo '{"type":"system","subtype":"init","session_id":"x"}'; sleep 30; exit 0;; esac
SID=x; for a in "$@"; do case "$prev" in --session-id|--resume) SID="$a";; esac; prev="$a"; done
echo '{"type":"system","subtype":"init","session_id":"'$SID'"}'
echo '{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"mcp__jarvis__desktop_displays","input":{}}]}}'
echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}'
echo '{"type":"stream_event","api_message_id":"m2","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Antwort von Claude"}}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Antwort von Claude"}'
`, { mode: 0o755 });
  writeFileSync(join(bin, "codex"), `#!/bin/sh
echo "codex $*" | tr '\n' ' ' >> "${log}"; echo >> "${log}"
if [ "$1" = login ]; then echo "Logged in using ChatGPT"; exit 0; fi
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
    expect(ready.backends.claude.config).toEqual({ provider: "claude", model: "", files: "none" });

    // Einstellungen: gültig speichern, ungültig und Schlüssel ablehnen
    send({ type: "backend_config", backend: "claude", config: { model: "sonnet", files: "none" } }); expect((await wait(m => m.type === "backend_saved")).ok).toBe(true);
    send({ type: "backend_config", backend: "claude", config: { model: "a b", files: "none" } }); expect((await wait(m => m.type === "backend_saved")).ok).toBe(false);
    send({ type: "backend_secret", backend: "codex", apiKey: "geheim-123456789" }); const rej = await wait(m => m.type === "backend_saved"); expect(rej.ok).toBe(false); expect(rej.error).toContain("meldet sich selbst an");
    send({ type: "backend_test", backend: "codex" }); expect((await wait(m => m.type === "backend_test")).ok).toBe(true);

    // Claude Code: neuer Chat, Werkzeug, Text, Ende; zweite Nachricht setzt die Sitzung fort
    send({ type: "backend_set", backend: "claude" }); await wait(m => m.type === "backend" && m.active === "claude");
    send({ type: "chat", text: "Hallo Claude", session: null });
    const sid = (await wait(m => m.type === "session" && m.id)).id; expect(sid.startsWith("claude_")).toBe(true);
    expect((await wait(m => m.type === "tool" && m.session === sid && m.status === "running")).name).toBe("desktop_displays");
    expect((await wait(m => m.type === "delta" && m.session === sid)).text).toBe("Antwort von Claude");
    await wait(m => m.type === "done" && m.session === sid);
    const stateMsg = await wait(m => m.type === "state" && m.backend === "claude"); expect(stateMsg.models[0].id).toBe("claude/sonnet");
    send({ type: "chat", text: "Noch eine", session: sid }); await wait(m => m.type === "done" && m.session === sid);
    const claudeCalls = calls().filter(c => c.startsWith("claude -p"));
    expect(claudeCalls).toHaveLength(2);
    expect(claudeCalls[0]).toContain("--session-id"); expect(claudeCalls[1]).toContain("--resume");
    expect(claudeCalls[0]).toContain("--model sonnet"); expect(claudeCalls[0]).toContain("--strict-mcp-config");
    expect(claudeCalls[0]).not.toMatch(/dangerously|Bash/);
    send({ type: "open", id: sid });
    expect((await wait(m => m.type === "messages" && m.session === sid)).messages.map((m: any) => m.text)).toEqual(["Hallo Claude", "Antwort von Claude", "Noch eine", "Antwort von Claude"]);

    // Verlauf, Umbenennen, Bearbeiten abgelehnt
    send({ type: "history" }); const hist = await wait(m => m.type === "history" && m.sessions.some((s: any) => s.id === sid)); expect(hist.sessions.find((s: any) => s.id === sid).running).toBe(false);
    send({ type: "chat_action", action: "rename", id: sid, title: "Mein Claude-Chat" });
    expect((await wait(m => m.type === "history" && m.sessions.some((s: any) => s.id === sid && s.title === "Mein Claude-Chat"))).sessions.length).toBeGreaterThan(0);
    send({ type: "rewind", id: sid, messageID: "m1" }); expect((await wait(m => m.type === "error" && m.session === sid)).message).toContain("Claude Code und Codex");

    // Codex: eigener Chat, Thread-ID wird beim zweiten Lauf verwendet
    send({ type: "backend_set", backend: "codex" }); await wait(m => m.type === "backend" && m.active === "codex");
    send({ type: "new" });
    send({ type: "chat", text: "Hallo Codex", session: null });
    const cid = (await wait(m => m.type === "session" && m.id && m.id.startsWith("codex_"))).id;
    expect((await wait(m => m.type === "delta" && m.session === cid)).text).toBe("Antwort von Codex"); await wait(m => m.type === "done" && m.session === cid);
    send({ type: "chat", text: "Nochmal", session: cid }); await wait(m => m.type === "done" && m.session === cid);
    const codexCalls = calls().filter(c => c.startsWith("codex exec"));
    expect(codexCalls[0]).not.toContain("resume"); expect(codexCalls[1]).toContain("exec resume"); expect(codexCalls[1]).toContain("THREAD-1 Nochmal");
    expect(codexCalls[0]).toContain("--disable shell_tool"); expect(codexCalls[0]).toContain("--ignore-user-config"); expect(codexCalls[0]).not.toMatch(/danger/);

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

    // Geheimnisse: Der Schlüsselversuch taucht nirgends auf
    expect(JSON.stringify(messages)).not.toContain("geheim-123456789");
  } finally { ws?.close(); proc.kill(); await proc.exited; oc.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 60000);
