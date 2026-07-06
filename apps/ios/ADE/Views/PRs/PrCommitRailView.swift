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

/// Vertical timeline of commits rendered inside a section card on the
/// Overview tab. Liquid-glass aesthetic: gradient dots with subtle glow,
/// mono SHAs, HEAD (first row) gets a brighter halo.
///
/// `PullRequestSnapshot` does not currently expose a `commits` array —
/// parent passes `nil` / an empty array to hide the section.
struct PrCommitRailView: View {
  let commits: [PrCommitRailEntry]

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(commits.enumerated()), id: \.element.id) { index, commit in
        commitRow(commit, isHead: index == 0, isLast: index == commits.count - 1)
      }
    }
  }

  private func commitRow(_ commit: PrCommitRailEntry, isHead: Bool, isLast: Bool) -> some View {
    let status = normalizedStatus(commit.checksState)
    let tint = statusTint(status)
    return HStack(alignment: .top, spacing: 12) {
      // Timeline gutter: vertical rail + flat dot (HEAD gets a ring).
      ZStack(alignment: .top) {
        // Connector line (hidden on last row).
        if !isLast {
          Rectangle()
            .fill(PrGlassPalette.cardBorder)
            .frame(width: 1.25)
            .padding(.top, 18)
        }

        ZStack {
          if isHead {
            Circle()
              .strokeBorder(tint.opacity(0.35), lineWidth: 2)
              .frame(width: 16, height: 16)
          }
          Circle()
            .fill(tint)
            .frame(width: 10, height: 10)
        }
        .frame(width: 16)
        .padding(.top, 4)
      }
      .frame(width: 16)

      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 8) {
          Text(String(commit.sha.prefix(7)))
            .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
            .foregroundStyle(PrGlassPalette.purpleBright)

          Text(commit.message)
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
            .truncationMode(.tail)

          Spacer(minLength: 0)

          if let ts = commit.timestampIso, !ts.isEmpty {
            Text(prCompactRelativeTime(ts))
              .font(.system(size: 10, weight: .medium, design: .monospaced))
              .foregroundStyle(ADEColor.textMuted)
          }
        }

        if let author = commit.author, !author.isEmpty {
          Text(author)
            .font(.system(size: 10.5, design: .monospaced))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
        }
      }
      .padding(.vertical, 2)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
  }

  private func normalizedStatus(_ raw: String) -> String {
    switch raw {
    case "success", "pass": return "pass"
    case "failure", "fail": return "fail"
    default: return raw
    }
  }

  private func statusTint(_ status: String) -> Color {
    switch status {
    case "pass": return PrGlassPalette.success
    case "fail": return PrGlassPalette.danger
    default: return PrGlassPalette.purple
    }
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
