import SwiftUI
import UIKit
import AVKit

/// Tool results longer than this threshold collapse to the first N characters
/// with a "Show all (N chars)" toggle so the transcript stays scannable.
/// Matches the desktop `TOOL_RESULT_TRUNCATE_LIMIT` in
/// apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx:802.
let workToolResultTruncateLimit = 500

/// Shared status glyph for work-log rows. Desktop parity:
/// completed = emerald check, failed = red x-circle, running = violet dot.
///
/// The running dot is intentionally STATIC (not a per-row `repeatForever`
/// pulse): the lone streaming animation lives in the tail
/// `WorkActivityIndicator`, so painting a pulsing dot on every running row
/// would reintroduce the stacked-loop jank this overhaul removes. Reduce Motion
/// has no extra effect because nothing here animates.
struct WorkToolStatusGlyph: View {
  let status: WorkToolCardStatus

  var body: some View {
    switch status {
    case .completed:
      Image(systemName: "checkmark.circle.fill")
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(ADEColor.success)
    case .failed:
      Image(systemName: "xmark.circle.fill")
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(ADEColor.danger)
    case .running:
      Circle()
        .fill(ADEColor.purpleAccent)
        .frame(width: 7, height: 7)
        .overlay(Circle().stroke(ADEColor.purpleAccent.opacity(0.35), lineWidth: 2).scaleEffect(1.5))
    }
  }
}

/// Flat reference chip (file / PR link) used inside expanded tool and event
/// cards. Replaces the former liquid-glass `.buttonStyle(.glass)` chips — a
/// plain tinted fill + hairline border keeps the transcript de-glassed while
/// still reading as a tappable affordance.
struct WorkReferenceChip: View {
  let label: String
  let systemImage: String
  let tint: Color
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Label(label, systemImage: systemImage)
        .font(.caption.weight(.semibold))
        .foregroundStyle(tint)
        .lineLimit(1)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(tint.opacity(0.10), in: Capsule(style: .continuous))
        .overlay(
          Capsule(style: .continuous)
            .stroke(tint.opacity(0.28), lineWidth: 1)
        )
    }
    .buttonStyle(.plain)
  }
}

private struct WorkWebSearchSource: Identifiable {
  let id: String
  let label: String
  let title: String?
  let url: URL
}

struct WorkToolCardView: View {
  let toolCard: WorkToolCardModel
  let references: WorkNavigationTargets
  let isExpanded: Bool
  let onToggle: () -> Void
  let onOpenFile: (String) -> Void
  let onOpenPr: (Int) -> Void

