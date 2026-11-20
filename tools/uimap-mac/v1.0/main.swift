import AppKit
import ApplicationServices

private extension NSScreen {
    var displayID: CGDirectDisplayID? {
        (deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
    }
}

final class OverlayPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class Controller: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let worker = DispatchQueue(label: "de.bildschirmmarker.scan", qos: .userInitiated)
    private let menu = NSMenu()
    private let view = OverlayView()
    private var status: NSStatusItem!
    private var panel: OverlayPanel!
    private var timer: Timer?
    private var hoverTimer: Timer?
    private var displayID: CGDirectDisplayID?
    private var generation = 0
    private var busy = false
    private var enabled = true

    func applicationDidFinishLaunching(_ notification: Notification) {
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        status.button?.image = NSImage(systemSymbolName: "viewfinder", accessibilityDescription: "Bildschirmmarker")
        status.button?.toolTip = "Bildschirmmarker"
        status.menu = menu
        menu.delegate = self
        panel = OverlayPanel(
            contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false
        )
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.contentView = view

        NotificationCenter.default.addObserver(
            self, selector: #selector(displaysChanged), name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(workspaceChanged), name: NSWorkspace.activeSpaceDidChangeNotification,
            object: nil
        )
        timer = Timer.scheduledTimer(withTimeInterval: 0.65, repeats: true) { [weak self] _ in self?.refresh() }
        hoverTimer = Timer.scheduledTimer(withTimeInterval: 0.10, repeats: true) { [weak self] _ in
            guard let self, self.panel.isVisible else { return }
            let mouse = self.panel.convertPoint(fromScreen: NSEvent.mouseLocation)
            self.view.updatePointer(self.view.convert(mouse, from: nil))
        }
        displaysChanged()
    }

    @objc private func displaysChanged() {
        let saved = UserDefaults.standard.object(forKey: "DisplayID") as? NSNumber
        displayID = NSScreen.screens.first(where: { $0.displayID == saved?.uint32Value })?.displayID
            ?? NSScreen.screens.first?.displayID
        workspaceChanged()
    }

    @objc private func workspaceChanged() {
        generation += 1
        view.targets = []
        refresh()
    }

    @objc private func chooseDisplay(_ sender: NSMenuItem) {
        guard let value = sender.representedObject as? NSNumber else { return }
        UserDefaults.standard.set(value, forKey: "DisplayID")
        displaysChanged()
    }

    @objc private func toggle() {
        enabled.toggle()
        workspaceChanged()
    }

    @objc private func toggleLabels() {
        view.labels.toggle()
    }

    @objc private func requestAccess() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
        _ = AXIsProcessTrustedWithOptions(options as CFDictionary)
        if let settings = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(settings)
        }
    }

    private func item(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let result = NSMenuItem(title: title, action: action, keyEquivalent: key)
        result.target = self
        return result
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        if !AXIsProcessTrusted() {
            menu.addItem(item("Bedienungshilfen freigeben …", #selector(requestAccess)))
            menu.addItem(.separator())
        }
        menu.addItem(item(enabled ? "Markierungen ausblenden" : "Markierungen einblenden", #selector(toggle)))
        let labels = item("Beschriftungen anzeigen", #selector(toggleLabels))
        labels.state = view.labels ? .on : .off
        menu.addItem(labels)

        let screens = NSMenuItem(title: "Monitor", action: nil, keyEquivalent: "")
        let submenu = NSMenu()
        for (index, screen) in NSScreen.screens.enumerated() {
            guard let id = screen.displayID else { continue }
            let title = "\(index + 1) · \(screen.localizedName)"
            let choice = item(title, #selector(chooseDisplay(_:)))
            choice.representedObject = NSNumber(value: id)
            choice.state = id == displayID ? .on : .off
            submenu.addItem(choice)
        }
        screens.submenu = submenu
        menu.addItem(screens)
        menu.addItem(.separator())
        menu.addItem(withTitle: "Bildschirmmarker beenden", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    }

    private func refresh() {
        guard enabled, AXIsProcessTrusted(), let displayID,
              let screen = NSScreen.screens.first(where: { $0.displayID == displayID }) else {
            panel.orderOut(nil)
            view.targets = []
            return
        }
        if panel.frame != screen.frame {
            panel.setFrame(screen.frame, display: true)
        }
        guard !busy else { return }
        busy = true
        let current = generation
        let display = CGDisplayBounds(displayID)
        let workspace = NSWorkspace.shared
        let frontPID = workspace.frontmostApplication?.processIdentifier
        let dockPID = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first?.processIdentifier
        let extrasPID = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.controlcenter").first?.processIdentifier
        worker.async { [weak self] in
            let targets = scan(display: display, frontPID: frontPID, dockPID: dockPID, menuExtrasPID: extrasPID)
            let localTargets = targets.map { target in
                Target(rect: target.rect.offsetBy(dx: -display.minX, dy: -display.minY),
                       label: target.label, enabled: target.enabled, kind: target.kind)
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.busy = false
                guard self.generation == current else {
                    self.refresh()
                    return
                }
                self.view.targets = localTargets
                if AXIsProcessTrusted() && !localTargets.isEmpty {
                    if !self.panel.isVisible { self.panel.orderFrontRegardless() }
                } else {
                    self.panel.orderOut(nil)
                }
            }
        }
    }
}

let app = NSApplication.shared
let controller = Controller()
app.setActivationPolicy(.accessory)
app.delegate = controller
app.run()
