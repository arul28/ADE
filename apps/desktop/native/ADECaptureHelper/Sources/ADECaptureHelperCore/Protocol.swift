import CoreGraphics
import Foundation

/// One NDJSON line from ADE on stdin.
public enum HelperCommand: Equatable {
    case capture
    case settings(enabled: Bool)
    case quit

    /// Parse one line. Returns nil for junk and for commands this build does not
    /// know — a newer ADE must be able to add a command without wedging an
    /// older helper.
    public static func parse(line: String) -> HelperCommand? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8) else { return nil }
        guard
            let object = try? JSONSerialization.jsonObject(with: data),
            let dictionary = object as? [String: Any],
            let type = dictionary["type"] as? String
        else { return nil }
        switch type {
        case "capture": return .capture
        case "quit": return .quit
        case "settings":
            let enabled = (dictionary["enabled"] as? Bool) ?? true
            return .settings(enabled: enabled)
        default: return nil
        }
    }
}

/// One NDJSON line from the helper to ADE.
public enum HelperEvent {
    case ready
    case chord
    case captured(
        path: String,
        appName: String?,
        windowTitle: String?,
        ownerPid: Int32?,
        bounds: CGRect?
    )
    case permissionDenied
    case noWindow
    case captureFailed(message: String)

    public var payload: [String: Any] {
        switch self {
        case .ready:
            return ["type": "ready"]
        case .chord:
            return ["type": "chord"]
        case .permissionDenied:
            return ["type": "permission-denied"]
        case .noWindow:
            return ["type": "no-window"]
        case let .captureFailed(message):
            return ["type": "capture-failed", "message": message]
        case let .captured(path, appName, windowTitle, ownerPid, bounds):
            var payload: [String: Any] = ["type": "captured", "path": path]
            if let appName { payload["appName"] = appName }
            if let windowTitle { payload["windowTitle"] = windowTitle }
            if let ownerPid { payload["ownerPid"] = Int(ownerPid) }
            if let bounds {
                payload["bounds"] = [
                    "x": Double(bounds.origin.x),
                    "y": Double(bounds.origin.y),
                    "width": Double(bounds.size.width),
                    "height": Double(bounds.size.height),
                ]
            }
            return payload
        }
    }

    /// The exact bytes written to stdout, newline included.
    ///
    /// Serialisation failure is impossible for these payloads (strings, numbers
    /// and bools only), but it is handled rather than force-unwrapped: a crash
    /// here would take the gesture down for the rest of the session.
    public func encoded() -> String? {
        guard
            let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
            let text = String(data: data, encoding: .utf8)
        else { return nil }
        return text + "\n"
    }
}
