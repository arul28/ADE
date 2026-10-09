import SwiftUI

/// A quiet boundary in the visible transcript; compaction only changes model context.
struct WorkContextCompactDivider: View {
  let summary: String?
  var isInProgress: Bool = false
  var sessionCompactionCount: Int? = nil
  var provider: String? = nil
  var startedAt: String? = nil
  var onRetry: (() -> Void)? = nil
  @State private var expanded = false

  /// The structured lines only; provider text after `summary:` never counts.
  private var header: [String] {
    summary.map { workCompactSummaryHeader($0).components(separatedBy: "\n") } ?? []
  }
  private func field(_ key: String) -> String? {
    header.first(where: { $0.hasPrefix(key + ":") }).map { String($0.dropFirst(key.count + 1)) }
  }
  private var failed: Bool { field("state") == "failed" }
  /// The provider's own text. The parser writes it last behind a line-anchored
  /// `summary:` header, so match that line rather than any `summary:` substring
  /// (a failure message or account label could contain one).
  private var providerSummary: String? {
    guard let summary else { return nil }
    var lines = summary.components(separatedBy: "\n")
    guard let index = lines.firstIndex(where: { $0.hasPrefix("summary:") }) else { return nil }
    lines[index] = String(lines[index].dropFirst("summary:".count))
    return lines[index...].joined(separator: "\n")
  }
  private func title(at now: Date) -> String {
    if failed {
      let detail = field("failure") ?? ""
      let reason = detail.localizedCaseInsensitiveContains("weekly limit") ? "weekly limit" : detail.localizedCaseInsensitiveContains("usage limit") ? "usage limit" : nil
      // Matches desktop compactionFailLabel: only a timeout gets its own label.
      let base = field("failReason") == "timed_out" ? "Compaction timed out" : "Compaction failed"
      return base + (reason.map { " · " + $0 + (field("account").map { " on " + $0 } ?? "") } ?? "")
    }
    if isInProgress {
      let tokens = field("Pre-compact tokens").flatMap { Int($0.trimmingCharacters(in: .whitespaces)) }.map { " · \(workAbbreviateCount($0)) tokens" } ?? ""
      let elapsed = startedAt.flatMap(workParsedDate).map { max(0, Int(now.timeIntervalSince($0))) } ?? 0
      return "Compacting context" + tokens + (elapsed >= 5 ? " · \(elapsed) s" : "")
    }
    let parsed = WorkContextCompactSummary.parse(summary)
    return "Context compacted" + (parsed.tokensLabel.map { " · " + $0 } ?? "") + (parsed.durationLabel.map { " · " + $0 } ?? "")
  }
  private var trigger: String {
    if header.contains("Manual") { return "you asked" }
    if header.contains("Ade Fallback") { return "ADE (near limit)" }
    return "automatic"
  }
  private var countLabel: String {
    guard let count = field("sessionCount").flatMap(Int.init) ?? sessionCompactionCount, count >= 2 else { return "" }
    let suffix: String
    switch count % 100 {
    case 11...13:
      suffix = "th"
    default:
      switch count % 10 {
      case 1: suffix = "st"
      case 2: suffix = "nd"
      case 3: suffix = "rd"
      default: suffix = "th"
      }
    }
    return " · \(count)\(suffix) this chat"
  }
  var body: some View {
    VStack(spacing: 4) {
      TimelineView(.animation(minimumInterval: 1, paused: !isInProgress)) { context in
        HStack(spacing: 6) {
          hairline
          Image(systemName: failed ? "exclamationmark.circle" : "rectangle.compress.vertical")
          Button { expanded.toggle() } label: { Text(title(at: context.date)) }
            .buttonStyle(.plain)
            .disabled(providerSummary == nil)
          if !isInProgress && !failed { Text(trigger + countLabel).foregroundStyle(ADEColor.textMuted) }
          if failed, let onRetry { Button("Retry", action: onRetry).buttonStyle(.plain) }
          hairline
        }
        .font(.caption2)
        .foregroundStyle(failed ? ADEColor.warning : ADEColor.textSecondary)
        .frame(minHeight: 28)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title(at: context.date))
      }
      if expanded, let providerSummary {
        Text(providerSummary).font(.caption).foregroundStyle(ADEColor.textSecondary).frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .padding(.vertical, 4)
  }
  private var hairline: some View {
    Rectangle().fill(ADEColor.glassBorder).frame(minWidth: 8, maxWidth: .infinity).frame(height: 0.6)
  }
}

/// Calm transcript boundary used when Claude starts a fresh conversation
/// while retaining the same ADE chat session.
struct WorkConversationResetDivider: View {
  var body: some View {
    HStack(spacing: 8) {
      hairline
      HStack(spacing: 6) {
        Image(systemName: "arrow.counterclockwise")
          .font(.caption2.weight(.bold))
        Text("New conversation")
          .font(.caption2.weight(.semibold))
          .tracking(0.3)
      }
      .foregroundStyle(ADEColor.textMuted)
      .padding(.horizontal, 10)
      .padding(.vertical, 5)
      .background(ADEColor.textMuted.opacity(0.07), in: Capsule())
      .overlay(Capsule().stroke(ADEColor.glassBorder, lineWidth: 0.5))
      hairline
    }
    .padding(.vertical, 4)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("New conversation")
  }

