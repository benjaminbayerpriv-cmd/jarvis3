import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Projects, slug } from "./projects";

const fresh = () => new Projects(mkdtempSync(join(tmpdir(), "jarvis-projects-")));
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

test("Projektordner sind dateschutzfest benannt", () => {
  expect(slug("Märchen & Träume/PC!")).toBe("maerchen-traeume-pc");
  expect(slug("..")).toBe("ordner");
});

test("Projekte und Chats liegen als Unterverzeichnisse und überstehen einen Neustart", () => {
  const s = fresh();
  const a = s.create("Urlaub 2026", "Reiseplanung");
  const b = s.create("Strand", "", a.id);
  s.upsertChat({ id: "chat-1", title: "Hotel", updated: 1000 });
  s.assign("chat-1", b.id, "ki");
  expect(existsSync(join(s.root, a.folder, b.folder, "chats", "chat-1", "chat.json"))).toBe(true);
  expect(json(join(s.root, a.folder, b.folder, "chats", "chat-1", "chat.json")).assignedBy).toBe("ki");
  const again = new Projects(s.root); again.load();
  expect(again.data().projects.map(p => p.name).sort()).toEqual(["Strand", "Urlaub 2026"]);
  expect(again.chat("chat-1")?.projectId).toBe(b.id);
  expect(again.label(b.id)).toBe("Urlaub 2026 / Strand");
});

test("Chats lassen sich verschieben und lösen, ohne die Nachrichten zu duplizieren", () => {
  const s = fresh();
  const a = s.create("A"), b = s.create("B");
  s.upsertChat({ id: "x", title: "Erster", updated: 1000 });
  s.assign("x", a.id, "manual");
  s.assign("x", b.id, "auto");
  expect(existsSync(join(s.root, a.folder, "chats", "x"))).toBe(false);
  expect(s.chat("x")?.assignedBy).toBe("auto");
  s.assign("x", null, "manual");
  expect(existsSync(join(s.root, "chats", "x", "chat.json"))).toBe(true);
  expect(s.chat("x")?.projectId).toBeNull();
  expect(s.data().chats).toHaveLength(1);
});

test("Umbenennen behält den Ordner, Verschieben unter ein neues Elternteil nicht", () => {
  const s = fresh();
  const a = s.create("Alt"), b = s.create("Neu");
  s.update(a.id, { name: "Umbenannt" });
  expect(existsSync(join(s.root, a.folder))).toBe(true);
  s.update(a.id, { parentId: b.id });
  expect(existsSync(join(s.root, b.folder, a.folder, "project.json"))).toBe(true);
  expect(() => s.update(b.id, { parentId: a.id })).toThrow(/eigenes Unterprojekt/);
});

test("Projekt löschen hängt seine Chats an die Wurzel und entfernt Unterprojekte", () => {
  const s = fresh();
  const a = s.create("A"), child = s.create("Kind", "", a.id), other = s.create("B");
  s.upsertChat({ id: "c1", title: "C1", updated: 1 }); s.assign("c1", a.id, "ki");
  s.upsertChat({ id: "c2", title: "C2", updated: 2 }); s.assign("c2", child.id, "ki");
  s.upsertChat({ id: "c3", title: "C3", updated: 3 }); s.assign("c3", other.id, "ki");
  expect(s.remove(a.id)).toBe(2);
  expect(s.data().projects.map(p => p.name)).toEqual(["B"]);
  expect(s.chat("c1")?.projectId).toBeNull();
  expect(s.chat("c2")?.projectId).toBeNull();
  expect(s.chat("c3")?.projectId).toBe(other.id);
  expect(existsSync(join(s.root, a.folder))).toBe(false);
});

test("Analyse-Status wird gesetzt und beim Hinzufügen eines Projekts zurückgesetzt", () => {
  const s = fresh();
  s.upsertChat({ id: "c", title: "C", updated: 1 });
  expect(s.chat("c")?.analyzed).toBe(false);
  s.markAnalyzed("c");
  expect(s.chat("c")?.analyzed).toBe(true);
  s.resetAnalysis();
  const reloaded = new Projects(s.root); reloaded.load();
  expect(reloaded.chat("c")?.analyzed).toBe(false);
  s.assign("c", s.create("Neu").id, "manual");
  expect(s.chat("c")?.analyzed).toBe(true);
});

test("Titel und Zeitstempel eines OpenCode-Chats werden aktualisiert, Zuordnung bleibt", () => {
  const s = fresh();
  s.upsertChat({ id: "id", title: "Alt", updated: 100 });
  const p = s.create("P"); s.assign("id", p.id, "ki");
  expect(s.upsertChat({ id: "id", title: "Neu", updated: 2000 })).toBe(true);
  expect(s.chat("id")?.title).toBe("Neu");
  expect(s.chat("id")?.projectId).toBe(p.id);
  expect(s.upsertChat({ id: "id", title: "Neu", updated: 2100 })).toBe(false);
});