  @Environment(\.openURL) private var openURL
  @State private var resultExpanded = false

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Button(action: onToggle) {
        if isExpanded {
          expandedHeader
        } else {
          collapsedHeader
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
                HStack(spacing: 8) {
                  ForEach(references.filePaths.prefix(3), id: \.self) { path in
                    WorkReferenceChip(
                      label: workReferenceLabel(for: path),
                      systemImage: "doc.text",
                      tint: ADEColor.textSecondary,
                      action: { onOpenFile(path) }
                    )
                    .accessibilityLabel("Open file \(path) in Files")
                  }

                  ForEach(references.pullRequestNumbers.prefix(3), id: \.self) { number in
                    WorkReferenceChip(
                      label: "PR #\(number)",
                      systemImage: "arrow.triangle.pull",
                      tint: ADEColor.accent,
                      action: { onOpenPr(number) }
                    )
                    .accessibilityLabel("Open PR number \(number)")
                  }
                }
              }
            }
          }

          let webSources = workWebSearchSources(from: toolCard.webSearchActions)
          if !webSources.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
              Text("Sources")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(ADEColor.textMuted)
              ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                  ForEach(webSources) { source in
                    Button {
                      openURL(source.url)
                    } label: {
                      Label(source.label, systemImage: "safari")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(ADEColor.info)
                        .lineLimit(1)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(ADEColor.info.opacity(0.10), in: Capsule(style: .continuous))
                        .overlay(
                          Capsule(style: .continuous)
                            .stroke(ADEColor.info.opacity(0.28), lineWidth: 1)
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Open \(source.title ?? source.label)")
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
    .padding(.horizontal, 12)
    .padding(.vertical, isExpanded ? 12 : 8)
    .background(ADEColor.cardBackground.opacity(0.45), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 1)
    )
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(toolDisplayName(toolCard.toolName)), \(toolCard.status.rawValue)")
    .adeInspectable(
      "Work.Chat.ToolCard",
      metadata: [
        "toolCardId": toolCard.id,
        "toolName": toolCard.toolName,
        "status": toolCard.status.rawValue
      ]
    )
  }

  /// Single-line compact row used once the tool completes — matches the
  /// desktop's collapsed work-log entry. No preview line, no status pill,
  /// no duration chip — just a status dot, the tool name, and the chevron.
  private var collapsedHeader: some View {
    HStack(spacing: 10) {
      WorkToolStatusGlyph(status: toolCard.status)
      Text(toolDisplayName(toolCard.toolName).lowercased())
        .font(.caption.monospaced().weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
        .truncationMode(.middle)
      if let preview = workToolResultPreview(toolCard.resultText) {
        Text("·")
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
        Text(preview)
          .font(.caption2.monospaced())
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
          .truncationMode(.tail)
      }
      Spacer(minLength: 4)
      Image(systemName: "chevron.down")
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(ADEColor.textMuted)
    }
  }

  /// Richer header shown only while the card is expanded — the
  /// extra status pill / duration chip / preview are welcome once the user
  /// has opted into the detail view, but would be noise at rest.
  private var expandedHeader: some View {
    HStack(spacing: 10) {
      Image(systemName: "hammer.fill")
        .foregroundStyle(statusTint)
      VStack(alignment: .leading, spacing: 4) {
        Text(toolDisplayName(toolCard.toolName))
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        HStack(spacing: 8) {
          // Running state is surfaced globally by WorkActivityIndicator at the
          // bottom of the chat; repeating it on every card just stacks clutter.
          if toolCard.status != .running {
            WorkTag(text: toolCard.status.rawValue.capitalized, icon: statusIcon, tint: statusTint)
          }
          Text(formattedSessionDuration(startedAt: toolCard.startedAt, endedAt: toolCard.completedAt))
            .font(.caption2.monospacedDigit())
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      Spacer()
      Image(systemName: "chevron.up")
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
    }
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

private func workWebSearchSources(from actions: [CodexWebSearchAction]?) -> [WorkWebSearchSource] {
  var seen = Set<String>()
  return (actions ?? []).compactMap { action -> WorkWebSearchSource? in
    guard let rawURL = action.url?.trimmingCharacters(in: .whitespacesAndNewlines),
          !rawURL.isEmpty,
          let url = URL(string: rawURL),
          let scheme = url.scheme?.lowercased(),
          scheme == "http" || scheme == "https",
          seen.insert(rawURL).inserted
    else {
      return nil
    }
    return WorkWebSearchSource(
      id: rawURL,
      label: workWebSearchSourceLabel(for: url, action: action),
      title: action.title,
      url: url
    )
  }
  .prefix(4)
  .map { $0 }
}

private func workWebSearchSourceLabel(for url: URL, action: CodexWebSearchAction) -> String {
  if let host = url.host?.replacingOccurrences(of: #"^www\."#, with: "", options: .regularExpression),
     !host.isEmpty {
    return host
  }
  let title = action.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  if !title.isEmpty {
    return title
  }
  return "Open"
}

/// Minimal "Tool calls (N)" panel — flat desktop parity. No card chrome: just a
/// tappable header row and an indented member list when expanded.
struct WorkToolCallsPanelView: View {
  let group: WorkToolGroupModel
  let isExpanded: Bool
  let onToggle: () -> Void

  @State private var expandedMemberIds: Set<String> = []

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
      if isExpanded {
        VStack(alignment: .leading, spacing: 2) {
          ForEach(group.members) { member in
            memberRow(member)
          }
        }
        .padding(.leading, 16)
        .padding(.top, 6)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Tool calls cluster, \(group.count) calls, \(isExpanded ? "expanded" : "collapsed")")
  }

  private var header: some View {
    Button(action: onToggle) {
      HStack(alignment: .center, spacing: 6) {
        Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
          .font(.system(size: 9, weight: .bold))
          .foregroundStyle(ADEColor.textMuted.opacity(0.65))
        Text("Tool calls")
          .font(.caption.weight(.medium))
          .foregroundStyle(ADEColor.textMuted)
        Text("(\(group.count))")
          .font(.caption2.monospacedDigit())
          .foregroundStyle(ADEColor.textMuted.opacity(0.55))
        if !isExpanded, let latest = group.latest {
          WorkToolStatusGlyph(status: latest.status)
          Text(memberSlug(latest))
            .font(.caption2.monospaced().weight(.semibold))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
          if let target = memberTarget(latest), !target.isEmpty {
            Text(target)
              .font(.caption)
              .foregroundStyle(ADEColor.textPrimary.opacity(0.88))
              .lineLimit(1)
              .truncationMode(.tail)
          }
        }
        Spacer(minLength: 0)
      }
      .padding(.vertical, 2)
    }
    .buttonStyle(.plain)
  }

  @ViewBuilder
  private func memberRow(_ member: WorkToolGroupMember) -> some View {
    let memberId = member.id
    let expanded = expandedMemberIds.contains(memberId)
    let target = memberTarget(member)

    Button {
      if expandedMemberIds.contains(memberId) {
        expandedMemberIds.remove(memberId)
      } else {
        expandedMemberIds.insert(memberId)
      }
    } label: {
      VStack(alignment: .leading, spacing: 4) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          WorkToolStatusGlyph(status: member.status)
          Text(memberSlug(member))
            .font(.caption.monospaced().weight(.semibold))
            .foregroundStyle(rowVerbColor(member.status))
          if let target, !target.isEmpty {
            Text(target)
              .font(.caption.monospaced())
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
              .truncationMode(.middle)
          }
          Spacer(minLength: 0)
        }
        if expanded, let detail = memberDetail(member) {
          ScrollView {
            Text(detail)
              .frame(maxWidth: .infinity, alignment: .leading)
              .font(.system(.caption, design: .monospaced))
              .foregroundStyle(ADEColor.textSecondary)
              .textSelection(.enabled)
          }
          .frame(maxHeight: 220)
          .padding(.leading, 17)
          .padding(.top, 4)
        }
      }
      .padding(.vertical, 6)
    }
    .buttonStyle(.plain)
  }

  // MARK: – Member helpers

  /// Mono "kind-slug" shown beside the status glyph — the lowercased tool name
  /// (`read`, `shell`, `edit`) rather than a prose verb, matching the desktop
  /// work-log row which leads with the raw tool kind.
  private func memberSlug(_ member: WorkToolGroupMember) -> String {
    switch member {
    case .tool(let card):
      return toolDisplayName(card.toolName).lowercased()
    case .command:
      return "shell"
    case .fileChange(let card):
      switch card.kind.lowercased() {
      case "create": return "create"
      case "delete": return "delete"
      default: return "edit"
      }
    }
  }

  private func memberTarget(_ member: WorkToolGroupMember) -> String? {
    switch member {
    case .tool(let card):
      return workToolArgPreview(toolName: card.toolName, argsText: card.argsText)
        ?? workToolResultPreview(card.resultText)
    case .command(let card):
      guard !card.command.isEmpty else { return nil }
      return workSummarizeInlineText(card.command, maxChars: 140)
    case .fileChange(let card):
      return workReferenceLabel(for: card.path)
    }
  }

  private func memberDetail(_ member: WorkToolGroupMember) -> String? {
    switch member {
    case .tool(let card):
      if let result = card.resultText, !result.isEmpty {
        let trimmed = result.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed == "{}" || trimmed == "[]" {
          return workToolArgPreview(toolName: card.toolName, argsText: card.argsText)
        }
        return result
      }
      if let preview = workToolArgPreview(toolName: card.toolName, argsText: card.argsText) {
        return preview
      }
      if let args = card.argsText, !args.isEmpty { return args }
      return nil
    case .command(let card):
      let output = card.output.trimmingCharacters(in: .whitespacesAndNewlines)
      return output.isEmpty ? nil : card.output
    case .fileChange(let card):
      return card.diff.isEmpty ? nil : card.diff
    }
  }

  private func rowVerbColor(_ status: WorkToolCardStatus) -> Color {
    switch status {
    case .failed: return ADEColor.danger
    case .running: return ADEColor.textPrimary
    case .completed: return ADEColor.textMuted
    }
  }
}

/// Minimal "Files changed (N)" panel — flat desktop/tool-calls parity. Collapsed
/// by default; tap to reveal one row per file; tap a row for the full diff.
struct WorkChangedFilesPanelView: View {
  let group: WorkChangedFilesGroupModel
  let isExpanded: Bool
  let onToggle: () -> Void
  let onUndo: (() -> Void)?

  @State private var expandedFileIds: Set<String> = []

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
      if isExpanded {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(group.files) { file in
            fileRow(file)
          }
        }
        .padding(.leading, 16)
        .padding(.top, 6)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Files changed cluster, \(group.count) files, \(isExpanded ? "expanded" : "collapsed")")
  }

  private var header: some View {
    HStack(alignment: .center, spacing: 6) {
      Button(action: onToggle) {
        HStack(alignment: .center, spacing: 6) {
          Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(ADEColor.textMuted.opacity(0.65))
          Text("Files changed")
            .font(.caption.weight(.medium))
            .foregroundStyle(ADEColor.textMuted)
          Text("(\(group.count))")
            .font(.caption2.monospacedDigit())
            .foregroundStyle(ADEColor.textMuted.opacity(0.55))
          if !isExpanded {
            collapsedPreview
          }
          Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
      }
      .buttonStyle(.plain)
      if isExpanded, let onUndo {
        Button(action: onUndo) {
          HStack(spacing: 4) {
            Image(systemName: "arrow.uturn.backward")
              .font(.system(size: 10, weight: .semibold))
            Text("Undo")
              .font(.caption.weight(.semibold))
          }
          .foregroundStyle(ADEColor.textMuted)
        }
        .buttonStyle(.plain)
      }
    }
  }

  @ViewBuilder
  private var collapsedPreview: some View {
    if group.hasRunning {
      Circle()
        .fill(ADEColor.warning.opacity(0.85))
        .frame(width: 6, height: 6)
    }
    if group.totalAdditions > 0 {
      Text("+\(group.totalAdditions)")
        .font(.caption2.monospacedDigit())
        .foregroundStyle(ADEColor.success.opacity(0.85))
    }
    if group.totalDeletions > 0 {
      Text("−\(group.totalDeletions)")
        .font(.caption2.monospacedDigit())
        .foregroundStyle(ADEColor.danger.opacity(0.85))
    }
    if let latest = group.files.last {
      Text(workReferenceLabel(for: latest.path))
        .font(.caption)
        .foregroundStyle(ADEColor.textPrimary.opacity(0.88))
        .lineLimit(1)
        .truncationMode(.middle)
    }
  }

  @ViewBuilder
  private func fileRow(_ file: WorkChangedFileEntry) -> some View {
    let expanded = expandedFileIds.contains(file.id)
    Button {
      if expandedFileIds.contains(file.id) {
        expandedFileIds.remove(file.id)
      } else {
        expandedFileIds.insert(file.id)
      }
    } label: {
      VStack(alignment: .leading, spacing: 4) {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          Text(fileExtBadge(file.path))
            .font(.system(size: 9, weight: .heavy, design: .monospaced))
            .tracking(0.4)
            .foregroundStyle(ADEColor.textMuted)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .overlay(
              RoundedRectangle(cornerRadius: 3, style: .continuous)
                .strokeBorder(ADEColor.glassBorder.opacity(0.6), lineWidth: 0.5)
            )
          Text(file.path)
            .font(.caption.monospaced())
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
            .truncationMode(.middle)
          Spacer(minLength: 4)
          if let kindLabel = fileKindLabel(file.kind) {
            Text(kindLabel)
              .font(.caption2.weight(.semibold))
              .foregroundStyle(file.kind.lowercased() == "delete" ? ADEColor.danger.opacity(0.8) : ADEColor.textMuted)
          }
          if file.additions > 0 {
            Text("+\(file.additions)")
              .font(.caption.monospacedDigit())
              .foregroundStyle(ADEColor.success.opacity(0.85))
          }
          if file.deletions > 0 {
            Text("−\(file.deletions)")
              .font(.caption.monospacedDigit())
              .foregroundStyle(ADEColor.danger.opacity(0.85))
          }
        }
        if expanded {
          if file.diff.isEmpty {
            Text("No diff payload available.")
              .font(.caption.monospaced())
              .foregroundStyle(ADEColor.textMuted)
              .padding(.top, 6)
          } else {
            ScrollView([.horizontal, .vertical]) {
              VStack(alignment: .leading, spacing: 1) {
                ForEach(Array(file.diff.split(separator: "\n", omittingEmptySubsequences: false).enumerated()), id: \.offset) { _, line in
                  let str = String(line)
                  Text(str.isEmpty ? " " : str)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(diffLineTint(str))
                }
              }
            }
            .frame(maxHeight: 220)
            .padding(.top, 6)
          }
        }
      }
      .padding(.vertical, 6)
    }
    .buttonStyle(.plain)
  }

  // MARK: – Helpers

  private func diffLineTint(_ line: String) -> Color {
    if line.hasPrefix("+") && !line.hasPrefix("+++") { return ADEColor.success.opacity(0.9) }
    if line.hasPrefix("-") && !line.hasPrefix("---") { return ADEColor.danger.opacity(0.9) }
    if line.hasPrefix("@@") { return ADEColor.purpleAccent.opacity(0.8) }
    return ADEColor.textSecondary
  }

  private func fileExtBadge(_ path: String) -> String {
    let basename = (path as NSString).lastPathComponent
    if let dot = basename.lastIndex(of: ".") {
      let ext = String(basename[basename.index(after: dot)...]).uppercased()
      if !ext.isEmpty && ext.count <= 4 { return ext }
    }
    return "FILE"
  }

  /// Past-tense kind label for non-modify changes — "Created" / "Deleted".
  /// Returns nil for plain edits so modify rows stay clean.
  private func fileKindLabel(_ kind: String) -> String? {
    switch kind.lowercased() {
    case "create", "add": return "Created"
    case "delete", "remove": return "Deleted"
    case "rename": return "Renamed"
    default: return nil
    }
  }
}

/// One expanded member of a tool group. Keeps its own expansion state so the
/// group container only toggles cluster-level collapse — individual cards can
/// still drill into args/output without leaking state up to the parent.
private struct WorkToolGroupMemberRow: View {
  let member: WorkToolGroupMember
  let onOpenFile: (String) -> Void
  let onOpenPr: (Int) -> Void
  @State private var localExpanded = false

  var body: some View {
    switch member {
    case .tool(let card):
      WorkToolCardView(
        toolCard: card,
        references: extractWorkNavigationTargets(
          from: [card.argsText, card.resultText].compactMap { $0 }.joined(separator: "\n")
        ),
        // Running cards stay auto-expanded so live args/output remain visible
        // during streaming — the whole point of the tool-streaming flow.
        isExpanded: card.status == .running || localExpanded,
        onToggle: { localExpanded.toggle() },
        onOpenFile: onOpenFile,
        onOpenPr: onOpenPr
      )
    case .command(let card):
      WorkCommandCardView(card: card)
    case .fileChange(let card):
      WorkFileChangeCardView(card: card)
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
        Task { @MainActor in
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
  @State private var isExpanded = false

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Button {
        isExpanded.toggle()
      } label: {
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
            if !isExpanded, let preview = workToolResultPreview(card.output) {
              Text(preview)
                .font(.caption2.monospaced())
                .foregroundStyle(ADEColor.textMuted)
                .lineLimit(1)
                .truncationMode(.tail)
            }
          }

          Spacer(minLength: 8)
          VStack(alignment: .trailing, spacing: 6) {
            Text(relativeTimestamp(card.timestamp))
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted)
            Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
              .font(.caption.weight(.semibold))
              .foregroundStyle(ADEColor.textMuted)
          }
        }
      }
      .buttonStyle(.plain)

      HStack(spacing: 8) {
        if card.status != .running {
          WorkTag(text: card.status.rawValue.capitalized, icon: statusIcon, tint: statusTint)
        }
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

      if isExpanded && !card.output.isEmpty {
        WorkANSIOutputBlock(title: "Output", text: card.output)
      }
    }
    .padding(14)
    .background(ADEColor.cardBackground.opacity(0.45), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 1)
    )
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Command, \(card.status.rawValue). Tap to \(isExpanded ? "collapse" : "expand") output.")
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

struct WorkInlineDiffPreview: View {
  let diff: String

  var body: some View {
    ScrollView([.horizontal, .vertical]) {
      LazyVStack(alignment: .leading, spacing: 2) {
        ForEach(Array(diff.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
          Text(line.isEmpty ? " " : line)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(diffLineColor(for: line))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .frame(maxHeight: 320)
    .padding(.top, 8)
    .padding(.leading, 18)
    .overlay(alignment: .topLeading) {
      Rectangle()
        .fill(ADEColor.glassBorder.opacity(0.55))
        .frame(height: 1)
        .padding(.leading, 18)
    }
  }
}

struct WorkFileChangeCardView: View {
  let card: WorkFileChangeCardModel
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var isExpanded = false

  private var diffStats: (additions: Int, deletions: Int) {
    aggregateDiffStats(card.diff)
  }

  private var hasDiff: Bool {
    !card.diff.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Button {
        guard hasDiff else { return }
        withAnimation(ADEMotion.quick(reduceMotion: reduceMotion)) {
          isExpanded.toggle()
        }
      } label: {
        HStack(spacing: 8) {
          Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
            .font(.caption2.weight(.bold))
            .foregroundStyle(ADEColor.textMuted)
            .frame(width: 10)

          Text(fileExtensionBadge)
            .font(.caption2.weight(.semibold).monospaced())
            .foregroundStyle(ADEColor.textSecondary)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .overlay(
              RoundedRectangle(cornerRadius: 3, style: .continuous)
                .stroke(ADEColor.glassBorder.opacity(0.8), lineWidth: 1)
            )

          Text(card.path)
            .font(.caption.monospaced())
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
            .truncationMode(.middle)
            .textSelection(.enabled)

          Spacer(minLength: 6)

          if diffStats.additions > 0 {
            Text("+\(diffStats.additions)")
              .font(.caption.monospaced())
              .foregroundStyle(ADEColor.success)
          }
          if diffStats.deletions > 0 || card.kind.lowercased() == "delete" {
            Text("-\(diffStats.deletions)")
              .font(.caption.monospaced())
              .foregroundStyle(ADEColor.danger)
          }
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(!hasDiff)

      if isExpanded {
        if hasDiff {
          WorkInlineDiffPreview(diff: card.diff)
        } else {
          Text("No diff payload available.")
            .font(.caption.monospaced())
            .foregroundStyle(ADEColor.textMuted)
            .padding(.leading, 18)
        }
      }
    }
    .padding(.vertical, 4)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("File change, \(card.path), \(diffStats.additions) additions, \(diffStats.deletions) deletions. \(hasDiff ? "Tap to \(isExpanded ? "collapse" : "expand") diff." : "No diff payload available.")")
  }

  private var fileExtensionBadge: String {
    let basename = (card.path as NSString).lastPathComponent
    let ext = (basename as NSString).pathExtension.uppercased()
    return ext.isEmpty || ext.count > 4 ? "FILE" : ext
  }
}

struct WorkEventCardView: View {
  let card: WorkEventCardModel
  var onOpenFile: ((String) -> Void)? = nil
  var onOpenPr: ((Int) -> Void)? = nil

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
      WorkContextCompactDivider(summary: card.body, isInProgress: card.isInProgress)
    } else if card.kind == "status" {
      statusRibbonBody
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

  private var statusRibbonBody: some View {
    let normalized = card.metadata.first?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    let isFailure = normalized == "failed"
    let isInterrupted = normalized == "interrupted"
    let tint = isFailure ? ADEColor.danger : (isInterrupted ? ADEColor.warning : ADEColor.textMuted)

    return HStack(alignment: .center, spacing: 8) {
      Image(systemName: isFailure ? "xmark.circle.fill" : "pause.circle.fill")
        .font(.system(size: 11, weight: .bold))
      Text(normalized.isEmpty ? ribbonText.uppercased() : normalized.uppercased())
        .font(.caption2.monospaced().weight(.semibold))
        .tracking(0.8)
      if let body = card.body?.trimmingCharacters(in: .whitespacesAndNewlines), !body.isEmpty {
        Text(body)
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
      }
      Spacer(minLength: 8)
      Text(relativeTimestamp(card.timestamp))
        .font(.caption2)
        .foregroundStyle(ADEColor.textMuted)
    }
    .foregroundStyle(tint.opacity(0.9))
    .padding(.horizontal, 10)
    .padding(.vertical, 6)
    .background(tint.opacity(isFailure || isInterrupted ? 0.05 : 0.0), in: Capsule(style: .continuous))
    .overlay(
      Capsule(style: .continuous)
        .stroke(tint.opacity(isFailure || isInterrupted ? 0.14 : 0.0), lineWidth: 1)
    )
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
          ForEach(Array(card.bullets.enumerated()), id: \.offset) { _, bullet in
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
          HStack(spacing: 8) {
            ForEach(navigationTargets.filePaths.prefix(6), id: \.self) { path in
              WorkReferenceChip(
                label: workReferenceLabel(for: path),
                systemImage: "doc.text",
                tint: ADEColor.textSecondary,
                action: { onOpenFile?(path) }
              )
              .disabled(onOpenFile == nil)
              .accessibilityLabel("Open file \(path)")
            }
            ForEach(navigationTargets.pullRequestNumbers.prefix(6), id: \.self) { number in
              WorkReferenceChip(
                label: "PR #\(number)",
                systemImage: "arrow.triangle.pull",
                tint: ADEColor.accent,
                action: { onOpenPr?(number) }
              )
              .disabled(onOpenPr == nil)
              .accessibilityLabel("Open pull request \(number)")
            }
          }
        }
      }
    }
    .padding(12)
    .background(ADEColor.cardBackground.opacity(0.4), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 1)
    )
    .accessibilityElement(children: .combine)
    .accessibilityLabel([card.title, card.body, card.bullets.joined(separator: ", ")].compactMap { $0 }.joined(separator: ". "))
  }
}

/// Resolved / historical structured-question card shown in the transcript once
/// a question is no longer pending. Replaces the flat "Question asked · Input
/// requested" event card: renders the asking provider's logo + "{Provider}
/// asked", the question text as the primary line, clean option rows (recommended
/// and chosen marked), and — when resolved — the outcome inline so the separate
/// "Input resolved" ribbon can be folded away.
struct WorkResolvedQuestionCard: View {
  let card: WorkEventCardModel
  var fallbackProvider: String? = nil

  private var model: WorkPendingQuestionModel? { card.questionModel }

  private var resolvedProvider: String? {
    if let source = model?.source?.trimmingCharacters(in: .whitespacesAndNewlines), !source.isEmpty {
      return source
    }
    return fallbackProvider
  }

  private var accent: Color { ADEColor.providerChatAccent(for: resolvedProvider) }

  private var resolution: String? {
    guard let trimmed = card.resolution?.trimmingCharacters(in: .whitespacesAndNewlines),
          !trimmed.isEmpty else { return nil }
    return trimmed
  }

  private var isResolved: Bool { resolution != nil }

  private var isDeclined: Bool {
    switch (resolution ?? "").lowercased() {
    case "declined", "rejected", "cancelled", "canceled": return true
    default: return false
    }
  }

  /// The option the user picked, matched by value or label against the
  /// resolution word. Nil when the resolution is a plain status ("accepted"),
  /// a freeform/typed answer, a decline, or a secure-response question (a
  /// secret answer must never surface, even as a matched option label).
  private var chosenOption: WorkPendingQuestionOption? {
    guard let model, !isDeclined else { return nil }
    for question in model.questions where !question.isSecret {
      if let match = question.options.first(where: { isSelected($0) }) {
        return match
      }
    }
    return nil
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      header

      if let model {
        ForEach(Array(model.questions.enumerated()), id: \.offset) { _, question in
          questionSection(question)
        }
      } else if let body = card.body, !body.isEmpty {
        Text(body)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }

      if isResolved {
        resolutionPill
      }
    }
    .padding(14)
    .background(ADEColor.cardBackground.opacity(0.45), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(accent.opacity(0.22), lineWidth: 1)
    )
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityText)
  }

  private var header: some View {
    HStack(spacing: 8) {
      WorkProviderBareLogo(
        provider: resolvedProvider,
        fallbackSymbol: providerIcon(resolvedProvider ?? ""),
        tint: accent,
        size: 16
      )
      Text("\(workChatSurfaceProviderName(resolvedProvider)) asked")
        .font(.caption.weight(.semibold))
        .foregroundStyle(accent)
      Spacer(minLength: 8)
      Text(relativeTimestamp(card.timestamp))
        .font(.caption2)
        .foregroundStyle(ADEColor.textMuted)
    }
  }

  @ViewBuilder
  private func questionSection(_ question: WorkPendingQuestion) -> some View {
    let questionText = question.isSecret ? "Secure response requested" : question.question
    VStack(alignment: .leading, spacing: 8) {
      if let header = question.header, !header.isEmpty {
        Text(header.uppercased())
          .font(.caption2.weight(.bold))
          .tracking(0.6)
          .foregroundStyle(ADEColor.textMuted)
      }
      if !questionText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        Text(questionText)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      // Secure-response questions mask more than the prompt: option labels and
      // descriptions can restate the secret, so the whole option list is hidden.
      if !question.isSecret, !question.options.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          ForEach(Array(question.options.enumerated()), id: \.offset) { _, option in
            optionRow(option)
          }
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  @ViewBuilder
  private func optionRow(_ option: WorkPendingQuestionOption) -> some View {
    let selected = isSelected(option)
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: selected ? "checkmark.circle.fill" : "circle")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(selected ? accent : ADEColor.textMuted.opacity(0.55))
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 6) {
          Text(option.label)
            .font(.caption.weight(selected ? .semibold : .regular))
            .foregroundStyle(selected ? ADEColor.textPrimary : ADEColor.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
          if option.recommended {
            Text("Recommended")
              .font(.caption2.weight(.semibold))
              .foregroundStyle(accent)
              .padding(.horizontal, 6)
              .padding(.vertical, 2)
              .background(accent.opacity(0.12), in: Capsule(style: .continuous))
          }
        }
        if let description = option.description, !description.isEmpty {
          Text(description)
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
    }
    .padding(.vertical, 5)
    .padding(.horizontal, 8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      selected ? accent.opacity(0.08) : Color.clear,
      in: RoundedRectangle(cornerRadius: 8, style: .continuous)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .stroke(selected ? accent.opacity(0.30) : Color.clear, lineWidth: 1)
    )
    .opacity(isDeclined ? 0.55 : 1)
  }

  private func isSelected(_ option: WorkPendingQuestionOption) -> Bool {
    guard let resolution, !isDeclined else { return false }
    let normalized = resolution.lowercased()
    if normalized == option.value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
      return true
    }
    return normalized == option.label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  }

  private var resolutionPill: some View {
    let key = (resolution ?? "").lowercased()
    let tint = pendingInputResolutionTint(for: key).color
    let label: String = {
      if let chosen = chosenOption {
        return "Answered · \(chosen.label)"
      }
      return isDeclined ? pendingInputResolutionLabel(for: key) : "Answered"
    }()
    return HStack(spacing: 5) {
      Image(systemName: pendingInputResolutionIcon(for: key))
        .font(.system(size: 11, weight: .semibold))
      Text(label)
        .font(.caption2.weight(.semibold))
        .lineLimit(1)
    }
    .foregroundStyle(tint)
    .padding(.horizontal, 8)
    .padding(.vertical, 4)
    .background(tint.opacity(0.10), in: Capsule(style: .continuous))
  }

  private var accessibilityText: String {
    var parts: [String] = ["\(workChatSurfaceProviderName(resolvedProvider)) asked."]
    if let model {
      for question in model.questions where !question.question.isEmpty {
        parts.append(question.isSecret ? "Secure response requested." : question.question)
      }
    } else if let body = card.body {
      parts.append(body)
    }
    if let chosen = chosenOption {
      parts.append("Answered \(chosen.label).")
    } else if let resolution {
      parts.append(pendingInputResolutionLabel(for: resolution.lowercased()) + ".")
    }
    return parts.joined(separator: " ")
  }
}

/// Resolved / historical plan-approval card. Mirrors the plan-ready composer
/// badge instead of dumping the plan markdown into per-line bullets: provider
/// logo + "{Provider} · Plan", the plan title, a short markdown preview, and a
/// "View full plan" affordance that presents the same `WorkPlanFullScreenView`
/// sheet the live badge uses. Shows the approve/reject outcome inline.
struct WorkResolvedPlanCard: View {
  let card: WorkEventCardModel
  var fallbackProvider: String? = nil

  @State private var planExpanded = false

  private var plan: WorkPendingPlanApprovalModel? { card.planApprovalModel }

  private var resolvedProvider: String? {
    workPlanResolvedProvider(source: plan?.source ?? "", fallbackProvider: fallbackProvider)
  }

  private var accent: Color { ADEColor.providerChatAccent(for: resolvedProvider) }

  private var resolution: String? {
    guard let trimmed = card.resolution?.trimmingCharacters(in: .whitespacesAndNewlines),
          !trimmed.isEmpty else { return nil }
    return trimmed
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      header

      if let plan {
        if !plan.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          Text(plan.title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .frame(maxWidth: .infinity, alignment: .leading)
        }

        WorkMarkdownRenderer(markdown: planPreviewText(plan.planText))
          .frame(maxWidth: .infinity, alignment: .leading)

        HStack(spacing: 8) {
          Button {
            planExpanded = true
          } label: {
            HStack(spacing: 4) {
              Image(systemName: "arrow.down.left.and.arrow.up.right")
                .font(.system(size: 9, weight: .bold))
              Text("View full plan")
                .font(.system(size: 11, weight: .semibold))
            }
            .foregroundStyle(accent)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("View full plan")

          Spacer(minLength: 8)

          resolutionPill
        }
      } else if let body = card.body, !body.isEmpty {
        Text(body)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .frame(maxWidth: .infinity, alignment: .leading)
        resolutionPill
      }
    }
    .padding(14)
    .background(ADEColor.cardBackground.opacity(0.45), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(accent.opacity(0.22), lineWidth: 1)
    )
    .sheet(isPresented: $planExpanded) {
      if let plan {
        WorkPlanFullScreenView(plan: plan, fallbackProvider: fallbackProvider)
          .presentationDetents([.large])
          .presentationDragIndicator(.visible)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityText)
  }

  private var header: some View {
    HStack(spacing: 8) {
      WorkProviderBareLogo(
        provider: resolvedProvider,
        fallbackSymbol: providerIcon(resolvedProvider ?? ""),
        tint: accent,
        size: 16
      )
      Text("\(workChatSurfaceProviderName(resolvedProvider)) · Plan")
        .font(.caption.weight(.semibold))
        .foregroundStyle(accent)
      Spacer(minLength: 8)
      Image(systemName: "list.bullet.clipboard")
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(accent.opacity(0.45))
    }
  }

  @ViewBuilder
  private var resolutionPill: some View {
    if let resolution {
      let key = resolution.lowercased()
      let tint = pendingInputResolutionTint(for: key).color
      HStack(spacing: 5) {
        Image(systemName: pendingInputResolutionIcon(for: key))
          .font(.system(size: 11, weight: .semibold))
        Text(planResolutionLabel(key))
          .font(.caption2.weight(.semibold))
      }
      .foregroundStyle(tint)
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
      .background(tint.opacity(0.10), in: Capsule(style: .continuous))
    }
  }

  /// Plan approvals read as "Approved" / "Rejected" rather than the generic
  /// "Accepted" / "Declined" the shared resolution mapping produces.
  private func planResolutionLabel(_ key: String) -> String {
    switch key {
    case "accepted": return "Approved"
    case "declined", "rejected": return "Rejected"
    default: return pendingInputResolutionLabel(for: key)
    }
  }

  /// A compact preview of the plan markdown for the collapsed card — the full
  /// text is available in the expand sheet.
  private func planPreviewText(_ text: String) -> String {
    let lines = text.components(separatedBy: .newlines)
    var preview = lines.prefix(6).joined(separator: "\n")
    if preview.count > 400 {
      preview = String(preview.prefix(400)).trimmingCharacters(in: .whitespacesAndNewlines) + "…"
    } else if lines.count > 6 {
      preview += "\n…"
    }
    return preview
  }

  private var accessibilityText: String {
    var parts: [String] = ["\(workChatSurfaceProviderName(resolvedProvider)) plan."]
    if let plan, !plan.title.isEmpty {
      parts.append(plan.title)
    }
    if let resolution {
      parts.append(planResolutionLabel(resolution.lowercased()) + ".")
    }
    return parts.joined(separator: " ")
  }
}

/// Resolved / historical generic (tool / file-change) approval, rendered as a
/// sleek one-line chip — provider logo + a small-caps "✓ ACCEPTED" / "✕ DECLINED"
/// outcome + the request description — instead of the old full card that printed
/// the description three times. The standalone "Input resolved" ribbon is folded
/// away (see `buildWorkEventCards`), so this chip is the single resolved surface.
struct WorkResolvedApprovalChip: View {
  let card: WorkEventCardModel
  var fallbackProvider: String? = nil

  private var accent: Color { ADEColor.providerChatAccent(for: fallbackProvider) }
  private var resolutionKey: String { (card.resolution ?? "").lowercased() }
  private var isResolved: Bool { card.resolution?.isEmpty == false }

  var body: some View {
    HStack(spacing: 8) {
      WorkProviderBareLogo(
        provider: fallbackProvider,
        fallbackSymbol: providerIcon(fallbackProvider ?? ""),
        tint: accent,
        size: 14
      )
      Image(systemName: isResolved ? pendingInputResolutionIcon(for: resolutionKey) : "checkmark.shield")
        .font(.system(size: 11, weight: .bold))
        .foregroundStyle(statusTint)
      Text(statusLabel.uppercased())
        .font(.caption2.monospaced().weight(.semibold))
        .tracking(0.6)
        .foregroundStyle(statusTint)
      if let description = card.body, !description.isEmpty {
        Text(description)
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
          .truncationMode(.tail)
      }
      Spacer(minLength: 8)
      Text(relativeTimestamp(card.timestamp))
        .font(.caption2)
        .foregroundStyle(ADEColor.textMuted)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 6)
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
    .accessibilityLabel([statusLabel, card.body].compactMap { $0 }.joined(separator: ". "))
  }

  private var statusTint: Color {
    isResolved ? pendingInputResolutionTint(for: resolutionKey).color : ADEColor.textMuted
  }

  private var statusLabel: String {
    isResolved ? pendingInputResolutionLabel(for: resolutionKey) : "Approval"
  }
}

/// Rich proposed-plan card — per-step checklist with status icon/color and a
/// progress meter. Replaces the generic "Status: text" bullet list so plans
/// feel like a plan, not a dumped array.
struct WorkProposedPlanCard: View {
  let card: WorkEventCardModel

  private var steps: [WorkPlanStep] { card.planSteps }

  private var completed: Int {
    steps.filter { normalize($0.status) == .completed }.count
  }

  private var inProgress: Int {
    steps.filter { normalize($0.status) == .inProgress }.count
  }

  private var progressFraction: Double {
    guard !steps.isEmpty else { return 0 }
    return Double(completed) / Double(steps.count)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      header

      if let body = card.body, !body.isEmpty {
        Text(body)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }

      if !steps.isEmpty {
        progressBar

        VStack(alignment: .leading, spacing: 8) {
          ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
            planStepRow(step: step, index: index + 1)
          }
        }
      }
    }
    .padding(14)
    .background(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .fill(ADEColor.cardBackground.opacity(0.45))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .stroke(ADEColor.brandClaude.opacity(0.22), lineWidth: 1)
    )
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilitySummary)
  }

  private var header: some View {
    HStack(alignment: .center, spacing: 10) {
      Image(systemName: "list.bullet.clipboard")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(ADEColor.brandClaude)
        .frame(width: 28, height: 28)
        .background(ADEColor.brandClaude.opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

      VStack(alignment: .leading, spacing: 2) {
        Text("Plan")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(stepSummary)
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
      }

      Spacer(minLength: 8)

      if !steps.isEmpty {
        Text("\(completed)/\(steps.count)")
          .font(.caption.weight(.semibold).monospacedDigit())
          .foregroundStyle(progressFraction == 1 ? ADEColor.success : ADEColor.brandClaude)
      }
    }
  }

  private var progressBar: some View {
    GeometryReader { geo in
      ZStack(alignment: .leading) {
        Capsule(style: .continuous)
          .fill(ADEColor.border.opacity(0.2))
        Capsule(style: .continuous)
          .fill(
            LinearGradient(
              colors: [ADEColor.brandClaude, ADEColor.brandClaude.opacity(0.6)],
              startPoint: .leading,
              endPoint: .trailing
            )
          )
          .frame(width: max(6, geo.size.width * progressFraction))
      }
    }
    .frame(height: 4)
  }

  @ViewBuilder
  private func planStepRow(step: WorkPlanStep, index: Int) -> some View {
    let status = normalize(step.status)
    HStack(alignment: .top, spacing: 10) {
      statusGlyph(for: status)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(tint(for: status))
        .frame(width: 20, height: 20)

      VStack(alignment: .leading, spacing: 2) {
        Text(step.text)
          .font(.caption)
          .foregroundStyle(status == .completed ? ADEColor.textMuted : ADEColor.textPrimary)
          .strikethrough(status == .completed, color: ADEColor.textMuted)
          .frame(maxWidth: .infinity, alignment: .leading)
        if status != .pending {
          Text(statusLabel(for: status))
            .font(.caption2.weight(.medium))
            .foregroundStyle(tint(for: status))
        }
      }

      Spacer(minLength: 0)

      Text("\(index)")
        .font(.caption2.monospacedDigit())
        .foregroundStyle(ADEColor.textMuted.opacity(0.6))
    }
    .padding(.vertical, 4)
  }

  private var stepSummary: String {
    if steps.isEmpty { return "Waiting for steps…" }
    var parts: [String] = ["\(steps.count) step\(steps.count == 1 ? "" : "s")"]
    if inProgress > 0 { parts.append("\(inProgress) running") }
    if completed > 0 && completed < steps.count { parts.append("\(completed) done") }
    if completed == steps.count { parts.append("complete") }
    return parts.joined(separator: " · ")
  }

  private var accessibilitySummary: String {
    var parts = ["Plan. \(stepSummary)."]
    if let body = card.body { parts.append(body) }
    for (idx, step) in steps.enumerated() {
      parts.append("Step \(idx + 1), \(statusLabel(for: normalize(step.status))). \(step.text)")
    }
    return parts.joined(separator: " ")
  }

  private enum NormalizedStatus {
    case pending, inProgress, completed, failed
  }

  private func normalize(_ raw: String) -> NormalizedStatus {
    switch raw.lowercased().replacingOccurrences(of: "_", with: "-") {
    case "completed", "done", "complete", "success": return .completed
    case "in-progress", "running", "active", "started": return .inProgress
    case "failed", "error", "cancelled", "canceled": return .failed
    default: return .pending
    }
  }

  private func tint(for status: NormalizedStatus) -> Color {
    switch status {
    case .pending: return ADEColor.textMuted
    case .inProgress: return ADEColor.brandClaude
    case .completed: return ADEColor.success
    case .failed: return ADEColor.danger
    }
  }

  private func statusGlyph(for status: NormalizedStatus) -> Image {
    switch status {
    case .pending: return Image(systemName: "circle")
    case .inProgress: return Image(systemName: "circle.dotted")
    case .completed: return Image(systemName: "checkmark.circle.fill")
    case .failed: return Image(systemName: "xmark.circle.fill")
    }
  }

  private func statusLabel(for status: NormalizedStatus) -> String {
    switch status {
    case .pending: return "Pending"
    case .inProgress: return "In progress"
    case .completed: return "Done"
    case .failed: return "Failed"
    }
  }
}

/// Plan-review card — shown when the agent enters plan mode and is waiting for
/// the user to approve or reject the implementation plan. Mirrors the desktop
/// `ChatProposedPlanCard` with amber/gold accent to separate it visually from
/// regular chat messages and draw the user's attention.
///
/// Collapsed state: header + truncated plan preview.
/// Expanded state: full scrollable plan text in a monospace block.
/// Actions: "Approve & Implement" (primary, success tint) and a "Reject & Revise"
/// flow that reveals an optional feedback text field before sending decline.
struct WorkPlanReviewCard: View {
  let plan: WorkPendingPlanApprovalModel
  let busy: Bool
  let onDecision: @MainActor (AgentChatApprovalDecision, String?) async -> Void
  /// Provider fallback for when the plan-approval detail carried no `source`.
  /// Usually the session provider.
  var fallbackProvider: String? = nil

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// Whether the full plan body is expanded in the scrollable block.
  @State private var planExpanded = false
  /// True while the "Reject & Revise" flow is open.
  @State private var rejectFlowVisible = false
  /// Optional feedback text the user can supply when rejecting.
  @State private var feedbackText = ""

  private let collapseThreshold = 400

  private var shouldOfferExpand: Bool {
    plan.planText.count > collapseThreshold
  }

  /// Resolved asking provider: the parsed plan source, else the session
  /// fallback. Drives the header verb, logo, and per-provider accent.
  private var resolvedProvider: String? {
    let trimmed = plan.source.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? fallbackProvider : trimmed
  }

  /// Per-provider accent (Claude amber, Codex warm white, Cursor/Droid violet,
  /// OpenCode blue). Replaces the single hardcoded gold the card used to carry.
  private var accent: Color { ADEColor.providerChatAccent(for: resolvedProvider) }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      // Per-provider accent gradient line at the top — matches desktop's `border-b` gradient.
      LinearGradient(
        colors: [Color.clear, accent.opacity(0.55), Color.clear],
        startPoint: .leading,
        endPoint: .trailing
      )
      .frame(height: 1)

      VStack(alignment: .leading, spacing: 14) {
        planHeader
        planBody
        if rejectFlowVisible {
          feedbackSection
        }
        actionRow
      }
      .padding(16)
    }
    .background(
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .fill(ADEColor.cardBackground.opacity(0.92))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .stroke(accent.opacity(0.22), lineWidth: 0.8)
    )
    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    .accessibilityElement(children: .contain)
    .accessibilityLabel("\(workChatSurfaceProviderName(resolvedProvider)) · Plan ready. \(plan.title). \(plan.planText.prefix(120))")
  }

  // MARK: - Header

  private var planHeader: some View {
    HStack(alignment: .center, spacing: 8) {
      // Provider-identified header: logo + "{Provider} · Plan ready". Replaces
      // the old clock glyph + "PLAN APPROVAL" label from the desktop redesign.
      WorkProviderBareLogo(
        provider: resolvedProvider,
        fallbackSymbol: providerIcon(resolvedProvider ?? ""),
        tint: accent,
        size: 18
      )

      Text(plan.providerHeaderVerb(fallbackProvider: fallbackProvider))
        .font(.caption.weight(.semibold))
        .foregroundStyle(accent)

      Spacer(minLength: 8)

      Image(systemName: "list.bullet.clipboard")
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(accent.opacity(0.45))
    }
  }

  // MARK: - Plan body

  @ViewBuilder
  private var planBody: some View {
    let displayText = (shouldOfferExpand && !planExpanded)
      ? String(plan.planText.prefix(collapseThreshold)) + "…"
      : plan.planText

    VStack(alignment: .leading, spacing: 8) {
      ScrollView {
        Text(displayText)
          .font(.system(.caption, design: .monospaced))
          .foregroundStyle(ADEColor.textPrimary.opacity(0.88))
          .frame(maxWidth: .infinity, alignment: .leading)
          .textSelection(.enabled)
      }
      .frame(maxHeight: planExpanded ? 420 : 220)
      .padding(12)
      .background(
        ADEColor.recessedBackground.opacity(0.75),
        in: RoundedRectangle(cornerRadius: 12, style: .continuous)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(accent.opacity(0.10), lineWidth: 0.5)
      )
      .animation(.spring(duration: 0.28), value: planExpanded)

      if shouldOfferExpand {
        HStack(spacing: 0) {
          Button {
            withAnimation(.spring(duration: 0.25)) {
              planExpanded.toggle()
            }
          } label: {
            HStack(spacing: 4) {
              Image(systemName: planExpanded ? "arrow.up.left.and.arrow.down.right" : "arrow.down.left.and.arrow.up.right")
                .font(.system(size: 9, weight: .bold))
              Text(planExpanded ? "Collapse" : "View full plan")
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .tracking(0.6)
            }
            .foregroundStyle(accent.opacity(0.60))
          }
          .buttonStyle(.plain)
          .accessibilityLabel(planExpanded ? "Collapse plan" : "View full plan")

          Spacer(minLength: 8)

          // Copy plan button
          WorkPlanCopyButton(text: plan.planText, accent: accent)
        }
      } else {
        HStack {
          Spacer(minLength: 0)
          WorkPlanCopyButton(text: plan.planText, accent: accent)
        }
      }
    }
  }

  // MARK: - Reject feedback section

  @ViewBuilder
  private var feedbackSection: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Feedback (optional)")
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
      TextField("Describe what to change…", text: $feedbackText, axis: .vertical)
        .lineLimit(2...5)
        .adeInsetField(cornerRadius: 12, padding: 10)
        .disabled(busy)
    }
    .transition(.opacity.combined(with: .move(edge: .top)))
  }

  // MARK: - Action row

  private var actionRow: some View {
    HStack(spacing: 10) {
      if !rejectFlowVisible {
        // Primary: Approve & Implement
        Button {
          Task { await onDecision(.accept, nil) }
        } label: {
          HStack(spacing: 6) {
            Image(systemName: "checkmark")
              .font(.system(size: 11, weight: .bold))
            Text("Approve & Implement")
              .font(.caption.weight(.semibold))
          }
          .foregroundStyle(.white)
          .padding(.horizontal, 14)
          .padding(.vertical, 9)
          .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .fill(ADEColor.success.opacity(0.82))
          )
          .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .stroke(ADEColor.success.opacity(0.40), lineWidth: 0.8)
          )
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityLabel("Approve plan and begin implementation")

        // Secondary: Reject & Revise
        Button {
          withAnimation(.spring(duration: 0.22)) {
            rejectFlowVisible = true
          }
        } label: {
          Text("Reject & Revise")
            .font(.caption.weight(.medium))
            .foregroundStyle(ADEColor.textSecondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(
              RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(ADEColor.surfaceBackground.opacity(0.70))
            )
            .overlay(
              RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(ADEColor.border.opacity(0.22), lineWidth: 0.8)
            )
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityLabel("Reject plan and request revisions")
      } else {
        // Confirm rejection
        Button {
          let feedback = feedbackText.trimmingCharacters(in: .whitespacesAndNewlines)
          Task { await onDecision(.decline, feedback.isEmpty ? nil : feedback) }
        } label: {
          Text("Send Rejection")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(
              RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(ADEColor.danger.opacity(0.82))
            )
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityLabel("Confirm plan rejection")

        // Cancel rejection flow
        Button {
          withAnimation(.spring(duration: 0.22)) {
            rejectFlowVisible = false
            feedbackText = ""
          }
        } label: {
          Text("Cancel")
            .font(.caption.weight(.medium))
            .foregroundStyle(ADEColor.textSecondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(
              RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(ADEColor.surfaceBackground.opacity(0.70))
            )
            .overlay(
              RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(ADEColor.border.opacity(0.22), lineWidth: 0.8)
            )
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityLabel("Cancel rejection")
      }
    }
    .animation(.spring(duration: 0.22), value: rejectFlowVisible)
  }
}

/// Compact copy-to-clipboard button used in the plan body footer.
private struct WorkPlanCopyButton: View {
  let text: String
  var accent: Color = ADEColor.warning
  @State private var copied = false

  var body: some View {
    Button {
      UIPasteboard.general.string = text
      copied = true
      Task { @MainActor in
        try? await Task.sleep(nanoseconds: 1_400_000_000)
        copied = false
      }
    } label: {
      HStack(spacing: 4) {
        Image(systemName: copied ? "checkmark" : "doc.on.doc")
          .font(.system(size: 9, weight: .bold))
        Text(copied ? "Copied" : "Copy plan")
          .font(.system(size: 10, weight: .semibold, design: .monospaced))
          .tracking(0.6)
      }
      .foregroundStyle(copied ? ADEColor.success : accent.opacity(0.55))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(copied ? "Copied to clipboard" : "Copy plan to clipboard")
  }
}

/// Horizontal chip strip surfacing running/recently-finished subagents above
/// the transcript, so the user can see at a glance what's in flight without
/// hunting through the timeline.
struct WorkSubagentStrip: View {
  let snapshots: [WorkSubagentSnapshot]
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var expandedTaskId: String? = nil

  var body: some View {
    if snapshots.isEmpty {
      EmptyView()
    } else {
      VStack(alignment: .leading, spacing: 8) {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            ForEach(snapshots) { snapshot in
              Button {
                withAnimation(ADEMotion.quick(reduceMotion: reduceMotion)) {
                  expandedTaskId = expandedTaskId == snapshot.taskId ? nil : snapshot.taskId
                }
              } label: {
                chipBody(for: snapshot, expanded: expandedTaskId == snapshot.taskId)
              }
              .buttonStyle(.plain)
              .accessibilityLabel(accessibilityLabel(for: snapshot))
            }
          }
          .padding(.horizontal, 2)
        }

        if let expanded = expandedTaskId,
           let snapshot = snapshots.first(where: { $0.taskId == expanded }) {
          expandedCard(for: snapshot)
        }
      }
    }
  }

  @ViewBuilder
  private func chipBody(for snapshot: WorkSubagentSnapshot, expanded: Bool) -> some View {
    let tint = tint(for: snapshot.status)
    HStack(spacing: 6) {
      statusDot(for: snapshot.status, tint: tint)
      Text(truncated(workSubagentMeaningfulName(snapshot), limit: 28))
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
      if snapshot.background {
        Image(systemName: "moon.zzz.fill")
          .font(.system(size: 9, weight: .bold))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 7)
    .background(tint.opacity(expanded ? 0.22 : 0.12), in: Capsule(style: .continuous))
    .overlay(
      Capsule(style: .continuous)
        .stroke(tint.opacity(expanded ? 0.55 : 0.3), lineWidth: 0.8)
    )
  }

  @ViewBuilder
  private func statusDot(for status: WorkSubagentSnapshot.Status, tint: Color) -> some View {
    switch status {
    case .running:
      Circle()
        .fill(tint)
        .frame(width: 7, height: 7)
        .overlay(Circle().stroke(tint.opacity(0.3), lineWidth: 2).scaleEffect(1.6))
    case .succeeded:
      Image(systemName: "checkmark.circle.fill")
        .font(.system(size: 11, weight: .bold))
        .foregroundStyle(tint)
    case .failed:
      Image(systemName: "xmark.circle.fill")
        .font(.system(size: 11, weight: .bold))
        .foregroundStyle(tint)
    case .stopped:
      Image(systemName: "pause.circle.fill")
        .font(.system(size: 11, weight: .bold))
        .foregroundStyle(tint)
    }
  }

  @ViewBuilder
  private func expandedCard(for snapshot: WorkSubagentSnapshot) -> some View {
    let tint = tint(for: snapshot.status)
    let runtime = workSubagentRuntimeLabel(snapshot)
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 8) {
        statusDot(for: snapshot.status, tint: tint)
        Text(workSubagentMeaningfulName(snapshot))
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Spacer(minLength: 6)
        Text(statusLabel(for: snapshot.status))
          .font(.caption2.weight(.semibold))
          .foregroundStyle(tint)
      }
      if let tool = snapshot.lastToolName, !tool.isEmpty {
        HStack(spacing: 4) {
          Image(systemName: "wrench.and.screwdriver")
            .font(.system(size: 9, weight: .semibold))
          Text(tool)
            .font(.caption2)
        }
        .foregroundStyle(ADEColor.textMuted)
      }
      if let runtime {
        HStack(spacing: 4) {
          Image(systemName: "cpu")
            .font(.system(size: 9, weight: .semibold))
          Text(runtime)
            .font(.caption2)
        }
        .foregroundStyle(ADEColor.textMuted)
      }
      if let summary = snapshot.latestSummary, !summary.isEmpty {
        Text(summary)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(4)
      }
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(ADEColor.surfaceBackground.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(tint.opacity(0.28), lineWidth: 0.75)
    )
    .transition(.opacity.combined(with: .move(edge: .top)))
  }

  private func tint(for status: WorkSubagentSnapshot.Status) -> Color {
    switch status {
    case .running: return ADEColor.accent
    case .succeeded: return ADEColor.success
    case .failed: return ADEColor.danger
    case .stopped: return ADEColor.warning
    }
  }

  private func statusLabel(for status: WorkSubagentSnapshot.Status) -> String {
    switch status {
    case .running: return "Running"
    case .succeeded: return "Done"
    case .failed: return "Failed"
    case .stopped: return "Halted"
    }
  }

  private func accessibilityLabel(for snapshot: WorkSubagentSnapshot) -> String {
    let status = statusLabel(for: snapshot.status)
    return "Subagent \(workSubagentMeaningfulName(snapshot)), \(status). Tap for details."
  }

  private func truncated(_ value: String, limit: Int) -> String {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.count <= limit { return trimmed }
    return String(trimmed.prefix(limit - 1)) + "…"
  }
}

struct WorkComposerBadgeCapsule<Content: View>: View {
  let tint: Color
  let spacing: CGFloat
  let strokeOpacity: Double
  let accessibilityLabel: String
  let onOpen: () -> Void
  @ViewBuilder let content: () -> Content

  init(
    tint: Color,
    spacing: CGFloat = 7,
    strokeOpacity: Double = 0.22,
    accessibilityLabel: String,
    onOpen: @escaping () -> Void,
    @ViewBuilder content: @escaping () -> Content
  ) {
    self.tint = tint
    self.spacing = spacing
    self.strokeOpacity = strokeOpacity
    self.accessibilityLabel = accessibilityLabel
    self.onOpen = onOpen
    self.content = content
  }

  var body: some View {
    Button(action: onOpen) {
      HStack(spacing: spacing) {
        content()
        Image(systemName: "chevron.up")
          .font(.system(size: 10, weight: .bold))
      }
      .foregroundStyle(tint)
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(ADEColor.cardBackground.opacity(0.76), in: Capsule(style: .continuous))
      .overlay(
        Capsule(style: .continuous)
          .stroke(tint.opacity(strokeOpacity), lineWidth: 1)
      )
      .frame(minHeight: 44)
      .contentShape(Capsule(style: .continuous))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(accessibilityLabel)
  }
}

struct WorkSubagentActivePopup: View {
  let count: Int
  let onOpen: () -> Void

  var body: some View {
    WorkComposerBadgeCapsule(
      tint: ADEColor.accent,
      spacing: 8,
      accessibilityLabel: "\(count) active subagent\(count == 1 ? "" : "s")",
      onOpen: onOpen
    ) {
      Image(systemName: "person.2.fill")
        .font(.system(size: 12, weight: .semibold))
      Text("\(count) active")
        .font(.caption.weight(.semibold))
    }
  }
}

struct WorkChatInfoActivePopup: View {
  let count: Int
  let onOpen: () -> Void

  var body: some View {
    WorkComposerBadgeCapsule(
      tint: ADEColor.accent,
      accessibilityLabel: "Chat Info, \(count) scheduled item\(count == 1 ? "" : "s")",
      onOpen: onOpen
    ) {
      Image(systemName: "info.circle.fill")
        .font(.system(size: 12, weight: .semibold))
      Text("Chat Info")
        .font(.caption.weight(.semibold))
        .lineLimit(1)
      Text("\(count)")
        .font(.caption2.weight(.bold))
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(ADEColor.accent.opacity(0.14), in: Capsule(style: .continuous))
    }
  }
}

func workScheduledWorkIsActive(_ item: WorkScheduledWorkSnapshot) -> Bool {
  let status = item.status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  return status == "scheduled" || status == "running" || status == "fired"
}

func workScheduledWorkActiveCount(_ snapshots: [WorkScheduledWorkSnapshot]) -> Int {
  snapshots.reduce(0) { count, item in
    count + (workScheduledWorkIsActive(item) ? 1 : 0)
  }
}

struct WorkChatInfoDetailsSheet: View {
  let scheduledWorkSnapshots: [WorkScheduledWorkSnapshot]

  private var activeCount: Int {
    workScheduledWorkActiveCount(scheduledWorkSnapshots)
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 14) {
          if scheduledWorkSnapshots.isEmpty {
            ADEEmptyStateView(
              symbol: "info.circle",
              title: "No chat info",
              message: "Scheduled wakeups and background work will appear here."
            )
            .padding(.top, 24)
          } else {
            summaryHeader
            section(title: "Schedule", count: scheduledWorkSnapshots.count) {
              VStack(spacing: 8) {
                ForEach(scheduledWorkSnapshots) { item in
                  WorkScheduledWorkRow(item: item)
                }
              }
            }
          }
        }
        .padding(16)
      }
      .scrollIndicators(.hidden)
      .background(workChatCanvasBackground.ignoresSafeArea())
      .navigationTitle("Chat Info")
      .navigationBarTitleDisplayMode(.inline)
    }
  }

  private var summaryHeader: some View {
    HStack(spacing: 10) {
      Image(systemName: "clock")
        .font(.system(size: 16, weight: .semibold))
        .foregroundStyle(ADEColor.accent)
        .frame(width: 30, height: 30)
        .background(ADEColor.accent.opacity(0.12), in: Circle())
      VStack(alignment: .leading, spacing: 2) {
        Text("\(scheduledWorkSnapshots.count) scheduled item\(scheduledWorkSnapshots.count == 1 ? "" : "s")")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(activeCount == 0 ? "No active scheduled work" : "\(activeCount) active")
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
      }
      Spacer(minLength: 0)
    }
    .padding(12)
    .background(ADEColor.cardBackground.opacity(0.72), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.border.opacity(0.5), lineWidth: 0.6)
    )
  }

  @ViewBuilder
  private func section<Content: View>(title: String, count: Int, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text(title)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
          .textCase(.uppercase)
        Spacer(minLength: 0)
        Text("\(count)")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
      }
      content()
    }
  }
}

