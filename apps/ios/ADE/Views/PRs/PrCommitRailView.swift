import SwiftUI

/// A single commit row in the Overview commits rail.
struct PrCommitRailEntry: Identifiable, Equatable {
  let id: String
  let sha: String
  let message: String
  let author: String?
  let timestampIso: String?
  /// One of: "pass" / "fail" / "none"
  let checksState: String
}

/// Vertical list of commits rendered inside a section card on the Overview tab.
/// `PullRequestSnapshot` does not currently expose a `commits` array — parent
/// passes `nil` / an empty array to hide the section.
struct PrCommitRailView: View {
  let commits: [PrCommitRailEntry]

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(commits.enumerated()), id: \.element.id) { index, commit in
        commitRow(commit)
        if index < commits.count - 1 {
          Divider()
            .background(ADEColor.textMuted.opacity(0.15))
        }
      }
    }
  }

  private func commitRow(_ commit: PrCommitRailEntry) -> some View {
    HStack(spacing: 10) {
      PrCommitDot(status: commit.checksState == "success" ? "pass" : commit.checksState == "failure" ? "fail" : commit.checksState)

      Text(String(commit.sha.prefix(7)))
        .font(.system(size: 10.5, design: .monospaced))
        .foregroundStyle(ADEColor.tintPRs)

      Text(commit.message)
        .font(.system(size: 12.5))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
        .truncationMode(.tail)

      Spacer(minLength: 0)

      if let ts = commit.timestampIso {
        Text(prCompactRelativeTime(ts))
          .font(.system(size: 10, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 11)
  }

}

/// Compact "12m" / "2h" / "3d" style relative string used by the mono-typed
/// trailing timestamp. Falls back to the shared `prRelativeTime` when the
/// delta can't be computed.
func prCompactRelativeTime(_ iso: String?) -> String {
  guard let date = prParsedDate(iso) else { return "" }
  let seconds = Date().timeIntervalSince(date)
  if seconds < 60 {
    return "now"
  }
  let minutes = Int(seconds / 60)
  if minutes < 60 { return "\(minutes)m" }
  let hours = minutes / 60
  if hours < 24 { return "\(hours)h" }
  let days = hours / 24
  if days < 30 { return "\(days)d" }
  let months = days / 30
  if months < 12 { return "\(months)mo" }
  return "\(months / 12)y"
}
