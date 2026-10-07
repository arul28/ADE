import SwiftUI

struct LaneDetailRebaseBanner: View {
  let behindCount: Int
  let parentLabel: String?
  let hasPr: Bool
  let canRunLiveActions: Bool
  let onViewRebase: () -> Void
  let onDismiss: () -> Void

  /// A kit card with one warning glyph: what is behind, then the two actions.
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .center, spacing: 8) {
        Image(systemName: "arrow.triangle.2.circlepath")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(ADEColor.warning)
        Text("Rebase suggested")
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Spacer(minLength: 4)
        if hasPr {
          ADEKitTag(text: "PR")
        }
        ADEKitTag(text: "\(behindCount) behind", tone: .warn)
      }

      Text(bodyCopy)
        .font(.system(size: 12.5))
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)

      HStack(spacing: 8) {
        Button("Rebase", action: onViewRebase)
          .buttonStyle(ADEKitButtonStyle(tone: .warn))
          .disabled(!canRunLiveActions)
          .opacity(canRunLiveActions ? 1.0 : 0.55)
        Button("Dismiss", action: onDismiss)
          .buttonStyle(ADEKitButtonStyle())
        Spacer(minLength: 0)
      }
    }
    .adeKitCard(padding: 14)
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