private struct WorkScheduledWorkRow: View {
  let item: WorkScheduledWorkSnapshot

  private var status: String {
    item.status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  }

  private var tint: Color {
    workScheduledWorkStatusTint(status)
  }

  private var metadata: String {
    [
      workScheduledWorkKindLabel(item.kind),
      item.nextRunAt.map { "next \(relativeTimestamp($0))" },
      item.lastRunAt.map { "last \(relativeTimestamp($0))" },
      item.cron,
    ].compactMap(workScheduledWorkText).joined(separator: " · ")
  }

  private var detail: String? {
    let statusError = status == "failed" || status == "missed"
      ? workScheduledWorkText(item.error)
      : nil
    return statusError
      ?? workScheduledWorkText(item.summary)
      ?? workScheduledWorkText(item.reason)
      ?? workScheduledWorkText(item.prompt)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: workScheduledWorkStatusSymbol(status))
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(tint)
          .frame(width: 24, height: 24)
          .background(tint.opacity(0.12), in: Circle())
        VStack(alignment: .leading, spacing: 3) {
          Text(item.title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(2)
          if !metadata.isEmpty {
            Text(metadata)
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(2)
          }
        }
        Spacer(minLength: 0)
        Text(workScheduledWorkStatusLabel(status))
          .font(.caption2.weight(.semibold))
          .foregroundStyle(tint)
          .padding(.horizontal, 7)
          .padding(.vertical, 3)
          .background(tint.opacity(0.10), in: Capsule(style: .continuous))
      }
      if let detail {
        Text(detail)
          .font(.caption)
          .foregroundStyle(status == "failed" || status == "missed" ? ADEColor.danger : ADEColor.textSecondary)
          .lineLimit(3)
      }
    }
    .padding(12)
    .background(ADEColor.cardBackground.opacity(0.76), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(tint.opacity(0.18), lineWidth: 0.8)
    )
  }
}

