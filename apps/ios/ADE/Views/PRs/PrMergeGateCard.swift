import SwiftUI

// MARK: - Liquid-glass style primitives
//
// Shared across the PR Detail surfaces (Screen, Overview, Checks, Merge gate).
// These are pure presentational helpers — they add no state, no behaviour.

/// Canonical accent palette for the liquid-glass look.
enum PrGlassPalette {
  static let ink = Color(red: 0x07 / 255, green: 0x06 / 255, blue: 0x09 / 255)
  static let purple = Color(red: 0xA7 / 255, green: 0x8B / 255, blue: 0xFA / 255)
  static let purpleBright = Color(red: 0xC4 / 255, green: 0xB1 / 255, blue: 0xFF / 255)
  static let purpleDeep = Color(red: 0x8B / 255, green: 0x5C / 255, blue: 0xF6 / 255)
  static let blue = Color(red: 0x6B / 255, green: 0x8A / 255, blue: 0xFD / 255)
  static let pink = Color(red: 0xF4 / 255, green: 0x72 / 255, blue: 0xB6 / 255)
  static let success = Color(red: 0x4A / 255, green: 0xDE / 255, blue: 0x80 / 255)
  static let warning = Color(red: 0xFB / 255, green: 0xBF / 255, blue: 0x24 / 255)
  static let danger = Color(red: 0xF8 / 255, green: 0x71 / 255, blue: 0x71 / 255)

  static let accentGradient = LinearGradient(
    colors: [purpleBright, purpleDeep],
    startPoint: .topLeading,
    endPoint: .bottomTrailing
  )
}

struct PrGlassCardStyle: ViewModifier {
  var cornerRadius: CGFloat = 18
  var padding: CGFloat? = nil
  var tint: Color? = nil
  var strokeOpacity: Double = 0.10
  var highlightOpacity: Double = 0.14
  var shadow: Bool = true

  func body(content: Content) -> some View {
    content
      .padding(padding ?? 0)
      .background(
        ZStack {
          RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(.ultraThinMaterial)

          if let tint {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
              .fill(tint.opacity(0.14))
          }

          RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(
              LinearGradient(
                colors: [Color.white.opacity(0.08), Color.white.opacity(0.0)],
                startPoint: .top,
                endPoint: .bottom
              )
            )
        }
      )
      .overlay(
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
          .strokeBorder(Color.white.opacity(strokeOpacity), lineWidth: 1)
      )
      .overlay(
        RoundedRectangle(cornerRadius: cornerRadius - 1, style: .continuous)
          .inset(by: 1)
          .stroke(Color.white.opacity(highlightOpacity), lineWidth: 0.5)
          .blendMode(.plusLighter)
      )
      .shadow(
        color: shadow ? Color.black.opacity(0.45) : .clear,
        radius: shadow ? 24 : 0,
        x: 0,
        y: shadow ? 8 : 0
      )
  }
}

extension View {
  func prGlassCard(
    cornerRadius: CGFloat = 18,
    tint: Color? = nil,
    strokeOpacity: Double = 0.10,
    highlightOpacity: Double = 0.14,
    shadow: Bool = true
  ) -> some View {
    modifier(
      PrGlassCardStyle(
        cornerRadius: cornerRadius,
        tint: tint,
        strokeOpacity: strokeOpacity,
        highlightOpacity: highlightOpacity,
        shadow: shadow
      )
    )
  }
}

/// 10pt uppercase bold eyebrow label.
struct PrEyebrow: View {
  let text: String
  var tint: Color = ADEColor.textSecondary

  var body: some View {
    Text(text.uppercased())
      .font(.system(size: 10, weight: .bold))
      .tracking(1)
      .foregroundStyle(tint)
  }
}

// MARK: - Merge gate types

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
  capabilities: PrActionCapabilities?,
  isDraft: Bool = false
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

  if isDraft {
    return PrMergeGateInfo(
      tone: .red,
      subline: "Draft PRs cannot be merged until marked ready for review.",
      target: .overview
    )
  }

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

// MARK: - Liquid-glass merge gate card

struct PrMergeGateCard: View {
  let info: PrMergeGateInfo
  let onTap: () -> Void

  var body: some View {
    Button(action: onTap) {
      Group {
        if info.tone == .green {
          greenHero
        } else {
          compactRow
        }
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(info.title). \(info.subline)")
  }

  // Large hero-tinted card when fully ready.
  private var greenHero: some View {
    HStack(alignment: .center, spacing: 14) {
      statusTile(size: 46, cornerRadius: 14, iconSize: 20)

      VStack(alignment: .leading, spacing: 4) {
        PrEyebrow(text: "Merge gate", tint: info.tone.color.opacity(0.9))
        Text(info.title)
          .font(.system(size: 17, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .tracking(-0.2)
        Text(info.subline)
          .font(.system(size: 11.5, design: .monospaced))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(2)
          .fixedSize(horizontal: false, vertical: true)
      }

      Spacer(minLength: 0)

      Image(systemName: "chevron.right")
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(ADEColor.textMuted)
    }
    .padding(.vertical, 16)
    .padding(.horizontal, 16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .prGlassCard(cornerRadius: 20, tint: info.tone.color.opacity(0.55))
  }

  // Compact attention row (amber/red).
  private var compactRow: some View {
    HStack(alignment: .center, spacing: 12) {
      Image(systemName: info.tone.icon)
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(info.tone.color)
        .shadow(color: info.tone.color.opacity(0.55), radius: 5)
        .frame(width: 22, height: 22)

      VStack(alignment: .leading, spacing: 2) {
        Text(info.title)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(info.tone.color)
          .tracking(-0.1)
        Text(info.subline)
          .font(.system(size: 11, design: .monospaced))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(2)
          .fixedSize(horizontal: false, vertical: true)
      }

      Spacer(minLength: 0)

      Image(systemName: "chevron.right")
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(ADEColor.textMuted)
    }
    .padding(.vertical, 11)
    .padding(.horizontal, 13)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      ZStack {
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .fill(.ultraThinMaterial)
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .fill(info.tone.color.opacity(0.10))
      }
    )
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .strokeBorder(info.tone.color.opacity(0.34), lineWidth: 0.75)
    )
    .shadow(color: Color.black.opacity(0.35), radius: 12, y: 4)
  }

  private func statusTile(size: CGFloat, cornerRadius: CGFloat, iconSize: CGFloat) -> some View {
    ZStack {
      RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        .fill(
          LinearGradient(
            colors: [info.tone.color.opacity(0.32), info.tone.color.opacity(0.14)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          )
        )
      RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        .strokeBorder(info.tone.color.opacity(0.45), lineWidth: 0.75)
      Image(systemName: info.tone.icon)
        .font(.system(size: iconSize, weight: .semibold))
        .foregroundStyle(info.tone.color)
        .shadow(color: info.tone.color.opacity(0.6), radius: 8)
    }
    .frame(width: size, height: size)
  }
}
