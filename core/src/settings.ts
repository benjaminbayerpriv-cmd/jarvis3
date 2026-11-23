// Gemeinsame Einstellungen für alle Jarvis-Oberflächen dieses lokalen Daemons.
export const defaults = {
  model: "opencode/deepseek-v4.1-flash-free",
  voiceModel: "opencode/deepseek-v4.1-flash-free",
  mode: "browser" as "browser" | "computer",
  lofi: false,
  liveView: true,
  micDevice: null as number | null,
  micName: null as string | null,
  speakerDevice: null as number | null,
  speakerName: null as string | null,
  sttMode: "de" as "auto" | "de" | "en" | "fast",
  voicePreset: "M1",
  voiceSpeed: 1.25,
  spokenReplies: true,
  actionAnnouncements: true,
  previewAuto: true,
  previewIdleSeconds: 8,
  autoChatTitles: true,
  autoProjects: true,
  errorScreenshots: true,
  voiceLog: true,
  internalBrowser: true,
  haptics: true,
  hapticsClick: true,
  hapticsTool: true,
  hapticsType: true,
  hapticsStrength: "normal" as "soft" | "normal" | "strong",
};

export type Settings = typeof defaults;
type Patch = Partial<Settings>;
const nonempty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 250;
const device = (v: unknown): v is number | null => v === null || typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

export function parseSettings(input: unknown, stored = false): Patch {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const patch: Patch = {};
  const switches = ["lofi", "liveView", "spokenReplies", "actionAnnouncements", "previewAuto", "autoChatTitles",
    "autoProjects", "errorScreenshots", "voiceLog", "internalBrowser", "haptics", "hapticsClick", "hapticsTool", "hapticsType"] as const;
  for (const key of switches) if (typeof value[key] === "boolean") patch[key] = value[key];
  if (value.hapticsStrength === "soft" || value.hapticsStrength === "normal" || value.hapticsStrength === "strong") patch.hapticsStrength = value.hapticsStrength;
  if (nonempty(value.model)) patch.model = value.model;
  if (nonempty(value.voiceModel)) patch.voiceModel = value.voiceModel;
  if (value.mode === "browser" || value.mode === "computer") patch.mode = value.mode;
  if (value.sttMode === "auto" || value.sttMode === "de" || value.sttMode === "en" || value.sttMode === "fast")
    patch.sttMode = value.sttMode;
  for (const key of ["micDevice", "speakerDevice"] as const) if (device(value[key])) patch[key] = value[key];
  if (stored) {
    for (const key of ["micName", "speakerName"] as const) if (value[key] === null || nonempty(value[key])) patch[key] = value[key];
  }
  if (typeof value.voicePreset === "string" && /^[FM][1-5]$/.test(value.voicePreset)) patch.voicePreset = value.voicePreset;
  if (typeof value.voiceSpeed === "number" && value.voiceSpeed >= 0.5 && value.voiceSpeed <= 2) patch.voiceSpeed = value.voiceSpeed;
  if (typeof value.previewIdleSeconds === "number" && [5, 8, 15, 30, 60].includes(value.previewIdleSeconds))
    patch.previewIdleSeconds = value.previewIdleSeconds;
  return patch;
}
