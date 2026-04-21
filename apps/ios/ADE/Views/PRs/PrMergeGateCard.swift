import SwiftUI

enum PrMergeGateTone: Equatable {
  case red
  case amber
  case green

  var color: Color {
    switch self {
    case .red: return ADEColor.danger
    case .amber: return ADEColor.warning
    case .green: return ADEColor.success
    }
  }

  var icon: String {
    switch self {
    case .red: return "exclamationmark.octagon.fill"
    case .amber: return "arrow.triangle.2.circlepath"
    case .green: return "checkmark.seal.fill"
    }
  }

  var title: String {
    switch self {
    case .red: return "Not ready to merge"
    case .amber: return "Needs rebase"
    case .green: return "Ready to merge"
    }
  }
}

enum PrMergeGateTarget: Equatable {
  case checks
  case reviews
  case overview
}

struct PrMergeGateInfo: Equatable {
  let tone: PrMergeGateTone
  let subline: String
  let target: PrMergeGateTarget

  var title: String {
    switch tone {
    case .red: return "Merge blocked"
    case .amber: return "Needs attention"
    case .green: return "Ready to merge"
    }
  }
}

/// Derives the merge-gate summary from the hydrated PR status + capabilities.
///
/// Precedence (worst wins): conflicts/failing/blockedReason → red;
/// clean but behind base or needs rebase → amber; otherwise green.
func prComputeMergeGate(
  status: PrStatus?,
  checks: [PrCheck],
  reviewThreadsUnresolved: Int,
  reviewsNeeded: Int,
  reviewsHave: Int,
  capabilities: PrActionCapabilities?
) -> PrMergeGateInfo {
  let failing = checks.filter { check in
    check.status == "completed" &&
      check.conclusion != nil &&
      check.conclusion != "success" &&
      check.conclusion != "neutral" &&
      check.conclusion != "skipped"
  }.count
  let conflicts = status?.mergeConflicts ?? false
  let blockedReason = capabilities?.mergeBlockedReason?.trimmingCharacters(in: .whitespacesAndNewlines)
  let hasBlockedReason = !(blockedReason?.isEmpty ?? true)
  let behind = status?.behindBaseBy ?? 0
  let mergeable = status?.isMergeable ?? true

  let approvalsText: String = {
    let have = max(reviewsHave, 0)
    let need = max(reviewsNeeded, 0)
    return "\(have)/\(max(need, have)) approvals"
  }()

  if conflicts || failing > 0 || hasBlockedReason {
    var parts: [String] = []
    if failing > 0 {
      parts.append("\(failing) failing check\(failing == 1 ? "" : "s")")
    }
    if conflicts {
      parts.append("merge conflicts")
    }
    if reviewsNeeded > 0 || reviewsHave > 0 {
      parts.append(approvalsText)
    }
    if reviewThreadsUnresolved > 0 {
      parts.append("\(reviewThreadsUnresolved) unresolved")
    }
    if let blockedReason, !blockedReason.isEmpty, parts.isEmpty {
      parts.append(blockedReason)
    }
    let subline = parts.isEmpty ? (blockedReason ?? "Merge blocked by host") : parts.joined(separator: " · ")
    let target: PrMergeGateTarget = (failing > 0 || conflicts) ? .checks : .reviews
    return PrMergeGateInfo(tone: .red, subline: subline, target: target)
  }

  if behind > 0 || !mergeable {
    let baseLabel = "base"
    let subline: String
    if behind > 0 {
      subline = "\(behind) commit\(behind == 1 ? "" : "s") behind \(baseLabel)"
    } else {
      subline = "Rebase needed"
    }
    return PrMergeGateInfo(tone: .amber, subline: subline, target: .overview)
  }

  let subline: String
  if reviewsNeeded > 0 || reviewsHave > 0 {
    subline = "\(approvalsText) · all checks green"
  } else {
    subline = "All checks green"
  }
  return PrMergeGateInfo(tone: .green, subline: subline, target: .overview)
}

/// Visual "merge gate" banner shown above the sub-tab picker on PR detail.
/// Tappable: the parent decides how to respond (scroll into view or switch tab).
struct PrMergeGateCard: View {
  let info: PrMergeGateInfo
  let onTap: () -> Void

  var body: some View {
    Button(action: onTap) {
      HStack(spacing: 12) {
        ZStack {
          RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(info.tone.color.opacity(0.18))
          RoundedRectangle(cornerRadius: 10, style: .continuous)
            .strokeBorder(info.tone.color.opacity(0.35), lineWidth: 0.5)
          Image(systemName: info.tone.icon)
            .font(.system(size: 18, weight: .semibold))
            .foregroundStyle(info.tone.color)
        }
        .frame(width: 36, height: 36)

        VStack(alignment: .leading, spacing: 2) {
          Text(info.title)
            .font(.system(size: 13.5, weight: .semibold))
            .foregroundStyle(info.tone.color)
          Text(info.subline)
            .font(.system(size: 10.5, design: .monospaced))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(2)
        }

        Spacer(minLength: 0)

        Image(systemName: "chevron.right")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(.vertical, 12)
      .padding(.horizontal, 14)
      .background(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .fill(info.tone.color.opacity(0.08))
      )
      .overlay(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .strokeBorder(info.tone.color.opacity(0.22), lineWidth: 0.5)
      )
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(info.title). \(info.subline)")
  }
}
