// uimap: Bildschirmmarker 1.0 als Werkzeug für Jarvis.
// Liefert sichtbare Bedienelemente als nummerierte JSON-Liste, damit die KI
// ohne Screenshot klicken und tippen kann.
//
//   uimap scan [--display N]      einmal scannen, JSON auf stdout
//   uimap serve [--display N]     JSON-Zeilen auf stdin:
//       {"cmd":"scan"} {"cmd":"click","id":3} {"cmd":"type","id":4,"text":"hallo"}
//       {"cmd":"scroll","id":2,"dy":-3} {"cmd":"focus","id":4} {"cmd":"displays"}
//   IDs gelten bis zum nächsten scan.
import AppKit
import ApplicationServices

struct Failure: Error { let message: String }

func displays() -> [NSScreen] { NSScreen.screens }

func displayRect(_ index: Int) -> CGRect {
    // CG-Koordinaten (Ursprung oben links am Hauptbildschirm) wie im Scanner.
    let screens = displays()
    let screen = screens.indices.contains(index) ? screens[index] : screens[0]
    let id = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
        ?? CGMainDisplayID()
    return CGDisplayBounds(id)
}

func pid(_ bundle: String) -> pid_t? {
    NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first?.processIdentifier
}

final class Session {
    var display = 0
    var targets: [Target] = []

    // Für die KI unwichtig: riesige Container und namenlose Gruppen/Texte.
    func useful(_ t: Target, _ screen: CGRect) -> Bool {
        if t.rect.width * t.rect.height > screen.width * screen.height * 0.35 { return false }
        let generic: Set<String> = ["Gruppe", "Text", "Bedienelement", "HTML-Inhalte", "Bild"]
        if ["AXGroup", "AXStaticText", "AXWebArea", "AXImage", "AXScrollArea", "AXUnknown"].contains(t.role),
           generic.contains(t.label) { return false }
        return true
    }

    func scanNow(all: Bool = false) -> [[String: Any]] {
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let screen = displayRect(display)
        targets = scan(display: screen, frontPID: front,
                       dockPID: pid("com.apple.dock"), menuExtrasPID: pid("com.apple.systemuiserver"))
        if !all { targets = targets.filter { useful($0, screen) } }
        return targets.enumerated().map { index, t in
            [
                "id": index,
                "role": kindName(t.kind),
                "axRole": t.role,
                "label": t.role == "AXSecureTextField" ? "Passwortfeld" : t.label,
                "rect": [Int(t.rect.minX), Int(t.rect.minY), Int(t.rect.width), Int(t.rect.height)],
                "enabled": t.enabled,
                "source": "ax"
            ]
        }
    }

    func target(_ id: Int?) throws -> Target {
        guard let id, targets.indices.contains(id) else { throw Failure(message: "unbekannte id, erst scan") }
        return targets[id]
    }