private func workScheduledWorkText(_ value: String?) -> String? {
  let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return trimmed.isEmpty ? nil : trimmed
}

private func workScheduledWorkKindLabel(_ raw: String) -> String {
  switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
  case "wakeup":
    return "Wakeup"
  case "cron":
    return "Scheduled task"
  case "loop":
    return "Loop wakeup"
  case "remote_trigger":
    return "Remote trigger"
  case "background_task":
    return "Background work"
  default:
    return raw.replacingOccurrences(of: "_", with: " ").capitalized
  }
}

private func workScheduledWorkStatusLabel(_ raw: String) -> String {
  switch raw {
  case "fired":
    return "Fired"
  default:
    return raw.replacingOccurrences(of: "_", with: " ").capitalized
  }
}

private func workScheduledWorkStatusTint(_ status: String) -> Color {
  switch status {
  case "running", "fired":
    return ADEColor.accent
  case "scheduled":
    return ADEColor.warning
  case "completed":
    return ADEColor.success
  case "failed", "missed":
    return ADEColor.danger
  default:
    return ADEColor.textMuted
  }
}

private func workScheduledWorkStatusSymbol(_ status: String) -> String {
  switch status {
  case "running", "fired":
    return "play.circle.fill"
  case "scheduled":
    return "clock.fill"
  case "completed":
    return "checkmark.circle.fill"
  case "failed", "missed":
    return "xmark.circle.fill"
  case "cancelled", "stopped":
    return "stop.circle"
  default:
    return "circle"
  }
}

