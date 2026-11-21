// Fenster-Steuerung wie bei Codex: ein bestimmtes Fenster wird gesteuert, ohne dass es vorne sein muss.
// - Bedienelemente und Texte kommen über die Bedienungshilfen (AX) direkt aus dem Fenster – auch wenn es verdeckt ist.
// - Klicks laufen zuerst über AXPress (kein Fokuswechsel, keine echte Maus). Sonst gehen Maus- und Tastenereignisse
//   per CGEvent.postToPid nur an dieses Programm: die echte Maus des Nutzers bewegt sich nicht ("virtuelle Maus").
// - Bilder kommen von der macOS-Bildschirmaufnahme (ScreenCaptureKit / screencapture -l) und zeigen den Fensterinhalt
//   auch, wenn andere Fenster davor liegen. Minimierte Fenster liefern kein Bild.
import AppKit
import ApplicationServices
import CoreImage
import ScreenCaptureKit
import Vision

struct WindowInfo {
    let id: CGWindowID
    let pid: pid_t
    let app: String
    let title: String
    let bounds: CGRect
    let onScreen: Bool
}

/// Alle normalen Programmfenster (Ebene 0), auch verdeckte und auf anderen Monitoren.
func listWindows() -> [WindowInfo] {
    let ownPID = ProcessInfo.processInfo.processIdentifier
    let info = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    return info.compactMap { entry -> WindowInfo? in
        guard (entry[kCGWindowLayer as String] as? Int) == 0,
              let id = entry[kCGWindowNumber as String] as? CGWindowID,
              let pid = entry[kCGWindowOwnerPID as String] as? pid_t, pid != ownPID,
              let raw = entry[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: raw), bounds.width >= 120, bounds.height >= 80,
              (entry[kCGWindowAlpha as String] as? Double ?? 1) > 0 else { return nil }
        let app = entry[kCGWindowOwnerName as String] as? String ?? "?"
        if ["Window Server", "Dock", "Control Center", "Kontrollzentrum", "Notification Center", "Mitteilungszentrale"].contains(app) { return nil }
        return WindowInfo(id: id, pid: pid, app: app, title: entry[kCGWindowName as String] as? String ?? "",
                          bounds: bounds, onScreen: entry[kCGWindowIsOnscreen as String] as? Bool ?? false)
    }
}

func windowInfo(_ id: CGWindowID) throws -> WindowInfo {
    guard let w = listWindows().first(where: { $0.id == id }) else {
        throw Failure(message: "Fenster \(id) gibt es nicht (mehr). desktop_windows zeigt die aktuellen Fenster.")
    }
    return w
}

/// Das AX-Fenster zu einem CGWindow: gleiche Position und Größe (wie im Bildschirm-Scan), sonst gleicher Titel,
/// sonst Fokus-/Hauptfenster, sonst Treffer in der Fenstermitte (nach oben bis zum AXWindow).
func axWindow(_ w: WindowInfo) -> AXUIElement? {
    let app = AXUIElementCreateApplication(w.pid)
    if requestAccessibility(app, pid: w.pid) { usleep(150_000) }
    let isWindow = { (e: AXUIElement) in (attribute(e, "AXRole") as? String) == "AXWindow" }
    let elements = (attribute(app, "AXWindows") as? [AXUIElement] ?? []).filter(isWindow)
    if let hit = elements.first(where: { element in
        guard let r = windowFrame(element) else { return false }
        return abs(r.minX - w.bounds.minX) <= 6 && abs(r.minY - w.bounds.minY) <= 6
            && abs(r.width - w.bounds.width) <= 10 && abs(r.height - w.bounds.height) <= 10
    }) { return hit }
    if !w.title.isEmpty, let hit = elements.first(where: { (attribute($0, "AXTitle") as? String) == w.title }) { return hit }
    for key in ["AXFocusedWindow", "AXMainWindow"] {
        if let e = elementAttribute(app, key), isWindow(e), let r = windowFrame(e), r.intersects(w.bounds) { return e }
    }
    var hit: AXUIElement?
    if AXUIElementCopyElementAtPosition(app, Float(w.bounds.midX), Float(w.bounds.midY), &hit) == .success {
        var e = hit
        for _ in 0..<60 { guard let cur = e else { break }; if isWindow(cur) { return cur }; e = elementAttribute(cur, "AXParent") }
    }
    return elements.count == 1 ? elements.first : nil
}

