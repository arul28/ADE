import SwiftUI

struct LaneEnvInitProgressView: View {
  let progress: LaneEnvInitProgress

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      header

      VStack(alignment: .leading, spacing: 12) {
        ForEach(progress.steps) { step in
          LaneEnvInitStepRow(step: step)
        }
      }

      if progress.steps.isEmpty {
        Text("No environment steps reported.")
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .adeGlassCard(cornerRadius: 14, padding: 14)
    .padding(.bottom, 4)
    .accessibilityElement(children: .contain)
  }

  @ViewBuilder
  private var header: some View {
    HStack(spacing: 8) {
      Text("Environment setup")
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      Spacer()
      statusChip
    }
  }

  @ViewBuilder
  private var statusChip: some View {
    switch progress.overallStatus {
    case "completed":
      LaneMicroChip(icon: "checkmark.circle.fill", text: "Done", tint: ADEColor.success)
    case "failed":
      LaneMicroChip(icon: "xmark.octagon.fill", text: "Failed", tint: ADEColor.danger)
    case "running":
      LaneMicroChip(icon: "hourglass", text: "Running", tint: ADEColor.warning)
    default:
      LaneMicroChip(icon: "circle", text: progress.overallStatus.capitalized, tint: ADEColor.textSecondary)
    }
  }
}

private struct LaneEnvInitStepRow: View {
  let step: LaneEnvInitStep

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      iconView
        .frame(width: 18, height: 18)
        .padding(.top, 1)

      VStack(alignment: .leading, spacing: 4) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(step.label)
            .font(.subheadline)
            .foregroundStyle(ADEColor.textPrimary)
          Spacer()
          if let durationMs = step.durationMs, step.status == "completed" {
            Text(String(format: "%.1fs", Double(durationMs) / 1000.0))
              .font(.system(.caption2, design: .monospaced))
              .foregroundStyle(ADEColor.textMuted)
          }
        }
        if let error = step.error, !error.isEmpty {
          Text(error)
            .font(.caption)
            .foregroundStyle(ADEColor.danger)
            .lineLimit(3)
        }
      }
    }
  }

  @ViewBuilder
  private var iconView: some View {
    switch step.status {
    case "completed":
      Image(systemName: "checkmark.circle.fill")
        .foregroundStyle(ADEColor.success)
        .font(.system(size: 14, weight: .semibold))
    case "running":
      ProgressView()
        .controlSize(.mini)
    case "failed":
      Image(systemName: "xmark.octagon.fill")
        .foregroundStyle(ADEColor.danger)
        .font(.system(size: 14, weight: .semibold))
    case "skipped":
      Image(systemName: "minus.circle")
        .foregroundStyle(ADEColor.textMuted)
        .font(.system(size: 14, weight: .semibold))
    default:
      Image(systemName: "circle")
        .foregroundStyle(ADEColor.textMuted)
        .font(.system(size: 14, weight: .semibold))
    }
  }
}

struct LaneEnvInitProgressPanel: View {
  let progress: LaneEnvInitProgress?
  let isPolling: Bool
  let onDone: () -> Void

  var body: some View {
    VStack(spacing: 14) {
      if let progress {
        LaneEnvInitProgressView(progress: progress)
      } else {
        VStack(spacing: 10) {
          ProgressView()
          Text("Preparing environment…")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
        .frame(maxWidth: .infinity)
        .adeGlassCard(cornerRadius: 14, padding: 18)
      }

      Button(action: onDone) {
        Text(doneTitle)
          .font(.subheadline.weight(.semibold))
          .frame(maxWidth: .infinity)
          .padding(.vertical, 6)
      }
      .buttonStyle(.glassProminent)
      .disabled(disableDone)
    }
  }

  private var doneTitle: String {
    guard let progress else { return "Working…" }
    switch progress.overallStatus {
    case "completed": return "Done"
    case "failed": return "Dismiss"
    case "running": return isPolling ? "Working…" : "Hide"
    default: return "Done"
    }
  }

  private var disableDone: Bool {
    guard let progress else { return true }
    return progress.overallStatus == "running"
  }
}