struct WorkSubagentDrawerSheet: View {
  let snapshots: [WorkSubagentSnapshot]
  let provider: String?
  let selectedTaskId: String?
  let probingTaskId: String?
  @Binding var expandedTaskIds: Set<String>
  let onSelect: @MainActor (WorkSubagentSnapshot) async -> Void

  private var foreground: [WorkSubagentSnapshot] {
    snapshots.filter { !$0.background }
  }

  private var background: [WorkSubagentSnapshot] {
    snapshots.filter(\.background)
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 16) {
          if !foreground.isEmpty {
            section(title: "Subagents", snapshots: foreground)
          }
          if !background.isEmpty {
            section(title: "Background", snapshots: background)
          }
          if snapshots.isEmpty {
            ADEEmptyStateView(
              symbol: "person.2",
              title: "No subagents",
              message: "This chat has not started any subagents yet."
            )
            .padding(.top, 24)
          }
        }
        .padding(16)
      }
      .scrollIndicators(.hidden)
      .background(workChatCanvasBackground.ignoresSafeArea())
      .navigationTitle("Subagents")
      .navigationBarTitleDisplayMode(.inline)
    }
  }

  @ViewBuilder
  private func section(title: String, snapshots: [WorkSubagentSnapshot]) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title)
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
        .textCase(.uppercase)
      VStack(spacing: 6) {
        ForEach(snapshots) { snapshot in
          row(snapshot)
        }
      }
    }
  }

  @ViewBuilder
  private func row(_ snapshot: WorkSubagentSnapshot) -> some View {
    let selected = selectedTaskId == snapshot.taskId
    let expanded = expandedTaskIds.contains(snapshot.taskId)
    let elapsed = workSubagentElapsedLabel(snapshot)
    let detailText = drawerDetailText(snapshot)
    let lastToolName = trimmedNonEmpty(snapshot.lastToolName)
    let subtitle = drawerSubtitleText(snapshot, elapsed: elapsed, detailText: detailText)
    let showsDisclosure = snapshot.status == .running || detailText != nil || lastToolName != nil
    Button {
      Task { await onSelect(snapshot) }
    } label: {
      VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 10) {
          WorkSubagentGlyph(id: snapshot.agentId ?? snapshot.taskId, status: snapshot.status)
          VStack(alignment: .leading, spacing: 2) {
            Text(workSubagentMeaningfulName(snapshot))
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(rowTitleColor(snapshot))
              .lineLimit(1)
              .truncationMode(.tail)
            if let subtitle {
              Text(subtitle)
                .font(.caption2)
                .foregroundStyle(ADEColor.textMuted)
                .lineLimit(1)
            }
          }
          Spacer(minLength: 0)
          HStack(spacing: 8) {
            if probingTaskId == snapshot.taskId {
              ProgressView()
                .controlSize(.small)
            }
            WorkSubagentStatusChip(status: snapshot.status)
            if showsDisclosure {
              Image(systemName: selected ? "arrow.uturn.left" : "chevron.right")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(ADEColor.textMuted)
            }
          }
        }

        if expanded, detailText != nil || lastToolName != nil {
          VStack(alignment: .leading, spacing: 5) {
            if let detailText {
              Text(detailText)
            }
            if let tool = lastToolName {
              Text("last: \(tool)")
                .font(.caption2.monospaced())
                .foregroundStyle(ADEColor.textMuted)
            }
          }
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.leading, 34)
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 9)
      .background(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(selected ? ADEColor.accent.opacity(0.12) : ADEColor.cardBackground.opacity(0.52))
      )
      .overlay(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .stroke(selected ? ADEColor.accent.opacity(0.45) : ADEColor.glassBorder, lineWidth: 1)
      )
    }
    .buttonStyle(.plain)
  }

  private func drawerDetailText(_ snapshot: WorkSubagentSnapshot) -> String? {
    if let summary = filteredSubagentDetail(snapshot.latestSummary) {
      return summary
    }

    return filteredSubagentDetail(snapshot.description)
  }

  private func drawerSubtitleText(
    _ snapshot: WorkSubagentSnapshot,
    elapsed: String?,
    detailText: String?
  ) -> String? {
    var parts: [String] = []
    if let elapsed {
      parts.append(elapsed)
    }
    if snapshot.background {
      parts.append("background")
    }
    if let runtime = workSubagentRuntimeLabel(snapshot) {
      parts.append(runtime)
    }
    if let detailText {
      parts.append(truncatedDrawerText(detailText, limit: 58))
    }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }

  private func filteredSubagentDetail(_ value: String?) -> String? {
    guard let trimmed = trimmedNonEmpty(value) else {
      return nil
    }
    switch trimmed.lowercased() {
    case "agent closed", "agent stopped", "subagent closed", "subagent stopped":
      return nil
    default:
      return trimmed
    }
  }

  private func trimmedNonEmpty(_ value: String?) -> String? {
    guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
      return nil
    }
    return trimmed
  }

  private func truncatedDrawerText(_ value: String, limit: Int) -> String {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.count > limit, limit > 1 else {
      return trimmed
    }
    return String(trimmed.prefix(limit - 1)) + "…"
  }

  private func rowTitleColor(_ snapshot: WorkSubagentSnapshot) -> Color {
    switch snapshot.status {
    case .running: return ADEColor.accent
    case .failed: return ADEColor.danger
    case .succeeded: return ADEColor.textPrimary
    case .stopped: return ADEColor.textMuted
    }
  }
}

