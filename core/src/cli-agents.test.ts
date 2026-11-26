import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliAgent, ClaudeParser, CodexParser, claudeArgs, cliModelId, codexArgs, defaultCliConfig, newParser, parseCliConfig, type CliEnv, type CliRun } from "./cli-agents";
import type { BrainEvent } from "./opencode";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures/cli", name), "utf8").split("\n").filter(Boolean);
const run = (kind: "claude" | "codex", lines: string[]) => { const p = newParser(kind); const events: BrainEvent[] = lines.flatMap(l => p.feed(l)); return { p, events }; };
const text = (events: BrainEvent[]) => events.filter(e => e.kind === "text").map(e => (e as any).delta).join("");
const env: CliEnv = { daemonUrl: "http://127.0.0.1:7777", workspace: "/tmp", bun: "/bin/bun", mcpPath: "/x/mcp.ts" };
const base: CliRun = { kind: "claude", config: defaultCliConfig(), input: "Hallo", instructions: "Anweisung", native: "11111111-1111-4111-8111-111111111111", resume: false };

describe("Claude Code: Ausgabe lesen (aufgezeichnet mit claude 2.1.331)", () => {
  test("Lesewerkzeug: Werkzeug läuft, ist fertig, Text kommt als Deltas, Ende ohne Fehler", () => {
    const { p, events } = run("claude", fixture("claude-read.jsonl"));
    const tools = events.filter(e => e.kind === "tool") as any[];
    expect(tools.map(t => [t.name, t.status])).toEqual([["Read", "running"], ["Read", "completed"]]);
    expect(tools[0].title).toContain("datei.txt");
    expect(text(events)).toBe("Die Datei datei.txt enthält den Text „hallo welt“.");   // keine Doppelung durch die fertige Nachricht
    expect(events.at(-1)).toEqual({ kind: "done" });
    expect(p.finished).toBe(true);
    expect(p.native).toBe("114e1d42-77b3-4a60-b474-1e7c8c525831");
  });
  test("Jarvis-MCP-Werkzeug: Präfix mcp__jarvis__ wird für die Anzeige entfernt", () => {
    const { events } = run("claude", fixture("claude-mcp.jsonl"));
    expect((events.filter(e => e.kind === "tool") as any[]).map(t => [t.name, t.status])).toEqual([["desktop_displays", "running"], ["desktop_displays", "completed"]]);
    expect(text(events)).toContain("Monitor 1");
  });
  test("Fehlerergebnis und Abbruch ohne Ergebnis", () => {
    const err = run("claude", ['{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Zu viele Anfragen"}']);
    expect(err.events).toEqual([{ kind: "error", message: "Claude Code: Zu viele Anfragen" }]);
    const p = new ClaudeParser();
    expect(p.end(1, false)[0]).toMatchObject({ kind: "error" });
    expect(new ClaudeParser().end(null, true)).toEqual([{ kind: "done", aborted: true }]);
  });
  test("Unteragenten-Text und kaputte Zeilen werden ignoriert", () => {
    const { events } = run("claude", ['kein json', '{"type":"stream_event","parent_tool_use_id":"x","api_message_id":"m","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"intern"}}}']);
    expect(events).toEqual([]);
  });
  test("Denk-Text wird getrennt gemeldet", () => {
    const { events } = run("claude", ['{"type":"stream_event","api_message_id":"m","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}}']);
    expect(events).toEqual([{ kind: "reasoning", delta: "hmm" }]);
  });
});

