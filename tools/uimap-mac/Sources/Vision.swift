// Text lesen und Screenshots – nur bei Bedarf, damit die KI nicht dauernd Bilder braucht.
import AppKit
import ApplicationServices
import Vision

/// Sichtbarer Text eines Elements und seiner Kinder aus den Bedienungshilfen.
func axText(_ root: AXUIElement, limit: Int = 4000) -> String {
    var parts: [String] = []
    var pending = [root]
    var visited = 0
    var length = 0
    while let element = pending.popLast(), visited < 800, length < limit {
        visited += 1
        var role: CFTypeRef?
        AXUIElementCopyAttributeValue(element, "AXRole" as CFString, &role)
        if (role as? String) == "AXSecureTextField" { continue }
        for key in ["AXValue", "AXTitle", "AXDescription"] {
            var value: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success,
               let text = value as? String {
                let clean = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
                if !clean.isEmpty, parts.last != clean {
                    parts.append(clean)
                    length += clean.count
                }
                break
            }
        }
        var children: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, "AXChildren" as CFString, &children) == .success,
           let list = children as? [AXUIElement] {
            pending.append(contentsOf: list.reversed())
        }
    }
    let joined = parts.joined(separator: "\n")
    return joined.count > limit ? String(joined.prefix(limit)) + "…" : joined
}

func capture(_ rect: CGRect) throws -> (URL, CGImage) {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("uimap-\(UUID().uuidString.prefix(8)).png")
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    task.arguments = ["-x", "-R\(Int(rect.minX)),\(Int(rect.minY)),\(Int(rect.width)),\(Int(rect.height))", url.path]
    try task.run()
    task.waitUntilExit()
    guard task.terminationStatus == 0,
          let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw Failure(message: "Screenshot fehlgeschlagen (Bildschirmaufnahme-Freigabe?)")
    }
    return (url, image)
}

/// Texterkennung (Apple Vision, Deutsch + Englisch) in einem Bildschirmbereich.
func ocr(_ rect: CGRect) throws -> String {
    let (url, image) = try capture(rect)
    defer { try? FileManager.default.removeItem(at: url) }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["de-DE", "en-US"]
    request.usesLanguageCorrection = true
    try VNImageRequestHandler(cgImage: image).perform([request])
    let lines = (request.results ?? []).sorted {
        // oben nach unten, dann links nach rechts (Vision: Ursprung unten links)
        abs($0.boundingBox.midY - $1.boundingBox.midY) > 0.01
            ? $0.boundingBox.midY > $1.boundingBox.midY
            : $0.boundingBox.minX < $1.boundingBox.minX
    }
    return lines.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}

/// Screenshot als PNG; optional mit nummerierten Rahmen (Set-of-Marks) für Vision-Modelle.
func screenshot(_ rect: CGRect, marks: [Target], window: CGWindowID? = nil) throws -> String {
    let (url, image) = try window.map { try captureWindow($0) } ?? capture(rect)
    guard !marks.isEmpty else { return url.path }
    let scale = CGFloat(image.width) / rect.width
    guard let ctx = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8,
                              bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return url.path }
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    let graphics = NSGraphicsContext(cgContext: ctx, flipped: false)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = graphics
    let accent = NSColor(red: 0.26, green: 0.52, blue: 0.96, alpha: 1)
    for (id, t) in marks.enumerated() where t.rect.intersects(rect) {
        // CG-Bildschirmkoordinaten (oben links) -> Bildkoordinaten (unten links)
        let r = CGRect(x: (t.rect.minX - rect.minX) * scale,
                       y: CGFloat(image.height) - (t.rect.maxY - rect.minY) * scale,
                       width: t.rect.width * scale, height: t.rect.height * scale)
        accent.setStroke()
        let box = NSBezierPath(rect: r)
        box.lineWidth = 2 * scale
        box.stroke()
        let label = NSAttributedString(string: " \(id) ", attributes: [
            .font: NSFont.boldSystemFont(ofSize: 11 * scale), .foregroundColor: NSColor.white,
            .backgroundColor: accent
        ])
        label.draw(at: CGPoint(x: r.minX, y: r.maxY - label.size().height))
    }
    NSGraphicsContext.restoreGraphicsState()
    guard let marked = ctx.makeImage(),
          let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else { return url.path }
    CGImageDestinationAddImage(dest, marked, nil)
    CGImageDestinationFinalize(dest)
    return url.path
}
