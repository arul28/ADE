import SwiftUI

/// Derives a coarse risk tone (low/medium/high) from the AI review summary's
/// freeform `mergeReadiness` string. The desktop writes values like `ready`,
/// `needs_changes`, `blocked`, etc; we map those onto a 3-step risk scale.
private func prInferRiskTone(_ readiness: String?) -> (label: String, tint: Color) {
  let raw = (readiness ?? "").lowercased()
  if raw.contains("block") || raw.contains("high") {
    return ("high risk", PrGlassPalette.danger)
  }
  if raw.contains("needs") || raw.contains("medium") || raw.contains("warn") || raw.contains("attention") {
    return ("medium risk", PrGlassPalette.warning)
  }
  if raw.contains("ready") || raw.contains("low") {
    return ("low risk", PrGlassPalette.success)
  }
  return ("summary", PrGlassPalette.purple)
}

/// AI summary card on the PR Overview tab. Liquid-glass treatment:
/// purple-gradient icon disc with a soft halo, eyebrow label, body text,
/// and a tinted chip row. Parent owns the fetch; this view is pure
/// presentation + a regenerate CTA.
struct PrAiSummaryCard: View {
  let summary: AiReviewSummary?
  let additions: Int
  let deletions: Int
  let fileCount: Int
  let isLoading: Bool
  let isLive: Bool
  let onRegenerate: () -> Void

  var body: some View {
    let risk = prInferRiskTone(summary?.mergeReadiness)
    return VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 12) {
        iconDisc

        VStack(alignment: .leading, spacing: 6) {
          PrsEyebrowLabel(text: "AI REVIEW", tint: PrGlassPalette.purpleBright)

          if let summary, !summary.summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            Text(summary.summary)
              .font(.system(size: 13, weight: .regular))
              .foregroundStyle(ADEColor.textPrimary)
              .lineSpacing(3)
              .fixedSize(horizontal: false, vertical: true)
          } else if isLoading {
            HStack(spacing: 8) {
              ProgressView().tint(PrGlassPalette.purpleBright)
              Text("Generating AI summary…")
                .font(.system(size: 13))
                .foregroundStyle(ADEColor.textSecondary)
            }
          } else {
            Text("No AI review summary has been generated yet.")
              .font(.system(size: 13))
              .foregroundStyle(ADEColor.textSecondary)
          }
        }

        Spacer(minLength: 0)
      }

      HStack(spacing: 6) {
        PrAiSummaryChip(text: risk.label, tint: risk.tint)
        PrAiSummaryChip(text: "+\(additions) / −\(deletions)", tint: PrGlassPalette.blue)
        PrAiSummaryChip(text: "\(fileCount) file\(fileCount == 1 ? "" : "s")", tint: PrGlassPalette.purple)
        Spacer(minLength: 0)
        Button(action: onRegenerate) {
          HStack(spacing: 4) {
            Image(systemName: "arrow.clockwise")
              .font(.system(size: 11, weight: .semibold))
            Text(summary == nil ? "Generate" : "Regenerate")
              .font(.system(size: 11, weight: .semibold))
          }
          .foregroundStyle(PrGlassPalette.purpleBright)
          .padding(.horizontal, 10)
          .padding(.vertical, 5)
          .background(
            Capsule(style: .continuous)
              .fill(PrGlassPalette.purple.opacity(0.14))
          )
          .overlay(
            Capsule(style: .continuous)
              .strokeBorder(PrGlassPalette.purple.opacity(0.35), lineWidth: 0.5)
          )
        }
        .buttonStyle(.plain)
        .disabled(!isLive || isLoading)
        .opacity(isLive && !isLoading ? 1 : 0.5)
      }

      if let summary, !summary.potentialIssues.isEmpty {
        VStack(alignment: .leading, spacing: 5) {
          ForEach(summary.potentialIssues.prefix(3), id: \.self) { issue in
            HStack(alignment: .top, spacing: 7) {
              Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 9))
                .foregroundStyle(PrGlassPalette.warning)
                .padding(.top, 3)
              Text(issue)
                .font(.system(size: 11.5))
                .foregroundStyle(ADEColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
        }
        .padding(.top, 2)
      }
    }
  }

  /// Purple-gradient icon disc with a soft outer glow.
  private var iconDisc: some View {
    ZStack {
      Circle()
        .fill(PrGlassPalette.purple.opacity(0.55))
        .frame(width: 36, height: 36)
        .blur(radius: 10)
        .opacity(0.7)

      Circle()
        .fill(
          LinearGradient(
            colors: [PrGlassPalette.purpleBright, PrGlassPalette.purpleDeep],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          )
        )
        .frame(width: 28, height: 28)

      Circle()
        .strokeBorder(
          LinearGradient(
            colors: [Color.white.opacity(0.55), .clear],
            startPoint: .top,
            endPoint: .center
          ),
          lineWidth: 1
        )
        .frame(width: 28, height: 28)

      Image(systemName: "sparkles")
        .font(.system(size: 13, weight: .bold))
        .foregroundStyle(.white)
        .symbolEffect(.pulse, options: .repeat(.continuous))
    }
  }
}

private struct PrAiSummaryChip: View {
  let text: String
  let tint: Color

  var body: some View {
    Text(text)
      .font(.system(size: 10, weight: .bold))
      .foregroundStyle(tint)
      .padding(.horizontal, 9)
      .padding(.vertical, 4)
      .background(
        Capsule(style: .continuous)
          .fill(tint.opacity(0.16))
      )
      .overlay(
        Capsule(style: .continuous)
          .strokeBorder(tint.opacity(0.40), lineWidth: 0.5)
      )
  }
}