private struct WorkSubagentStatusChip: View {
  let status: WorkSubagentSnapshot.Status

  var body: some View {
    Text(workSubagentStatusLabel(status))
      .font(.caption2.weight(.semibold))
      .foregroundStyle(tint)
      .lineLimit(1)
      .fixedSize(horizontal: true, vertical: false)
      .padding(.horizontal, 7)
      .padding(.vertical, 3)
      .background(tint.opacity(0.13), in: Capsule(style: .continuous))
      .overlay(
        Capsule(style: .continuous)
          .stroke(tint.opacity(0.28), lineWidth: 0.75)
      )
      .accessibilityLabel(workSubagentStatusLabel(status))
  }

  private var tint: Color {
    workSubagentStatusTint(status)
  }
}

private struct WorkSubagentGlyph: View {
  let id: String
  let status: WorkSubagentSnapshot.Status

  private var color: Color {
    let palette: [Color] = [ADEColor.accent, ADEColor.success, ADEColor.warning, ADEColor.info, ADEColor.danger]
    return palette[Int(UInt(bitPattern: workStableSubagentHash(id)) % UInt(palette.count))]
  }

  var body: some View {
    ZStack(alignment: .bottomTrailing) {
      LazyVGrid(columns: Array(repeating: GridItem(.fixed(5), spacing: 1), count: 3), spacing: 1) {
        ForEach(0..<9, id: \.self) { index in
          RoundedRectangle(cornerRadius: 1.5, style: .continuous)
            .fill(workSubagentGlyphBit(id: id, index: index) ? color : color.opacity(0.22))
            .frame(width: 5, height: 5)
        }
      }
      .padding(5)
      .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 7, style: .continuous))

