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

// Vorspann: Figuren werden automatisch gespeichert (plt.show() blockiert nicht, sondern speichert), dunkles Design passend zur Oberfläche.
const PRELUDE = `
import os, sys, warnings
warnings.filterwarnings("ignore")
os.environ.setdefault("MPLBACKEND", "Agg")
try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.style.use("dark_background")
    plt.rcParams.update({"figure.facecolor": "#131314", "axes.facecolor": "#131314", "savefig.facecolor": "#131314",
        "figure.dpi": 110, "savefig.dpi": 160, "axes.grid": True, "grid.alpha": .18, "font.size": 11,
        "axes.edgecolor": "#444746", "axes.labelcolor": "#c4c7c5", "xtick.color": "#9a9b9c", "ytick.color": "#9a9b9c", "text.color": "#e3e3e3",
        "legend.frameon": False, "axes.spines.top": False, "axes.spines.right": False,
        "axes.prop_cycle": matplotlib.cycler(color=["#4fa0ff", "#d8627e", "#00a5b7", "#ffb74d", "#a975aa", "#6dd58c"])})
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

/** Führt Python-Code in einem eigenen Ordner aus und sammelt Bilder (Figuren, gespeicherte Dateien). */
export async function runPython(code: string, title = "Visualisierung"): Promise<Visual> {
  const id = newId(), dir = dirOf(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "skript.py"), code);
  writeFileSync(join(dir, ".run.py"), PRELUDE + "\nexec(compile(open('skript.py', encoding='utf-8').read(), 'skript.py', 'exec'))\n");
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
  const doc = /<html[\s>]/i.test(trimmed) ? trimmed
    : `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{color-scheme:dark}html,body{margin:0;background:#131314;color:#e3e3e3;font:15px/1.5 system-ui,-apple-system,sans-serif}body{padding:16px;box-sizing:border-box;min-height:100vh}</style>
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
