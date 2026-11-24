// Einstellungen → Backend: OpenCode oder Hermes wählen, je Backend Anbieter, Modell, Adresse und API-Schlüssel einstellen.
// Reine Oberfläche; die Nachrichtenformen stehen in backends.js (ANNAHME-BACKEND, bis core sie bestätigt).
// Sicherheit: Der Schlüssel liegt nur in einem Passwortfeld, geht nur in `backend_secret` an jarvisd und wird danach aus dem Feld
// gelöscht (auch beim Wechsel des Bereichs und beim Schließen). Er steht in keinem Attribut, keinem Speicher und keinem Protokoll.
import { BACKEND_IDS, BACKENDS, configOf, keyStatus, msgConfig, msgGet, msgSecret, msgSet, msgTest, normalizeBackendState, sameConfig, validateConfig } from "./backends.js";

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
};
const STATUS_TEXT = { ready: "Bereit", connecting: "Verbindet …", error: "Fehler", unsupported: "Nicht verfügbar" };
const NETWORK_TEXT = { lokal: "Dieser Rechner", heimnetz: "Heimnetz", extern: "Internet" };
const SUPPORT_WAIT_MS = 2500;

export function initBackendPanel({ root, send, isBusy = () => false }) {
  let model = normalizeBackendState(undefined);
  let supported = false, waiting = false, waitTimer = 0, switching = false;
  const cards = new Map();       // id -> { card, fields, draft, baseline, ... }
  const nameSuffix = Math.random().toString(36).slice(2, 8);

  const banner = root.querySelector("#beBanner"), seg = root.querySelector("#beSeg"), host = root.querySelector("#beCards");

  // ----- Aufbau -----
  function buildSegment() {
    seg.replaceChildren(...BACKEND_IDS.map(id => {
      const b = el("button", { type: "button", className: "be-seg-btn", id: `beSeg-${id}`, role: "radio", textContent: BACKENDS[id].label });
      b.dataset.backend = id;
      b.onclick = () => choose(id);
      b.onkeydown = e => {
        const i = BACKEND_IDS.indexOf(id), step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const next = BACKEND_IDS[(i + step + BACKEND_IDS.length) % BACKEND_IDS.length];
        seg.querySelector(`[data-backend="${next}"]`)?.focus();
        choose(next);
      };
      return b;
    }));
  }

  function row(id, name, label, description, control, extra) {
    const left = el("div", {}, el("label", { htmlFor: `be-${id}-${name}`, id: `be-${id}-${name}-label`, textContent: label }), el("p", { id: `be-${id}-${name}-desc`, textContent: description }));
    if (extra) left.append(extra);
    return el("div", { className: "setting be-row" }, left, control);
  }

  function buildCard(id) {
    const meta = BACKENDS[id];
    const f = {};
    const title = el("h4", { textContent: meta.label });
    f.status = el("span", { className: "ext-chip", role: "status" });
    f.active = el("span", { className: "ext-chip ok", textContent: "Aktiv", hidden: true });
    const head = el("div", { className: "be-head" }, el("div", { className: "be-title" }, title, el("p", { textContent: meta.tagline })), f.status, f.active);

    f.provider = el("select", { id: `be-${id}-provider`, name: `be-provider-${id}` });
    f.model = el("input", { id: `be-${id}-model`, type: "text", name: `be-model-${id}`, spellcheck: false, autocomplete: "off", autocapitalize: "off", placeholder: "Modellname" });
    f.models = el("datalist", { id: `be-${id}-models` });
    f.model.setAttribute("list", f.models.id);
    f.baseUrl = el("input", { id: `be-${id}-baseUrl`, type: "text", name: `be-url-${id}`, spellcheck: false, autocomplete: "off", autocapitalize: "off", inputMode: "url", placeholder: "http://192.168.1.20:11434/v1" });
    f.urlHint = el("span", { className: "be-hint", id: `be-${id}-baseUrl-hint` });
    f.network = el("span", { className: "ext-chip be-net", hidden: true });
    f.apiKey = el("input", { id: `be-${id}-apiKey`, type: "password", name: `be-secret-${id}-${nameSuffix}`, autocomplete: "new-password", spellcheck: false, autocapitalize: "off", placeholder: "Neuen Schlüssel eingeben" });
    for (const a of ["data-lpignore", "data-1p-ignore", "data-form-type"]) f.apiKey.setAttribute(a, a === "data-form-type" ? "other" : "true");
    f.keyState = el("span", { className: "be-keystate", id: `be-${id}-apiKey-state`, role: "status" });
    f.keyRemove = el("button", { type: "button", className: "chip-btn", textContent: "Entfernen" });
    f.save = el("button", { type: "button", className: "chip-btn be-primary", textContent: "Speichern" });
    f.test = el("button", { type: "button", className: "chip-btn", textContent: "Verbindung testen" });
    f.reset = el("button", { type: "button", className: "chip-btn", textContent: "Zurücksetzen" });
    f.result = el("p", { className: "be-result", role: "status", id: `be-${id}-result` });
    for (const k of ["provider", "model", "baseUrl", "apiKey"]) f[k].setAttribute("aria-describedby", `be-${id}-${k}-desc`);
    const urlWrap = el("div", { className: "be-field" }, f.baseUrl, f.network);
    const keyWrap = el("div", { className: "be-field" }, f.apiKey, f.keyRemove);
    const body = el("div", { className: "be-body" },
      row(id, "provider", "Anbieter", "Woher das Modell kommt.", f.provider),
      row(id, "model", "Modell", "Name des Modells beim Anbieter.", el("div", { className: "be-field" }, f.model, f.models)),
      row(id, "baseUrl", "Adresse", "Leer lassen für die Standardadresse des Anbieters. Für einen Rechner im Heimnetz die Adresse samt Port eintragen.", urlWrap, f.urlHint),
      row(id, "apiKey", "API-Schlüssel", "Wird verschlüsselt im Daemon gespeichert und nie wieder angezeigt.", keyWrap, f.keyState));
    const actions = el("div", { className: "be-actions" }, f.save, f.test, f.reset, f.result);
    const card = el("section", { className: "be-card" }, head, body, actions);
    card.dataset.backend = id;
    card.setAttribute("aria-label", `${meta.label}-Einstellungen`);

    const c = { id, card, f, draft: { provider: "", model: "", baseUrl: "" }, baseline: { provider: "", model: "", baseUrl: "" }, removeArmed: 0, testing: false, saving: false };
    f.provider.onchange = () => { providerChanged(c); update(c); };
    for (const k of ["model", "baseUrl"]) f[k].oninput = () => { c.draft[k] = f[k].value; update(c); };
    f.apiKey.oninput = () => update(c);
    f.save.onclick = () => save(c);
    f.test.onclick = () => test(c);
    f.reset.onclick = () => { c.draft = { ...c.baseline }; f.apiKey.value = ""; c.f.result.textContent = ""; fill(c); update(c); };
    f.keyRemove.onclick = () => removeKey(c);
    return c;
  }

  // ----- Daten → Felder -----
  function providerOptions(c) {
    const list = model.backends[c.id].providers;
    const keep = c.draft.provider;
    const items = list.some(p => p.id === keep) || !keep ? list : [...list, { id: keep, label: keep }];
    c.f.provider.replaceChildren(el("option", { value: "", textContent: "Anbieter wählen …" }), ...items.map(p => el("option", { value: p.id, textContent: p.label })));
    c.f.provider.value = keep;
  }
  function fill(c) {
    const b = model.backends[c.id];
    providerOptions(c);
    c.f.model.value = c.draft.model;
    c.f.baseUrl.value = c.draft.baseUrl;
    c.f.models.replaceChildren(...b.models.map(m => el("option", { value: m.id, label: m.label })));
  }
  function providerChanged(c) {
    const list = model.backends[c.id].providers;
    const prev = list.find(p => p.id === c.draft.provider), next = list.find(p => p.id === c.f.provider.value);
    c.draft.provider = c.f.provider.value;
    // Adresse mit der Voreinstellung des neuen Anbieters füllen, solange der Nutzer keine eigene eingetragen hat
    if (next && (!c.draft.baseUrl || c.draft.baseUrl === prev?.url)) { c.draft.baseUrl = next.url; c.f.baseUrl.value = next.url; }
  }

  function update(c) {
    const b = model.backends[c.id], f = c.f;
    const keyTyped = f.apiKey.value.length > 0;
    const v = validateConfig(c.id, c.draft, { keySet: b.keySet, keyTyped });
    const dirty = !sameConfig(c.draft, c.baseline) || keyTyped;
    const enabled = supported && !c.saving;
    for (const k of ["provider", "model", "baseUrl", "apiKey"]) { f[k].disabled = !enabled; }
    f.save.disabled = !enabled || !dirty || !v.valid;
    f.test.disabled = !supported || dirty || c.testing || !c.baseline.provider || b.status === "unsupported";
    f.test.title = dirty ? "Erst speichern, dann testen." : "";
    f.reset.disabled = !enabled || !dirty;
    f.keyRemove.hidden = !b.keySet;
    f.keyRemove.disabled = !enabled;
    f.keyState.textContent = keyTyped ? "Wird beim Speichern ersetzt." : keyStatus(b.keySet);
    f.keyState.dataset.set = String(b.keySet);
    const fieldError = (input, text) => { input.setAttribute("aria-invalid", String(!!text)); };
    const show = dirty || c.touched;      // Fehler erst zeigen, wenn der Nutzer etwas geändert hat
    fieldError(f.model, show && v.errors.model); fieldError(f.baseUrl, show && v.errors.baseUrl); fieldError(f.provider, show && v.errors.provider);
    f.urlHint.textContent = show && v.errors.baseUrl ? v.errors.baseUrl : v.hints.baseUrl ?? "";
    f.urlHint.classList.toggle("bad", !!(show && v.errors.baseUrl) || v.hints.baseUrl?.startsWith("Unverschlüsselt"));
    f.network.hidden = !v.hints.network; f.network.textContent = NETWORK_TEXT[v.hints.network] ?? "";
    f.network.classList.toggle("bad", v.hints.network === "extern" && /^http:/i.test(c.draft.baseUrl));
    // Status
    f.status.textContent = STATUS_TEXT[b.status] ?? b.status;
    f.status.className = "ext-chip " + (b.status === "ready" ? "ok" : b.status === "error" ? "bad" : "");
    f.status.title = b.error || "";
    f.active.hidden = model.active !== c.id;
    c.card.classList.toggle("is-active", model.active === c.id);
    c.card.toggleAttribute("data-disabled", !supported);
    if (b.error && b.status === "error" && !c.f.result.textContent) c.f.result.textContent = b.error;
  }

  // ----- Aktionen -----
  function save(c) {
    const v = validateConfig(c.id, c.draft, { keySet: model.backends[c.id].keySet, keyTyped: c.f.apiKey.value.length > 0 });
    c.touched = true;
    if (!v.valid) { update(c); return; }
    c.saving = true; c.f.result.textContent = "Speichert …"; c.f.result.className = "be-result";
    if (!sameConfig(c.draft, c.baseline)) send(msgConfig(c.id, c.draft));
    const key = c.f.apiKey.value;
    if (key) send(msgSecret(c.id, key));
    c.f.apiKey.value = "";           // sofort aus dem Feld: der Schlüssel liegt nur noch in der gesendeten Nachricht
    update(c);
  }
  function test(c) {
    c.testing = true; c.f.result.textContent = "Prüft die Verbindung …"; c.f.result.className = "be-result";
    send(msgTest(c.id)); update(c);
  }
  function removeKey(c) {
    if (!c.removeArmed) { // zweiter Klick bestätigt
      c.removeArmed = setTimeout(() => { c.removeArmed = 0; c.f.keyRemove.textContent = "Entfernen"; }, 4000);
      c.f.keyRemove.textContent = "Wirklich entfernen?"; return;
    }
    clearTimeout(c.removeArmed); c.removeArmed = 0; c.f.keyRemove.textContent = "Entfernen";
    send(msgSecret(c.id, null)); c.f.result.textContent = "Schlüssel wird entfernt …"; c.f.result.className = "be-result";
  }
  function choose(id) {
    if (!supported || model.active === id || switching) return;
    switching = true;
    banner.hidden = false; banner.className = "be-banner"; banner.textContent = `Wechsle zu ${BACKENDS[id].label} …`;
    send(msgSet(id));
    setTimeout(() => { if (switching) { switching = false; render(); } }, 6000);
  }

  // ----- Darstellung -----
  function renderSegment() {
    for (const b of seg.querySelectorAll(".be-seg-btn")) {
      const on = b.dataset.backend === model.active;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
      b.disabled = !supported;
    }
  }
  function renderBanner() {
    if (switching) return;
    if (!supported) {
      banner.hidden = false; banner.className = "be-banner warn";
      banner.textContent = waiting ? "Prüft, ob der Daemon den Backend-Wechsel kennt …"
        : "Dieser Daemon kennt den Backend-Wechsel noch nicht. OpenCode bleibt aktiv; die Felder sind gesperrt, bis die Backend-Schnittstelle von jarvisd verfügbar ist (docs/protocol.md).";
      return;
    }
    const act = model.backends[model.active];
    if (act.status === "error") { banner.hidden = false; banner.className = "be-banner bad"; banner.textContent = `${act.label} ist nicht erreichbar${act.error ? `: ${act.error}` : "."} Prüfe Adresse und Schlüssel.`; return; }
    if (isBusy()) { banner.hidden = false; banner.className = "be-banner"; banner.textContent = "Es läuft gerade eine Antwort. Ein Wechsel gilt für neue Nachrichten; laufende Chats bleiben bei ihrem Backend."; return; }
    banner.hidden = true;
  }
  function render() {
    renderSegment(); renderBanner();
    for (const c of cards.values()) update(c);
  }
  function adopt(next, { initial } = {}) {
    model = next;
    for (const id of BACKEND_IDS) {
      const c = cards.get(id), cfg = next.backends[id].config;
      const dirty = !sameConfig(c.draft, c.baseline);
      c.baseline = { ...cfg };
      if (!dirty || initial) { c.draft = { ...cfg }; fill(c); } else providerOptions(c);
    }
  }

  // ----- Eingang von jarvisd -----
  function handle(m) {
    if (m.type === "backend") {
      supported = true; waiting = false; clearTimeout(waitTimer); switching = false;
      adopt(normalizeBackendState(m), { initial: !cards.get("opencode").touched && !cards.get("hermes").touched });
      render();
    } else if (m.type === "backend_saved") {
      const c = cards.get(m.backend); if (!c) return;
      c.saving = false;
      c.f.result.className = "be-result " + (m.ok ? "ok" : "bad");
      c.f.result.textContent = m.ok ? "Gespeichert." : `Nicht gespeichert${m.error ? `: ${String(m.error).slice(0, 300)}` : "."}`;
      if (m.ok) c.touched = false;
      update(c);
    } else if (m.type === "backend_test") {
      const c = cards.get(m.backend); if (!c) return;
      c.testing = false;
      c.f.result.className = "be-result " + (m.ok ? "ok" : "bad");
      c.f.result.textContent = m.ok ? `Verbindung steht${Number.isFinite(m.latencyMs) ? ` (${Math.round(m.latencyMs)} ms)` : ""}.` : `Keine Verbindung${m.error ? `: ${String(m.error).slice(0, 300)}` : "."}`;
      if (m.ok && Array.isArray(m.models) && m.models.length) {
        const merged = normalizeBackendState({ active: model.active, backends: { [m.backend]: { ...model.backends[m.backend], models: m.models } } });
        model.backends[m.backend].models = merged.backends[m.backend].models; fill(c);
      }
      update(c);
    }
  }

  // ----- Öffnen / Schließen -----
  function show() {
    waiting = !supported; render();
    send(msgGet());
    if (!supported) {
      clearTimeout(waitTimer);
      waitTimer = setTimeout(() => { waiting = false; render(); }, SUPPORT_WAIT_MS);
    }
  }
  function hide() {
    clearTimeout(waitTimer);
    for (const c of cards.values()) { c.f.apiKey.value = ""; clearTimeout(c.removeArmed); c.removeArmed = 0; c.f.keyRemove.textContent = "Entfernen"; }
  }

  buildSegment();
  for (const id of BACKEND_IDS) { const c = buildCard(id); cards.set(id, c); host.append(c.card); fill(c); }
  render();
  return { handle, show, hide, get supported() { return supported; }, get active() { return model.active; } };
}
