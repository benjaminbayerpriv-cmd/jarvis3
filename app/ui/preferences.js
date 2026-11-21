// Darstellungsoptionen gelten nur in dieser App bzw. in diesem Browserprofil.
const key = "jarvis.preferences";
const defaults = {
  theme: "system", textSize: "normal", reduceMotion: false, liveCaptions: true,
  showTools: true, showTiming: true, enterSends: true, showPreviewCursor: true,
};
const colorScheme = matchMedia("(prefers-color-scheme: dark)");
const motion = matchMedia("(prefers-reduced-motion: reduce)");
export const preferences = { ...defaults };

function valid(name, value) {
  if (name === "theme") return ["system", "dark", "light"].includes(value);
  if (name === "textSize") return ["small", "normal", "large"].includes(value);
  return Object.hasOwn(defaults, name) && typeof value === "boolean";
}
try {
  const stored = JSON.parse(localStorage.getItem(key) || "{}");
  for (const [name, value] of Object.entries(stored ?? {})) if (valid(name, value)) preferences[name] = value;
} catch {}

export const lessMotion = () => preferences.reduceMotion || motion.matches;

function apply() {
  const root = document.documentElement.dataset;
  root.theme = preferences.theme === "system" ? (colorScheme.matches ? "dark" : "light") : preferences.theme;
  root.chatTextSize = preferences.textSize;
  for (const name of ["liveCaptions", "showTools", "showTiming"]) root[name] = String(preferences[name]);
  root.reduceMotion = String(lessMotion());
}

export function setPreference(name, value) {
  if (!valid(name, value)) return;
  preferences[name] = value;
  try { localStorage.setItem(key, JSON.stringify(preferences)); } catch {}
  apply();
}

colorScheme.addEventListener("change", apply);
motion.addEventListener("change", apply);
apply();