/// Texterkennung im Fensterbild: Zeilen mit Lage in Bildschirmkoordinaten (für Programme ohne Bedienbaum).
func ocrWindow(_ w: WindowInfo) throws -> [Target] {
    let (url, image) = try captureWindow(w.id)
    defer { try? FileManager.default.removeItem(at: url) }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["de-DE", "en-US"]
    request.usesLanguageCorrection = true
    try VNImageRequestHandler(cgImage: image).perform([request])
    return (request.results ?? []).compactMap { line -> Target? in
        guard let text = line.topCandidates(1).first?.string, !text.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        let b = line.boundingBox   // 0…1, Ursprung unten links
        let rect = CGRect(x: w.bounds.minX + b.minX * w.bounds.width, y: w.bounds.minY + (1 - b.maxY) * w.bounds.height,
                          width: b.width * w.bounds.width, height: b.height * w.bounds.height)
        return Target(rect: rect, label: text, enabled: true, kind: .text, role: "OCRText", element: nil)
    }.sorted { abs($0.rect.minY - $1.rect.minY) > 6 ? $0.rect.minY < $1.rect.minY : $0.rect.minX < $1.rect.minX }
}

/// Bedienelemente und Texte eines Fensters, ohne Rücksicht auf davorliegende Fenster.
func scanWindow(_ w: WindowInfo) throws -> [Target] {
    AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.08)
    var found = axWindow(w).map { collect($0, inside: w.bounds, coveredBy: [], deadline: ProcessInfo.processInfo.systemUptime + 1.2) } ?? []
    // Liefert das Programm (fast) nichts über die Bedienungshilfen, Text per Texterkennung aus dem Fensterbild lesen.
    // Diese Einträge sind trotzdem anklickbar (Klick geht als Mausereignis an das Programm).
    if found.filter({ $0.kind != .text }).count < 3 { found += (try? ocrWindow(w)) ?? [] }
    var seen = Set<String>()
    return found.filter { t in
        let r = t.rect.integral
        return seen.insert("\(r.minX),\(r.minY),\(r.width),\(r.height),\(t.label)").inserted
    }
}

/// Bild eines Fensters per ScreenCaptureKit (auch verdeckt; `screencapture -l` geht unter macOS 27 nicht mehr).
func windowImage(_ id: CGWindowID, maxWidth: CGFloat = 2400) throws -> CGImage {
    var result: Result<CGImage, Error> = .failure(Failure(message: "Fensterbild: keine Antwort"))
    let done = DispatchSemaphore(value: 0)
    Task {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let window = content.windows.first(where: { $0.windowID == id }) else {
                throw Failure(message: "Fenster \(id) ist für die Bildschirmaufnahme nicht sichtbar (minimiert?)")
            }
            let config = SCStreamConfiguration()
            let scale = min(2.0, maxWidth / max(1, window.frame.width))
            config.width = max(2, Int(window.frame.width * scale))
            config.height = max(2, Int(window.frame.height * scale))
            config.showsCursor = false
            let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window),
                                                                   configuration: config)
            result = .success(image)
        } catch { result = .failure(error) }
        done.signal()
    }
    if done.wait(timeout: .now() + 8) == .timedOut { throw Failure(message: "Fensterbild: Zeitüberschreitung (Bildschirmaufnahme-Freigabe?)") }
    switch result {
    case .success(let image): return image
    case .failure(let error): throw error is Failure ? error : Failure(message: "Fensterbild: \(error.localizedDescription)")
    }
}

/// Bild eines Fensters als PNG-Datei (für desktop_look und die Texterkennung).
func captureWindow(_ id: CGWindowID) throws -> (URL, CGImage) {
    let image: CGImage
    do { image = try windowImage(id) } catch {
        // ScreenCaptureKit braucht eine eigene Bildschirmaufnahme-Freigabe für ein App-Bundle (siehe docs). Bis dahin:
        // ein sichtbares Fenster als Bildschirmbereich aufnehmen (davorliegende Fenster wären mit im Bild).
        let w = try windowInfo(id)
        guard w.onScreen else { throw Failure(message: "Fenster \(id) ist verdeckt oder minimiert; ohne ScreenCaptureKit-Freigabe nur sichtbare Fenster aufnehmbar.") }
        return try capture(w.bounds)
    }
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("uimap-win-\(UUID().uuidString.prefix(8)).png")
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
        throw Failure(message: "Fensterbild konnte nicht gespeichert werden")
    }
    CGImageDestinationAddImage(dest, image, nil)
    CGImageDestinationFinalize(dest)
    return (url, image)
}

