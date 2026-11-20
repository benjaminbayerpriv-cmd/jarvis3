// OpenCode-Anbindung: Modellliste lesen und headless Server starten.
export type ModelGroup = "free" | "lmstudio" | "nvidia" | "other";
export interface ModelInfo { id: string; provider: string; group: ModelGroup; vision: boolean }

export function parseModels(stdout: string): ModelInfo[] {
  return stdout.split("\n").map(l => l.trim()).filter(l => l.includes("/")).map(id => {
    const provider = id.split("/")[0];
    const group: ModelGroup = id.endsWith("-free") || id === "opencode/big-pickle" ? "free"
      : provider === "lmstudio" ? "lmstudio" : provider === "nvidia" ? "nvidia" : "other";
    return { id, provider, group, vision: /(-vl|vision|gemma-4|paligemma)/.test(id) };
  });
}

export async function listModels(): Promise<ModelInfo[]> {
  const p = Bun.spawn(["opencode", "models"], { stdout: "pipe", stderr: "ignore" });
  return parseModels(await new Response(p.stdout).text());
}

export function startServer(port = 4096) {
  return Bun.spawn(["opencode", "serve", "--port", String(port), "--hostname", "127.0.0.1"],
    { stdout: "inherit", stderr: "inherit" });
}
