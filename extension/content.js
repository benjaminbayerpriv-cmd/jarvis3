(() => {
  "use strict";

  const roles = new Map([
    ["button", "Taste"], ["link", "Link"], ["checkbox", "Kontrollkästchen"],
    ["radio", "Auswahltaste"], ["switch", "Schalter"], ["tab", "Tab"],
    ["menuitem", "Menüeintrag"], ["menuitemcheckbox", "Menüeintrag"],
    ["menuitemradio", "Menüeintrag"], ["option", "Option"], ["slider", "Regler"],
    ["spinbutton", "Zahlenfeld"], ["scrollbar", "Scrollleiste"], ["treeitem", "Eintrag"],
    ["combobox", "Auswahlliste"], ["listbox", "Liste"], ["textbox", "Textfeld"],
    ["searchbox", "Suchfeld"]
  ]);
  const fields = new Set(["textbox", "searchbox", "combobox", "spinbutton", "listbox"]);
  const inputRoles = {
    button: "button", submit: "button", reset: "button", image: "button", file: "button",
    checkbox: "checkbox", radio: "radio", range: "slider", search: "searchbox",
    number: "spinbutton", color: "button"
  };
  const htmlRoles = { BUTTON: "button", A: "link", AREA: "link", TEXTAREA: "textbox",
    SELECT: "combobox", SUMMARY: "button", OPTION: "option" };
  const colors = { control: "#5cf0cb", field: "#ffcb59", link: "#c1b5ff",
    custom: "#ffadd1", disabled: "#c4c8d0" };

  function semanticRole(element) {
    if (element.tagName === "INPUT" && element.type === "hidden") return null;
    const role = element.getAttribute("role")?.trim().split(/\s+/).find(value => roles.has(value));
    if (role) return role;

    const tag = element.tagName;
    if (tag === "INPUT") return Object.hasOwn(inputRoles, element.type) ? inputRoles[element.type] : "textbox";
    if (tag === "A" || tag === "AREA") return element.hasAttribute("href") ? "link" : null;
    if (tag === "OPTION" && element.closest("select")?.size < 2) return null;
    if (tag === "SUMMARY" && element.parentElement?.tagName !== "DETAILS") return null;
    if (Object.hasOwn(htmlRoles, tag)) return htmlRoles[tag];
    if (element.hasAttribute("contenteditable") && element.isContentEditable) return "textbox";
    return null;
  }

  function parentOf(element) {
    return element.assignedSlot || element.parentElement || element.getRootNode().host || null;
  }

  function belongsTo(element, ancestor) {
    for (let current = element; current; current = parentOf(current)) {
      if (current === ancestor) return true;
    }
    return false;
  }

  function shortText(value) {
    const clean = value?.replace(/\s+/g, " ").trim() ?? "";
    return clean.length > 90 ? clean.slice(0, 89) + "…" : clean;
  }

  function itemName(element, role, custom) {
    const root = element.getRootNode();
    const references = (element.getAttribute("aria-labelledby") ?? "").trim().split(/\s+/);
    const referenced = references.map(id => root.getElementById?.(id) ?? document.getElementById(id));
    const labelledBy = shortText(referenced.map(node => node?.innerText || node?.textContent || "").join(" "));
    if (labelledBy) return labelledBy;
    const ariaLabel = shortText(element.getAttribute("aria-label"));
    if (ariaLabel) return ariaLabel;
    const nativeLabel = shortText(Array.from(element.labels ?? [], label => label.innerText).join(" "));
    if (nativeLabel) return nativeLabel;

    if (element.tagName === "INPUT") {
      if (["button", "submit", "reset"].includes(element.type)) {
        const value = shortText(element.value);
        if (value) return value;
        if (element.type === "submit") return "Absenden";
        if (element.type === "reset") return "Zurücksetzen";
      }
      const alt = shortText(element.getAttribute("alt"));
      if (alt) return alt;
    }
    const isField = fields.has(role);
    if (!isField) {
      const text = shortText(element.innerText);
      if (text) return text;
      const icon = element.querySelector("img[alt], svg[aria-label], svg > title");
      const iconName = shortText(icon?.getAttribute("alt") || icon?.getAttribute("aria-label") || icon?.textContent);
      if (iconName) return iconName;
    }
    return shortText(element.getAttribute("placeholder") || element.getAttribute("aria-placeholder"))
      || shortText(element.getAttribute("title")) || (custom ? "Klickbereich" : roles.get(role));
  }

  const host = document.createElement("web-bildschirmmarker-overlay");
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("popover", "manual");
  const shadow = host.attachShadow({ mode: "open" });
  const canvas = document.createElement("canvas");
  const style = document.createElement("style");
  style.textContent = `
    :host {
      all: initial !important;
      display: block !important;
      position: fixed !important;
      inset: 0 !important;
      width: auto !important;
      height: auto !important;
      margin: 0 !important;
      padding: 0 !important;
      border: 0 !important;
      background: transparent !important;
      box-shadow: none !important;
      z-index: 2147483647 !important;
      pointer-events: none !important;
      overflow: hidden !important;
    }
    canvas { display: block; width: 100%; height: 100%; pointer-events: none; }
  `;
  shadow.append(style, canvas);
  const context = canvas.getContext("2d");

  let enabled = false;
  let targets = [];
  let refreshTimer;
  let scanPending = true;
  let pointer = null;
  const roots = new Set();
  const observer = new MutationObserver(records => {
    if (records.some(record => record.target !== host && ![
      ...record.addedNodes, ...record.removedNodes
    ].some(node => node === host))) schedule(true);
  });

  function registerRoot(root) {
    if (roots.has(root)) return;
    roots.add(root);
    root.addEventListener("scroll", onLayout, { capture: true, passive: true });
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  }

  function nestedRoot(element) {
    return element.shadowRoot || (
      element instanceof HTMLElement ? chrome.dom?.openOrClosedShadowRoot(element) : null
    );
  }

  function scan() {
    const candidates = [];
    const activeRoots = new Set([document]);
    for (const root of activeRoots) {
      for (const element of root.querySelectorAll("*")) {
        if (element === host) continue;
        const inner = nestedRoot(element);
        if (inner) activeRoots.add(inner);
        const role = semanticRole(element);
        if (role || (element instanceof HTMLElement && element.getClientRects().length)) {
          candidates.push({ element, role });
        }
      }
    }

    if ([...roots].some(root => !activeRoots.has(root))) {
      observer.disconnect();
      for (const root of roots) root.removeEventListener("scroll", onLayout, true);
      roots.clear();
    }
    for (const root of activeRoots) registerRoot(root);
    targets = candidates;
  }

  function box(rect) {
    return { x: rect.left, y: rect.top, right: rect.right, bottom: rect.bottom };
  }

  function intersect(a, b) {
    return { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y),
      right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
  }

  function inside(point, rect) {
    return point && point.x >= rect.x && point.x < rect.right && point.y >= rect.y && point.y < rect.bottom;
  }

  function hitTarget(x, y) {
    let top = document.elementFromPoint(x, y);
    while (top) {
      const deeper = nestedRoot(top)?.elementFromPoint(x, y);
      if (!deeper || deeper === top) return top;
      top = deeper;
    }
    return null;
  }

  function uncover(rect, element, hitCache) {
    const fraction = [0.5, 0.2, 0.8];
    for (const px of fraction) {
      for (const py of fraction) {
        const x = rect.x + (rect.right - rect.x) * px;
        const y = rect.y + (rect.bottom - rect.y) * py;
        const key = Math.floor(x) + "," + Math.floor(y);
        if (!hitCache.has(key)) hitCache.set(key, hitTarget(x, y));
        if (belongsTo(hitCache.get(key), element)) return true;
      }
    }
    return false;
  }

  function locate(viewport) {
    const styleCache = new Map();
    const hitCache = new Map();
    const appearance = element => {
      if (!styleCache.has(element)) styleCache.set(element, getComputedStyle(element));
      return styleCache.get(element);
    };
    const visible = [];
    for (const { element, role } of targets) {
      let rect = intersect(viewport, box(element.getBoundingClientRect()));
      if (rect.right - rect.x < 3 || rect.bottom - rect.y < 3) continue;
      const appearanceOfElement = appearance(element);
      if (appearanceOfElement.visibility !== "visible") continue;

      let custom = false;
      if (!role) {
        const ancestor = parentOf(element);
        const hasClick = element.hasAttribute("onclick");
        const startsPointer = appearanceOfElement.cursor === "pointer"
          && (!ancestor || appearance(ancestor).cursor !== "pointer");
        if (!hasClick && !startsPointer) continue;
        if (element === document.body || element === document.documentElement) continue;
        custom = true;
      }

      let hidden = false;
      for (let ancestor = element; ancestor; ancestor = parentOf(ancestor)) {
        const computed = appearance(ancestor);
        if (computed.opacity === "0" || ancestor.inert) {
          hidden = true;
          break;
        }
        if (ancestor === element || ancestor === document.documentElement || ancestor === document.body) continue;
        if (computed.overflowX === "visible" && computed.overflowY === "visible") continue;
        const bounds = ancestor.getBoundingClientRect();
        const clip = {
          x: bounds.left + ancestor.clientLeft, y: bounds.top + ancestor.clientTop,
          right: bounds.left + ancestor.clientLeft + ancestor.clientWidth,
          bottom: bounds.top + ancestor.clientTop + ancestor.clientHeight
        };
        if (computed.overflowX === "visible") { clip.x = viewport.x; clip.right = viewport.right; }
        if (computed.overflowY === "visible") { clip.y = viewport.y; clip.bottom = viewport.bottom; }
        rect = intersect(rect, clip);
      }
      if (hidden || rect.right - rect.x < 3 || rect.bottom - rect.y < 3) continue;
      if (!uncover(rect, element, hitCache)) continue;

      const disabled = element.matches(":disabled, [aria-disabled='true']");
      const type = disabled ? "disabled" : custom ? "custom" : fields.has(role) ? "field" : role === "link" ? "link" : "control";
      visible.push({ rect, color: colors[type], custom, name: itemName(element, role, custom) });
    }
    return visible;
  }

  function draw() {
    if (!canvas.isConnected) return;
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (!width || !height) return;
    const scale = Math.min(2, devicePixelRatio || 1);
    const scaledWidth = Math.ceil(width * scale);
    const scaledHeight = Math.ceil(height * scale);
    if (canvas.width !== scaledWidth || canvas.height !== scaledHeight) {
      canvas.width = scaledWidth;
      canvas.height = scaledHeight;
    }
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, width, height);
    const items = locate({ x: 0, y: 0, right: width, bottom: height });
    const area = ({ rect }) => (rect.right - rect.x) * (rect.bottom - rect.y);
    items.sort((a, b) => Number(inside(pointer, b.rect)) - Number(inside(pointer, a.rect)) || area(a) - area(b));

    for (const item of [...items].reverse()) {
      const { x, y, right, bottom } = item.rect;
      context.beginPath();
      context.roundRect(x + 1, y + 1, right - x - 2, bottom - y - 2, 3);
      context.setLineDash([]);
      context.lineWidth = 3.4;
      context.strokeStyle = "rgba(8, 12, 18, .82)";
      context.stroke();
      context.setLineDash(item.custom ? [4, 3] : []);
      context.lineWidth = 1.4;
      context.strokeStyle = item.color;
      context.stroke();
    }

    const occupied = [];
    context.setLineDash([]);
    context.font = "600 11px system-ui, sans-serif";
    context.textBaseline = "middle";
    for (const { rect, name, color } of items) {
      const maxTextWidth = Math.min(width - 10, 218);
      if (maxTextWidth < 10) break;
      let caption = name;
      while (context.measureText(caption).width > maxTextWidth && caption.length > 2) {
        caption = caption.replace(/…$/, "").slice(0, -1) + "…";
      }
      const w = Math.ceil(context.measureText(caption).width) + 10;
      const h = 17;
      const x = Math.max(0, Math.min(rect.x, width - w));
      const right = Math.max(0, Math.min(rect.right + 2, width - w));
      const positions = [[x, rect.y - h - 2], [x, rect.bottom + 2],
        [right, rect.y], [x, Math.max(0, Math.min(height - h, rect.y + 2))]];
      const spot = positions.find(([left, top]) => top >= 0 && top + h <= height &&
        !occupied.some(a => left < a.x + a.w && left + w > a.x && top < a.y + a.h && top + h > a.y));
      if (!spot) continue;
      const [left, top] = spot;
      occupied.push({ x: left, y: top, w, h });
      context.beginPath();
      context.roundRect(left, top, w, h, 3);
      context.fillStyle = "rgba(9, 16, 23, .96)";
      context.fill();
      context.fillStyle = color;
      context.fillText(caption, left + 5, top + h / 2 + 0.5);
    }
  }

  function ensureOverlay() {
    const container = document.fullscreenElement || document.documentElement;
    if (host.parentNode !== container) {
      container.appendChild(host);
      if (!host.matches(":popover-open")) {
        try { host.showPopover(); } catch { /* The fixed overlay still works. */ }
      }
    }
  }

  function schedule(rescan = false) {
    if (!enabled) return;
    scanPending ||= rescan;
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      if (!enabled || document.hidden) return;
      ensureOverlay();
      if (scanPending) {
        scanPending = false;
        scan();
      }
      draw();
    }, 65);
  }

  function onLayout() { schedule(); }
  function onPageChange() { schedule(true); }
  function liftOverlay(event) {
    if (!enabled || event.target === host) return;
    if (event.type === "toggle" && event.newState === "open" && host.matches(":popover-open")) {
      // Keep annotations visible when a website opens its own popover or dialog.
      try { host.hidePopover(); host.showPopover(); } catch { /* Fixed overlay fallback. */ }
    }
    schedule(true);
  }

  document.addEventListener("visibilitychange", onPageChange);
  document.addEventListener("fullscreenchange", onPageChange);
  document.addEventListener("toggle", liftOverlay, true);
  document.addEventListener("transitionend", onLayout, true);
  window.addEventListener("resize", onLayout, { passive: true });
  const pageSize = new ResizeObserver(onLayout);
  pageSize.observe(document.documentElement);
  window.addEventListener("pointermove", event => {
    pointer = { x: event.clientX, y: event.clientY };
    onLayout();
  }, { passive: true });
  document.documentElement.addEventListener("pointerleave", () => {
    pointer = null;
    onLayout();
  }, { passive: true });

  function setEnabled(value) {
    enabled = value;
    if (enabled) {
      schedule(true);
      return;
    }
    host.remove();
    observer.disconnect();
    for (const root of roots) root.removeEventListener("scroll", onLayout, true);
    roots.clear();
    targets = [];
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.enabled) setEnabled(changes.enabled.newValue !== false);
  });
  chrome.storage.local.get({ enabled: true }).then(({ enabled }) => setEnabled(enabled));
})();
