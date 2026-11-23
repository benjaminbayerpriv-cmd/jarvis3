// Haptisches Feedback am Force-Touch-Trackpad (MacBook oder Magic Trackpad).
//
// Zwei Wege:
//  1. Der Trackpad-Aktor aus MultitouchSupport (privat, per dlopen): fühlbar auch ohne aufgelegten Finger.
//  2. NSHapticFeedbackManager (öffentlich): vibriert nur, solange ein Finger auf dem Trackpad liegt.
// Beides ist nur ein Zusatz; fehlt ein Weg, passiert einfach nichts.
import AppKit
import Darwin

enum Pulse: String {
    case tick      // winzig: ein Buchstabe im Antwort-Stream
    case think     // weich: Denken (Zyklus)
    case click     // deutlich: Jarvis klickt
    case tool      // mittel: ein Werkzeugaufruf beginnt oder endet

    /// Stärke-Nummern des Aktors (1–6 schwach bis stark, 15/16 kräftiger Klick)
    var actuation: Int32 {
        switch self { case .tick: return 1; case .think: return 3; case .click: return 6; case .tool: return 4 }
    }
    var fallback: NSHapticFeedbackManager.FeedbackPattern {
        switch self { case .tick: return .alignment; case .think: return .levelChange; case .click, .tool: return .generic }
    }
}

final class Haptics {
    private typealias CreateList = @convention(c) () -> Unmanaged<CFArray>?
    private typealias DeviceID = @convention(c) (UnsafeRawPointer, UnsafeMutablePointer<UInt64>) -> Int32
    private typealias ActCreate = @convention(c) (UInt64) -> Unmanaged<CFTypeRef>?
    private typealias ActOpen = @convention(c) (CFTypeRef) -> Int32
    private typealias ActActuate = @convention(c) (CFTypeRef, Int32, UInt32, Float, Float) -> Int32

    private var actuator: CFTypeRef?
    private var actuate: ActActuate?
    /// Beschreibung für die Diagnose ("aktor", "nur-berührung", "keine")
    private(set) var mode = "keine"

    init() {
        guard let handle = dlopen("/System/Library/PrivateFrameworks/MultitouchSupport.framework/MultitouchSupport", RTLD_LAZY),
              let createList = dlsym(handle, "MTDeviceCreateList"), let deviceID = dlsym(handle, "MTDeviceGetDeviceID"),
              let create = dlsym(handle, "MTActuatorCreateFromDeviceID"), let open = dlsym(handle, "MTActuatorOpen"),
              let act = dlsym(handle, "MTActuatorActuate") else { mode = "nur-berührung"; return }
        let list = unsafeBitCast(createList, to: CreateList.self)
        let getID = unsafeBitCast(deviceID, to: DeviceID.self)
        let make = unsafeBitCast(create, to: ActCreate.self)
        let openFn = unsafeBitCast(open, to: ActOpen.self)
        actuate = unsafeBitCast(act, to: ActActuate.self)
        var ids: [UInt64] = []
        if let devices = list()?.takeRetainedValue() {
            for i in 0..<CFArrayGetCount(devices) {
                guard let device = CFArrayGetValueAtIndex(devices, i) else { continue }
                var id: UInt64 = 0
                if getID(device, &id) == 0, id != 0 { ids.append(id) }
            }
        }
        ids.append(0x200000001) // eingebautes Trackpad der meisten MacBooks
        for id in ids {
            guard let candidate = make(id)?.takeRetainedValue() else { continue }
            if openFn(candidate) == 0 { actuator = candidate; mode = "aktor"; return }
        }
        mode = "nur-berührung"
    }

    func fire(_ pulse: Pulse, strength: Int32? = nil) {
        if let actuator, let actuate, actuate(actuator, strength ?? pulse.actuation, 0, 0, 0) == 0 { return }
        NSHapticFeedbackManager.defaultPerformer.perform(pulse.fallback, performanceTime: .now)
    }
}

/// `uimap haptic-serve`: liest pro Zeile einen Impuls (tick, think, click) von stdin und löst ihn sofort aus. Keine Antworten.
func hapticServe() {
    let haptics = Haptics()
    FileHandle.standardError.write(Data("haptik: \(haptics.mode)\n".utf8))
    while let line = readLine() {
        // "<impuls> [stärke]", z. B. "click 15"
        let parts = line.split(separator: " ").map(String.init)
        guard let name = parts.first else { continue }
        if name == "mode" { print(haptics.mode); fflush(stdout); continue }
        if let pulse = Pulse(rawValue: name) { haptics.fire(pulse, strength: parts.count > 1 ? Int32(parts[1]) : nil) }
    }
}
