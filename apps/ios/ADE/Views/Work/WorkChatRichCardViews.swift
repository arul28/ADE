import SwiftUI
import UIKit
import AVKit

/// Tool results longer than this threshold collapse to the first N characters
/// with a "Show all (N chars)" toggle so the transcript stays scannable.
/// Matches the desktop `TOOL_RESULT_TRUNCATE_LIMIT` in
/// apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx:802.
let workToolResultTruncateLimit = 500

struct WorkToolCardView: View {
  let toolCard: WorkToolCardModel
  let references: WorkNavigationTargets
  let isExpanded: Bool
  let onToggle: () -> Void
  let onOpenFile: (String) -> Void
  let onOpenPr: (Int) -> Void

  @State private var resultExpanded = false

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Button(action: onToggle) {
        HStack(spacing: 10) {
          Image(systemName: "hammer.fill")
            .foregroundStyle(statusTint)
          VStack(alignment: .leading, spacing: 4) {
            Text(toolDisplayName(toolCard.toolName))
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
            HStack(spacing: 8) {
              WorkTag(text: toolCard.status.rawValue.capitalized, icon: statusIcon, tint: statusTint)
              Text(formattedSessionDuration(startedAt: toolCard.startedAt, endedAt: toolCard.completedAt))
                .font(.caption2.monospacedDigit())
                .foregroundStyle(ADEColor.textMuted)
            }
            if !isExpanded, let preview = workToolResultPreview(toolCard.resultText) {
              Text(preview)
                .font(.caption2.monospaced())
                .foregroundStyle(ADEColor.textSecondary)
                .lineLimit(1)
                .truncationMode(.tail)
            }
          }
          Spacer()
          Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      .buttonStyle(.plain)

      if isExpanded {
        VStack(alignment: .leading, spacing: 10) {
          if !references.filePaths.isEmpty || !references.pullRequestNumbers.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
              Text("Linked references")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(ADEColor.textMuted)
              ScrollView(.horizontal, showsIndicators: false) {
                ADEGlassGroup(spacing: 8) {
                  ForEach(references.filePaths.prefix(3), id: \.self) { path in
                    Button {
                      onOpenFile(path)
                    } label: {
                      Label(workReferenceLabel(for: path), systemImage: "doc.text")
                        .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.glass)
                    .accessibilityLabel("Open file \(path) in Files")
                  }

                  ForEach(references.pullRequestNumbers.prefix(3), id: \.self) { number in
                    Button {
                      onOpenPr(number)
                    } label: {
                      Label("PR #\(number)", systemImage: "arrow.triangle.pull")
                        .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.glass)
                    .tint(ADEColor.accent)
                    .accessibilityLabel("Open PR number \(number)")
                  }
                }
              }
            }
          }

          if let argsText = toolCard.argsText, !argsText.isEmpty {
            WorkStructuredOutputBlock(title: "Arguments", text: argsText)
          }
          if let resultText = toolCard.resultText, !resultText.isEmpty {
            let truncated = workToolResultTruncate(resultText, expanded: resultExpanded)
            WorkStructuredOutputBlock(title: "Result", text: truncated.text)
            if truncated.didTruncate {
              Button {
                resultExpanded.toggle()
              } label: {
                Text(resultExpanded
                  ? "Collapse"
                  : "Show all (\(workToolResultByteLabel(resultText)))")
                  .font(.caption2.weight(.semibold))
                  .foregroundStyle(ADEColor.accent)
              }
              .buttonStyle(.plain)
              .accessibilityLabel(resultExpanded ? "Collapse tool result" : "Show full tool result")
            }
          }
        }
      }
    }
    .padding(14)
    .background(ADEColor.surfaceBackground.opacity(0.7), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(toolDisplayName(toolCard.toolName)), \(toolCard.status.rawValue)")
  }

  var statusTint: Color {
    switch toolCard.status {
    case .running: return ADEColor.warning
    case .completed: return ADEColor.success
    case .failed: return ADEColor.danger
    }
  }

  var statusIcon: String {
    switch toolCard.status {
    case .running: return "ellipsis.circle"
    case .completed: return "checkmark.circle.fill"
    case .failed: return "xmark.circle.fill"
    }
  }
}

