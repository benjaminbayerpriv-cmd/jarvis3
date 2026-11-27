// Eigenes Logo: Bild wählen, auf höchstens 256 px verkleinern und als PNG an den Daemon schicken (er prüft noch einmal streng).
export const LOGO_SIDE = 256;
export const MAX_FILE = 8 * 1024 * 1024;

/** Passt (w, h) in ein Quadrat mit Kantenlänge max, nie größer als das Original. */
export function fitSize(w, h, max = LOGO_SIDE) {
  if (!(w > 0) || !(h > 0)) return { width: 0, height: 0 };
  const k = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** Meldet einen Fehlertext oder "" wenn die Datei als Logo in Frage kommt. */
export function checkLogoFile(file) {
  if (!file) return "Keine Datei gewählt.";
  if (!/^image\//.test(file.type || "")) return "Das ist kein Bild.";
  if (file.size > MAX_FILE) return "Die Datei ist zu groß (höchstens 8 MB).";
  return "";
}

export const logoUrl = (host, version) => (version > 0 ? `http://${host}/logo?v=${version}` : "");

/** Datei → PNG als Base64 (ohne Präfix), verkleinert. Nur im Browser. */
export async function fileToLogoPng(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error("Das Bild konnte nicht gelesen werden.")); i.src = url; });
    const w = img.naturalWidth || img.width || LOGO_SIDE, h = img.naturalHeight || img.height || LOGO_SIDE;
    const { width, height } = fitSize(w, h);
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    canvas.getContext("2d").drawImage(img, 0, 0, width, height);
    const data = canvas.toDataURL("image/png").split(",")[1];
    if (!data) throw new Error("Das Bild konnte nicht umgewandelt werden.");
    return data;
  } finally { URL.revokeObjectURL(url); }
}
