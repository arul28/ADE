import SwiftUI

struct PrChecksTab: View {
  let checks: [PrCheck]
  let actionRuns: [PrActionRun]
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

      if !actionRuns.isEmpty {
        PrDetailSectionCard("Action runs") {
          VStack(alignment: .leading, spacing: 12) {
            ForEach(actionRuns) { run in
              PrActionRunRow(run: run)
            }
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
            if let url = URL(string: detailsUrl) {
              Link(destination: url) {
                Label("Open check details", systemImage: "arrow.up.right.square")
                  .font(.caption.weight(.semibold))
              }
              .foregroundStyle(ADEColor.accent)
            } else {
              Text(detailsUrl)
                .font(.caption2)
                .foregroundStyle(ADEColor.textMuted)
                .lineLimit(1)
            }
          }
        }
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

struct PrActionRunRow: View {
  let run: PrActionRun
  @State private var expanded = false

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Button {
        withAnimation(.snappy) {
          expanded.toggle()
        }
      } label: {
        HStack(alignment: .top, spacing: 10) {
          Image(systemName: run.conclusion == "success" ? "checkmark.circle.fill" : run.status == "completed" ? "xmark.circle.fill" : "circle.dashed")
            .foregroundStyle(run.conclusion == "success" ? ADEColor.success : run.status == "completed" ? ADEColor.danger : ADEColor.warning)
          VStack(alignment: .leading, spacing: 4) {
            Text(run.name)
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
            Text((run.conclusion ?? run.status).replacingOccurrences(of: "_", with: " ").uppercased())
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
          Spacer(minLength: 0)
          Image(systemName: expanded ? "chevron.up" : "chevron.down")
            .font(.caption.weight(.bold))
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      .buttonStyle(.plain)

      if expanded {
        ForEach(run.jobs) { job in
          VStack(alignment: .leading, spacing: 6) {
            HStack {
              Text(job.name)
                .font(.caption.weight(.semibold))
                .foregroundStyle(ADEColor.textPrimary)
              Spacer(minLength: 0)
              Text((job.conclusion ?? job.status).uppercased())
                .font(.caption2.weight(.bold))
                .foregroundStyle(job.conclusion == "success" ? ADEColor.success : ADEColor.textSecondary)
            }
            ForEach(job.steps.prefix(6)) { step in
              HStack(spacing: 8) {
                Text("\(step.number)")
                  .font(.caption2.monospacedDigit())
                  .foregroundStyle(ADEColor.textMuted)
                Text(step.name)
                  .font(.caption2)
                  .foregroundStyle(ADEColor.textSecondary)
                Spacer(minLength: 0)
                Text((step.conclusion ?? step.status).uppercased())
                  .font(.caption2)
                  .foregroundStyle(ADEColor.textMuted)
              }
            }
          }
          .adeInsetField(cornerRadius: 12, padding: 10)
        }

        if let url = URL(string: run.htmlUrl), !run.htmlUrl.isEmpty {
          Link(destination: url) {
            Label("Open run", systemImage: "arrow.up.right.square")
              .font(.caption.weight(.semibold))
          }
          .foregroundStyle(ADEColor.accent)
        }
      }
    }
    .adeInsetField(cornerRadius: 14, padding: 12)
  }
}
