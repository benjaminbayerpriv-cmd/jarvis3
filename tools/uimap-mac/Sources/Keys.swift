// Tastenkombinationen wie "cmd+shift+t", "return", "escape" als echte Tastendrücke.
import CoreGraphics

private let codes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
    "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
    "9": 25, "7": 26, "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40,
    "n": 45, "m": 46, "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "forward_delete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "left": 123, "right": 124, "down": 125, "up": 126, ",": 43, ".": 47, "-": 44,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
]
private let mods: [String: CGEventFlags] = [
    "cmd": .maskCommand, "command": .maskCommand, "ctrl": .maskControl, "control": .maskControl,
    "alt": .maskAlternate, "option": .maskAlternate, "opt": .maskAlternate, "shift": .maskShift, "fn": .maskSecondaryFn,
]

func pressCombo(_ combo: String) throws {
    var flags: CGEventFlags = []
    var key: CGKeyCode?
    for raw in combo.lowercased().split(separator: "+") {
        let part = raw.trimmingCharacters(in: .whitespaces)
        if let m = mods[part] { flags.insert(m) } else if let k = codes[part] { key = k }
        else { throw Failure(message: "unbekannte Taste: \(part)") }
    }
    guard let key else { throw Failure(message: "keine Taste in \(combo)") }
    for down in [true, false] {
        let e = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: down)
        e?.flags = flags
        e?.post(tap: .cghidEventTap)
    }
}
