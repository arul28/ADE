import SwiftUI

/// Inline divider that marks a point in the transcript where the host
/// compacted context (auto or manual). Renders as a horizontal hairline
/// with a centered chip so users know context was trimmed without losing
/// their scroll position to a full card.
///
/// Port of the desktop `context_compact` divider
/// (apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx:1627).
struct WorkContextCompactDivider: View {
  let summary: String?
  /// True while the host is mid-compaction (`state: "started"`). Renders a live
  /// "Compacting context…" chip with a spinner; flips to the static
  /// "Context compacted" chip once the completed event merges into this card.
  var isInProgress: Bool = false

  private var parsed: WorkContextCompactSummary {
    WorkContextCompactSummary.parse(summary)
  }

  var body: some View {
    HStack(spacing: 10) {
      Rectangle()
        .fill(
          LinearGradient(
            colors: [.clear, ADEColor.warning.opacity(0.22), .clear],
            startPoint: .leading,
            endPoint: .trailing
          )
        )
        .frame(height: 0.6)

      chip

      Rectangle()
        .fill(
          LinearGradient(
            colors: [.clear, ADEColor.warning.opacity(0.22), .clear],
            startPoint: .trailing,
            endPoint: .leading
          )
        )
        .frame(height: 0.6)
    }
    .padding(.vertical, 4)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(isInProgress ? "Compacting context" : parsed.accessibilityLabel)
  }

  @ViewBuilder
  private var chip: some View {
    HStack(spacing: 6) {
      if isInProgress {
        ProgressView()
          .controlSize(.mini)
          .tint(ADEColor.warning)
        Text("Compacting context…")
          .font(.caption2.weight(.semibold))
          .tracking(0.3)
        if let triggerLabel = parsed.triggerLabel {
          Text(triggerLabel)
            .font(.caption2.weight(.bold))
            .tracking(0.3)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(ADEColor.warning.opacity(0.14), in: Capsule())
        }
      } else {
        Image(systemName: "rectangle.compress.vertical")
          .font(.caption2.weight(.bold))
        Text("Context compacted")
          .font(.caption2.weight(.semibold))
          .tracking(0.3)
        if let tokensFreedLabel = parsed.tokensFreedLabel {
          Text("·").foregroundStyle(ADEColor.warning.opacity(0.4))
          Text(tokensFreedLabel)
            .font(.caption2.monospaced())
            .foregroundStyle(ADEColor.warning.opacity(0.7))
        }
        if let triggerLabel = parsed.triggerLabel {
          Text(triggerLabel)
            .font(.caption2.weight(.bold))
            .tracking(0.3)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(ADEColor.warning.opacity(0.14), in: Capsule())
        }
      }
    }
    .foregroundStyle(ADEColor.warning)
    .padding(.horizontal, 10)
    .padding(.vertical, 5)
    .background(ADEColor.warning.opacity(0.08), in: Capsule())
    .overlay(
      Capsule().stroke(ADEColor.warning.opacity(0.2), lineWidth: 0.5)
    )
  }
}

/// Parses the free-form summary string emitted by `contextCompact` events
/// into a display label. Looks for two hints: a "~Ntokens" style fragment
/// and an "auto" / "manual" trigger tag. Anything else falls back to just
/// the base label.
struct WorkContextCompactSummary: Equatable {
  let tokensFreedLabel: String?
  let triggerLabel: String?

  var accessibilityLabel: String {
    var parts = ["Context compacted"]
    if let tokensFreedLabel { parts.append(tokensFreedLabel) }
    if let triggerLabel { parts.append(triggerLabel.lowercased()) }
    return parts.joined(separator: ", ")
  }

  static func parse(_ raw: String?) -> WorkContextCompactSummary {
    guard let raw = raw?.lowercased() else {
      return WorkContextCompactSummary(tokensFreedLabel: nil, triggerLabel: nil)
    }

    let trigger: String?
    if raw.range(of: #"\bauto\b"#, options: .regularExpression) != nil {
      trigger = "AUTO"
    } else if raw.range(of: #"\bmanual\b"#, options: .regularExpression) != nil {
      trigger = "MANUAL"
    } else {
      trigger = nil
    }

    let tokens = extractTokenCount(raw).map { count -> String in
      let rounded = formatCompactTokenCount(count)
      return "~\(rounded) freed"
    }

    return WorkContextCompactSummary(tokensFreedLabel: tokens, triggerLabel: trigger)
  }

  private static func extractTokenCount(_ raw: String) -> Int? {
    // Matches the first integer (possibly with commas) that appears
    // alongside the substring "token" in a summary like
    // "~12,400 tokens freed" or "Freed 8_200 tokens".
    guard raw.contains("token") else { return nil }
    var digits = ""
    var seenDigit = false
    for char in raw {
      if char.isNumber {
        digits.append(char)
        seenDigit = true
      } else if seenDigit && (char == "," || char == "_") {
        continue
      } else if seenDigit {
        break
      }
    }
    return Int(digits)
  }

  private static func formatCompactTokenCount(_ count: Int) -> String {
    if count < 1000 { return "\(count) tokens" }
    let value = Double(count) / 1000.0
    if value < 10 {
      return String(format: "%.1fk tokens", value)
    }
    return "\(Int(value.rounded()))k tokens"
  }
}
