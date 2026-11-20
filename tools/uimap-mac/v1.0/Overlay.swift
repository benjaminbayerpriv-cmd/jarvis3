import AppKit

final class OverlayView: NSView {
    var targets: [Target] = [] { didSet { needsDisplay = true } }
    private var pointer: CGPoint = CGPoint(x: -1, y: -1)
    private var hovered: Int? {
        targets.indices.filter { targets[$0].rect.contains(pointer) }.min {
            targets[$0].rect.width * targets[$0].rect.height
                < targets[$1].rect.width * targets[$1].rect.height
        }
    }

    func updatePointer(_ point: CGPoint) {
        guard point != pointer else { return }
        let previous = hovered
        pointer = point
        if hovered != previous { needsDisplay = true }
    }
    var labels = true { didSet { needsDisplay = true } }
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    private func color(for target: Target) -> NSColor {
        guard target.enabled else { return NSColor(srgbRed: 0.73, green: 0.75, blue: 0.81, alpha: 1) }
        switch target.kind {
        case .field: return NSColor(srgbRed: 1, green: 0.80, blue: 0.35, alpha: 1)
        case .link: return NSColor(srgbRed: 0.70, green: 0.68, blue: 1, alpha: 1)
        case .control: return NSColor(srgbRed: 0.35, green: 0.95, blue: 0.82, alpha: 1)
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.clear.setFill()
        dirtyRect.fill(using: .copy)

        var placed: [CGRect] = []
        for target in targets.reversed() {
            let border = NSBezierPath(roundedRect: target.rect.insetBy(dx: 1, dy: 1), xRadius: 3, yRadius: 3)
            NSColor.black.withAlphaComponent(0.8).setStroke()
            border.lineWidth = 3.5
            border.stroke()
            color(for: target).setStroke()
            border.lineWidth = 1.5
            border.stroke()
        }
        guard labels else { return }
        let hovered = hovered
        var order = Array(targets.indices)
        if let hovered {
            order.remove(at: hovered)
            order.insert(hovered, at: 0)
        }
        for index in order {
            let target = targets[index]
            let ink = color(for: target)
            let retinaFont = NSFont.systemFont(ofSize: 10, weight: .semibold)
            let style = NSMutableParagraphStyle()
            style.lineBreakMode = .byTruncatingTail
            let attributes: [NSAttributedString.Key: Any] = [
                .font: retinaFont, .foregroundColor: ink, .paragraphStyle: style
            ]
            let text = target.label as NSString
            let width = min(210, bounds.width, ceil(text.size(withAttributes: attributes).width) + 10)
            let height: CGFloat = 16
            let x = min(max(0, target.rect.minX), bounds.width - width)
            let right = min(max(0, target.rect.maxX + 2), bounds.width - width)
            let candidates = [
                CGRect(x: x, y: target.rect.minY - height - 2, width: width, height: height),
                CGRect(x: x, y: target.rect.maxY + 2, width: width, height: height),
                CGRect(x: right, y: target.rect.minY, width: width, height: height),
                CGRect(x: x, y: max(0, min(bounds.height - height, target.rect.minY + 2)), width: width, height: height)
            ]
            guard let rect = candidates.first(where: { candidate in
                bounds.contains(candidate) && !placed.contains(where: { $0.intersects(candidate) })
            }) else { continue }
            placed.append(rect)
            NSColor(srgbRed: 0.05, green: 0.09, blue: 0.12, alpha: 0.96).setFill()
            NSBezierPath(roundedRect: rect, xRadius: 3, yRadius: 3).fill()
            text.draw(in: rect.insetBy(dx: 5, dy: 1), withAttributes: attributes)
        }
    }
}
