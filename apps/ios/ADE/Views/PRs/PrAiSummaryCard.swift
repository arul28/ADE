import SwiftUI

/// Derives a coarse risk tone (low/medium/high) from the AI review summary's
/// freeform `mergeReadiness` string. The desktop writes values like `ready`,
/// `needs_changes`, `blocked`, etc; we map those onto a 3-step risk scale.
private func prInferRiskTone(_ readiness: String?) -> (label: String, tint: Color) {
  let raw = (readiness ?? "").lowercased()
  if raw.contains("block") || raw.contains("high") {
    return ("high risk", ADEColor.danger)
  }
  if raw.contains("needs") || raw.contains("medium") || raw.contains("warn") || raw.contains("attention") {
    return ("medium risk", ADEColor.warning)
  }
  if raw.contains("ready") || raw.contains("low") {
    return ("low risk", ADEColor.success)
  }
  return ("summary", ADEColor.accent)
}

/// AI summary card on the PR Overview tab. Renders a compact violet
/// spark icon, the summary text, and trailing risk / +add-rem / files chips.
/// Parent owns the fetch; this view is pure presentation + a regenerate CTA.
struct PrAiSummaryCard: View {
  let summary: AiReviewSummary?
  let additions: Int
  let deletions: Int
  let fileCount: Int
  let isLoading: Bool
  let isLive: Bool
  let onRegenerate: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 10) {
        ZStack {
          RoundedRectangle(cornerRadius: 6, style: .continuous)
            .fill(ADEColor.tintPRs.opacity(0.14))
          RoundedRectangle(cornerRadius: 6, style: .continuous)
            .strokeBorder(ADEColor.tintPRs.opacity(0.3), lineWidth: 0.5)
          Image(systemName: "sparkles")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(ADEColor.tintPRs)
        }
        .frame(width: 22, height: 22)

        if let summary, !summary.summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          Text(summary.summary)
            .font(.system(size: 13, weight: .regular))
            .foregroundStyle(ADEColor.textPrimary)
            .lineSpacing(3)
            .fixedSize(horizontal: false, vertical: true)
        } else if isLoading {
          HStack(spacing: 8) {
            ProgressView().tint(ADEColor.tintPRs)
            Text("Generating AI summary…")
              .font(.system(size: 13))
              .foregroundStyle(ADEColor.textSecondary)
          }
        } else {
          Text("No AI review summary has been generated yet.")
            .font(.system(size: 13))
            .foregroundStyle(ADEColor.textSecondary)
        }

        Spacer(minLength: 0)
      }

      HStack(spacing: 6) {
        let risk = prInferRiskTone(summary?.mergeReadiness)
        PrAiSummaryChip(text: risk.label, tint: risk.tint)
        PrAiSummaryChip(text: "+\(additions) / −\(deletions)", tint: ADEColor.textSecondary)
        PrAiSummaryChip(text: "\(fileCount) file\(fileCount == 1 ? "" : "s")", tint: ADEColor.textSecondary)
        Spacer(minLength: 0)
        Button(action: onRegenerate) {
          HStack(spacing: 4) {
            Image(systemName: "arrow.clockwise")
              .font(.system(size: 11, weight: .semibold))
            Text(summary == nil ? "Generate" : "Regenerate")
              .font(.system(size: 11, weight: .semibold))
          }
          .foregroundStyle(ADEColor.tintPRs)
        }
        .buttonStyle(.plain)
        .disabled(!isLive || isLoading)
        .opacity(isLive && !isLoading ? 1 : 0.5)
      }

      if let summary, !summary.potentialIssues.isEmpty {
        VStack(alignment: .leading, spacing: 4) {
          ForEach(summary.potentialIssues.prefix(3), id: \.self) { issue in
            HStack(alignment: .top, spacing: 6) {
              Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 9))
                .foregroundStyle(ADEColor.warning)
                .padding(.top, 3)
              Text(issue)
                .font(.system(size: 11.5))
                .foregroundStyle(ADEColor.textSecondary)
            }
          }
        }
      }
    }
  }
}

private struct PrAiSummaryChip: View {
  let text: String
  let tint: Color

  var body: some View {
    Text(text)
      .font(.system(size: 10, weight: .semibold))
      .foregroundStyle(tint)
      .padding(.horizontal, 7)
      .padding(.vertical, 3)
      .background(
        Capsule(style: .continuous)
          .fill(tint.opacity(0.14))
      )
      .overlay(
        Capsule(style: .continuous)
          .strokeBorder(tint.opacity(0.3), lineWidth: 0.5)
      )
  }
}