// ---------- Eingaben direkt an ein Programm (ohne Fokus, ohne echte Maus) ----------

func clickInApp(_ pid: pid_t, at point: CGPoint) {
    for type in [CGEventType.leftMouseDown, .leftMouseUp] {
        let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)
        e?.setIntegerValueField(.mouseEventClickState, value: 1)
        e?.postToPid(pid)
        usleep(30_000)
    }
}

func scrollInApp(_ pid: pid_t, at point: CGPoint, dy: Int) {
    let e = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: Int32(-dy), wheel2: 0, wheel3: 0)
    e?.location = point
    e?.postToPid(pid)
}

func typeInApp(_ pid: pid_t, _ text: String) {
    for scalar in text.utf16 {
        var unit = scalar
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
            e?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &unit)
            e?.postToPid(pid)
        }
        usleep(4_000)
    }
}

// ---------- Live-Bild eines Fensters (ScreenCaptureKit) ----------

/// Gibt Bildzeilen als {"event":"frame",...} auf stdout aus (zwischen den Antworten, eigene Zeilen).
final class WindowStreamer: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private let queue = DispatchQueue(label: "uimap.window-stream")
    private let ci = CIContext(options: [.useSoftwareRenderer: false])
    private(set) var windowID: CGWindowID = 0
    private var bounds = CGRect.zero
    private var title = ""
    private var app = ""
    private var lastSent = 0.0
    private var interval = 1.0 / 20
    /// zuletzt bedienter Punkt in Bildschirmkoordinaten – wird als virtuelle Maus ins Bild gemeldet
    var cursor: CGPoint?

    func start(_ w: WindowInfo, fps: Int) throws {
        stop()
        windowID = w.id; bounds = w.bounds; title = w.title; app = w.app
        interval = 1.0 / Double(max(5, min(30, fps)))
        var failure: Error?
        let done = DispatchSemaphore(value: 0)
        Task {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
                guard let window = content.windows.first(where: { $0.windowID == w.id }) else {
                    throw Failure(message: "Fenster \(w.id) ist für die Bildschirmaufnahme nicht sichtbar (minimiert?)")
                }
                let config = SCStreamConfiguration()
                let scale = min(2.0, 1600.0 / max(1, window.frame.width))
                config.width = max(2, Int(window.frame.width * scale))
                config.height = max(2, Int(window.frame.height * scale))
                config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(5, min(30, fps))))
                config.pixelFormat = kCVPixelFormatType_32BGRA
                config.showsCursor = false
                config.queueDepth = 4
                let stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: window), configuration: config, delegate: self)
                try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.queue)
                try await stream.startCapture()
                self.stream = stream
            } catch { failure = error }
            done.signal()
        }
        if done.wait(timeout: .now() + 8) == .timedOut { throw Failure(message: "Fenster-Aufnahme startet nicht (Bildschirmaufnahme-Freigabe?)") }
        if let failure { throw failure is Failure ? failure : Failure(message: "Fenster-Aufnahme: \(failure.localizedDescription)") }
    }

    func stop() {
        guard let stream else { return }
        self.stream = nil
        let done = DispatchSemaphore(value: 0)
        Task { try? await stream.stopCapture(); done.signal() }
        _ = done.wait(timeout: .now() + 2)
        emit(["event": "stream_ended", "window": Int(windowID)])
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        self.stream = nil
        emit(["event": "stream_ended", "window": Int(windowID), "reason": error.localizedDescription])
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, let pixels = sample.imageBuffer else { return }
        // Nur vollständige Bilder (ScreenCaptureKit schickt auch "idle"-Meldungen ohne neuen Inhalt)
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
           let raw = attachments.first?[.status] as? Int, let status = SCFrameStatus(rawValue: raw), status != .complete { return }
        let now = ProcessInfo.processInfo.systemUptime
        if now - lastSent < interval * 0.8 { return }
        lastSent = now
        let image = CIImage(cvPixelBuffer: pixels)
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let jpeg = ci.jpegRepresentation(of: image, colorSpace: space,
                                               options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.72]) else { return }
        let w = CVPixelBufferGetWidth(pixels), h = CVPixelBufferGetHeight(pixels)
        var frame: [String: Any] = ["event": "frame", "window": Int(windowID), "data": jpeg.base64EncodedString(),
                                    "w": w, "h": h, "title": title, "app": app,
                                    "bounds": [Int(bounds.minX), Int(bounds.minY), Int(bounds.width), Int(bounds.height)]]
        if let cursor, bounds.width > 0 {
            frame["cursor"] = [Int((cursor.x - bounds.minX) * CGFloat(w) / bounds.width),
                               Int((cursor.y - bounds.minY) * CGFloat(h) / bounds.height)]
        }
        emit(frame)
    }
}