/// One-line summary of a tool result for the collapsed-card header. Returns
/// the first non-empty line (trimmed) or `nil` when the result is empty.
func workToolResultPreview(_ text: String?) -> String? {
  guard let text, !text.isEmpty else { return nil }
  for line in text.split(separator: "\n") {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmed.isEmpty {
      return trimmed
    }
  }
  return nil
}

/// Returns the text to render in the result block, plus whether it was
/// actually truncated. `expanded == true` always returns the full text.
func workToolResultTruncate(_ text: String, expanded: Bool) -> (text: String, didTruncate: Bool) {
  guard !expanded, text.count > workToolResultTruncateLimit else {
    return (text, didTruncate: !expanded && text.count > workToolResultTruncateLimit)
  }
  let end = text.index(text.startIndex, offsetBy: workToolResultTruncateLimit)
  return (String(text[..<end]) + "…", didTruncate: true)
}

/// Short "N chars" label used in the "Show all" affordance. Uses the raw
/// character count — this is display copy, not a byte-precise measurement.
func workToolResultByteLabel(_ text: String) -> String {
  let count = text.count
  if count < 1000 { return "\(count) chars" }
  let rounded = Double(count) / 1000.0
  return String(format: "%.1fk chars", rounded)
}

struct WorkStructuredOutputBlock: View {
  let title: String
  let text: String

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      WorkOutputBlockHeader(title: title, copyText: text)
      ScrollView {
        Text(text)
          .frame(maxWidth: .infinity, alignment: .leading)
          .font(.system(.caption, design: .monospaced))
          .foregroundStyle(ADEColor.textPrimary)
          .textSelection(.enabled)
      }
      .frame(maxHeight: 180)
      .padding(10)
      .background(ADEColor.recessedBackground.opacity(0.9), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
  }
}

struct WorkANSIOutputBlock: View {
  let title: String
  let text: String

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      WorkOutputBlockHeader(title: title, copyText: text)
      ScrollView([.horizontal, .vertical]) {
        Text(ansiAttributedString(text))
          .frame(maxWidth: .infinity, alignment: .leading)
          .font(.system(.caption, design: .monospaced))
          .textSelection(.enabled)
      }
      .frame(maxHeight: 200)
      .padding(10)
      .background(ADEColor.recessedBackground.opacity(0.9), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
  }
}

struct WorkOutputBlockHeader: View {
  let title: String
  let copyText: String
  @State var copied = false

  var body: some View {
    HStack(spacing: 6) {
      Text(title)
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
      Spacer(minLength: 0)
      Button {
        UIPasteboard.general.string = copyText
        copied = true
        Task {
          try? await Task.sleep(nanoseconds: 1_400_000_000)
          copied = false
        }
      } label: {
        HStack(spacing: 4) {
          Image(systemName: copied ? "checkmark" : "doc.on.doc")
          Text(copied ? "Copied" : "Copy")
        }
        .font(.caption2.weight(.semibold))
        .foregroundStyle(copied ? ADEColor.success : ADEColor.textSecondary)
      }
      .buttonStyle(.plain)
      .accessibilityLabel(copied ? "Copied to clipboard" : "Copy \(title.lowercased())")
    }
  }
}

