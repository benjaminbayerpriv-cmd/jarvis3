import AppKit
import ApplicationServices

struct Target {
    let rect: CGRect
    let label: String
    let enabled: Bool
    let kind: Kind

    enum Kind {
        case field, link, control
    }
}

func subtract(_ rect: CGRect, _ cover: CGRect) -> [CGRect] {
    let overlap = rect.intersection(cover)
    guard !overlap.isNull, !overlap.isEmpty else { return [rect] }
    return [
        CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: overlap.minY - rect.minY),
        CGRect(x: rect.minX, y: overlap.maxY, width: rect.width, height: rect.maxY - overlap.maxY),
        CGRect(x: rect.minX, y: overlap.minY, width: overlap.minX - rect.minX, height: overlap.height),
        CGRect(x: overlap.maxX, y: overlap.minY, width: rect.maxX - overlap.maxX, height: overlap.height)
    ].filter { !$0.isEmpty }
}

private struct OnscreenWindow {
    let pid: pid_t
    let bounds: CGRect
    let layer: Int
    let alpha: Double

    init?(_ info: [String: Any]) {
        guard let pid = info[kCGWindowOwnerPID as String] as? pid_t,
              let raw = info[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: raw as CFDictionary),
              let layer = info[kCGWindowLayer as String] as? Int,
              let alpha = info[kCGWindowAlpha as String] as? Double, alpha > 0.05,
              bounds.width > 2, bounds.height > 2 else { return nil }
        self.pid = pid
        self.bounds = bounds
        self.layer = layer
        self.alpha = alpha
    }
}

private func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success else {
        return nil
    }
    return value
}

private func attributes(_ element: AXUIElement, _ keys: [String]) -> [Any] {
    var values: CFArray?
    guard AXUIElementCopyMultipleAttributeValues(element, keys as CFArray, [], &values) == .success,
          let result = values as? [Any], result.count == keys.count else {
        return keys.map { attribute(element, $0) ?? kCFNull! }
    }
    return result
}

