import Foundation

// Lanes of the focused repository on the other paired machines, the way the
// desktop shows every machine in every tab (`laneMachineRouting.ts`).
//
// A lane owns its machine. On the phone a lane of another machine keeps a
// namespaced id (`workRemoteLaneId`: `fleet|<machineKey>|<laneId>`) in every
// screen, and every command that names it goes to that machine:
// `routeOrStripFleetTarget` takes the tag off the args, sends the command to
// the lane's machine in the project that machine holds, and tags the lane ids
// of the reply again (`syncTagRemoteLaneIds`). A command for such a lane is
// never queued and never falls through to the focused machine: the same lane
// id can name a different lane there.
//
// Lanes of other machines live in memory only. `ade.db` replicates the focused
// machine's project and has no machine column.

/// A command whose args name lanes of one other machine.
struct SyncRemoteLaneTarget {
  let machineKey: String
  /// The args with the machine tag taken off every lane id.
  let args: [String: Any]
}

/// Keys whose values are lane ids, in command args and in host replies.
private let syncLaneIdKeys: Set<String> = [
  "laneId", "parentLaneId", "baseLaneId", "sourceLaneId", "targetLaneId", "newParentLaneId",
]
private let syncLaneIdListKeys: Set<String> = ["laneIds"]

/// The machine a command's lane ids name, with the tags taken off. Nil when no
/// arg is a namespaced lane id. Throws when the args name lanes of two
/// machines: no host can serve that.
func syncRemoteLaneTarget(args: [String: Any]) throws -> SyncRemoteLaneTarget? {
  var machineKey: String?
  var stripped = args
  func take(_ value: String) throws -> String {
    guard let parsed = workParseRemoteLaneId(value) else { return value }
    if let machineKey, machineKey != parsed.machineKey {
      throw NSError(domain: "ADE", code: 26, userInfo: [NSLocalizedDescriptionKey: "These lanes are on different machines."])
    }
    machineKey = parsed.machineKey
    return parsed.laneId
  }
  for (key, value) in args {
    if syncLaneIdKeys.contains(key), let text = value as? String {
      stripped[key] = try take(text)
    } else if syncLaneIdListKeys.contains(key), let list = value as? [String] {
      stripped[key] = try list.map(take)
    }
  }
  guard let machineKey else { return nil }
  return SyncRemoteLaneTarget(machineKey: machineKey, args: stripped)
}

/// A host reply with every lane id of `machineKey` namespaced: the lane-id
/// keys everywhere, and the `id` of every lane object (one that has both
/// `laneType` and `worktreePath`). Already namespaced ids stay as they are.
func syncTagRemoteLaneIds(in value: Any, machineKey: String) -> Any {
  func tag(_ id: String) -> String {
    guard !id.isEmpty, workParseRemoteLaneId(id) == nil else { return id }
    return workRemoteLaneId(machineKey: machineKey, laneId: id)
  }
  if let list = value as? [Any] {
    return list.map { syncTagRemoteLaneIds(in: $0, machineKey: machineKey) }
  }
  guard var object = value as? [String: Any] else { return value }
  let isLane = object["laneType"] != nil && object["worktreePath"] != nil
  for (key, child) in object {
    if syncLaneIdKeys.contains(key), let text = child as? String {
      object[key] = tag(text)
    } else if syncLaneIdListKeys.contains(key), let list = child as? [String] {
      object[key] = list.map(tag)
    } else if isLane, key == "id", let text = child as? String {
      object[key] = tag(text)
    } else if child is [Any] || child is [String: Any] {
      object[key] = syncTagRemoteLaneIds(in: child, machineKey: machineKey)
    }
  }
  return object
}

/// A lane row built from roster data only (a machine that is not live, or a
/// reply with no snapshots): no sessions are known.
let syncRemoteLaneEmptyRuntime = LaneRuntimeSummary(
  bucket: "none", runningCount: 0, awaitingInputCount: 0, endedCount: 0, sessionCount: 0
)
