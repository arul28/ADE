import Foundation

// What `ade cloud push-work` and `ade cloud work-state` answer on a cloud
// computer, as the phone reads it (`readPushWorkTally` in the account
// directory, `readPushAllTally` in the desktop): each lane's state, and the
// sentence when GitHub stopped one. `CloudServerClient` runs the commands.

/// One lane as `ade cloud push-work` left it (`CloudPushWorkLane`). Older computers leave the list out.
struct CloudPushWorkLane: Equatable {
  let laneId: String
  let laneName: String
  let branchRef: String
  let primary: Bool
  let dirty: Bool
  let ahead: Int
  /// `clean`, `pushed`, `failed` or `unpushed` (anything else reads as unpushed).
  let state: String
  /// Why GitHub stopped a failed lane (`github_refused`, `github_unreachable`); nil when it didn't.
  var reason: String? = nil

  /// "main checkout", else the lane's name, else its branch (`cloudWorkLaneName`).
  var shownName: String { primary ? "main checkout" : (laneName.isEmpty ? branchRef : laneName) }
  /// Work that is still only on the computer.
  var isLeft: Bool { state == "unpushed" || state == "failed" }
}

/// `ade cloud push-work` / `work-state`'s tally (`CloudPushWorkTally`).
struct CloudPushWorkTally: Equatable {
  let pushed: Int
  let failed: Int
  let skipped: Int
  let lanes: [CloudPushWorkLane]?

  /// The command's JSON (`{ result: … }` or the tally itself), or nil when it isn't JSON (`readPushAllTally`).
  init?(stdout: String) {
    guard let data = stdout.trimmingCharacters(in: .whitespacesAndNewlines).data(using: .utf8),
          let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    let tally = parsed["result"] as? [String: Any] ?? parsed
    func count(_ key: String) -> Int {
      if let number = tally[key] as? NSNumber { return number.intValue }
      if let text = tally[key] as? String { return Int(text) ?? 0 }
      return 0
    }
    pushed = count("pushed")
    failed = count("failed")
    skipped = count("skipped")
    if let raw = tally["lanes"] as? [Any] {
      let known: Set<String> = ["clean", "pushed", "failed", "unpushed"]
      lanes = raw.compactMap { entry in
        guard let lane = entry as? [String: Any], let laneId = lane["laneId"] as? String else { return nil }
        let state = lane["state"] as? String ?? ""
        return CloudPushWorkLane(
          laneId: laneId,
          laneName: lane["laneName"] as? String ?? "",
          branchRef: lane["branchRef"] as? String ?? "",
          primary: lane["primary"] as? Bool == true,
          dirty: lane["dirty"] as? Bool == true,
          ahead: (lane["ahead"] as? NSNumber)?.intValue ?? 0,
          state: known.contains(state) ? state : "unpushed",
          reason: lane["reason"] as? String
        )
      }
    } else {
      lanes = nil
    }
  }

  /// The lanes whose work is still only on the computer (`toWorkLanes`).
  var leftLanes: [CloudPushWorkLane] { (lanes ?? []).filter(\.isLeft) }
}

/// The sentence when GitHub stopped a lane at risk, the desktop's words
/// (`pushWorkGithubProblem` and `pushWorkGithubMessage` in the account
/// directory): a refusal wins over no answer. `kept`: a free that stopped;
/// otherwise a check before a delete. Nil when GitHub didn't stop one.
func cloudPushWorkGithubMessage(_ lanes: [CloudPushWorkLane], kept: Bool) -> String? {
  let atRisk = lanes.filter(\.isLeft)
  if atRisk.contains(where: { $0.reason == "github_refused" }) {
    return kept
      ? "GitHub refused this computer access to the lane's repository, so nothing was deleted. The repository may have moved, or your GitHub connection (Settings › GitHub) can't reach it. Fix that, then try again."
      : "GitHub refused this computer access to the lane's repository, so \(Brand.name) can't tell what isn't on GitHub."
  }
  if atRisk.contains(where: { $0.reason == "github_unreachable" }) {
    return kept
      ? "This computer couldn't reach GitHub to check the lane's work, so nothing was deleted. Try again in a minute."
      : "This computer couldn't reach GitHub, so \(Brand.name) can't tell what isn't on GitHub."
  }
  return nil
}

/// A free whose lanes don't include this one (`LANE_NOT_ON_COMPUTER_MESSAGE`).
let cloudLaneNotOnComputerMessage = "This lane isn't on the computer (its setup didn't finish, or it was removed there), so there is no lane to keep. Delete the computer instead."