private func elementAttribute(_ element: AXUIElement, _ key: String) -> AXUIElement? {
    guard let value = attribute(element, key), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

private func frame(_ position: Any, _ size: Any) -> CGRect? {
    let pointValue = position as CFTypeRef
    let sizeValue = size as CFTypeRef
    guard CFGetTypeID(pointValue) == AXValueGetTypeID(), CFGetTypeID(sizeValue) == AXValueGetTypeID()
    else { return nil }
    var point = CGPoint.zero
    var dimensions = CGSize.zero
    guard AXValueGetValue(pointValue as! AXValue, .cgPoint, &point),
          AXValueGetValue(sizeValue as! AXValue, .cgSize, &dimensions),
          point.x.isFinite, point.y.isFinite, dimensions.width.isFinite, dimensions.height.isFinite,
          dimensions.width > 0, dimensions.height > 0 else { return nil }
    return CGRect(origin: point, size: dimensions)
}

private func windowFrame(_ element: AXUIElement) -> CGRect? {
    let values = attributes(element, ["AXPosition", "AXSize"])
    return frame(values[0], values[1])
}

private let fields: Set<String> = ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXSecureTextField"]
private let controls: Set<String> = [
    "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXMenuBarItem",
    "AXMenuItem", "AXSlider", "AXIncrementor", "AXDisclosureTriangle", "AXSwitch", "AXTab",
    "AXColorWell", "AXScrollBar", "AXSplitter", "AXDockItem", "AXCell", "AXLink"
]
private let actionable: Set<String> = ["AXPress", "AXPick", "AXShowMenu", "AXConfirm", "AXOpen"]
private let fallbackLabels: [String: String] = [
    "AXButton": "Taste", "AXCheckBox": "Kontrollkästchen", "AXRadioButton": "Auswahltaste",
    "AXSearchField": "Suchfeld", "AXTextField": "Textfeld", "AXTextArea": "Textbereich",
    "AXSecureTextField": "Passwortfeld", "AXComboBox": "Kombinationsfeld",
    "AXLink": "Link", "AXMenuItem": "Menüeintrag", "AXMenuBarItem": "Menü",
    "AXSlider": "Regler", "AXScrollBar": "Scrollleiste", "AXMenuButton": "Menü",
    "AXPopUpButton": "Auswahlmenü", "AXSwitch": "Schalter", "AXTab": "Tab",
    "AXCloseButton": "Schließen", "AXMinimizeButton": "Minimieren",
    "AXZoomButton": "Zoomen", "AXFullScreenButton": "Vollbild"
]

private func cleanLabel(_ value: Any) -> String? {
    guard let value = value as? String else { return nil }
    let words = value.split(whereSeparator: \.isWhitespace)
    let result = words.joined(separator: " ")
    guard !result.isEmpty else { return nil }
    return result.count > 100 ? String(result.prefix(99)) + "…" : result
}

private func label(_ element: AXUIElement, role: String) -> String {
    let values = attributes(element, [
        "AXTitle", "AXDescription", "AXPlaceholderValue", "AXTitleUIElement",
        "AXSubrole", "AXRoleDescription", "AXHelp"
    ])
    for value in values.prefix(3) {
        if let name = cleanLabel(value) { return name }
    }
    let title = values[3] as CFTypeRef
    if CFGetTypeID(title) == AXUIElementGetTypeID(),
       let text = attribute(title as! AXUIElement, "AXValue"),
       let name = cleanLabel(text) {
        return name
    }
    return (values[4] as? String).flatMap { fallbackLabels[$0] }
        ?? cleanLabel(values[6])
        ?? fallbackLabels[role]
        ?? cleanLabel(values[5])
        ?? "Bedienelement"
}

private func collect(
    _ root: AXUIElement, inside region: CGRect, coveredBy covers: [CGRect], deadline: TimeInterval
) -> [Target] {
    var pending = [(element: root, clip: region)]
    var visited = Set<AXUIElement>()
    var targets: [Target] = []

    while let node = pending.popLast(),
          visited.count < 3200, targets.count < 600,
          ProcessInfo.processInfo.systemUptime < deadline {
        guard visited.insert(node.element).inserted else { continue }
        let values = attributes(node.element, ["AXRole", "AXPosition", "AXSize", "AXEnabled", "AXHidden"])
        guard (values[4] as? Bool) != true else { continue }

        let role = values[0] as? String ?? ""
        let bounds = frame(values[1], values[2])
        var childClip = node.clip
        if let bounds, ["AXScrollArea", "AXWebArea", "AXList", "AXTable", "AXOutline"].contains(role) {
            childClip = childClip.intersection(bounds)
            if childClip.isEmpty || childClip.isNull { continue }
        }
        if role == "AXMenu", bounds == nil || bounds?.intersects(node.clip) == false { continue }

        if let bounds {
            let clipped = bounds.intersection(node.clip)
            if !clipped.isNull && clipped.width >= 3 && clipped.height >= 3 && role != "AXWindow" {
                let isField = fields.contains(role)
                var interactive = isField || controls.contains(role)
                if role == "AXCell" { interactive = false }
                if !interactive {
                    var actions: CFArray?
                    if AXUIElementCopyActionNames(node.element, &actions) == .success,
                       let names = actions as? [String] {
                        interactive = names.contains(where: actionable.contains)
                    }
                }
                if interactive {
                    let visible = covers.reduce([clipped]) { fragments, cover in
                        fragments.flatMap { subtract($0, cover) }
                    }
                    if visible.contains(where: { $0.width >= 3 && $0.height >= 3 }) {
                        let name = label(node.element, role: role)
                        for rect in visible where rect.width >= 3 && rect.height >= 3 {
                            targets.append(Target(
                                rect: rect, label: name, enabled: (values[3] as? Bool) != false,
                                kind: isField ? .field : (role == "AXLink" ? .link : .control)
                            ))
                        }
                    }
                }
            }
        }

        let childAttribute = ["AXList", "AXTable", "AXOutline"].contains(role) ? "AXVisibleChildren" : "AXChildren"
        let children = attribute(node.element, childAttribute) as? [AXUIElement]
            ?? (childAttribute == "AXChildren" ? [] : attribute(node.element, "AXChildren") as? [AXUIElement] ?? [])
        pending.append(contentsOf: children.reversed().map { ($0, childClip) })
    }
    return targets
}

func scan(display: CGRect, frontPID: pid_t?, dockPID: pid_t?, menuExtrasPID: pid_t?) -> [Target] {
    AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.08)
    let ownPID = ProcessInfo.processInfo.processIdentifier
    let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
    let windows = info.compactMap(OnscreenWindow.init).filter { $0.pid != ownPID && $0.bounds.intersects(display) }
    var output: [Target] = []
    var appWindows: [pid_t: [(AXUIElement, CGRect)]] = [:]
    var covers: [CGRect] = []
    var jobs: [(AXUIElement, CGRect, [CGRect])] = []
    let frameDeadline = ProcessInfo.processInfo.systemUptime + 0.50

    for window in windows where (0...8).contains(window.layer) {
        if ProcessInfo.processInfo.systemUptime >= frameDeadline || jobs.count >= 20 { break }
        let region = window.bounds.intersection(display)
        let visible = covers.reduce([region]) { fragments, cover in
            fragments.flatMap { subtract($0, cover) }
        }
        if !visible.isEmpty {
            if appWindows[window.pid] == nil {
                let app = AXUIElementCreateApplication(window.pid)
                let elements = attribute(app, "AXWindows") as? [AXUIElement] ?? []
                appWindows[window.pid] = elements.prefix(50).compactMap { element in
                    windowFrame(element).map { (element, $0) }
                }
            }
            if let index = appWindows[window.pid]?.firstIndex(where: { _, rect in
                abs(rect.minX - window.bounds.minX) <= 4 && abs(rect.minY - window.bounds.minY) <= 4
                    && abs(rect.width - window.bounds.width) <= 8 && abs(rect.height - window.bounds.height) <= 8
            }), let element = appWindows[window.pid]?.remove(at: index).0 {
                jobs.append((element, region, covers))
            }
        }
        if window.alpha >= 0.9 { covers.append(region) }
    }

    if let frontPID, frontPID != ownPID,
       let menu = elementAttribute(AXUIElementCreateApplication(frontPID), "AXMenuBar"),
       let bounds = windowFrame(menu), bounds.intersects(display) {
        jobs.append((menu, display, []))
    }
    if let dockPID {
        let app = AXUIElementCreateApplication(dockPID)
        let children = attribute(app, "AXChildren") as? [AXUIElement] ?? []
        for list in children.prefix(8) {
            if let bounds = windowFrame(list), bounds.intersects(display) {
                jobs.append((list, bounds.intersection(display), []))
            }
        }
    }
    if let menuExtrasPID,
       let extras = elementAttribute(AXUIElementCreateApplication(menuExtrasPID), "AXExtrasMenuBar"),
       let bounds = windowFrame(extras), bounds.intersects(display) {
        jobs.append((extras, display, []))
    }

    for (index, job) in jobs.enumerated() {
        let budget = index == 0 ? 0.48 : min(0.20, 0.85 / Double(max(1, jobs.count - 1)))
        output += collect(job.0, inside: job.1, coveredBy: job.2,
                          deadline: ProcessInfo.processInfo.systemUptime + budget)
    }
    var seen = Set<String>()
    return output.filter { target in
        let rect = target.rect.integral
        let key = "\(rect.minX),\(rect.minY),\(rect.width),\(rect.height),\(target.label)"
        return seen.insert(key).inserted
    }
}
