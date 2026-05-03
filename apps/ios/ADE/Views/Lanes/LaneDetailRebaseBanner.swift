import SwiftUI

struct LaneDetailRebaseBanner: View {
  let behindCount: Int
  let parentLabel: String?
  let hasPr: Bool
  let canRunLiveActions: Bool
  let onViewRebase: () -> Void
  let onDismiss: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .center, spacing: 10) {
        Image(systemName: "arrow.triangle.2.circlepath")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.warning)
        Text("REBASE SUGGESTED")
          .font(.caption.weight(.semibold))
          .tracking(0.6)
          .foregroundStyle(ADEColor.textMuted)
        Spacer(minLength: 4)
        LaneTypeBadge(text: "1 LANE", tint: ADEColor.warning)
      }

      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 6) {
          if hasPr {
            LaneTypeBadge(text: "PR", tint: ADEColor.accent)
          }
          LaneTypeBadge(text: "\(behindCount) BEHIND", tint: ADEColor.warning)
        }

        Text(bodyCopy)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }

      HStack(spacing: 8) {
        Button(action: onViewRebase) {
          Text("View in Rebase/Merge tab")
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .padding(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
            .background(ADEColor.warning.opacity(0.24), in: Capsule())
            .overlay(Capsule().stroke(ADEColor.warning.opacity(0.5), lineWidth: 0.6))
        }
        .buttonStyle(.plain)
        .disabled(!canRunLiveActions)
        .opacity(canRunLiveActions ? 1.0 : 0.55)

        Button(action: onDismiss) {
          Text("Dismiss")
            .font(.caption.weight(.medium))
            .foregroundStyle(ADEColor.textSecondary)
            .padding(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
            .overlay(Capsule().stroke(ADEColor.border.opacity(0.4), lineWidth: 0.6))
        }
        .buttonStyle(.plain)

        Spacer(minLength: 0)
      }
    }
    .padding(14)
    .background(ADEColor.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .glassEffect(in: .rect(cornerRadius: 14))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.warning.opacity(0.28), lineWidth: 0.8)
    )
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityLabel)
  }

  private var bodyCopy: String {
    let base = parentLabel.flatMap { $0.isEmpty ? nil : $0 } ?? "parent branch"
    return "Rebase this lane onto \(base) to pick up new commits."
  }

  private var accessibilityLabel: String {
    laneDetailRebaseBannerAccessibilityLabel(behindCount: behindCount, parentLabel: parentLabel, hasPr: hasPr)
  }
}

func laneDetailRebaseBannerAccessibilityLabel(behindCount: Int, parentLabel: String?, hasPr: Bool) -> String {
  let noun = behindCount == 1 ? "commit" : "commits"
  let base = parentLabel.flatMap { $0.isEmpty ? nil : $0 } ?? "parent branch"
  var parts = [
    "Rebase suggested",
    "\(behindCount) \(noun) behind",
  ]
  if hasPr {
    parts.append("PR open")
  }
  parts.append("Rebase this lane onto \(base) to pick up new commits.")
  return parts.joined(separator: ". ")
}
