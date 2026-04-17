import SwiftUI

struct LaneDetailRebaseBanner: View {
  let behindCount: Int
  let parentLabel: String?
  let canRunLiveActions: Bool
  let onRebase: () -> Void
  let onDefer: () -> Void
  let onDismiss: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .center, spacing: 10) {
        Image(systemName: "exclamationmark.arrow.triangle.2.circlepath")
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(ADEColor.warning)
          .frame(width: 28, height: 28)
          .background(ADEColor.warning.opacity(0.16), in: Circle())

        VStack(alignment: .leading, spacing: 2) {
          Text("Rebase suggested")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(headline)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }

        Spacer(minLength: 4)
      }

      HStack(spacing: 8) {
        Button(action: onRebase) {
          HStack(spacing: 6) {
            Image(systemName: "arrow.triangle.branch")
              .font(.system(size: 12, weight: .semibold))
            Text("Rebase")
              .font(.subheadline.weight(.semibold))
          }
          .foregroundStyle(ADEColor.textPrimary)
          .padding(.horizontal, 14)
          .padding(.vertical, 9)
          .background(ADEColor.warning.opacity(0.24), in: Capsule())
          .overlay(Capsule().stroke(ADEColor.warning.opacity(0.5), lineWidth: 0.6))
        }
        .buttonStyle(.plain)
        .disabled(!canRunLiveActions)

        Button("Defer", action: onDefer)
          .buttonStyle(.plain)
          .font(.caption.weight(.medium))
          .foregroundStyle(ADEColor.textSecondary)
          .padding(.horizontal, 10)
          .padding(.vertical, 8)

        Button("Dismiss", action: onDismiss)
          .buttonStyle(.plain)
          .font(.caption.weight(.medium))
          .foregroundStyle(ADEColor.textMuted)
          .padding(.horizontal, 10)
          .padding(.vertical, 8)

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
    .accessibilityLabel("Rebase suggested. \(headline)")
  }

  private var headline: String {
    let noun = behindCount == 1 ? "commit" : "commits"
    if let parentLabel, !parentLabel.isEmpty {
      return "Behind \(parentLabel) by \(behindCount) \(noun)"
    }
    return "Behind parent by \(behindCount) \(noun)"
  }
}
