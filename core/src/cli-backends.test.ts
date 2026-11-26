import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendStore } from "./backend-config";
import { CliAgent } from "./cli-agents";
import { CliBackends, cliKindOf, isCli } from "./cli-backends";

const make = (home = mkdtempSync(join(tmpdir(), "cli-be-"))) => ({ home, cb: new CliBackends(new BackendStore(home), new CliAgent({ daemonUrl: "http://127.0.0.1:1", workspace: home })) });

test("Chat-IDs gehören eindeutig zu einem Backend", () => {
  expect(cliKindOf("claude_123e4567-e89b-42d3-a456-426614174000")).toBe("claude");
  expect(cliKindOf("codex_123e4567-e89b-42d3-a456-426614174000")).toBe("codex");
  for (const x of ["hermes_abc", "ses_123", "claude_../../x", "claude_", "", undefined, null]) expect(isCli(x)).toBe(false);
});

test("Chats, Verlauf und Einstellungen bleiben nach Neustart erhalten, Dateien nur für den Nutzer lesbar", () => {
  const { home, cb } = make();
  const id = cb.createSession("claude", "Test");
  cb.append(id, { role: "user", text: "Hallo" }); cb.append(id, { role: "assistant", text: "Hi" });
  cb.markStarted(id);
  const codex = cb.createSession("codex", "Cx");
  cb.markStarted(codex, "thread-1");
  cb.configure("claude", { model: "sonnet", files: "read" });
  const again = make(home).cb;
  expect(again.rows.map(r => [r.kind, r.title, r.started])).toEqual([["claude", "Test", true], ["codex", "Cx", true]]);
  expect(again.get(codex).native).toBe("thread-1");
  expect(again.get(id).native).toMatch(/^[0-9a-f-]{36}$/);           // Claude: ID von Jarvis vergeben
  expect(again.messages(id).map(m => [m.role, m.text])).toEqual([["user", "Hallo"], ["assistant", "Hi"]]);
  expect(again.configs.claude).toEqual({ model: "sonnet", files: "read" });
  expect(again.configs.codex).toEqual({ model: "", files: "none" });
  for (const f of readdirSync(join(home, "backend"))) expect(statSync(join(home, "backend", f)).mode & 0o077).toBe(0);
});

test("Umbenennen, Löschen (inkl. Verlauf), unbekannte Chats, ungültige Einstellungen", () => {
  const { home, cb } = make();
  const id = cb.createSession("codex", "A");
  cb.append(id, { role: "user", text: "x" });
  cb.rename(id, "B"); expect(cb.get(id).title).toBe("B");
  cb.remove(id);
  expect(cb.rows).toHaveLength(0);
  expect(readdirSync(join(home, "backend")).some(f => f.startsWith("cli-msg-"))).toBe(false);
  expect(() => cb.messages(id)).toThrow("nicht gefunden");
  expect(() => cb.configure("claude", { model: "a b" })).toThrow();
  expect(cb.configs.claude.model).toBe("");
});
