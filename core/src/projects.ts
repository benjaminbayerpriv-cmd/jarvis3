// Projekte: echte Verzeichnisse unter ~/.jarvis3/projects.
// Jedes Projekt ist ein Ordner mit project.json; seine Chats liegen in chats/<id>/chat.json.
// Die Nachrichten selbst bleiben in OpenCode – hier liegen nur Zuordnung und Titel.
import { homedir } from "node:os";
import { join, dirname, relative } from "node:path";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";

export type Assignment = "manual" | "ki" | "auto" | null;
export interface Project { id: string; name: string; description: string; parentId: string | null; folder: string; created: number; pinned?: boolean; archived?: boolean }
export interface ChatMeta { id: string; title: string; projectId: string | null; assignedBy: Assignment; analyzed: boolean; created: number; updated: number }
export interface ProjectData { projects: Project[]; chats: ChatMeta[]; root: string }
export interface SessionInfo { id: string; title: string; updated?: number }

export const defaultProjectsDir = () => join(homedir(), ".jarvis3", "projects");
export const slug = (s: string) => s.replace(/ä/gi, "ae").replace(/ö/gi, "oe").replace(/ü/gi, "ue").replace(/ß/g, "ss")
  .normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "ordner";
const safe = slug;
const newId = () => randomBytes(6).toString("hex");
const readJson = <T>(path: string): T | undefined => {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
};
const writeJson = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
};

export class Projects {
  private projects = new Map<string, Project>();
  private chats = new Map<string, ChatMeta>();

  constructor(public root = defaultProjectsDir()) { mkdirSync(root, { recursive: true }); }

  load() {
    this.projects.clear(); this.chats.clear();
    const scan = (dir: string, parentId: string | null) => {
      const p = readJson<Project>(join(dir, "project.json"));
      let id: string | null = null;
      if (p?.id && p.folder && p.parentId === parentId && !this.projects.has(p.id)) {
        id = p.id;
        this.projects.set(id, { id, name: String(p.name ?? p.folder), description: String(p.description ?? ""),
          parentId, folder: safe(p.folder), created: Number(p.created) || Date.now(),
          ...(p.pinned ? { pinned: true } : {}), ...(p.archived ? { archived: true } : {}) });
      }
      this.readChats(join(dir, "chats"));
      for (const name of readdirSync(dir)) {
        const sub = join(dir, name);
        if (name === "chats" || !existsSync(join(sub, "project.json"))) continue;
        scan(sub, id);
      }
    };
    scan(this.root, null);
  }

