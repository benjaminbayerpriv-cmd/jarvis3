// Einstellungen → Backend: OpenCode oder Hermes wählen; für Hermes Serveradresse, Server-Schlüssel, Modellanbieter und Modell.
// OpenCode verwaltet seine Anbieter selbst und zeigt hier nur seinen Zustand. Reine Oberfläche; Nachrichtenformen in backends.js.
// Sicherheit: Der Schlüssel liegt nur in einem Passwortfeld, geht nur in `backend_secret` an jarvisd und wird danach aus dem Feld
// gelöscht (auch beim Wechsel des Bereichs und beim Schließen). Er steht in keinem Attribut, keinem Speicher und keinem Protokoll.
import { BACKEND_IDS, BACKENDS, DEFAULT_SERVER_URL, KEY_STORAGE_NOTE, MODEL_URL_EXAMPLE, PROVIDER_KEY_NOTE, keyStatus, msgConfig, msgGet, msgSecret, msgSet, msgTest, normalizeBackendState, sameConfig, validateConfig } from "./backends.js";

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
};
const STATUS_TEXT = { ready: "Bereit", connecting: "Verbindet …", error: "Fehler", unsupported: "Nicht verfügbar" };
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

    const cfgd = meta.configurable;
    const empty = { serverUrl: "", provider: "", model: "", modelBaseUrl: "", modelSupportsVision: false };
    if (!cfgd) {
      f.info = el("p", { className: "be-result", id: `be-${id}-info`, textContent: "OpenCode verwaltet Anbieter, Modell und Zugänge selbst. Dieser Bereich speichert dafür nichts." });
      const card = el("section", { className: "be-card" }, head, el("div", { className: "be-body" }, f.info));
      card.dataset.backend = id; card.setAttribute("aria-label", `${meta.label}-Einstellungen`);
      return { id, card, f, draft: { ...empty }, baseline: { ...empty }, removeArmed: 0, testing: false, saving: false };
    }
    const secretInput = (name, placeholder) => {
      const i = el("input", { id: `be-${id}-${name}`, type: "password", name: `be-secret-${id}-${name}-${nameSuffix}`, autocomplete: "new-password", spellcheck: false, autocapitalize: "off", placeholder });
      for (const a of ["data-lpignore", "data-1p-ignore", "data-form-type"]) i.setAttribute(a, a === "data-form-type" ? "other" : "true");
      return i;
    };
    const urlInput = (name, placeholder) => el("input", { id: `be-${id}-${name}`, type: "text", name: `be-url-${name}-${id}`, spellcheck: false, autocomplete: "off", autocapitalize: "off", inputMode: "url", placeholder });
    f.serverUrl = urlInput("serverUrl", DEFAULT_SERVER_URL);
    f.urlHint = el("span", { className: "be-hint", id: `be-${id}-serverUrl-hint` });
    f.apiKey = secretInput("apiKey", "Neuen Server-Schlüssel eingeben");
    f.keyState = el("span", { className: "be-keystate", id: `be-${id}-apiKey-state`, role: "status" });
    f.keyRemove = el("button", { type: "button", className: "chip-btn", textContent: "Entfernen" });
    f.provider = el("select", { id: `be-${id}-provider`, name: `be-provider-${id}` });
    f.model = el("input", { id: `be-${id}-model`, type: "text", name: `be-model-${id}`, spellcheck: false, autocomplete: "off", autocapitalize: "off", placeholder: "hermes-agent" });
    f.modelBaseUrl = urlInput("modelBaseUrl", MODEL_URL_EXAMPLE);
    f.modelHint = el("span", { className: "be-hint", id: `be-${id}-modelBaseUrl-hint` });
    f.providerKey = secretInput("providerKey", "Neuen Modellanbieter-Schlüssel eingeben");
    f.providerKeyState = el("span", { className: "be-keystate", id: `be-${id}-providerKey-state`, role: "status" });
    f.providerKeyRemove = el("button", { type: "button", className: "chip-btn", textContent: "Entfernen" });
    f.vision = el("input", { id: `be-${id}-vision`, type: "checkbox", name: `be-vision-${id}` });
    f.save = el("button", { type: "button", className: "chip-btn be-primary", textContent: "Speichern" });
    f.test = el("button", { type: "button", className: "chip-btn", textContent: "Verbindung testen" });
    f.reset = el("button", { type: "button", className: "chip-btn", textContent: "Zurücksetzen" });
    f.result = el("p", { className: "be-result", role: "status", id: `be-${id}-result` });
    for (const k of ["serverUrl", "apiKey", "provider", "model", "modelBaseUrl", "providerKey", "vision"]) f[k].setAttribute("aria-describedby", `be-${id}-${k}-desc`);
    const body = el("div", { className: "be-body" },
      row(id, "serverUrl", "Hermes-Serveradresse", "Adresse des Hermes-Gateways (http:// oder https://), auch im Netzwerk. Auf diesem Rechner (127.0.0.1, [::1], localhost) startet und verwaltet Jarvis es selbst.", f.serverUrl, f.urlHint),
      row(id, "apiKey", "Hermes-Server-Schlüssel", KEY_STORAGE_NOTE, el("div", { className: "be-field" }, f.apiKey, f.keyRemove), f.keyState),
      row(id, "provider", "Modellanbieter in Hermes", "Ein in Hermes eingerichteter Anbieter; „OpenAI-kompatibler Modellserver“ nutzt die Modellserver-Adresse unten.", f.provider),
      row(id, "model", "Modell", "Modell dieses Anbieters. „hermes-agent“ verwendet die Hermes-Vorgabe.", f.model),
      row(id, "modelBaseUrl", "Modellserver-Adresse (optional)", "Getrennt von der Hermes-Serveradresse: OpenAI-kompatibler Server für lokale Modelle, auch im Heimnetz (LM Studio, Ollama, vLLM). Mit Adresse nutzt Hermes den Anbieter „custom“. Nur bei einem von Jarvis verwalteten Gateway.", f.modelBaseUrl, f.modelHint),
      row(id, "providerKey", "Modellanbieter-Schlüssel", PROVIDER_KEY_NOTE, el("div", { className: "be-field" }, f.providerKey, f.providerKeyRemove), f.providerKeyState),
      row(id, "vision", "Modell versteht Bilder", "Nur ankreuzen, wenn das gewählte Modell Bilder verarbeiten kann; dann werden Bilder an Hermes übergeben.", f.vision));
    const actions = el("div", { className: "be-actions" }, f.save, f.test, f.reset, f.result);
    const card = el("section", { className: "be-card" }, head, body, actions);
    card.dataset.backend = id;
    card.setAttribute("aria-label", `${meta.label}-Einstellungen`);

    const c = { id, card, f, draft: { ...empty }, baseline: { ...empty }, removeArmed: { server: 0, provider: 0 }, testing: false, saving: false };
    f.provider.onchange = () => { c.draft.provider = f.provider.value; update(c); };
    for (const k of ["model", "serverUrl", "modelBaseUrl"]) f[k].oninput = () => { c.draft[k] = f[k].value; update(c); };
    f.vision.onchange = () => { c.draft.modelSupportsVision = f.vision.checked; update(c); };
    f.providerKey.oninput = () => update(c);
    f.apiKey.oninput = () => update(c);
    f.save.onclick = () => save(c);
    f.test.onclick = () => test(c);
    f.reset.onclick = () => { c.draft = { ...c.baseline }; f.apiKey.value = ""; c.f.result.textContent = ""; fill(c); update(c); };
    f.keyRemove.onclick = () => removeKey(c, "server");
    f.providerKeyRemove.onclick = () => removeKey(c, "provider");
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
    if (!c.f.provider) return;
    providerOptions(c);
    c.f.model.value = c.draft.model;
    c.f.serverUrl.value = c.draft.serverUrl;
    c.f.modelBaseUrl.value = c.draft.modelBaseUrl;
    c.f.vision.checked = c.draft.modelSupportsVision === true;
  }

  function update(c) {
    const b = model.backends[c.id], f = c.f;
    const done = () => {
      f.status.textContent = STATUS_TEXT[b.status] ?? b.status;
      f.status.className = "ext-chip " + (b.status === "ready" ? "ok" : b.status === "error" ? "bad" : "");
      f.status.title = b.error || "";
      f.active.hidden = model.active !== c.id;
      c.card.classList.toggle("is-active", model.active === c.id);
      c.card.toggleAttribute("data-disabled", !supported);
    };
    if (!b.configurable) return done();
    const keyTyped = f.apiKey.value.length > 0, pKeyTyped = f.providerKey.value.length > 0;
    const v = validateConfig(c.draft);
    const dirty = !sameConfig(c.draft, c.baseline) || keyTyped || pKeyTyped;
    const locked = isBusy() && model.active === c.id;       // der Daemon lehnt Änderungen während eines Hermes-Laufs ab
    const enabled = supported && !c.saving && !locked;
    const external = !v.errors.serverUrl && !v.managed;       // fremdes Gateway: Modellserver und Anbieter-Schlüssel gehören dorthin
    for (const k of ["serverUrl", "apiKey", "provider", "model", "vision"]) f[k].disabled = !enabled;
    for (const k of ["modelBaseUrl", "providerKey"]) f[k].disabled = !enabled || external;
    f.save.disabled = !enabled || !dirty || !v.valid || (external && pKeyTyped);
    f.test.disabled = !supported || dirty || c.testing || !c.baseline.serverUrl || b.status === "unsupported";
    f.test.title = locked ? "Während eines laufenden Hermes-Laufs nicht änderbar." : dirty ? "Erst speichern, dann testen." : "";
    f.reset.disabled = !enabled || !dirty;
    for (const [rm, set] of [[f.keyRemove, b.keySet], [f.providerKeyRemove, b.providerKeySet]]) { rm.hidden = !set; rm.disabled = !enabled || (rm === f.providerKeyRemove && external); }
    f.keyState.textContent = keyTyped ? "Wird beim Speichern ersetzt." : keyStatus(b.keySet);
    f.keyState.dataset.set = String(b.keySet);
    f.providerKeyState.textContent = external ? "Bei einem fremden Gateway dort einrichten." : pKeyTyped ? "Wird beim Speichern ersetzt." : keyStatus(b.providerKeySet);
    f.providerKeyState.dataset.set = String(b.providerKeySet);
    const show = dirty || c.touched;      // Fehler erst zeigen, wenn der Nutzer etwas geändert hat
    for (const k of ["serverUrl", "provider", "model", "modelBaseUrl"]) f[k].setAttribute("aria-invalid", String(!!(show && v.errors[k])));
    const hint = (el, err, info) => { el.textContent = show && err ? err : info ?? ""; el.classList.toggle("bad", !!(show && err) || /^(Unverschlüsselt|Fremdes)/.test(String(info ?? ""))); };
    hint(f.urlHint, v.errors.serverUrl, locked ? "Gesperrt, solange Hermes antwortet." : v.hints.serverUrl);
    hint(f.modelHint, v.errors.modelBaseUrl, v.hints.modelBaseUrl);
    done();
    if (b.error && b.status === "error" && !f.result.textContent) f.result.textContent = b.error;
  }

  // ----- Aktionen -----
  function save(c) {
    const v = validateConfig(c.draft);
    c.touched = true;
    if (!v.valid) { update(c); return; }
    c.saving = true; c.f.result.textContent = "Speichert …"; c.f.result.className = "be-result";
    if (!sameConfig(c.draft, c.baseline)) send(msgConfig(c.id, c.draft));
    const key = c.f.apiKey.value;
    if (key) send(msgSecret(c.id, key, "server"));
    const pKey = c.f.providerKey.value;
    if (pKey) send(msgSecret(c.id, pKey, "provider"));
    c.f.apiKey.value = ""; c.f.providerKey.value = "";   // sofort aus den Feldern: die Schlüssel liegen nur noch in den gesendeten Nachrichten
    update(c);
  }
  function test(c) {
    c.testing = true; c.f.result.textContent = "Prüft die Verbindung …"; c.f.result.className = "be-result";
    send(msgTest(c.id)); update(c);
  }
  function removeKey(c, target) {
    const btn = target === "server" ? c.f.keyRemove : c.f.providerKeyRemove;
    if (!c.removeArmed[target]) { // zweiter Klick bestätigt
      c.removeArmed[target] = setTimeout(() => { c.removeArmed[target] = 0; btn.textContent = "Entfernen"; }, 4000);
      btn.textContent = "Wirklich entfernen?"; return;
    }
    clearTimeout(c.removeArmed[target]); c.removeArmed[target] = 0; btn.textContent = "Entfernen";
    send(msgSecret(c.id, null, target)); c.f.result.textContent = "Schlüssel wird entfernt …"; c.f.result.className = "be-result";
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
    if (act.status === "error") { banner.hidden = false; banner.className = "be-banner bad"; banner.textContent = `${act.label} ist nicht erreichbar${act.error ? `: ${act.error}` : "."} Prüfe Serveradresse und Server-Schlüssel.`; return; }
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
      if (!next.backends[id].configurable) continue;
      const dirty = !sameConfig(c.draft, c.baseline);
      c.baseline = { ...cfg };
      if (!dirty || initial) { c.draft = { ...cfg }; fill(c); } else providerOptions(c);
    }
  }

  // ----- Eingang von jarvisd -----
  function handle(m) {
    if (m.type === "backend") {
      supported = true; waiting = false; clearTimeout(waitTimer); switching = false;
      adopt(normalizeBackendState(m), { initial: !cards.get("hermes").touched });
      render();
    } else if (m.type === "backend_saved") {
      const c = cards.get(m.backend); if (!c?.f.save) return;
      c.saving = false;
      c.f.result.className = "be-result " + (m.ok ? "ok" : "bad");
      c.f.result.textContent = m.ok ? "Gespeichert." : `Nicht gespeichert${m.error ? `: ${String(m.error).slice(0, 300)}` : "."}`;
      if (m.ok) c.touched = false;
      if (!c.f.provider) return;
      update(c);
    } else if (m.type === "backend_test") {
      const c = cards.get(m.backend); if (!c?.f.test) return;
      c.testing = false;
      c.f.result.className = "be-result " + (m.ok ? "ok" : "bad");
      c.f.result.textContent = m.ok ? `Verbindung steht${Number.isFinite(m.latencyMs) ? ` (${Math.round(m.latencyMs)} ms)` : ""}.` : `Keine Verbindung${m.error ? `: ${String(m.error).slice(0, 300)}` : "."}`;
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
    for (const c of cards.values()) {
      if (!c.f.apiKey) continue;
      c.f.apiKey.value = ""; c.f.providerKey.value = "";
      for (const [t, btn] of [["server", c.f.keyRemove], ["provider", c.f.providerKeyRemove]]) { clearTimeout(c.removeArmed[t]); c.removeArmed[t] = 0; btn.textContent = "Entfernen"; }
    }
  }

  buildSegment();
  for (const id of BACKEND_IDS) { const c = buildCard(id); cards.set(id, c); host.append(c.card); fill(c); }
  render();
  return { handle, show, hide, get supported() { return supported; }, get active() { return model.active; } };
}
