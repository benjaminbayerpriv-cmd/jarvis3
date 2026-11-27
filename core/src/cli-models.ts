// Modelllisten für Claude Code und Codex. Codex liefert seinen Katalog selbst (`codex debug models`, nur Text, kein Modellaufruf);
// Claude Code hat keinen Befehl dafür, hier stehen die Kurznamen und die bekannten Modell-IDs.
import type { CliKind } from "./cli-agents";

export type CliModel = { id: string; label: string; efforts?: string[] };

/** Denkaufwand-Stufen, die Claude Code (`--effort`) und Codex (`model_reasoning_effort`) kennen. Leer = Vorgabe des Programms. */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
export const ALL_EFFORTS = CODEX_EFFORTS;

export const CLAUDE_MODELS: CliModel[] = [
  { id: "sonnet", label: "Sonnet (aktuell)" }, { id: "opus", label: "Opus (aktuell)" }, { id: "haiku", label: "Haiku (aktuell)" },
  { id: "claude-fable-5-2", label: "Fable 5.2" }, { id: "claude-opus-5-5", label: "Opus 5.5" }, { id: "claude-sonnet-5-5", label: "Sonnet 5.5" }, { id: "claude-haiku-5-5", label: "Haiku 5.5" },
].map(m => ({ ...m, efforts: CLAUDE_EFFORTS }));

/** Sichtbare Modelle aus dem Katalog von `codex debug models`, nach Priorität sortiert. Unbrauchbare Einträge werden übersprungen. */
export function parseCodexCatalog(raw: string): CliModel[] {
  let data: any; try { data = JSON.parse(raw); } catch { return []; }
  const list: any[] = Array.isArray(data) ? data : Array.isArray(data?.models) ? data.models : [];
  return list.filter(m => m && typeof m.slug === "string" && /^[\w][\w.:/\-]*$/.test(m.slug) && m.visibility !== "hide")
    .sort((a, b) => (Number(a.priority) || 999) - (Number(b.priority) || 999))
    .map(m => ({ id: m.slug, label: typeof m.display_name === "string" && m.display_name ? m.display_name : m.slug,
      efforts: Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map((l: any) => l?.effort).filter((e: unknown) => typeof e === "string") : CODEX_EFFORTS }));
}

export async function loadCodexModels(bin = "codex", timeoutMs = 20_000): Promise<CliModel[]> {
  try {
    const p = Bun.spawn([bin, "debug", "models"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: process.env });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    const out = await new Response(p.stdout).text(); await p.exited; clearTimeout(timer);
    return parseCodexCatalog(out);
  } catch { return []; }
}

export const staticModels = (kind: CliKind): CliModel[] => kind === "claude" ? CLAUDE_MODELS : [];
export const effortsFor = (kind: CliKind) => kind === "claude" ? CLAUDE_EFFORTS : CODEX_EFFORTS;
