import SwiftUI
import UIKit

// MARK: - PR surface style primitives
//
// Shared across the PR Detail surfaces (Screen, Overview, Checks, Merge gate).
// These are pure presentational helpers — they add no state, no behaviour.
//
// Design contract (desktop parity): the PRs tab mirrors the desktop PR detail
// tokens — `--pr-surface` rgb(15,16,16), `--pr-thread-card` rgb(23,23,24),
// `--pr-panel-card` rgb(24,23,43) in dark mode — with light-mode values drawn
// from the app-wide `ADEColor` adaptive system. Cards are FLAT fills with a
// hairline border and a cheap shadow: no live materials, no blend modes, no
// blur layers. Those were the primary scroll-perf cost inside PR detail.

private func prAdaptive(light: UIColor, dark: UIColor) -> Color {
  Color(UIColor { traits in traits.userInterfaceStyle == .dark ? dark : light })
}

private func prRgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ alpha: CGFloat = 1) -> UIColor {
  UIColor(red: r / 255, green: g / 255, blue: b / 255, alpha: alpha)
}

/// Canonical adaptive palette for the PRs surfaces. Legacy names (`ink`,
/// `purple*`, …) are kept so existing call sites keep compiling; they now map
/// onto theme-aware tokens instead of fixed dark-mode RGB values.
enum PrGlassPalette {
  /// Page surface behind the PR list/detail. Desktop `--pr-surface`.
  static let ink = prAdaptive(light: prRgb(245, 243, 240), dark: prRgb(15, 16, 16))
  /// Timeline thread cards. Desktop `--pr-thread-card`.
  static let threadCard = prAdaptive(light: prRgb(255, 255, 255), dark: prRgb(23, 23, 24))
  /// Floating rail/metadata panes. Desktop `--pr-panel-card` (faint violet).
  static let panelCard = prAdaptive(light: prRgb(255, 255, 255), dark: prRgb(24, 23, 43))
  /// Hairline border for cards.
  static let cardBorder = prAdaptive(light: prRgb(26, 26, 30, 0.10), dark: prRgb(255, 255, 255, 0.08))
  /// Card drop shadow (cheap, small radius).
  static let cardShadow = prAdaptive(light: prRgb(0, 0, 0, 0.08), dark: prRgb(0, 0, 0, 0.35))

  // Accents route through the app-wide adaptive tokens so light mode stops
  // rendering the fixed dark-mode violet.
  static var purple: Color { ADEColor.accent }
  static var purpleBright: Color { ADEColor.accentBright }
  static var purpleDeep: Color { ADEColor.accentDeep }
  static var blue: Color { ADEColor.info }
  static var success: Color { ADEColor.success }
  static var warning: Color { ADEColor.warning }
  static var danger: Color { ADEColor.danger }

  static var accentGradient: LinearGradient {
    LinearGradient(
      colors: [ADEColor.accentBright, ADEColor.accentDeep],
      startPoint: .topLeading,
      endPoint: .bottomTrailing
    )
  }
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
            .fill(PrGlassPalette.threadCard)

