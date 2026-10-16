import Foundation

// Value types of the machine fleet: dial results, routes to chats on other
// machines, and the hello terms both connection kinds share.

struct SyncFleetDialResult {
  let task: URLSessionWebSocketTask
  let helloPayload: [String: Any]
  let address: String
}

/// The defaults key of one machine's offline roster.
func syncRosterCacheKey(host: String) -> String {
  "ade.roster.cache.v2.\(Data(host.utf8).base64EncodedString())"
}

/// One saved, credentialed machine the fleet may keep live.
struct SyncFleetMachineProfile: Equatable {
  let machineKey: String
  let profile: HostConnectionProfile
}

/// A chat on another paired machine, and the project it belongs to there.
struct SyncRemoteMachineChat: Hashable {
  let machineKey: String
  let projectId: String
  let rootPath: String
}

/// Routes the work of one async task to a chat's machine. The chat screen of a
/// chat on another machine runs its artifact reads inside
/// `SyncFleetTaskRoute.$chat.withValue(...)`, so calls that carry no session id
/// (file reads by artifact id) still reach the right machine.
enum SyncFleetTaskRoute {
  @TaskLocal static var chat: SyncRemoteMachineChat?
}

struct SyncFleetCommandRoute {
  let connection: MachineConnection
  let projectId: String?
  let rootPath: String?
}

private let syncFleetMarkerSeparator: Character = "\u{1}"

/// A project id that also names its machine. Only `chatCommandScope(for:)`
/// makes one, and only `syncFleetRoute` reads it: the command goes to that
/// machine with the plain project id, so the marker never reaches a host.
func syncFleetMarkedProjectId(machineKey: String, projectId: String) -> String {
  "fleet\(syncFleetMarkerSeparator)\(machineKey)\(syncFleetMarkerSeparator)\(projectId)"
}

func syncFleetParseMarkedProjectId(_ value: String?) -> (machineKey: String, projectId: String)? {
  guard let value, value.hasPrefix("fleet\(syncFleetMarkerSeparator)") else { return nil }
  let parts = value.split(separator: syncFleetMarkerSeparator, maxSplits: 2, omittingEmptySubsequences: false)
  guard parts.count == 3, !parts[1].isEmpty else { return nil }
  return (String(parts[1]), String(parts[2]))
}

enum SyncFleetTargetResolution {
  case routed(Any)
  /// For the focused machine: the plain project id, and the args with any
  /// machine tag taken off their lane ids.
  case focused(projectId: String?, args: [String: Any])
}

/// The transport terms a host's `hello_ok` sets. The focused connection and
/// the roster connections read them the same way.
struct SyncHelloNegotiation {
  let features: [String: Any]?
  /// The frame size for chunked envelopes, or nil when the host does not chunk.
  let chunkedMaxFrameBytes: Int?
  /// The deflate threshold, or nil when the host does not compress.
  let deflateThresholdBytes: Int?

  init(helloPayload payload: [String: Any]) {
    let features = payload["features"] as? [String: Any]
    self.features = features
    if let chunking = features?["chunkedEnvelopes"] as? [String: Any],
       chunking["enabled"] as? Bool == true,
       let frameBytes = (chunking["maxFrameBytes"] as? NSNumber)?.intValue,
       frameBytes > 1_024 {
      chunkedMaxFrameBytes = min(syncDefaultMaxFrameBytes, frameBytes)
    } else {
      chunkedMaxFrameBytes = nil
    }
    if let compression = payload["compression"] as? [String: Any],
       compression["codec"] as? String == SyncWireCompressionCodec.deflate.rawValue,
       let threshold = (compression["thresholdBytes"] as? NSNumber)?.intValue,
       threshold > 0 {
      deflateThresholdBytes = threshold
    } else {
      deflateThresholdBytes = nil
    }
  }

  /// A feature is on when its first known spelling says so: either
  /// `{ "enabled": true }` or a plain `true`.
  func featureEnabled(_ keys: String...) -> Bool {
    featureEnabled(keys)
  }

  func featureEnabled(_ keys: [String]) -> Bool {
    for key in keys {
      if let feature = features?[key] as? [String: Any],
         let enabled = feature["enabled"] as? Bool {
        return enabled
      }
      if let value = features?[key] as? Bool {
        return value
      }
    }
    return false
  }
}