  private readChats(dir: string) {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const c = readJson<ChatMeta>(join(dir, name, "chat.json"));
      if (!c?.id) continue;
      this.chats.set(c.id, { id: c.id, title: String(c.title ?? c.id), projectId: this.projects.has(String(c.projectId)) ? c.projectId : null,
        assignedBy: (["manual", "ki", "auto"].includes(String(c.assignedBy)) ? c.assignedBy : null) as Assignment,
        analyzed: !!c.analyzed, created: Number(c.created) || Date.now(), updated: Number(c.updated) || Date.now() });
    }
  }

  data(): ProjectData {
    return { projects: [...this.projects.values()].sort((a, b) => a.created - b.created),
      chats: [...this.chats.values()].sort((a, b) => b.updated - a.updated), root: relative(homedir(), this.root) };
  }
  project(id: string | null | undefined) { return id ? this.projects.get(id) : undefined; }
  chat(id: string) { return this.chats.get(id); }
  label(id: string | null) {
    const names: string[] = []; let p = this.project(id); const seen = new Set<string>();
    while (p && !seen.has(p.id)) { seen.add(p.id); names.unshift(p.name); p = this.project(p.parentId); }
    return names.join(" / ");
  }

  private pathOf(id: string | null): string {
    const chain: Project[] = []; const seen = new Set<string>();
    let p = this.project(id);
    while (p && !seen.has(p.id)) { seen.add(p.id); chain.unshift(p); p = this.project(p.parentId); }
    return join(this.root, ...chain.map(x => x.folder));
  }
  private chatDir(chat: ChatMeta) { return join(this.pathOf(chat.projectId), "chats", safe(chat.id)); }
  private saveProject(p: Project) { writeJson(join(this.pathOf(p.parentId), p.folder, "project.json"), p); }

  create(name: string, description = "", parentId: string | null = null): Project {
    const clean = String(name ?? "").trim();
    if (!clean) throw new Error("Projektname fehlt");
    if (parentId && !this.project(parentId)) throw new Error("Übergeordnetes Projekt nicht gefunden");
    const p: Project = { id: newId(), name: clean, description: String(description ?? "").trim(), parentId,
      folder: `${newId()}-${safe(clean)}`, created: Date.now() };
    this.projects.set(p.id, p);
    this.saveProject(p);
    return p;
  }

  update(id: string, patch: { name?: string; description?: string; parentId?: string | null; pinned?: boolean; archived?: boolean }): Project {
    const p = this.project(id);
    if (!p) throw new Error("Projekt nicht gefunden");
    const parent = "parentId" in patch ? patch.parentId ?? null : p.parentId;
    if (parent && !this.project(parent)) throw new Error("Übergeordnetes Projekt nicht gefunden");
    if (parent) { // kein Zyklus: Ziel darf kein Nachkomme sein
      let q = this.project(parent);
      while (q) { if (q.id === id) throw new Error("Ein Projekt kann nicht sein eigenes Unterprojekt werden"); q = this.project(q.parentId); }
    }
    if (parent !== p.parentId) {
      const from = this.pathOf(p.id), to = join(this.pathOf(parent), p.folder);
      mkdirSync(dirname(to), { recursive: true }); renameSync(from, to);
    }
    p.name = patch.name !== undefined && String(patch.name).trim() ? String(patch.name).trim() : p.name;
    p.description = patch.description !== undefined ? String(patch.description).trim() : p.description;
    p.parentId = parent;
    if (patch.pinned !== undefined) { if (patch.pinned) p.pinned = true; else delete p.pinned; }
    if (patch.archived !== undefined) { if (patch.archived) p.archived = true; else delete p.archived; }
    this.saveProject(p);
    return p;
  }

  remove(id: string): number {
    if (!this.project(id)) throw new Error("Projekt nicht gefunden");
    const doomed = new Set([id]); let grew = true;
    while (grew) { grew = false; for (const p of this.projects.values()) if (p.parentId && doomed.has(p.parentId) && !doomed.has(p.id)) { doomed.add(p.id); grew = true; } }
    let moved = 0;
    for (const c of this.chats.values()) if (c.projectId && doomed.has(c.projectId)) {
      this.moveChatDir(c, null); c.projectId = null; c.assignedBy = null; this.writeChat(c); moved++;
    }
    for (const pid of doomed) { rmSync(this.pathOf(pid), { recursive: true, force: true }); this.projects.delete(pid); }
    return moved;
  }

  private moveChatDir(c: ChatMeta, target: string | null) {
    const from = this.chatDir(c), old = c.projectId;
    c.projectId = target;
    const to = this.chatDir(c);
    if (from === to) { c.projectId = old; return; }
    mkdirSync(dirname(to), { recursive: true }); renameSync(from, to);
  }
  private writeChat(c: ChatMeta) { writeJson(join(this.chatDir(c), "chat.json"), c); }

  assign(chatId: string, projectId: string | null, by: Exclude<Assignment, null>): ChatMeta {
    const c = this.chat(chatId);
    if (!c) throw new Error("Chat nicht gefunden");
    if (projectId && !this.project(projectId)) throw new Error("Projekt nicht gefunden");
    if (c.projectId !== projectId) this.moveChatDir(c, projectId);
    c.assignedBy = by; c.analyzed = true; this.writeChat(c);
    return c;
  }

  upsertChat(s: SessionInfo): boolean {
    const updated = Number(s.updated) || Date.now();
    const c = this.chats.get(s.id);
    if (!c) {
      const n: ChatMeta = { id: s.id, title: s.title, projectId: null, assignedBy: null, analyzed: false, created: updated, updated };
      this.chats.set(n.id, n); this.writeChat(n); return true;
    }
    let changed = false;
    if (c.title !== s.title) { c.title = s.title; changed = true; }
    if (Math.abs(c.updated - updated) > 2000) { c.updated = updated; changed = true; }
    if (changed) this.writeChat(c);
    return changed;
  }

  markAnalyzed(chatId: string) {
    const c = this.chat(chatId);
    if (c && !c.analyzed) { c.analyzed = true; this.writeChat(c); }
  }
  resetAnalysis() {
    for (const c of this.chats.values()) if (!c.projectId && c.analyzed) { c.analyzed = false; this.writeChat(c); }
  }
}