// ---------- Virtuelle Maus im echten Fenster ----------
// Ein durchsichtiges, klickdurchlässiges Fenster mit dem violetten Jarvis-Zeiger. Es liegt über allem, nimmt keinen Fokus
// und wechselt keinen Bildschirm-Space. Der Zeiger gleitet zum Ziel, pulsiert beim Klick und verschwindet nach einer Weile.
final class CursorView: NSView {
    var ripple: CGFloat = 0
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        if ripple > 0 {
            ctx.setStrokeColor(NSColor(red: 0.655, green: 0.545, blue: 0.98, alpha: 1 - ripple).cgColor)
            ctx.setLineWidth(2.5)
            let r = 8 + ripple * 22
            ctx.strokeEllipse(in: CGRect(x: 6 - r + 8, y: 6 - r + 8, width: r * 2, height: r * 2))
        }
        let path = NSBezierPath()
        path.move(to: NSPoint(x: 6, y: 6)); path.line(to: NSPoint(x: 6, y: 29)); path.line(to: NSPoint(x: 12, y: 23))
        path.line(to: NSPoint(x: 17, y: 33)); path.line(to: NSPoint(x: 21, y: 31)); path.line(to: NSPoint(x: 16, y: 21))
        path.line(to: NSPoint(x: 25, y: 21)); path.close()
        ctx.saveGState()
        ctx.setShadow(offset: .zero, blur: 6, color: NSColor.black.withAlphaComponent(0.55).cgColor)
        NSColor(red: 0.655, green: 0.545, blue: 0.98, alpha: 1).setFill(); path.fill()
        ctx.restoreGState()
        NSColor.white.setStroke(); path.lineWidth = 1.6; path.stroke()
    }
}

final class CursorOverlay {
    private var panel: NSPanel?
    private let view = CursorView(frame: NSRect(x: 0, y: 0, width: 96, height: 96))
    private var hideTimer: Timer?

    /// point in Bildschirmkoordinaten (oben links, wie CoreGraphics)
    func show(at point: CGPoint, click: Bool) {
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        // Spitze des Zeigers liegt bei (6,6) im Bild; das Fenster so setzen, dass sie auf `point` sitzt
        let frame = NSRect(x: point.x - 6, y: primaryHeight - point.y - 90, width: 96, height: 96)
        let firstTime = panel == nil
        if firstTime {
            let p = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            p.isOpaque = false; p.backgroundColor = .clear; p.hasShadow = false
            p.level = .statusBar; p.ignoresMouseEvents = true; p.isReleasedWhenClosed = false
            p.hidesOnDeactivate = false
            p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
            p.contentView = view
            panel = p
        }
        guard let panel else { return }
        let wasHidden = firstTime || panel.alphaValue < 0.5
        if wasHidden { panel.setFrame(frame, display: true); panel.alphaValue = 1 }
        panel.orderFrontRegardless()
        if !wasHidden {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.35
                ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0, 0, 1)
                panel.animator().setFrame(frame, display: true)
            }
        }
        if click { pulse() }
        hideTimer?.invalidate()
        hideTimer = Timer.scheduledTimer(withTimeInterval: 4.0, repeats: false) { [weak self] _ in
            NSAnimationContext.runAnimationGroup({ $0.duration = 0.4; self?.panel?.animator().alphaValue = 0 })
        }
    }

    private func pulse() {
        view.ripple = 0.01
        Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { [weak self] timer in
            guard let self else { timer.invalidate(); return }
            self.view.ripple += 0.06
            if self.view.ripple >= 1 { self.view.ripple = 0; timer.invalidate() }
            self.view.needsDisplay = true
        }
    }

    func hide() { hideTimer?.invalidate(); panel?.animator().alphaValue = 0 }
}