describe("Codex: Ausgabe lesen (aufgezeichnet mit codex-cli 0.170.0)", () => {
  test("Befehl: Befehl läuft und endet, Antwort, Ende, Thread-ID", () => {
    const { p, events } = run("codex", fixture("codex-shell.jsonl"));
    expect((events.filter(e => e.kind === "tool") as any[]).map(t => [t.name, t.status])).toEqual([["Befehl", "running"], ["Befehl", "completed"]]);
    expect(text(events)).toBe("Die Datei enthält „hallo welt“.");
    expect(events.at(-1)).toEqual({ kind: "done" });
    expect(p.native).toBe("01a21a3d-39ca-7183-bddd-328c69e30901");
  });
  test("Jarvis-MCP-Werkzeug; mehrere Nachrichten werden durch Absatz getrennt", () => {
    const { events } = run("codex", fixture("codex-mcp.jsonl"));
    expect((events.filter(e => e.kind === "tool") as any[]).map(t => [t.name, t.status])).toEqual([["desktop_displays", "running"], ["desktop_displays", "completed"]]);
    expect(text(events)).toBe("Ich suche das Werkzeug und rufe es auf, sobald ich es gefunden habe.\n\n`desktop_displays` meldet einen Monitor, den Hauptbildschirm mit 1920 × 1080 Pixeln.");
  });
  test("Fehler: turn.failed und Prozessende ohne Ergebnis", () => {
    expect(run("codex", ['{"type":"turn.failed","error":{"message":"Kontingent erreicht"}}']).events).toEqual([{ kind: "error", message: "Codex: Kontingent erreicht" }]);
    const p = new CodexParser(); p.feed('{"type":"error","message":"Verbindung getrennt"}');
    expect((p.end(1, false)[0] as any).message).toContain("Verbindung getrennt");
    expect(new CodexParser().end(null, true)).toEqual([{ kind: "done", aborted: true }]);
    const failed = run("codex", ['{"type":"item.completed","item":{"id":"i","type":"mcp_tool_call","tool":"x","status":"failed","error":{"message":"boom"}}}']).events[0] as any;
    expect(failed).toMatchObject({ status: "error", error: "Werkzeug fehlgeschlagen" });
  });
});

