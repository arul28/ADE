import Foundation

enum LaneDeeplinkHelpers {
  static func laneLink(laneId: String) -> String {
    "ade://lane/\(laneId)"
  }

  static func branchLink(repoOwner: String, repoName: String, branch: String) -> String {
    let encodedBranch = branch
      .split(separator: "/")
      .map { segment in
        segment.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String(segment)
      }
      .joined(separator: "/")
    return "ade://repo/\(repoOwner)/\(repoName)/branch/\(encodedBranch)"
  }
}
