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
    /// Fenster-Modus: Jarvis steuert genau dieses Fenster (auch verdeckt); nil = ganzer Monitor
    var window: WindowInfo?
    let streamer = WindowStreamer()
    func mark(_ point: CGPoint) { streamer.cursor = point }   // virtuelle Maus im Live-Bild

    // Für die KI unwichtig: riesige Container und namenlose Gruppen/Texte.
    func useful(_ t: Target, _ screen: CGRect) -> Bool {
        if t.kind == .text { return !t.label.isEmpty }
        if t.rect.width * t.rect.height > screen.width * screen.height * 0.35 { return false }
        let generic: Set<String> = ["Gruppe", "Text", "Bedienelement", "HTML-Inhalte", "Bild"]
        if ["AXGroup", "AXStaticText", "AXWebArea", "AXImage", "AXScrollArea", "AXUnknown"].contains(t.role),
           generic.contains(t.label) { return false }
        return true
    }

    func scanNow(all: Bool = false) throws -> [[String: Any]] {
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        var screen = displayRect(display)
        if let w = window {
            screen = w.bounds
            targets = try scanWindow(w)
        } else {
            targets = scan(display: screen, frontPID: front,
                           dockPID: pid("com.apple.dock"), menuExtrasPID: pid("com.apple.systemuiserver"))
        }
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
        if let w = window { clickInApp(w.pid, at: point); return "app-mouse" }   // echte Maus bleibt, wo sie ist
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
        if let w = window { typeInApp(w.pid, text); return "app-keys" }
        postText(text)
        return "keys"
    }

    func scroll(_ t: Target, _ dy: Int) {
        let point = CGPoint(x: t.rect.midX, y: t.rect.midY)
        if let w = window { scrollInApp(w.pid, at: point, dy: dy); return }
        CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?
            .post(tap: .cghidEventTap)
        CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: Int32(-dy), wheel2: 0, wheel3: 0)?
            .post(tap: .cghidEventTap)
    }

    func handle(_ request: [String: Any]) -> [String: Any] {
        do {
            switch request["cmd"] as? String {
            case "scan":
                if let d = request["display"] as? Int { display = d; window = nil }
                if let id = request["window"] as? Int { window = try windowInfo(CGWindowID(id)) }
                else if request["display"] != nil || request["window"] is NSNull { window = nil }
                let started = Date()
                let list = try scanNow(all: request["all"] as? Bool ?? false)
                var reply: [String: Any] = ["ok": true, "targets": list, "ms": Int(Date().timeIntervalSince(started) * 1000)]
                if request["text"] as? Bool == true { reply["text"] = textList(list) }
                return reply
            case "click":
                let t = try target(request["id"] as? Int); mark(CGPoint(x: t.rect.midX, y: t.rect.midY))
                return ["ok": true, "via": click(t), "point": [Int(t.rect.midX), Int(t.rect.midY)]]
            case "focus":
                return ["ok": focus(try target(request["id"] as? Int))]
            case "type":
                let t = try target(request["id"] as? Int); mark(CGPoint(x: t.rect.midX, y: t.rect.midY))
                return ["ok": true, "via": try type(t, request["text"] as? String ?? ""), "point": [Int(t.rect.midX), Int(t.rect.midY)]]
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
                var shotWindow: CGWindowID?
                if let id = request["window"] as? Int { let w = try windowInfo(CGWindowID(id)); rect = w.bounds; shotWindow = w.id }
                else if let w = window, request["rect"] == nil, request["display"] == nil { rect = w.bounds; shotWindow = w.id }
                if let r = request["rect"] as? [Int], r.count == 4 { rect = CGRect(x: r[0], y: r[1], width: r[2], height: r[3]); shotWindow = nil }
                let path = try screenshot(rect, marks: request["marks"] as? Bool == true ? targets : [], window: shotWindow)
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
                if let id = request["window"] as? Int { window = try windowInfo(CGWindowID(id)) }
                if let w = window { typeInApp(w.pid, request["text"] as? String ?? ""); return ["ok": true, "via": "app-keys", "window": Int(w.id)] }
                postText(request["text"] as? String ?? "")
                return ["ok": true, "via": "keys"]
            case "key":
                if let id = request["window"] as? Int { window = try windowInfo(CGWindowID(id)) }
                try pressCombo(request["combo"] as? String ?? "", pid: window?.pid)
                return ["ok": true]
            case "windows":
                let screens = displays().indices.map { displayRect($0) }
                return ["ok": true, "windows": listWindows().map { w in
                    ["id": Int(w.id), "app": w.app, "title": w.title, "pid": Int(w.pid), "onScreen": w.onScreen,
                     "display": screens.firstIndex(where: { $0.intersects(w.bounds) }) ?? -1,
                     "rect": [Int(w.bounds.minX), Int(w.bounds.minY), Int(w.bounds.width), Int(w.bounds.height)]] as [String: Any]
                }]
            case "stream_start":
                guard let id = request["window"] as? Int else { throw Failure(message: "window fehlt") }
                try streamer.start(try windowInfo(CGWindowID(id)), fps: request["fps"] as? Int ?? 20)
                return ["ok": true]
            case "stream_stop":
                streamer.stop()
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
    case .text: return "text"
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

private let emitLock = NSLock()
/// Ziel der Ausgabe: stdout (serve) oder der verbundene Client (capture-serve)
var outputFD: Int32 = STDOUT_FILENO
func emit(_ object: [String: Any]) {
    var data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
    data.append(Data("\n".utf8))
    emitLock.lock()
    data.withUnsafeBytes { raw in
        var offset = 0
        while offset < raw.count {
            let n = write(outputFD, raw.baseAddress! + offset, raw.count - offset)
            if n <= 0 { break }
            offset += n
        }
    }
    emitLock.unlock()
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
case "capture-serve":
    // Läuft als App-Bundle "Jarvis Bildschirm.app" mit eigener Bildschirmaufnahme-Freigabe (ScreenCaptureKit liefert
    // einem Kommandozeilenprogramm keine Bilder). Nur Aufnahme: stream_start/stream_stop/windowshot/cursor.
    let port = args.firstIndex(of: "--port").flatMap { args.indices.contains($0 + 1) ? UInt16(args[$0 + 1]) : nil } ?? 7779
    let server = socket(AF_INET, SOCK_STREAM, 0)
    var yes: Int32 = 1
    setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
    var address = sockaddr_in()
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = port.bigEndian
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(server, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
    guard bound == 0, listen(server, 4) == 0 else { FileHandle.standardError.write(Data("Port \(port) belegt\n".utf8)); exit(1) }
    signal(SIGPIPE, SIG_IGN)
    // Fehlt die Bildschirmaufnahme-Freigabe, zeigt macOS hiermit den Dialog bzw. trägt die App in die Liste ein.
    if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
    while true {
        let client = accept(server, nil, nil)
        if client < 0 { continue }
        outputFD = client
        let input = fdopen(client, "r")
        var line: UnsafeMutablePointer<CChar>?
        var capacity = 0
        while getline(&line, &capacity, input) > 0 {
            guard let text = line.map({ String(cString: $0) }), let data = text.data(using: .utf8),
                  let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            var reply: [String: Any]
            switch request["cmd"] as? String {
            case "windowshot":
                do {
                    guard let id = request["window"] as? Int else { throw Failure(message: "window fehlt") }
                    let image = try windowImage(CGWindowID(id))
                    let url = FileManager.default.temporaryDirectory.appendingPathComponent("uimap-win-\(UUID().uuidString.prefix(8)).png")
                    if let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) {
                        CGImageDestinationAddImage(dest, image, nil); CGImageDestinationFinalize(dest)
                    }
                    reply = ["ok": true, "path": url.path, "w": image.width, "h": image.height]
                } catch let f as Failure { reply = ["ok": false, "error": f.message] } catch { reply = ["ok": false, "error": "\(error)"] }
            case "cursor":
                if let p = request["point"] as? [Int], p.count == 2 { session.streamer.cursor = CGPoint(x: p[0], y: p[1]) }
                reply = ["ok": true]
            case "stream_start", "stream_stop":
                reply = session.handle(request)
            case "ping":
                reply = ["ok": true, "screen": CGPreflightScreenCaptureAccess()]
            default:
                reply = ["ok": false, "error": "Aufnahme-Dienst kennt nur windowshot, stream_start, stream_stop, cursor"]
            }
            if let id = request["rid"] { reply["rid"] = id }
            emit(reply)
        }
        session.streamer.stop()
        free(line)
        fclose(input)
        outputFD = STDOUT_FILENO
    }
default:
    FileHandle.standardError.write(Data("uimap scan|serve|capture-serve|displays [--display N]\n".utf8))
    exit(2)
}
