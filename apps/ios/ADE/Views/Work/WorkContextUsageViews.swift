import SwiftUI

struct WorkContextUsageMeter: View {
  let usage: WorkContextUsageViewModel
  @Binding var isPresented: Bool

  private var percent: Int? {
    guard usage.state == .measured else { return nil }
    return usage.ratio.map { Int(($0 * 100).rounded()) }
  }

  private var ringColor: Color {
    guard let ratio = usage.ratio else { return ADEColor.textSecondary }
    if ratio >= 0.9 { return ADEColor.danger }
    if ratio >= 0.7 { return ADEColor.warning }
    return Color(red: 0.22, green: 0.74, blue: 0.97)
  }

  private var accessibilityLabel: String {
    switch usage.state {
    case .compacting:
      return "Context usage: compacting"
    case .recalculating:
      return "Context usage: recalculating"
    case .unknown:
      return "Context usage unavailable"
    case .measured:
      return percent.map { "Context usage: \($0)% full" } ?? "Context usage"
    }
  }

  var body: some View {
    if usage.state != .measured || usage.ratio != nil || usage.usedTokens != nil {
      Button {
        withAnimation(.easeInOut(duration: 0.18)) {
          isPresented.toggle()
        }
      } label: {
        ZStack {
          if usage.state != .measured {
            Circle()
              .stroke(Color.white.opacity(0.12), lineWidth: 1.5)
              .frame(width: 22, height: 22)
            Text(usage.state == .unknown ? "?" : "…")
              .font(.system(size: 10, weight: .semibold, design: .rounded))
              .foregroundStyle(ADEColor.textSecondary)
          } else if let ratio = usage.ratio, let percent {
            Circle()
              .stroke(Color.white.opacity(0.10), lineWidth: 2.5)
              .frame(width: 22, height: 22)

            Circle()
              .trim(from: 0, to: CGFloat(ratio))
              .stroke(ringColor, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
              .rotationEffect(.degrees(-90))
              .frame(width: 22, height: 22)

            Text("\(percent)")
              .font(.system(size: percent >= 100 ? 7 : 8, weight: .semibold, design: .rounded))
              .monospacedDigit()
              .foregroundStyle(ADEColor.textPrimary.opacity(0.78))
              .minimumScaleFactor(0.65)
          } else if let usedTokens = usage.usedTokens {
            Text(workAbbreviateCount(usedTokens))
              .font(.system(size: 10, weight: .semibold, design: .rounded))
              .monospacedDigit()
              .foregroundStyle(ADEColor.textSecondary)
              .minimumScaleFactor(0.7)
          }
        }
        .frame(width: 28, height: 28)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(accessibilityLabel)
      .accessibilityHint(isPresented ? "Dismisses context usage details" : "Shows context usage details")
      .adeInspectable(
        "Work.Chat.Composer.ContextUsageMeter",
        metadata: [
          "label": percent.map { "Context usage: \($0)% full" } ?? "Context usage",
          "role": "button"
        ]
      )
    }
  }
}

struct WorkContextUsagePopover: View {
  let usage: WorkContextUsageViewModel
  let modelLabel: String?

  private var percent: Int? {
    guard usage.state == .measured else { return nil }
    return usage.ratio.map { Int(($0 * 100).rounded()) }
  }

  private var windowLabel: String? {
    usage.contextWindow.map { workAbbreviateCount($0) }
  }

  private var usedLabel: String? {
    usage.usedTokens.map { workAbbreviateCount($0) }
  }

  private var description: String {
    if usage.state == .compacting {
      return "The runtime is compacting this chat. The previous exact reading is temporarily hidden."
    }
    if usage.state == .recalculating {
      return "Compaction finished. ADE is waiting for the next authoritative usage snapshot."
    }
    if usage.state == .unknown {
      return "The runtime did not return an authoritative context reading."
    }
    let model = modelLabel?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let percent, let windowLabel {
      let owner: String
      if let model, !model.isEmpty {
        owner = "\(model)'s "
      } else {
        owner = "the "
      }
      let estimated = usage.windowSource == .registry ? " (estimated)" : ""
      return "Using \(percent)% of \(owner)\(windowLabel)-token context window\(estimated)."
    }
    let used = usedLabel ?? "--"
    if let model, !model.isEmpty {
      return "\(used) tokens used so far by \(model); context window unknown."
    }
    return "\(used) tokens used so far; context window unknown."
  }

  private var breakdown: String? {
    guard usage.state == .measured else { return nil }
    var segments: [String] = []
    if let value = usage.inputTokens { segments.append("in \(workAbbreviateCount(value))") }
    if let value = usage.outputTokens { segments.append("out \(workAbbreviateCount(value))") }
    if let value = usage.cacheReadTokens { segments.append("cached \(workAbbreviateCount(value)) *") }
    if let value = usage.reasoningTokens { segments.append("reasoning \(workAbbreviateCount(value))") }
    return segments.isEmpty ? nil : segments.joined(separator: " · ")
  }

  private var effect: String? {
    guard let percent, let windowLabel else { return nil }
    return "\(usedLabel ?? "--") / \(windowLabel) tokens · \(percent)% full"
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      Text("Context usage")
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)

      Text(description)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)

      if breakdown != nil || effect != nil {
        Rectangle()
          .fill(ADEColor.border.opacity(0.35))
          .frame(height: 1)
      }

      if let breakdown {
        Text(breakdown)
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(2)
          .fixedSize(horizontal: false, vertical: true)
      }

      if let effect {
        Text(effect)
          .font(.caption.monospacedDigit())
          .foregroundStyle((usage.ratio ?? 0) >= 0.8 ? ADEColor.warning : ADEColor.success)
          .lineLimit(1)
          .minimumScaleFactor(0.7)
      }

      if usage.state == .measured, let ratio = usage.ratio, ratio >= 0.8 {
        Text("Nearing the limit; older context may be auto-trimmed or compacted.")
          .font(.caption2)
          .foregroundStyle(ADEColor.warning)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(14)
    .frame(minWidth: 240, idealWidth: 300, maxWidth: 320, alignment: .leading)
    .fixedSize(horizontal: false, vertical: true)
    .accessibilityIdentifier("Work.Chat.Composer.ContextUsagePopover")
  }
}
