// Tastenkombinationen wie "cmd+shift+t", "return", "escape" als echte Tastendrücke.
import CoreGraphics
import Carbon.HIToolbox
import Foundation

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

// Zeichen -> Tastencode für das AKTUELLE Tastaturlayout (die Codes oben gelten nur für die US-Belegung; auf einer deutschen
// Tastatur liegen z und y vertauscht, "*" liegt auf Shift+Plus usw.). Aufgebaut mit UCKeyTranslate, einmal pro Aufruf.
func layoutKeys() -> [String: (code: CGKeyCode, shift: Bool)] {
    guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
          let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return [:] }
    let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
    var map: [String: (code: CGKeyCode, shift: Bool)] = [:]
    data.withUnsafeBytes { buffer in
        guard let base = buffer.baseAddress else { return }
        let layout = base.assumingMemoryBound(to: UCKeyboardLayout.self)
        for shift in [false, true] {
            for code in 0..<128 {
                var dead: UInt32 = 0
                var length = 0
                var chars = [UniChar](repeating: 0, count: 4)
                let modifiers: UInt32 = shift ? UInt32(shiftKey >> 8) & 0xFF : 0
                let status = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDown), modifiers, UInt32(LMGetKbdType()),
                                            OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, chars.count, &length, &chars)
                guard status == noErr, length > 0 else { continue }
                let character = String(utf16CodeUnits: chars, count: length).lowercased()
                if character.unicodeScalars.contains(where: { $0.value < 32 }) { continue }
                if let known = map[character], !known.shift || shift { continue }  // ohne Shift bevorzugen
                map[character] = (CGKeyCode(code), shift)
            }
        }
    }
    return map
}

private let aliases: [String: String] = [
    "plus": "+", "minus": "-", "equal": "=", "equals": "=", "star": "*", "asterisk": "*", "multiply": "*", "slash": "/",
    "backslash": "\\", "comma": ",", "period": ".", "dot": ".", "colon": ":", "semicolon": ";", "quote": "'",
    "apostrophe": "'", "hash": "#", "at": "@", "underscore": "_", "bracketleft": "[", "bracketright": "]",
]

func pressCombo(_ combo: String, pid: pid_t? = nil) throws {
    var flags: CGEventFlags = []
    var key: CGKeyCode?
    let layout = layoutKeys()
    // "+" selbst als Taste: "cmd++" -> Teile am "+" trennen, ohne die leere Stelle zu verlieren
    var parts = combo.lowercased().components(separatedBy: "+").map { $0.trimmingCharacters(in: .whitespaces) }
    if let last = parts.last, last.isEmpty, parts.count >= 2 { parts.removeLast(); parts[parts.count - 1] = "+" } // "shift++"
    for raw in parts where !raw.isEmpty {
        let part = raw.trimmingCharacters(in: CharacterSet(charactersIn: "'\"`„“”"))
        if let m = mods[part] { flags.insert(m); continue }
        if let k = codes[part], part.count > 1 { key = k; continue }              // benannte Taste (return, tab, f5 …)
        let symbol = aliases[part] ?? part
        if let entry = layout[symbol] { key = entry.code; if entry.shift { flags.insert(.maskShift) }; continue }
        if let k = codes[part] { key = k; continue }                              // Rückfall auf die US-Tabelle
        throw Failure(message: "unbekannte Taste: \(raw). Erlaubt sind Zeichen wie 8, *, = und Namen wie return, tab, escape, left, f5, plus Modifier cmd, shift, alt, ctrl (Beispiel: cmd+shift+4). Text zum Schreiben bitte mit desktop_type_text.")
    }
    guard let key else { throw Failure(message: "Modifier allein reichen nicht (\(combo)); nenne zusätzlich eine Taste, z. B. shift+8. Zum Schreiben von Text desktop_type_text benutzen.") }
    for down in [true, false] {
        let e = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: down)
        e?.flags = flags
        if let pid { e?.postToPid(pid) } else { e?.post(tap: .cghidEventTap) }
    }
}

/// Text in das gerade fokussierte Feld tippen (Unicode-Ereignisse, unabhängig vom Tastaturlayout).
func postText(_ text: String) {
    for scalar in text.utf16 {
        var unit = scalar
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
            e?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &unit)
            e?.post(tap: .cghidEventTap)
        }
        usleep(4_000)
    }
}