    func click(_ t: Target) -> String {
        if let element = t.element {
            var actions: CFArray?
            if AXUIElementCopyActionNames(element, &actions) == .success,
               let names = actions as? [String], names.contains("AXPress"),
               AXUIElementPerformAction(element, "AXPress" as CFString) == .success {
                return "ax-press"
            }
        }
        let point = CGPoint(x: t.rect.midX, y: t.rect.midY)
        for type in [CGEventType.leftMouseDown, .leftMouseUp] {
            CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)?
                .post(tap: .cghidEventTap)
            usleep(30_000)
        }
        return "mouse"
    }

    func focus(_ t: Target) -> Bool {
        guard let element = t.element else { return false }
        return AXUIElementSetAttributeValue(element, "AXFocused" as CFString, kCFBooleanTrue) == .success
    }

    func type(_ t: Target, _ text: String) throws -> String {
        // Harte Regel: niemals in Passwortfelder schreiben.
        if t.role == "AXSecureTextField" { throw Failure(message: "Passwortfelder sind gesperrt") }
        if let element = t.element,
           AXUIElementSetAttributeValue(element, "AXValue" as CFString, text as CFString) == .success {
            return "ax-value"
        }
        if !focus(t) { _ = click(t) }
        usleep(80_000)
        postText(text)
        return "keys"
    }

    func scroll(_ t: Target, _ dy: Int) {
        let point = CGPoint(x: t.rect.midX, y: t.rect.midY)
        CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?
            .post(tap: .cghidEventTap)
        CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: Int32(-dy), wheel2: 0, wheel3: 0)?
            .post(tap: .cghidEventTap)
    }

    func handle(_ request: [String: Any]) -> [String: Any] {
        do {
            switch request["cmd"] as? String {
            case "scan":
                if let d = request["display"] as? Int { display = d }
                let started = Date()
                let list = scanNow(all: request["all"] as? Bool ?? false)
                var reply: [String: Any] = ["ok": true, "targets": list, "ms": Int(Date().timeIntervalSince(started) * 1000)]
                if request["text"] as? Bool == true { reply["text"] = textList(list) }
                return reply
            case "click":
                return ["ok": true, "via": click(try target(request["id"] as? Int))]
            case "focus":
                return ["ok": focus(try target(request["id"] as? Int))]
            case "type":
                return ["ok": true, "via": try type(try target(request["id"] as? Int), request["text"] as? String ?? "")]
            case "scroll":
                scroll(try target(request["id"] as? Int), request["dy"] as? Int ?? 3)
                return ["ok": true]
            case "read":
                if let id = request["id"] as? Int {
                    let t = try target(id)
                    if t.role == "AXSecureTextField" { throw Failure(message: "Passwortfelder sind gesperrt") }
                    let ax = t.element.map { axText($0) } ?? ""
                    if !ax.isEmpty { return ["ok": true, "text": ax, "via": "ax"] }
                    return ["ok": true, "text": try ocr(t.rect), "via": "ocr"]
                }
                guard let r = request["rect"] as? [Int], r.count == 4 else { throw Failure(message: "id oder rect nötig") }
                return ["ok": true, "text": try ocr(CGRect(x: r[0], y: r[1], width: r[2], height: r[3])), "via": "ocr"]
            case "shot":
                var rect = displayRect(display)
                if let r = request["rect"] as? [Int], r.count == 4 { rect = CGRect(x: r[0], y: r[1], width: r[2], height: r[3]) }
                let path = try screenshot(rect, marks: request["marks"] as? Bool == true ? targets : [])
                return ["ok": true, "path": path, "rect": [Int(rect.minX), Int(rect.minY), Int(rect.width), Int(rect.height)]]
            case "typetext":
                // Text ohne Element-ID in das gerade fokussierte Feld schreiben (Rechner, Notizen, Suchfelder …)
                var focusedRef: CFTypeRef?
                if AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), "AXFocusedUIElement" as CFString, &focusedRef) == .success,
                   let focusedRef, CFGetTypeID(focusedRef) == AXUIElementGetTypeID() {
                    var roleRef: CFTypeRef?
                    let focused = focusedRef as! AXUIElement
                    if AXUIElementCopyAttributeValue(focused, "AXRole" as CFString, &roleRef) == .success,
                       (roleRef as? String) == "AXSecureTextField" { throw Failure(message: "Passwortfelder sind gesperrt") }
                }
                postText(request["text"] as? String ?? "")
                return ["ok": true, "via": "keys"]
            case "key":
                try pressCombo(request["combo"] as? String ?? "")
                return ["ok": true]
            case "displays":
                return ["ok": true, "displays": displays().indices.map { i in
                    let r = displayRect(i)
                    return ["index": i, "name": displays()[i].localizedName,
                            "rect": [Int(r.minX), Int(r.minY), Int(r.width), Int(r.height)]]
                }]
            case "trusted":
                return ["ok": true, "trusted": AXIsProcessTrusted()]
            default:
                return ["ok": false, "error": "unbekannter Befehl"]
            }
        } catch let failure as Failure {
            return ["ok": false, "error": failure.message]
        } catch {
            return ["ok": false, "error": "\(error)"]
        }
    }
}

func kindName(_ kind: Target.Kind) -> String {
    switch kind {
    case .field: return "field"
    case .link: return "link"
    case .control: return "control"
    }
}

// Kurzform für das Modell: "12 Button „Senden“ @640,812" (Mitte in Bildschirmpunkten).
func textList(_ list: [[String: Any]]) -> String {
    list.map { item in
        let r = item["rect"] as? [Int] ?? [0, 0, 0, 0]
        let role = (item["axRole"] as? String ?? "").replacingOccurrences(of: "AX", with: "")
        let off = (item["enabled"] as? Bool) == false ? " (aus)" : ""
        return "\(item["id"] ?? 0) \(role) „\(item["label"] ?? "")“ @\(r[0] + r[2] / 2),\(r[1] + r[3] / 2)\(off)"
    }.joined(separator: "\n")
}

func emit(_ object: [String: Any]) {
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

let args = Array(CommandLine.arguments.dropFirst())
let session = Session()
if let i = args.firstIndex(of: "--display"), args.indices.contains(i + 1), let d = Int(args[i + 1]) {
    session.display = d
}
_ = NSApplication.shared  // NSScreen braucht eine App-Instanz

if !AXIsProcessTrusted() {
    FileHandle.standardError.write(Data("uimap: Bedienungshilfen-Freigabe fehlt (Datenschutz & Sicherheit → Bedienungshilfen)\n".utf8))
}

switch args.first {
case "scan":
    let reply = session.handle(["cmd": "scan", "all": args.contains("--all"), "text": args.contains("--text")])
    if args.contains("--text") { print(reply["text"] as? String ?? "") } else { emit(reply) }
case "displays":
    emit(session.handle(["cmd": "displays"]))
case "serve":
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
              let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            emit(["ok": false, "error": "kein JSON"]); continue
        }
        var reply = session.handle(request)
        if let id = request["rid"] { reply["rid"] = id }
        emit(reply)
    }
default:
    FileHandle.standardError.write(Data("uimap scan|serve|displays [--display N]\n".utf8))
    exit(2)
}