describe("Aufruf und Einstellungen", () => {
  test("Claude: nur Jarvis-Werkzeuge, keine Nutzer-Einstellungen, Sitzung neu oder fortgesetzt", () => {
    const a = claudeArgs(base, env);
    expect(a[a.indexOf("--tools") + 1]).toBe("");
    expect(a[a.indexOf("--allowedTools") + 1]).toBe("mcp__jarvis__*");
    expect(a).toContain("--strict-mcp-config");
    expect(a[a.indexOf("--setting-sources") + 1]).toBe("");
    expect(a).not.toContain("--dangerously-skip-permissions");
    expect(a.join(" ")).not.toMatch(/Bash|Edit|Write/);
    expect(a.slice(a.indexOf("--session-id"), a.indexOf("--session-id") + 2)).toEqual(["--session-id", base.native]);
    expect(JSON.parse(a[a.indexOf("--mcp-config") + 1]).mcpServers.jarvis).toEqual({ command: "/bin/bun", args: ["/x/mcp.ts"], env: { JARVISD_URL: "http://127.0.0.1:7777" } });
    const r = claudeArgs({ ...base, resume: true, config: { model: "sonnet", files: "read" } }, env);
    expect(r).toContain("--resume"); expect(r).not.toContain("--session-id");
    expect(r[r.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
    expect(r[r.indexOf("--model") + 1]).toBe("sonnet");
  });
  test("Codex: Nur-Lese-Sandbox, Shell aus, eigene MCP-Konfiguration, Anweisung nur vor der ersten Nachricht", () => {
    const a = codexArgs({ ...base, kind: "codex" }, env);
    expect(a.slice(0, 1)).toEqual(["exec"]);
    expect(a).toContain("--ignore-user-config");
    expect(a.join(" ")).toContain('sandbox_mode="read-only"');
    expect(a).toContain("shell_tool");
    expect(a.join(" ")).toContain('mcp_servers.jarvis.env={JARVISD_URL="http://127.0.0.1:7777"}');
    expect(a.at(-1)).toBe("Anweisung\n\n---\n\nHallo");
    expect(a.join(" ")).not.toContain("danger");
    const r = codexArgs({ ...base, kind: "codex", resume: true, native: "t-1", config: { model: "gpt-x", files: "read" } }, env);
    expect(r.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(r).not.toContain("shell_tool");
    expect(r.at(-2)).toBe("t-1"); expect(r.at(-1)).toBe("Hallo");
  });
  test("Einstellungen prüfen", () => {
    expect(parseCliConfig({ model: "", files: "none" })).toEqual({ model: "", files: "none" });
    expect(parseCliConfig({ model: "claude-sonnet-5-5", files: "read" })).toEqual({ model: "claude-sonnet-5-5", files: "read" });
    for (const bad of [null, [], { model: 5 }, { model: "a b" }, { model: "x".repeat(101) }, { files: "write" }, { model: "--evil" }]) expect(() => parseCliConfig(bad)).toThrow();
    expect(cliModelId("claude", defaultCliConfig())).toBe("claude/default");
  });
});

// Ein falsches „Programm“ (Skript), damit Ablauf, Fortsetzen und Abbrechen ohne Konto und Netz geprüft werden
describe("Ausführung mit Ersatzprogramm", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-agent-"));
  const script = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); return p; };
  const agent = (bin: string, kind: "claude" | "codex" = "claude") => new CliAgent({ ...env, workspace: dir, bin: { [kind]: bin } }, 500);
  const collect = async (a: CliAgent, kind: "claude" | "codex", extra: Partial<CliRun> = {}, id = "s1") => {
    const events: BrainEvent[] = []; const r = await a.prompt(id, { ...base, kind, ...extra }, e => events.push(e)); return { events, r };
  };

  test("Claude-Ersatz: Argumente kommen an, Text und Ende, Sitzungs-ID", async () => {
    const bin = script("fake-claude", `echo "$@" > "${dir}/args.txt"\ncat <<'EOF'\n{"type":"system","subtype":"init","session_id":"abc"}\n{"type":"stream_event","api_message_id":"m","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}}\n{"type":"result","subtype":"success","is_error":false,"result":"Hi"}\nEOF`);
    const { events, r } = await collect(agent(bin), "claude");
    expect(events).toEqual([{ kind: "text", delta: "Hi" }, { kind: "done" }]);
    expect(r.native).toBe("abc");
    expect(readFileSync(join(dir, "args.txt"), "utf8")).toContain("--session-id");
  });
  test("Codex-Ersatz: Thread-ID wird geliefert", async () => {
    const bin = script("fake-codex", `echo '{"type":"thread.started","thread_id":"T1"}'\necho '{"type":"item.completed","item":{"id":"a","type":"agent_message","text":"Ok"}}'\necho '{"type":"turn.completed"}'`);
    const { events, r } = await collect(agent(bin, "codex"), "codex");
    expect(events).toEqual([{ kind: "text", delta: "Ok" }, { kind: "done" }]);
    expect(r.native).toBe("T1");
  });
  test("Abbruch beendet das Programm und meldet „abgebrochen“", async () => {
    const bin = script("slow-claude", `echo '{"type":"system","subtype":"init","session_id":"abc"}'\nsleep 30`);
    const a = agent(bin); const events: BrainEvent[] = [];
    const p = a.prompt("s2", base, e => events.push(e));
    await Bun.sleep(300); expect(a.isRunning("s2")).toBe(true);
    const t = performance.now(); await a.abort("s2"); await p;
    expect(performance.now() - t).toBeLessThan(5000);
    expect(events).toEqual([{ kind: "done", aborted: true }]);
    expect(a.isRunning("s2")).toBe(false);
  });
  test("Programm stirbt ohne Ergebnis: Fehler statt Hängen; fehlendes Programm: Fehler", async () => {
    const bin = script("dead-claude", `exit 3`);
    expect((await collect(agent(bin), "claude")).events[0]).toMatchObject({ kind: "error" });
    const missing = await collect(agent(join(dir, "gibt-es-nicht")), "claude");
    expect(missing.events).toHaveLength(1); expect(missing.events[0]).toMatchObject({ kind: "error" });
  });
  test("Zweite Anfrage in derselben Sitzung wird abgelehnt", async () => {
    const bin = script("slow2", `sleep 5`); const a = agent(bin);
    const first = a.prompt("s3", base, () => {});
    await Bun.sleep(100);
    await expect(a.prompt("s3", base, () => {})).rejects.toThrow("läuft bereits");
    await a.abort("s3"); await first;
  });
  test("Status: nicht installiert wird erkannt, Ersatz für angemeldet/abgemeldet", async () => {
    expect((await agent(join(dir, "nope")).status("claude")).installed).toBe(false);
    const ok = script("auth-ok", `echo '{"loggedIn":true}'`); const out = script("auth-out", `echo '{"loggedIn":false}'`);
    expect(await agent(ok).status("claude")).toMatchObject({ installed: true, loggedIn: true });
    expect(await agent(out).status("claude")).toMatchObject({ installed: true, loggedIn: false });
    const cx = script("cx-ok", `echo "Logged in using ChatGPT"`); expect(await agent(cx, "codex").status("codex")).toMatchObject({ loggedIn: true });
    const cxOut = script("cx-out", `echo "Not logged in" >&2; exit 1`); expect(await agent(cxOut, "codex").status("codex")).toMatchObject({ loggedIn: false });
  });
});