  private var hairline: some View {
    Rectangle()
      .fill(ADEColor.glassBorder)
      .frame(minWidth: 8, maxWidth: .infinity)
      .frame(height: 0.6)
  }
}

/// Parses the free-form summary string emitted by `contextCompact` events
/// into a display label. Looks for two hints: a "~Ntokens" style fragment
/// and an "auto" / "manual" trigger tag. Anything else falls back to just
/// the base label.
struct WorkContextCompactSummary: Equatable {
  let tokensLabel: String?
  let durationLabel: String?
  let triggerLabel: String?

  static func parse(_ raw: String?) -> WorkContextCompactSummary {
    guard let raw else {
      return WorkContextCompactSummary(tokensLabel: nil, durationLabel: nil, triggerLabel: nil)
    }

    let contentLines = workCompactSummaryHeader(raw)
      .split(separator: "\n")
      .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { line in
        let lower = line.lowercased()
        return !lower.hasPrefix("provider:") && !lower.hasPrefix("sessioncount:")
      }
    let normalized = contentLines.joined(separator: "\n").lowercased()

    let trigger: String?
    if normalized.range(of: #"\bauto\b"#, options: .regularExpression) != nil {
      trigger = "AUTO"
    } else if normalized.range(of: #"\bmanual\b"#, options: .regularExpression) != nil {
      trigger = "MANUAL"
    } else {
      trigger = nil
    }

    if let range = normalized.range(of: #"(\d[\d.,k]*) ?→ ?(\d[\d.,k]*)"#, options: .regularExpression) {
      let tokens = String(normalized[range])
      return WorkContextCompactSummary(tokensLabel: tokens, durationLabel: extractDuration(normalized), triggerLabel: trigger)
    }

    let tokens = extractTokenCount(normalized).map { "~\(workAbbreviateCount($0)) tokens freed" }

    return WorkContextCompactSummary(tokensLabel: tokens, durationLabel: extractDuration(normalized), triggerLabel: trigger)
  }

  private static func extractDuration(_ raw: String) -> String? {
    if let match = raw.range(of: #"duration:\s*(\d+)ms"#, options: .regularExpression) {
      let fragment = String(raw[match])
      if let value = Int(fragment.replacingOccurrences(of: "duration:", with: "").replacingOccurrences(of: "ms", with: "").trimmingCharacters(in: .whitespaces)) {
        if value < 1000 { return "\(max(1, value))ms" }
        let seconds = Double(value) / 1000.0
        return seconds < 60 ? "\(Int(seconds.rounded())) s" : "\(Int(seconds.rounded())) s"
      }
    }
    return nil
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
}