struct WorkCommandCardView: View {
  let card: WorkCommandCardModel

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: statusIcon)
          .foregroundStyle(statusTint)
          .frame(width: 28, height: 28)
          .background(statusTint.opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

        VStack(alignment: .leading, spacing: 4) {
          Text("Command")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(card.command)
            .font(.caption.monospaced())
            .foregroundStyle(ADEColor.textSecondary)
            .textSelection(.enabled)
        }

        Spacer(minLength: 8)
        Text(relativeTimestamp(card.timestamp))
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
      }

      HStack(spacing: 8) {
        WorkTag(text: card.status.rawValue.capitalized, icon: statusIcon, tint: statusTint)
        if !card.cwd.isEmpty {
          WorkTag(text: card.cwd, icon: "folder", tint: ADEColor.textSecondary)
        }
        if let exitCode = card.exitCode {
          WorkTag(text: "Exit \(exitCode)", icon: exitCode == 0 ? "checkmark.circle" : "xmark.circle", tint: exitCode == 0 ? ADEColor.success : ADEColor.danger)
        }
        if let durationMs = card.durationMs {
          WorkTag(text: formattedDuration(milliseconds: durationMs), icon: "clock", tint: ADEColor.textSecondary)
        }
      }

      if !card.output.isEmpty {
        WorkANSIOutputBlock(title: "Output", text: card.output)
      }
    }
    .padding(14)
    .background(ADEColor.surfaceBackground.opacity(0.7), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
  }

  var statusTint: Color {
    color(for: card.status)
  }

  var statusIcon: String {
    icon(for: card.status)
  }
}

