import AppKit
import ScreenCaptureKit
import Vision

@available(macOS 14.0, *)
func scanScreenImage(displayID: CGDirectDisplayID, bounds: CGRect) async throws -> [Target] {
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    guard let display = content.displays.first(where: { $0.displayID == displayID }) else { return [] }
    let ownPID = ProcessInfo.processInfo.processIdentifier
    let ownApps = content.applications.filter { $0.processID == ownPID }
    let filter = SCContentFilter(display: display, excludingApplications: ownApps, exceptingWindows: [])
    let ratio = min(1.5, 2300 / max(bounds.width, bounds.height))
    let configuration = SCStreamConfiguration()
    configuration.width = Int(bounds.width * ratio)
    configuration.height = Int(bounds.height * ratio)
    configuration.showsCursor = false
    configuration.capturesAudio = false
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    return try detectVisualTargets(in: image, display: bounds)
}

func detectVisualTargets(in image: CGImage, display: CGRect) throws -> [Target] {
    let rectangleRequest = VNDetectRectanglesRequest()
    rectangleRequest.maximumObservations = 160
    rectangleRequest.minimumSize = 0.010
    rectangleRequest.minimumAspectRatio = 0.12
    rectangleRequest.minimumConfidence = 0.52
    rectangleRequest.quadratureTolerance = 14
    let ocr = VNRecognizeTextRequest()
    ocr.recognitionLevel = .accurate
    ocr.usesLanguageCorrection = true
    ocr.recognitionLanguages = ["de-DE", "en-US"]

    let handler = VNImageRequestHandler(cgImage: image)
    try handler.perform([rectangleRequest, ocr])

    func screenRect(_ normalized: CGRect) -> CGRect {
        CGRect(x: display.minX + normalized.minX * display.width,
               y: display.minY + (1 - normalized.maxY) * display.height,
               width: normalized.width * display.width, height: normalized.height * display.height)
    }

    let text = (ocr.results ?? []).compactMap { observation -> (CGRect, String)? in
        guard let reading = observation.topCandidates(1).first, reading.confidence >= 0.40 else { return nil }
        return (screenRect(observation.boundingBox), reading.string)
    }
    var targets: [Target] = []
    let grayImage = grayscalePixels(image)
    for observation in rectangleRequest.results ?? [] {
        let rect = screenRect(observation.boundingBox)
        guard (18...310).contains(rect.width), (15...68).contains(rect.height),
              rect.width >= rect.height * 0.75, !hasSimilarTarget(rect, in: targets) else { continue }

        let readings = text.filter { textRect, _ in
            rect.insetBy(dx: 2, dy: 1).contains(textRect) && textRect.height < rect.height * 0.82
        }
        if readings.isEmpty {
            // A compact, filled outline can be a button with an icon. Require a clear edge
            // so separators, text glyphs and other thin outlines produce fewer guesses.
            guard rect.width <= 72, rect.height >= 18,
                  let grayImage, hasFilledEdge(grayImage, rect: observation.boundingBox) else { continue }
        }
        let title = readings.sorted { $0.0.midX < $1.0.midX }.map(\.1).joined(separator: " ")
        targets.append(Target(rect: rect, label: title.isEmpty ? "Mögliche Taste" : String(title.prefix(100)),
                              enabled: true, kind: .visual))
    }
    return targets
}

private struct GrayImage {
    let bytes: [UInt8]
    let width: Int
    let height: Int

    func tone(x: CGFloat, y: CGFloat) -> Int {
        let column = min(width - 1, max(0, Int(x * CGFloat(width))))
        let row = min(height - 1, max(0, Int((1 - y) * CGFloat(height))))
        return Int(bytes[row * width + column])
    }
}

private func grayscalePixels(_ image: CGImage) -> GrayImage? {
    var bytes = [UInt8](repeating: 0, count: image.width * image.height)
    let drew = bytes.withUnsafeMutableBytes { buffer -> Bool in
        guard let context = CGContext(data: buffer.baseAddress, width: image.width, height: image.height,
                                      bitsPerComponent: 8, bytesPerRow: image.width,
                                      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: 0) else { return false }
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return true
    }
    return drew ? GrayImage(bytes: bytes, width: image.width, height: image.height) : nil
}

private func hasFilledEdge(_ image: GrayImage, rect: CGRect) -> Bool {
    let x = rect.width * 0.18
    let y = rect.height * 0.18
    let edgePairs = [
        (rect.midX, rect.maxY - y, rect.midX, rect.maxY + y),
        (rect.midX, rect.minY + y, rect.midX, rect.minY - y),
        (rect.maxX - x, rect.midY, rect.maxX + x, rect.midY),
        (rect.minX + x, rect.midY, rect.minX - x, rect.midY)
    ]
    let jumps = edgePairs.map { insideX, insideY, outsideX, outsideY in
        image.tone(x: insideX, y: insideY) - image.tone(x: outsideX, y: outsideY)
    }
    return jumps.filter { $0 >= 16 }.count >= 3 || jumps.filter { $0 <= -16 }.count >= 3
}
