import SwiftUI

/// A live one-line pill that surfaces what the agent is doing right now
/// ("Running bash: ls -la", "Editing src/foo.ts", "Thinking…") by scanning
/// the tail of the transcript for the most recent actionable event.
///
/// Ports desktop `deriveLatestActivity` behaviour (see
/// apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx:2500)
/// against the existing `WorkChatEvent` shapes. Does not add new envelope
/// payloads. Respects Reduce Motion by falling back to a static dot.
struct WorkActivityIndicator: View {
  let transcript: [WorkChatEnvelope]
  let isStreaming: Bool

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    guard isStreaming else { return AnyView(EmptyView()) }

    let presentation = Self.derivePresentation(from: transcript)

    return AnyView(
      HStack(spacing: 10) {
        WorkActivityPulseDot(reduceMotion: reduceMotion, tint: presentation.tint)

        VStack(alignment: .leading, spacing: 1) {
          Text(presentation.label)
            .font(.caption.weight(.semibold))
            .foregroundStyle(presentation.tint)
            .tracking(0.3)
          if let detail = presentation.detail {
            Text(detail)
              .font(.caption2.monospaced())
              .foregroundStyle(ADEColor.textSecondary)
              .lineLimit(1)
              .truncationMode(.middle)
          }
        }

        Spacer(minLength: 0)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 9)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(ADEColor.surfaceBackground.opacity(0.55))
      )
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(presentation.tint.opacity(0.18), lineWidth: 0.5)
      )
      .accessibilityElement(children: .combine)
      .accessibilityLabel(presentation.accessibilityLabel)
    )
  }

  struct Presentation: Equatable {
    let label: String
    let detail: String?
    let tint: Color

    var accessibilityLabel: String {
      detail.map { "\(label): \($0)" } ?? label
    }
  }

  /// Walks the transcript tail looking for the most recent running/active
  /// event. Command > running tool call > file change > named activity >
  /// subagent progress > fall back to "Thinking…".
  static func derivePresentation(from transcript: [WorkChatEnvelope]) -> Presentation {
    let thinkingFallback = Presentation(label: "Thinking", detail: nil, tint: ADEColor.accent)

    for envelope in transcript.reversed() {
      switch envelope.event {
      case .command(let command, _, _, let status, _, _, _, _):
        if status == .running {
          return Presentation(
            label: "Running",
            detail: summarizeCommand(command),
            tint: ADEColor.accent
          )
        }

      case .toolCall(let tool, _, _, _, _):
        return Presentation(
          label: labelForTool(tool),
          detail: nil,
          tint: ADEColor.accent
        )

      case .toolResult(let tool, _, _, _, _, let status):
        if status == .running {
          return Presentation(
            label: labelForTool(tool),
            detail: nil,
            tint: ADEColor.accent
          )
        }

      case .fileChange(let path, _, let kind, let status, _, _):
        if status == .running {
          return Presentation(
            label: fileChangeLabel(kind: kind),
            detail: truncatedPath(path),
            tint: ADEColor.accent
          )
        }

      case .activity(let kind, let detail, _):
        return Presentation(
          label: humanizeActivityKind(kind),
          detail: detail?.isEmpty == false ? detail : nil,
          tint: ADEColor.accent
        )

      case .webSearch(let query, _, let status, _, _):
        if status == .running {
          return Presentation(
            label: "Searching",
            detail: query,
            tint: ADEColor.accent
          )
        }

      case .subagentStarted(_, let description, _, _):
        return Presentation(
          label: "Agent",
          detail: description,
          tint: ADEColor.accent
        )

      case .subagentProgress(_, _, let summary, let toolName, _):
        return Presentation(
          label: toolName.map { "Agent · \($0)" } ?? "Agent",
          detail: summary.isEmpty ? nil : summary,
          tint: ADEColor.accent
        )

      case .status(let turnStatus, let message, _):
        if let message, !message.isEmpty {
          return Presentation(
            label: humanizeActivityKind(turnStatus),
            detail: message,
            tint: ADEColor.accent
          )
        }

      case .reasoning:
        return Presentation(label: "Thinking", detail: nil, tint: ADEColor.accent)

      case .assistantText, .userMessage, .done, .plan, .planText,
           .todoUpdate, .approvalRequest, .structuredQuestion, .toolUseSummary,
           .systemNotice, .error, .promptSuggestion, .contextCompact,
           .autoApprovalReview, .pendingInputResolved, .subagentResult,
           .completionReport, .unknown:
        continue
      }
    }

    return thinkingFallback
  }

  private static func labelForTool(_ tool: String) -> String {
    let normalized = tool.lowercased()
    if normalized.contains("read") { return "Reading" }
    if normalized.contains("write") { return "Writing" }
    if normalized.contains("edit") { return "Editing" }
    if normalized.contains("search") || normalized.contains("grep") { return "Searching" }
    if normalized.contains("bash") || normalized.contains("shell") { return "Running" }
    if normalized.contains("web") { return "Browsing" }
    return "Using \(tool)"
  }

  private static func fileChangeLabel(kind: String) -> String {
    switch kind.lowercased() {
    case "create", "add": return "Creating"
    case "delete", "remove": return "Deleting"
    case "rename": return "Renaming"
    case "update", "modify", "edit": return "Editing"
    default: return "Editing"
    }
  }

  private static func humanizeActivityKind(_ kind: String) -> String {
    let cleaned = kind.replacingOccurrences(of: "_", with: " ")
    return cleaned.prefix(1).uppercased() + cleaned.dropFirst()
  }

  private static func truncatedPath(_ path: String) -> String {
    let parts = path.split(separator: "/")
    guard parts.count > 2 else { return path }
    return ".../" + parts.suffix(2).joined(separator: "/")
  }

  private static func summarizeCommand(_ command: String) -> String {
    let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
    let firstLine = trimmed.split(separator: "\n").first.map(String.init) ?? trimmed
    if firstLine.count <= 72 { return firstLine }
    return String(firstLine.prefix(69)) + "…"
  }
}

private struct WorkActivityPulseDot: View {
  let reduceMotion: Bool
  let tint: Color

  @State private var pulsing = false

  var body: some View {
    ZStack {
      if !reduceMotion {
        Circle()
          .fill(tint.opacity(0.35))
          .frame(width: 14, height: 14)
          .scaleEffect(pulsing ? 1.6 : 0.9)
          .opacity(pulsing ? 0 : 0.7)
          .animation(
            .easeOut(duration: 1.1).repeatForever(autoreverses: false),
            value: pulsing
          )
      }
      Circle()
        .fill(tint)
        .frame(width: 8, height: 8)
        .overlay(
          Circle().stroke(.white.opacity(0.25), lineWidth: 0.5)
        )
    }
    .frame(width: 14, height: 14)
    .onAppear { pulsing = true }
  }
}