struct WorkDiffOutputBlock: View {
  let title: String
  let diff: String

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title)
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
      ScrollView([.horizontal, .vertical]) {
        VStack(alignment: .leading, spacing: 2) {
          ForEach(Array(diff.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
            Text(line.isEmpty ? " " : line)
              .frame(maxWidth: .infinity, alignment: .leading)
              .font(.system(.caption, design: .monospaced))
              .foregroundStyle(diffLineColor(for: line))
              .padding(.horizontal, 8)
              .padding(.vertical, 2)
              .background(diffLineBackground(for: line))
              .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .frame(maxHeight: 220)
      .padding(10)
      .background(ADEColor.recessedBackground.opacity(0.9), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
  }
}

struct WorkFileChangeCardView: View {
  let card: WorkFileChangeCardModel

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: fileChangeIcon)
          .foregroundStyle(statusTint)
          .frame(width: 28, height: 28)
          .background(statusTint.opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

        VStack(alignment: .leading, spacing: 4) {
          Text("File change")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(card.path)
            .font(.caption.monospaced())
            .foregroundStyle(ADEColor.textSecondary)
            .textSelection(.enabled)
        }

        Spacer(minLength: 8)
        Text(relativeTimestamp(card.timestamp))
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
      }

      HStack(spacing: 8) {
        WorkTag(text: card.kind.replacingOccurrences(of: "_", with: " ").capitalized, icon: fileChangeIcon, tint: statusTint)
        WorkTag(text: card.status.rawValue.capitalized, icon: statusIcon, tint: statusTint)
      }

      if !card.diff.isEmpty {
        WorkDiffOutputBlock(title: "Diff", diff: card.diff)
      }
    }
    .padding(14)
    .background(ADEColor.surfaceBackground.opacity(0.7), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
  }

  var statusTint: Color {
    color(for: card.status)
  }

  var fileChangeIcon: String {
    switch card.kind.lowercased() {
    case "create": return "doc.badge.plus"
    case "delete": return "trash"
    default: return "pencil.line"
    }
  }

  var statusIcon: String {
    icon(for: card.status)
  }
}

struct WorkEventCardView: View {
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  let card: WorkEventCardModel
  var onOpenFile: ((String) -> Void)? = nil
  var onOpenPr: ((Int) -> Void)? = nil
  @State var isAnimating = false

  var navigationTargets: WorkNavigationTargets? {
    guard card.kind == "completionReport" else { return nil }
    let blob = ([card.body] + card.bullets).compactMap { $0 }.joined(separator: "\n")
    let targets = extractWorkNavigationTargets(from: blob)
    if targets.filePaths.isEmpty && targets.pullRequestNumbers.isEmpty {
      return nil
    }
    return targets
  }

  var body: some View {
    if card.kind == "contextCompact" {
      WorkContextCompactDivider(summary: card.body)
    } else if isRibbonKind(card.kind) {
      ribbonBody
    } else {
      defaultBody
    }
  }

  /// Status/activity/notice/todo/auto-approval events carry almost no content
  /// but used to render as full cards — that's what made the mobile timeline
  /// feel like a stack of boxes. Collapse them into a single-line ribbon that
  /// reads like prose.
  private func isRibbonKind(_ kind: String) -> Bool {
    switch kind {
    case "status", "activity", "notice", "todo", "autoApproval",
         "pendingInputResolved", "webSearch", "promptSuggestion",
         "toolUseSummary":
      return true
    default:
      return false
    }
  }

  private var ribbonBody: some View {
    HStack(alignment: .center, spacing: 8) {
      Image(systemName: card.icon)
        .font(.caption.weight(.semibold))
        .foregroundStyle(card.tint.color)
        .frame(width: 18, height: 18)
      Text(ribbonText)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(2)
      Spacer(minLength: 8)
      Text(relativeTimestamp(card.timestamp))
        .font(.caption2)
        .foregroundStyle(ADEColor.textMuted)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 6)
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
    .accessibilityLabel([card.title, card.body].compactMap { $0 }.joined(separator: ". "))
  }

  private var ribbonText: String {
    // Prefer the actual event text over the generic "Turn status" title so
    // the ribbon reads "Started" / "Completed" / "Session ready" instead of
    // leaking our UI kind name into the document.
    if let body = card.body?.trimmingCharacters(in: .whitespacesAndNewlines), !body.isEmpty {
      if let first = card.metadata.first, !first.isEmpty {
        return "\(first) · \(body)"
      }
      return body
    }
    if let first = card.metadata.first, !first.isEmpty {
      return "\(card.title) · \(first)"
    }
    return card.title
  }

  private var defaultBody: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: card.icon)
          .foregroundStyle(card.tint.color)
          .frame(width: 28, height: 28)
          .background(card.tint.color.opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
          .scaleEffect(card.kind == "activity" && isAnimating && !reduceMotion ? 1.08 : 1.0)
          .animation(card.kind == "activity" ? ADEMotion.pulse(reduceMotion: reduceMotion) : .default, value: isAnimating)
        VStack(alignment: .leading, spacing: 4) {
          Text(card.title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          if !card.metadata.isEmpty {
            Text(card.metadata.joined(separator: " · "))
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted)
          }
        }
        Spacer(minLength: 8)
        Text(relativeTimestamp(card.timestamp))
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
      }

      if let body = card.body, !body.isEmpty {
        Text(body)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }

      if !card.bullets.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          ForEach(card.bullets, id: \.self) { bullet in
            HStack(alignment: .top, spacing: 8) {
              Text("•")
                .foregroundStyle(card.tint.color)
              Text(bullet)
                .font(.caption)
                .foregroundStyle(ADEColor.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
          }
        }
      }

      if let navigationTargets {
        ScrollView(.horizontal, showsIndicators: false) {
          ADEGlassGroup(spacing: 8) {
            ForEach(navigationTargets.filePaths.prefix(6), id: \.self) { path in
              Button {
                onOpenFile?(path)
              } label: {
                Label(workReferenceLabel(for: path), systemImage: "doc.text")
                  .font(.caption.weight(.semibold))
              }
              .buttonStyle(.glass)
              .disabled(onOpenFile == nil)
              .accessibilityLabel("Open file \(path)")
            }
            ForEach(navigationTargets.pullRequestNumbers.prefix(6), id: \.self) { number in
              Button {
                onOpenPr?(number)
              } label: {
                Label("PR #\(number)", systemImage: "arrow.triangle.pull")
                  .font(.caption.weight(.semibold))
              }
              .buttonStyle(.glass)
              .disabled(onOpenPr == nil)
              .accessibilityLabel("Open pull request \(number)")
            }
          }
        }
      }
    }
    .padding(12)
    .background(ADEColor.surfaceBackground.opacity(0.35), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.border.opacity(0.14), lineWidth: 0.5)
    )
    .accessibilityElement(children: .combine)
    .accessibilityLabel([card.title, card.body, card.bullets.joined(separator: ", ")].compactMap { $0 }.joined(separator: ". "))
    .onAppear {
      guard card.kind == "activity", !reduceMotion else { return }
      isAnimating = true
    }
  }
}

