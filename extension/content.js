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

  const passwordFields = new WeakSet();

  function isPassword(element) {
    if (passwordFields.has(element)) return true;
    const masked = (element instanceof HTMLInputElement && element.type === "password")
      || /(?:^|\s)(?:current-password|new-password)(?:\s|$)/i.test(element.getAttribute("autocomplete") ?? "")
      || getComputedStyle(element).webkitTextSecurity !== "none";
    if (masked) passwordFields.add(element);
    return masked;
  }

  function itemName(element, role, custom) {
    if (isPassword(element)) return "Passwortfeld";
    const root = element.getRootNode();
    const references = (element.getAttribute("aria-labelledby") ?? "").trim().split(/\s+/);
    const referenced = references.map(id => root.getElementById?.(id) ?? document.getElementById(id));
    const labelledBy = shortText(referenced.map(node => node && !isPassword(node) ? readText(node) : "").join(" "));
    if (labelledBy) return labelledBy;
    const ariaLabel = shortText(element.getAttribute("aria-label"));
    if (ariaLabel) return ariaLabel;
    const nativeLabel = shortText(Array.from(element.labels ?? [], label => readText(label)).join(" "));
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
      const text = shortText(readText(element));
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
  const shadow = host.attachShadow({ mode: "closed" });
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
  let agentCursor = null;
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
    if (enabled) for (const root of activeRoots) registerRoot(root);
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

  function locate(viewport, all = false) {
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
      if (!all && !uncover(rect, element, hitCache)) continue;

      const disabled = element.matches(":disabled, [aria-disabled='true']");
      const type = disabled ? "disabled" : custom ? "custom" : fields.has(role) ? "field" : role === "link" ? "link" : "control";
      visible.push({ element, rect, role, enabled: !disabled, color: colors[type],
        custom, name: itemName(element, role, custom) });
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
    if (agentCursor) {
      const { x, y, active } = agentCursor;
      const time = performance.now() - agentCursor.started;
      const progress = Math.min(1, time / 420);
      const eased = 1 - Math.pow(1 - progress, 3);
      const px = agentCursor.fromX + (x - agentCursor.fromX) * eased;
      const py = agentCursor.fromY + (y - agentCursor.fromY) * eased;
      context.save();
      context.translate(px, py);
      context.shadowColor = "rgba(0, 0, 0, .55)";
      context.shadowBlur = 8;
      context.fillStyle = "#a78bfa";
      context.strokeStyle = "#fff";
      context.lineWidth = 1.6;
      context.beginPath();
      context.moveTo(0, 0);
      context.lineTo(0, 23);
      context.lineTo(6, 17);
      context.lineTo(11, 27);
      context.lineTo(15, 25);
      context.lineTo(10, 15);
      context.lineTo(19, 15);
      context.closePath();
      context.fill();
      context.stroke();
      if (active && time < 420) {
        context.beginPath();
        context.arc(5, 5, 7 + Math.min(time, 180) / 12, 0, Math.PI * 2);
        context.strokeStyle = `rgba(167, 139, 250, ${1 - Math.min(time, 420) / 420})`;
        context.lineWidth = 2;
        context.stroke();
      }
      context.restore();
      if (time < 450) schedule(false, 33); // setTimeout statt requestAnimationFrame: läuft auch im Hintergrund-Tab
      if (active && time > 550) { agentCursor.active = false; schedule(); }
    }
  }

  let capturePending = false;

  function ensureOverlay() {
    const container = document.fullscreenElement || document.documentElement;
    if (host.parentNode !== container) {
      container.appendChild(host);
      if (!host.matches(":popover-open")) {
        try { host.showPopover(); } catch { /* The fixed overlay still works. */ }
      }
    }
  }

  function schedule(rescan = false, delay = 65) {
    if (!enabled) return;
    scanPending ||= rescan;
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      // Der Jarvis-Cursor muss auch in Hintergrund-Tabs gezeichnet werden (dort ist document.hidden wahr).
      if (!enabled || capturePending || (document.hidden && !agentCursor)) return;
      ensureOverlay();
      if (scanPending) {
        scanPending = false;
        scan();
      }
      draw();
    }, delay);
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
    if (area === "local" && changes.enabled) setEnabled(changes.enabled.newValue === true);
  });
  chrome.storage.local.get({ enabled: false }).then(({ enabled }) => setEnabled(enabled));

  let commandTargets = new Map();
  const frameViewport = () => ({ x: 0, y: 0, right: innerWidth, bottom: innerHeight });
  const rectArray = ({ x, y, right, bottom }) => [x, y, right - x, bottom - y];
  const overlaps = (a, b) => Math.min(a.right, b.right) > Math.max(a.x, b.x)
    && Math.min(a.bottom, b.bottom) > Math.max(a.y, b.y);

  // Translate same-origin frame coordinates into the top-level CSS viewport.
  function placement() {
    let x = 0;
    let y = 0;
    let clip = frameViewport();
    try {
      for (let view = window; view !== view.top; view = view.parent) {
        const frame = view.frameElement;
        if (!frame || !frame.getClientRects().length) return null;
        const style = view.parent.getComputedStyle(frame);
        if (style.visibility !== "visible" || style.opacity === "0" || style.transform !== "none") return null;
        const bounds = frame.getBoundingClientRect();
        const dx = bounds.left + frame.clientLeft + parseFloat(style.paddingLeft);
        const dy = bounds.top + frame.clientTop + parseFloat(style.paddingTop);
        x += dx;
        y += dy;
        clip = intersect({ x: clip.x + dx, y: clip.y + dy, right: clip.right + dx, bottom: clip.bottom + dy },
          { x: 0, y: 0, right: view.parent.innerWidth, bottom: view.parent.innerHeight });
      }
    } catch {
      return null;
    }
    return { x, y, clip };
  }

  function isTextInput(element) {
    return element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement &&
      ["text", "email", "search", "password", "tel", "url", "number"].includes(element.type));
  }

  function readText(container, region, limit, skip) {
    if (container instanceof Element && isPassword(container)) return "";
    for (let ancestor = container instanceof Element ? container : null; ancestor; ancestor = parentOf(ancestor)) {
      if (getComputedStyle(ancestor).opacity === "0") return "";
    }
    const parts = [];
    const range = new Range();
    let length = 0;
    const append = value => {
      if (!value) return false;
      parts.push(limit === undefined ? value : value.slice(0, limit - length));
      length += value.length + 1;
      return limit !== undefined && length >= limit;
    };
    const activeRoots = new Set([container]);
    for (const root of activeRoots) {
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (node.nodeType === Node.TEXT_NODE) {
            return node.data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
          }
          if (node === host || skip?.(node) || node.matches("script, style, noscript, template, input[type=hidden]")
            || getComputedStyle(node).opacity === "0" || isPassword(node)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      for (let node = walk.nextNode(); node; node = walk.nextNode()) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const inner = nestedRoot(node);
          if (inner) activeRoots.add(inner);
          if ((region || limit !== undefined) && (isTextInput(node) || node instanceof HTMLSelectElement)
            && getComputedStyle(node).visibility === "visible"
            && node.getClientRects().length && (!region || overlaps(region, box(node.getBoundingClientRect())))) {
            if (append(node instanceof HTMLSelectElement ? node.selectedOptions[0]?.label : node.value)) {
              return parts.join(" ");
            }
          }
          continue;
        }
        const parent = node.parentElement;
        if (parent && (getComputedStyle(parent).visibility !== "visible" || parent.closest("textarea, select"))) continue;
        range.selectNodeContents(node);
        if ([...range.getClientRects()].some(bounds => bounds.width > 0 && bounds.height > 0
          && (!region || overlaps(region, box(bounds))))) {
          if (append(node.data.trim())) return parts.join(" ");
        }
      }
    }
    return parts.join(" ");
  }

  // Force links and forms to use this tab for the duration of native activation.
  function click(element) {
    const link = element.closest("a[href], area[href]");
    const form = element.closest("button, input")?.form;
    const submitter = form && element.closest("button, input");
    const attributes = link ? [[link, "target"]] : form ? [[form, "target"], [submitter, "formtarget"]] : [];
    let submitted = false;
    const onSubmit = () => { submitted = true; };
    form?.addEventListener("submit", onSubmit, true);
    const restore = targetThisTab(attributes);
    try {
      if (element instanceof HTMLElement) element.click();
      else element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
    } finally {
      restore();
      form?.removeEventListener("submit", onSubmit, true);
    }
    return Boolean(link) || submitted;
  }

  function targetThisTab(attributes) {
    const previous = attributes.map(([node, attribute]) => node.getAttribute(attribute));
    for (const [node, attribute] of attributes) node.setAttribute(attribute, "_self");
    return () => attributes.forEach(([node, attribute], index) => {
      if (node.getAttribute(attribute) !== "_self") return;
      if (previous[index] === null) node.removeAttribute(attribute);
      else node.setAttribute(attribute, previous[index]);
    });
  }

  function checkWritable(element) {
    if (isPassword(element)) throw new Error("Passwortfelder sind gesperrt");
    if (!element.isConnected || element.matches(":disabled, [aria-disabled='true']")
      || !(isTextInput(element) && !element.readOnly || element.isContentEditable)) {
      throw new Error("Element ist kein beschreibbares Textfeld");
    }
    if (element.isContentEditable && element.querySelector("input, [autocomplete], [contenteditable]")) {
      throw new Error("Das Textfeld enthält weitere Eingabefelder");
    }
  }

  function checkTypeFocus(element) {
    checkWritable(element);
    for (let current = element; current; current = current.getRootNode().host) {
      if (current.getRootNode().activeElement !== current) throw new Error("Textfeld hat den Fokus verloren");
    }
    for (let view = window; view !== view.top; view = view.parent) {
      if (view.parent.document.activeElement !== view.frameElement) throw new Error("Textfeld hat den Fokus verloren");
    }
  }

  function prepareType(element) {
    checkWritable(element);
    element.focus({ preventScroll: true });
    checkTypeFocus(element);
    if (isTextInput(element)) element.select();
    else {
      const selection = element.getRootNode().getSelection?.() ?? window.getSelection();
      const range = new Range();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    checkTypeFocus(element);
  }

  const formFor = element => element.form ?? element.closest("form");
  const submittersFor = form => [...form.getRootNode().querySelectorAll("button, input[type=submit], input[type=image]")]
    .filter(node => node.form === form && (node.type === "submit" || node.type === "image"));

  function submissionContent(element) {
    // Typing and opening or dismissing suggestions do not count as a result.
    const popupIds = ["aria-controls", "aria-owns"].flatMap(name => (element.getAttribute(name) ?? "").split(/\s+/));
    const text = readText(document.body ?? document, undefined, undefined, node =>
      node === element || node.matches('[role="listbox"], [role="option"]') || (node.id && popupIds.includes(node.id)));
    return JSON.stringify([location.href, document.title, text]);
  }

  let submission;
  function prepareSubmit(element) {
    checkTypeFocus(element);
    const form = formFor(element);
    const before = submissionContent(element);
    const restore = form && targetThisTab([[form, "target"], ...submittersFor(form).map(node => [node, "formtarget"])]);
    submission = { element, form, before, restore };
  }

  function finishEnter() {
    submission?.restore?.();
    if (submission) submission.restore = null;
  }

  function finishType() {
    finishEnter();
    submission = undefined;
  }
  window.addEventListener("pagehide", finishType);

  function submitProgress() {
    return { changed: Boolean(submission && submissionContent(submission.element) !== submission.before) };
  }

  function submitForm() {
    const { changed } = submitProgress();
    if (changed) return { changed };
    if (!submission) return { attempted: false };
    const { element, form } = submission;
    if (!form?.isConnected || !element.isConnected || formFor(element) !== form) return { attempted: false };
    checkWritable(element);
    const [submitter] = submittersFor(form);
    if (submitter?.matches(":disabled, [aria-disabled='true']")) return { attempted: false };
    const restore = targetThisTab(submitter ? [[form, "target"], [submitter, "formtarget"]] : [[form, "target"]]);
    try {
      HTMLFormElement.prototype.requestSubmit.call(form, submitter);
    } finally {
      restore();
    }
    return { attempted: true };
  }

  function scroll(element, dy) {
    const pixels = dy * 40;
    for (let node = element; node && node !== document.scrollingElement; node = parentOf(node)) {
      if (node.scrollHeight > node.clientHeight && /^(auto|scroll|overlay)$/.test(getComputedStyle(node).overflowY)) {
        node.scrollBy({ top: pixels, behavior: "instant" });
        return;
      }
    }
    window.scrollBy({ top: pixels, behavior: "instant" });
  }

  function describe(item) {
    const { element, role, enabled, name } = item;
    const password = isPassword(element);
    const category = password || fields.has(role) ? "field" : role === "link" ? "link" : "control";
    const axRoles = { button: "Button", link: "Link", textbox: "TextField", searchbox: "SearchField",
      checkbox: "CheckBox", radio: "RadioButton", combobox: "ComboBox", menuitem: "MenuItem" };
    const axRole = password ? "SecureTextField" : (axRoles[role] ?? (role ? role[0].toUpperCase() + role.slice(1) : "Unknown"));
    return { role: category, axRole: "AX" + axRole, label: name, enabled, source: "dom" };
  }

  function priority({ element, role, enabled, name }) {
    if (!enabled || isPassword(element)) return 7;
    if (role === "searchbox" || (fields.has(role) && /such|search/i.test(name))
      || (isTextInput(element) && element.closest("search, [role=search]"))) return 0;
    if (role === "textbox" || isTextInput(element)) return 1;
    const main = element.closest("main, [role=main]");
    const peripheral = element.closest("nav, footer, [role=navigation], [role=contentinfo], [role=banner]")
      || (!main && element.closest("header"));
    if (peripheral) return 6;
    if (role === "button" && (main || element.type === "submit" || element.type === "image")) return 2;
    if (role === "button" || fields.has(role)) return 3;
    return 4;
  }

  function handle(request) {
    const { cmd, id, dy } = request;
    if (cmd === "ready") return { loaded: document.readyState === "complete" };
    if (cmd === "finishType") {
      finishType();
      return {};
    }
    if (cmd === "finishEnter") {
      finishEnter();
      return {};
    }
    if (cmd === "submitProgress") return submitProgress();
    if (cmd === "submitForm") return submitForm();
    const frame = placement();
    if (cmd === "agentCursor") {
      const x = Math.max(0, Math.min(innerWidth, Number(request.x)));
      const y = Math.max(0, Math.min(innerHeight, Number(request.y)));
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Ungültige Cursorposition");
      const fromX = agentCursor?.x ?? pointer?.x ?? x;
      const fromY = agentCursor?.y ?? pointer?.y ?? y;
      agentCursor = { x, y, fromX, fromY, started: performance.now(), active: true };
      enabled = true;
      scanPending = false;
      ensureOverlay();
      draw();
      schedule(false, 33);
      return {};
    }
    if (cmd === "overlay") {
      capturePending = request.hide;
      if (capturePending) host.remove();
      else schedule(true);
      return {};
    }
    if (!frame) return { skipped: true };
    const translate = rect => intersect(frame.clip, {
      x: rect.x + frame.x, y: rect.y + frame.y, right: rect.right + frame.x, bottom: rect.bottom + frame.y
    });
    if (cmd === "scan" || cmd === "viewport") {
      scan();
      if (cmd === "viewport") {
        const passwords = targets.filter(({ element }) => isPassword(element))
          .map(({ element }) => translate(box(element.getBoundingClientRect())))
          .filter(rect => rect.x < rect.right && rect.y < rect.bottom).map(rectArray);
        const marks = [];
        if (request.marks?.length) {
          const byElement = new Map(request.marks.map(({ id, localId }) => [commandTargets.get(localId), id]));
          for (const item of locate(frameViewport())) {
            if (!byElement.has(item.element)) continue;
            const rect = translate(item.rect);
            if (rect.x < rect.right && rect.y < rect.bottom) marks.push({ id: byElement.get(item.element), rect: rectArray(rect) });
          }
        }
        return { rect: [0, 0, innerWidth, innerHeight], passwords, marks };
      }
      commandTargets = new Map();
      const items = [];
      for (const item of locate(frameViewport(), request.all === true)) {
        const rect = translate(item.rect);
        if (rect.x >= rect.right || rect.y >= rect.bottom) continue;
        const localId = items.length;
        commandTargets.set(localId, item.element);
        items.push({ localId, ...describe(item), priority: priority(item), rect: rectArray(rect) });
      }
      return { targets: items };
    }
    if (cmd === "read" && id === undefined) {
      if (request.rect === undefined) return { text: readText(document.body ?? document, undefined, request.limit) };
      const [x, y, width, height] = request.rect;
      const region = intersect(frame.clip, { x, y, right: x + width, bottom: y + height });
      const local = { x: region.x - frame.x, y: region.y - frame.y,
        right: region.right - frame.x, bottom: region.bottom - frame.y };
      return { text: region.x < region.right && region.y < region.bottom ? readText(document, local) : "" };
    }
    if (cmd === "wait") {
      return { found: readText(document).includes(request.for) };
    }
    if (cmd === "scroll" && id === undefined) {
      scroll(null, dy);
      return {};
    }
    const element = commandTargets.get(id);
    if (!element?.isConnected) throw new Error("Unbekannte oder abgelaufene ID. Erst scan ausführen.");
    if (["click", "type", "focus"].includes(cmd) && element.matches(":disabled, [aria-disabled='true']")) {
      throw new Error("Element ist deaktiviert");
    }
    switch (cmd) {
      case "click":
        // Native typing leaves transient activation that a site's click handler could use for popups.
        if (navigator.userActivation.isActive) return { activationPending: true };
        return { via: "dom", invalidates: click(element) };
      case "rect": {
        // Position des Elements im Koordinatensystem des obersten Fensters (für den Jarvis-Cursor)
        const r = translate(box(element.getBoundingClientRect()));
        return { rect: r.x < r.right && r.y < r.bottom ? rectArray(r) : null };
      }
      case "prepareType": prepareType(element); return {};
      case "prepareSubmit": prepareSubmit(element); return {};
      case "focus":
        element.focus({ preventScroll: true });
        if (element.getRootNode().activeElement !== element) throw new Error("Element ist nicht fokussierbar");
        return {};
      case "scroll": scroll(element, dy); return {};
      case "read":
        if (isPassword(element)) throw new Error("Passwortfelder sind gesperrt");
        return { text: isTextInput(element) ? element.value
          : element instanceof HTMLSelectElement ? element.selectedOptions[0]?.label ?? ""
          : element instanceof HTMLOptionElement ? element.label : readText(element) };
      default: throw new Error("Unbekannter Seitenbefehl");
    }
  }

  chrome.runtime.onMessage.addListener((request, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    try {
      reply({ ok: true, ...handle(request) });
    } catch (error) {
      reply({ ok: false, error: error.message });
    }
  });
})();
