import Foundation

/// Which part of a `type` request is the words to type, and which part says
/// where to type them.
///
/// Both used to share one field. `text` was the words AND the text-match
/// target, so `type "hello"` searched for an element labelled "hello", found
/// none, and failed; `type --target "Search"` lost its label to the words; and a
/// word that happened to match some label typed into that element instead of
/// the one named. A service that knows this sends the words as `typeText`,
/// leaving `text` free to be a label. An older service sends the words as
/// `text`; then `text` is the words only and never a label.
public enum TypeCommand {
    public static func split(_ payload: [String: JSONValue]) -> (text: String, target: [String: JSONValue]) {
        var target = payload
        target.removeValue(forKey: "clear")
        target.removeValue(forKey: "typePaceMs")
        if let typed = target.removeValue(forKey: "typeText") {
            return (typed.stringValue ?? "", target)
        }
        let typed = target.removeValue(forKey: "text")?.stringValue ?? ""
        return (typed, target)
    }

    /// The pause between characters a running recording asked for, in
    /// milliseconds (`typePaceMs`), so a video shows typing; 0 types at once.
    /// Capped, so a bad value cannot stall the driver.
    public static func paceMs(_ payload: [String: JSONValue]) -> Int {
        max(0, min(200, payload["typePaceMs"]?.intValue ?? 0))
    }

    /// True when the target half names something to act on.
    public static func hasTarget(_ target: [String: JSONValue]) -> Bool {
        if let handle = target["handle"]?.stringValue, !handle.isEmpty { return true }
        if let text = target["text"]?.stringValue, !text.isEmpty { return true }
        if let nested = target["target"]?.objectValue { return hasTarget(nested) }
        return false
    }
}