      Circle()
        .fill(statusColor)
        .frame(width: 7, height: 7)
        .overlay(Circle().stroke(workChatCanvasBackground, lineWidth: 1.5))
    }
    .frame(width: 28, height: 28)
  }

  private var statusColor: Color {
    workSubagentStatusTint(status)
  }
}

private func workStableSubagentHash(_ value: String) -> Int {
  var hash = 5381
  for scalar in value.unicodeScalars {
    hash = ((hash << 5) &+ hash) &+ Int(scalar.value)
  }
  return hash
}

private func workSubagentGlyphBit(id: String, index: Int) -> Bool {
  let hash = UInt(bitPattern: workStableSubagentHash("\(id):\(index)"))
  return hash % 3 != 0
}

private func workSubagentStatusLabel(_ status: WorkSubagentSnapshot.Status) -> String {
  switch status {
  case .running: return "Running"
  case .succeeded: return "Completed"
  case .failed: return "Failed"
  case .stopped: return "Stopped"
  }
}

private func workSubagentStatusTint(_ status: WorkSubagentSnapshot.Status) -> Color {
  switch status {
  case .running: return ADEColor.accent
  case .succeeded: return ADEColor.success
  case .failed: return ADEColor.danger
  case .stopped: return ADEColor.warning
  }
}

