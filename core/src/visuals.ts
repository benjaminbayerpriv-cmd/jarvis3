// Visualisierungen: Jarvis rechnet und zeichnet mit Python (matplotlib, numpy, …) oder baut eine HTML-Seite
// (Diagramme, Mermaid, Formeln, interaktive Grafiken). Ergebnisse liegen unter ~/.jarvis3/visuals/<id>/ und
// werden über jarvisd (/visual/<id>/<datei>) im Chat und in der Vorschau angezeigt.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

export const VISUALS = process.env.JARVIS_VISUALS ?? join(homedir(), ".jarvis3", "visuals");
export type Visual = { id: string; kind: "python" | "html"; title: string; files: string[]; created: number; stdout?: string; error?: string };

const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const SHOW = new Set([...IMAGE, ".html"]);
const PY_PACKAGES = ["numpy", "matplotlib", "pandas", "scipy", "sympy", "pillow"];
const TIMEOUT_MS = 90_000;

const newId = () => `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const dirOf = (id: string) => join(VISUALS, id);
export const validId = (id: string) => /^v[a-z0-9]{6,20}$/.test(id);

function save(v: Visual) { writeFileSync(join(dirOf(v.id), "meta.json"), JSON.stringify(v, null, 2)); return v; }
export function getVisual(id: string): Visual | undefined {
  if (!validId(id)) return;
  try { return JSON.parse(readFileSync(join(dirOf(id), "meta.json"), "utf8")); } catch { return; }
}
function outputs(dir: string) {
  return readdirSync(dir).filter(f => SHOW.has(extname(f).toLowerCase()) && !f.startsWith("."))
    .sort((a, b) => statSync(join(dir, a)).mtimeMs - statSync(join(dir, b)).mtimeMs);
}

// Hell oder dunkel: folgt der Darstellung der Oberfläche (setVisualTheme, gemeldet von der Oberfläche; Systemmodus eingeschlossen).
export type Theme = "dark" | "light";
let theme: Theme = "dark";
export const setVisualTheme = (t: Theme) => { theme = t; };
const PALETTE: Record<Theme, Record<string, string>> = {
  dark: { bg: "#131314", fg: "#e3e3e3", muted: "#9a9b9c", line: "#444746", accent: "#4fa0ff", accent2: "#d8627e", accent3: "#00a5b7", accent4: "#ffb74d", accent5: "#a975aa", accent6: "#6dd58c" },
  light: { bg: "#ffffff", fg: "#1f1f1f", muted: "#5f6368", line: "#dadce0", accent: "#1a73e8", accent2: "#d93a5e", accent3: "#009688", accent4: "#e37400", accent5: "#8e4ec6", accent6: "#1e8e3e" },
};
const cssVars = (t: Theme) => `:root{color-scheme:${t};${Object.entries(PALETTE[t]).map(([k, v]) => `--${k}:${v}`).join(";")}}`;

// Vorspann: Figuren werden automatisch gespeichert (plt.show() blockiert nicht, sondern speichert), Stil passend zur Oberfläche.
const prelude = (t: Theme) => {
  const c = PALETTE[t];
  return `
import os, sys, warnings
warnings.filterwarnings("ignore")
os.environ.setdefault("MPLBACKEND", "Agg")
try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.style.use(${t === "dark" ? '"dark_background"' : '"default"'})
    plt.rcParams.update({"figure.facecolor": "${c.bg}", "axes.facecolor": "${c.bg}", "savefig.facecolor": "${c.bg}",
        "figure.dpi": 110, "savefig.dpi": 160, "axes.grid": True, "grid.alpha": ${t === "dark" ? ".18" : ".28"}, "font.size": 11,
        "axes.edgecolor": "${c.line}", "axes.labelcolor": "${c.fg}", "xtick.color": "${c.muted}", "ytick.color": "${c.muted}", "text.color": "${c.fg}",
        "legend.frameon": False, "axes.spines.top": False, "axes.spines.right": False,
        "axes.prop_cycle": matplotlib.cycler(color=["${c.accent}", "${c.accent2}", "${c.accent3}", "${c.accent4}", "${c.accent5}", "${c.accent6}"])})
    _jarvis_saved = set()
    def _jarvis_save_all(*_a, **_k):
        for n in plt.get_fignums():
            if n in _jarvis_saved: continue
            plt.figure(n).savefig(f"figur_{n}.png", bbox_inches="tight")
            _jarvis_saved.add(n)
    plt.show = _jarvis_save_all
    import atexit; atexit.register(_jarvis_save_all)
except Exception:
    pass
