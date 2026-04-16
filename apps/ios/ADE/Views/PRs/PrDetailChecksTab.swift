import SwiftUI

struct PrChecksTab: View {
  let checks: [PrCheck]
  let canRerunChecks: Bool
  let isLive: Bool
  let onRerun: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      PrDetailSectionCard("Checks") {
        VStack(alignment: .leading, spacing: 10) {
          Button("Re-run failed checks") {
            onRerun()
          }
          .buttonStyle(.glass)
          .disabled(!canRerunChecks || !isLive || checks.isEmpty)

          if !canRerunChecks {
            Text("This host has not exposed PR check reruns to the mobile sync channel yet.")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
        }
      }

      if checks.isEmpty {
        ADEEmptyStateView(
          symbol: "checklist",
          title: "No CI checks",
          message: "No check runs were synced for this PR yet."
        )
      } else {
        VStack(spacing: 12) {
          ForEach(checks) { check in
            PrCheckRow(check: check)
          }
        }
      }
    }
  }
}

struct PrCheckRow: View {
  let check: PrCheck

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: checkSymbol(check))
          .foregroundStyle(prChecksTint(check.status == "completed" ? (check.conclusion == "success" ? "passing" : check.conclusion == "failure" ? "failing" : "none") : "pending"))
          .padding(.top, 2)

        VStack(alignment: .leading, spacing: 4) {
          Text(check.name)
            .foregroundStyle(ADEColor.textPrimary)
          Text(prCheckStatusLabel(check))
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)

          if let duration = prDurationText(startedAt: check.startedAt, completedAt: check.completedAt) {
            Text(duration)
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted)
          }

          if let detailsUrl = check.detailsUrl, !detailsUrl.isEmpty {
            Text(detailsUrl)
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
          }
        }
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }
}