private func workSubagentRuntimeLabel(_ snapshot: WorkSubagentSnapshot) -> String? {
  var parts: [String] = []
  if let model = snapshot.model?.trimmingCharacters(in: .whitespacesAndNewlines),
     !model.isEmpty {
    parts.append(model)
  }
  if let effort = snapshot.reasoningEffort?.trimmingCharacters(in: .whitespacesAndNewlines),
     !effort.isEmpty {
    parts.append(effort)
  }
  return parts.isEmpty ? nil : parts.joined(separator: " · ")
}

private func workSubagentElapsedLabel(_ snapshot: WorkSubagentSnapshot) -> String? {
  guard let startedAt = snapshot.startedAt,
        let start = parseWorkTimestampForSubagent(startedAt)
  else { return nil }
  let end = snapshot.status == .running
    ? Date()
    : snapshot.updatedAt.flatMap(parseWorkTimestampForSubagent) ?? Date()
  return WorkActivityIndicator.formatElapsedSeconds(Int(max(0, end.timeIntervalSince(start))))
}

private func parseWorkTimestampForSubagent(_ value: String) -> Date? {
  workSubagentIsoFormatter.date(from: value) ?? workSubagentIsoFallbackFormatter.date(from: value)
}

private let workSubagentIsoFormatter: ISO8601DateFormatter = {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter
}()

private let workSubagentIsoFallbackFormatter: ISO8601DateFormatter = {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime]
  return formatter
}()
