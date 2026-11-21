// Text, dessen Buchstaben einzeln unscharf erscheinen und scharf werden (Live-Untertitel, Diktat).
// set(text) vergleicht mit dem bisherigen Text: der gemeinsame Anfang bleibt unverändert stehen, nur neue Zeichen
// werden als <span class="bt in"> angehängt und animiert (CSS: .bt.in). Ohne animate erscheint alles sofort scharf.
export class BlurText {
  constructor(el) { this.el = el; this.text = ""; }
  set(text, { animate = true } = {}) {
    text = String(text ?? "");
    let i = 0;
    const n = Math.min(text.length, this.text.length);
    while (i < n && text[i] === this.text[i]) i++;
    while (this.el.childNodes.length > i) this.el.lastChild.remove();
    const frag = document.createDocumentFragment();
    for (let k = i; k < text.length; k++) {
      const s = document.createElement("span");
      s.className = animate ? "bt in" : "bt";
      s.textContent = text[k];
      frag.append(s);
    }
    this.el.append(frag);
    this.text = text;
  }
  clear() { this.set("", { animate: false }); }
}