`;
};

/** Führt Python-Code in einem eigenen Ordner aus und sammelt Bilder (Figuren, gespeicherte Dateien). */
export async function runPython(code: string, title = "Visualisierung"): Promise<Visual> {
  const id = newId(), dir = dirOf(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "skript.py"), code);
  writeFileSync(join(dir, ".run.py"), prelude(theme) + "\nexec(compile(open('skript.py', encoding='utf-8').read(), 'skript.py', 'exec'))\n");
  const uv = Bun.which("uv") ?? join(homedir(), ".local", "bin", "uv");
  const cmd = existsSync(uv)
    ? [uv, "run", "--quiet", "--no-project", "--python", "3.12", ...PY_PACKAGES.flatMap(p => ["--with", p]), "python", "-I", ".run.py"]
    : ["python3", "-I", ".run.py"];
  let stdout = "", error: string | undefined;
  try {
    const p = Bun.spawn(cmd, { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, MPLBACKEND: "Agg", PYTHONIOENCODING: "utf-8" } });
    const timer = setTimeout(() => p.kill(), TIMEOUT_MS);
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(timer);
    stdout = out.slice(-6000);
    if (code !== 0) error = (p.signalCode ? `Abgebrochen nach ${TIMEOUT_MS / 1000} s. ` : "") + (err.trim().split("\n").slice(-25).join("\n") || `Exit-Code ${code}`);
  } catch (e) { error = String((e as Error)?.message ?? e); }
  return save({ id, kind: "python", title: title.slice(0, 120), files: outputs(dir), created: Date.now(), stdout, error });
}

/** Speichert eine HTML-Seite (Diagramm, Formeln, interaktive Grafik). Ein reines SVG wird als Bild gespeichert. */
export function saveHtml(html: string, title = "Visualisierung"): Visual {
  const id = newId(), dir = dirOf(id);
  mkdirSync(dir, { recursive: true });
  const trimmed = html.trim();
  if (/^<svg[\s>]/i.test(trimmed)) {
    writeFileSync(join(dir, "bild.svg"), trimmed.includes("xmlns=") ? trimmed : trimmed.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"'));
    return save({ id, kind: "html", title: title.slice(0, 120), files: ["bild.svg"], created: Date.now() });
  }
  const base = `<style>${cssVars(theme)}</style>`;
  const doc = /<html[\s>]/i.test(trimmed)
    ? (/<head[^>]*>/i.test(trimmed) ? trimmed.replace(/<head[^>]*>/i, m => m + base) : trimmed.replace(/<html[^>]*>/i, m => m + base))
    : `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${base}<style>html,body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif}body{padding:16px;box-sizing:border-box;min-height:100vh}</style>
</head><body>${trimmed}</body></html>`;
  writeFileSync(join(dir, "index.html"), doc);
  return save({ id, kind: "html", title: title.slice(0, 120), files: ["index.html"], created: Date.now() });
}

const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".html": "text/html; charset=utf-8" };
// HTML-Visualisierungen laufen in einer abgeschotteten Sandbox (eigener Ursprung, kein Zugriff auf jarvisd);
// Bibliotheken dürfen von den üblichen CDNs kommen.
const CDNS = "https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://esm.sh https://cdn.plot.ly https://d3js.org";
const HTML_CSP = `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' ${CDNS}; style-src 'unsafe-inline' ${CDNS} https://fonts.googleapis.com; `
  + `img-src data: blob: ${CDNS}; font-src data: ${CDNS} https://fonts.gstatic.com; connect-src ${CDNS}; sandbox allow-scripts allow-popups`;

/** HTTP-Antwort für /visual/<id>/<datei> */
export function serveVisual(path: string): Response {
  const [, id, file] = path.match(/^\/visual\/([^/]+)\/([^/]+)$/) ?? [];
  if (!id || !validId(id) || !file || basename(file) !== file || file.startsWith(".")) return new Response("nicht gefunden", { status: 404 });
  const full = join(dirOf(id), decodeURIComponent(file));
  if (!existsSync(full)) return new Response("nicht gefunden", { status: 404 });
  const ext = extname(full).toLowerCase();
  const headers: Record<string, string> = { "content-type": TYPES[ext] ?? "application/octet-stream", "cache-control": "max-age=31536000, immutable",
    "access-control-allow-origin": "*" };
  if (ext === ".html" || ext === ".svg") headers["content-security-policy"] = ext === ".svg" ? "default-src 'none'; style-src 'unsafe-inline'; sandbox" : HTML_CSP;
  return new Response(Bun.file(full), { headers });
}

/** Kennung, mit der Werkzeugausgaben im Verlauf wiedergefunden werden (Chat zeigt die Visualisierung erneut an). */
export const MARKER = (id: string) => `[visual:${id}]`;
export const markers = (text: string) => [...String(text ?? "").matchAll(/\[visual:(v[a-z0-9]{6,20})\]/g)].map(m => m[1]);