          if let tint {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
              .fill(tint.opacity(0.08))
          }
        }
      )
      .overlay(
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
          .strokeBorder(
            tint.map { $0.opacity(max(0.30, strokeOpacity)) } ?? PrGlassPalette.cardBorder,
            lineWidth: 1
          )
      )
      .shadow(
        color: shadow ? PrGlassPalette.cardShadow : .clear,
        radius: shadow ? 6 : 0,
        x: 0,
        y: shadow ? 2 : 0
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
/// Precedence (worst wins): conflicts/failing/blockedReason/unresolved review
/// threads → red; pending checks/reviews or rebase-needed → amber; otherwise green.
func prComputeMergeGate(
  status: PrStatus?,
  checks: [PrCheck],
  summaryChecksStatus: String? = nil,
  reviewThreadsUnresolved: Int,
  reviewsNeeded: Int,
  reviewsHave: Int,
  capabilities: PrActionCapabilities?,
  isDraft: Bool = false
) -> PrMergeGateInfo {
  let normalizedSummaryChecksStatus = summaryChecksStatus?.lowercased()
  let summarySaysFailing = checks.isEmpty && ["failing", "failure", "failed"].contains(normalizedSummaryChecksStatus ?? "")
  let summarySaysPending = checks.isEmpty && ["pending", "running", "in_progress", "queued"].contains(normalizedSummaryChecksStatus ?? "")
  let summarySaysPassing = ["passing", "success", "passed"].contains(normalizedSummaryChecksStatus ?? "")
  let failingChecks = checks.filter { check in
    check.status == "completed" &&
      check.conclusion != nil &&
      check.conclusion != "success" &&
      check.conclusion != "neutral" &&
      check.conclusion != "skipped"
  }.count
  let pendingChecks = checks.filter { check in
    let status = check.status.lowercased()
    if status != "completed" { return true }
    return check.conclusion == nil
  }.count
  let failing = failingChecks + (summarySaysFailing ? 1 : 0)
  let pending = pendingChecks + (summarySaysPending && pendingChecks == 0 ? 1 : 0)
  let conflicts = status?.mergeConflicts ?? false
  let blockedReason = capabilities?.mergeBlockedReason?.trimmingCharacters(in: .whitespacesAndNewlines)
  let hasBlockedReason = !(blockedReason?.isEmpty ?? true)
  let behind = status?.behindBaseBy ?? 0
  let mergeable = status?.isMergeable ?? true
  let missingApprovals = max(reviewsNeeded - reviewsHave, 0)

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

  if conflicts || failing > 0 || reviewThreadsUnresolved > 0 || hasBlockedReason {
    var parts: [String] = []
    if summarySaysFailing {
      parts.append("checks failing")
    } else if failingChecks > 0 {
      parts.append("\(failingChecks) failing check\(failingChecks == 1 ? "" : "s")")
    }
    if conflicts {
      parts.append("merge conflicts")
    }
    if missingApprovals > 0 {
      parts.append("\(missingApprovals) approval\(missingApprovals == 1 ? "" : "s") needed")
    } else if reviewsNeeded > 0 || reviewsHave > 0 {
      parts.append(approvalsText)
    }
    if reviewThreadsUnresolved > 0 {
      parts.append("\(reviewThreadsUnresolved) unresolved")
    }
    if let blockedReason, !blockedReason.isEmpty, parts.isEmpty {
      parts.append(blockedReason)
    }
    let subline = parts.isEmpty ? (blockedReason ?? "Merge blocked by machine") : parts.joined(separator: " · ")
    let target: PrMergeGateTarget = (failing > 0 || conflicts) ? .checks : .reviews
    return PrMergeGateInfo(tone: .red, subline: subline, target: target)
  }

  if pending > 0 {
    let subline = pending == 1 ? "1 check pending" : "\(pending) checks pending"
    return PrMergeGateInfo(tone: .amber, subline: subline, target: .checks)
  }

  if missingApprovals > 0 {
    let subline = "\(approvalsText) · \(missingApprovals) approval\(missingApprovals == 1 ? "" : "s") needed"
    return PrMergeGateInfo(tone: .amber, subline: subline, target: .reviews)
  }

  if status == nil && checks.isEmpty && !summarySaysPassing {
    let subline = summarySaysPending ? "Checks pending" : "Waiting for synced PR status"
    return PrMergeGateInfo(tone: .amber, subline: subline, target: .overview)
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
          .fill(PrGlassPalette.threadCard)
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .fill(info.tone.color.opacity(0.08))
      }
    )
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .strokeBorder(info.tone.color.opacity(0.34), lineWidth: 0.75)
    )
  }

  private func statusTile(size: CGFloat, cornerRadius: CGFloat, iconSize: CGFloat) -> some View {
    ZStack {
      RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        .fill(info.tone.color.opacity(0.14))
      RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        .strokeBorder(info.tone.color.opacity(0.45), lineWidth: 0.75)
      Image(systemName: info.tone.icon)
        .font(.system(size: iconSize, weight: .semibold))
        .foregroundStyle(info.tone.color)
    }
    .frame(width: size, height: size)
  }
}
