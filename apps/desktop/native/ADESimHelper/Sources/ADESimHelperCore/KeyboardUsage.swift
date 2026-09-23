import Foundation

/// Text → USB HID keyboard usage codes (Usage Page 0x07).
///
/// The vendored `HIDInjector` injects one usage at a time; there is no
/// "type this string" primitive anywhere below it, and `simctl` has none either.
/// So `type` is spelled out here as a key sequence.
///
/// Scope is deliberately ASCII. A non-ASCII character has no HID usage at all —
/// it is produced by an input method, not a key — so pretending to support one
/// would mean silently typing the wrong thing. `usages(for:)` reports what it
/// could not map instead.
public enum KeyboardUsage {
    public static let leftShift: UInt32 = 0xE1
    public static let returnKey: UInt32 = 0x28

    /// One keystroke: a usage, and whether shift is held for it.
    public struct Stroke: Equatable {
        public let usage: UInt32
        public let shifted: Bool
    }

    private static let unshifted: [Character: UInt32] = {
        var map: [Character: UInt32] = [:]
        // a-z are contiguous from 0x04.
        for (index, scalar) in "abcdefghijklmnopqrstuvwxyz".enumerated() {
            map[scalar] = UInt32(0x04 + index)
        }
        // 1-9 are contiguous from 0x1E; zero is 0x27, after nine, not before one.
        for (index, scalar) in "123456789".enumerated() {
            map[scalar] = UInt32(0x1E + index)
        }
        map["0"] = 0x27
        map["\n"] = returnKey
        map["\r"] = returnKey
        map["\t"] = 0x2B
        map[" "] = 0x2C
        map["-"] = 0x2D
        map["="] = 0x2E
        map["["] = 0x2F
        map["]"] = 0x30
        map["\\"] = 0x31
        map[";"] = 0x33
        map["'"] = 0x34
        map["`"] = 0x35
        map[","] = 0x36
        map["."] = 0x37
        map["/"] = 0x38
        return map
    }()

    /// Characters reached by holding shift, mapped to the key that produces them.
    private static let shifted: [Character: Character] = [
        "A": "a", "B": "b", "C": "c", "D": "d", "E": "e", "F": "f", "G": "g",
        "H": "h", "I": "i", "J": "j", "K": "k", "L": "l", "M": "m", "N": "n",
        "O": "o", "P": "p", "Q": "q", "R": "r", "S": "s", "T": "t", "U": "u",
        "V": "v", "W": "w", "X": "x", "Y": "y", "Z": "z",
        "!": "1", "@": "2", "#": "3", "$": "4", "%": "5",
        "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
        "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\",
        ":": ";", "\"": "'", "~": "`", "<": ",", ">": ".", "?": "/",
    ]

    public static func stroke(for character: Character) -> Stroke? {
        if let usage = unshifted[character] {
            return Stroke(usage: usage, shifted: false)
        }
        if let base = shifted[character], let usage = unshifted[base] {
            return Stroke(usage: usage, shifted: true)
        }
        return nil
    }

    /// Map a whole string, reporting every character that has no HID usage.
    public static func usages(for text: String) -> (strokes: [Stroke], unsupported: [Character]) {
        var strokes: [Stroke] = []
        var unsupported: [Character] = []
        for character in text {
            if let stroke = stroke(for: character) {
                strokes.append(stroke)
            } else {
                unsupported.append(character)
            }
        }
        return (strokes, unsupported)
    }
}

/// Hardware buttons ADE can press, and how each reaches the device.
///
/// Two different mechanisms hide behind one command. `home`, `lock` and `siri`
/// go through the vendored `sendButton(button:deviceUDID:)`, which knows the
/// Indigo event-source constants and the quirks around them. Volume has no
/// event source, so it goes through `sendButtonHID` with a raw
/// (usage page, usage) pair from the HID Consumer page.
public enum SimButton: Equatable {
    /// Handled by `HIDInjector.sendButton`.
    case named(String)
    /// Handled by `HIDInjector.sendButtonHID`, momentary press.
    case hid(page: UInt32, usage: UInt32)

    /// HID Consumer page (0x0C).
    private static let consumerPage: UInt32 = 0x0C

    public static func resolve(_ name: String) -> SimButton? {
        switch name {
        case "home", "lock", "siri", "side_button", "app_switcher", "swipe_home":
            return .named(name)
        case "volume-up", "volume_up":
            return .hid(page: consumerPage, usage: 0xE9)
        case "volume-down", "volume_down":
            return .hid(page: consumerPage, usage: 0xEA)
        default:
            return nil
        }
    }
}
