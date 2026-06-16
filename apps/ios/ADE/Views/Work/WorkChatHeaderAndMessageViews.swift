import SwiftUI
import UIKit
import AVKit

struct WorkSessionHeader: View {
  let session: TerminalSessionSummary
  let chatSummary: AgentChatSessionSummary?
  // transitionNamespace is retained on the init for caller compatibility but
  // intentionally unused in body: navigationTransition(.zoom(sourceID:)) on
  // the container already interpolates child layouts during the push, so
  // this destination must NOT emit per-element matchedGeometryEffect for
  // work-icon/title/status — the list row is the sole isSource=true view
  // in each matched-geometry group.
  let transitionNamespace: Namespace.ID?
  let onOpenLane: (() -> Void)?

  private var status: String {
    normalizedWorkChatSessionStatus(session: session, summary: chatSummary)
  }

  private var statusTint: Color {
    workChatStatusTint(status)
  }

  private var relativeStartLabel: String {
    relativeTimestamp(session.startedAt)
  }

  var body: some View {
    // Compact context row. Lane actions live in the nav bar and on the lane
    // chip, so this row avoids a second anonymous overflow menu.
    HStack(spacing: 8) {
      laneChip
      Text(relativeStartLabel)
        .font(.caption.monospacedDigit())
        .foregroundStyle(ADEColor.textMuted)
        .lineLimit(1)
      Spacer(minLength: 0)
    }
    .padding(.vertical, 4)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("\(chatSummary?.title ?? session.title), \(sessionStatusLabel(session, summary: chatSummary)), lane \(session.laneName)")
  }

  @ViewBuilder
  private var laneChip: some View {
    if let onOpenLane {
      Button(action: onOpenLane) {
        laneChipContent
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Open lane \(session.laneName)")
    } else {
      laneChipContent
        .accessibilityLabel("Context \(session.laneName)")
    }
  }

  private var laneChipContent: some View {
    HStack(spacing: 6) {
      Circle()
        .fill(statusTint)
        .frame(width: 6, height: 6)
      Image(systemName: "arrow.triangle.branch")
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.accent)
      Text(session.laneName)
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
    }
    .padding(.horizontal, 9)
    .padding(.vertical, 5)
    .background(ADEColor.surfaceBackground.opacity(0.55), in: Capsule(style: .continuous))
    .overlay(
      Capsule(style: .continuous)
        .stroke(ADEColor.border.opacity(0.22), lineWidth: 0.6)
    )
  }
}

/// Desktop-shaped message row.
///
/// Assistant messages live inside a dark rounded card with only a small
/// model-badge chip above (no name, no per-message timestamp — that goes into
/// the centered turn separator). User messages stay right-aligned but size to
/// their content so short replies don't look like banner ads, and they drop
/// the per-message timestamp for the same reason.
struct WorkChatMessageBubble: View {
  let message: WorkChatMessage
  /// True only for the assistant message still receiving streaming deltas.
  /// Switches its markdown block parsing to the tail-only streaming parser so
  /// each delta re-parses just the growing tail instead of the whole message.
  var isStreaming: Bool = false
  /// Computed once by the parent transcript view. Avoids installing one
  /// GeometryReader per user row while preserving the desktop-style max width.
  var maxUserBubbleWidth: CGFloat? = nil
  @State private var assistantLineBudget = workAssistantMessageInitialLineBudget

  /// Provider string for the current chat session (e.g. "claude", "codex", "cursor").
  /// Injected via `.environment(\.workChatProvider, ...)` by the session view.
  @Environment(\.workChatProvider) private var sessionProvider
  /// Active session model id, used to resolve the per-model accent for the
  /// model badge chip and card border tint.
  @Environment(\.workChatModelId) private var sessionModelId
  /// Pretty model label ("Claude Sonnet 4.6"), injected by the session view
  /// so each bubble doesn't have to recompute the same string.
  @Environment(\.workChatModelLabel) private var sessionModelLabel

  var body: some View {
    if message.role == "assistant" {
      assistantRow
    } else {
      userRow
    }
  }

  private var accent: Color {
    ADEColor.chatSurfaceAccent(
      modelId: message.turnModelId ?? sessionModelId,
      provider: message.turnProvider ?? sessionProvider
    )
  }

  /// Desktop's `--chat-user-bubble-gradient`: a 135° sweep that starts at the
  /// (slightly lightened) provider accent, eases into #7c3aed (violet), then
  /// settles on #4c1d95 (deep violet). Replicated with explicit color mixes so
  /// the per-runtime accent still tints the bubble while every message shares
  /// the same violet base.
  private var userBubbleGradient: LinearGradient {
    LinearGradient(
      stops: [
        .init(color: workMixColors(accent, Color.white, 0.08), location: 0.0),
        .init(color: workMixColors(accent, workViolet, 0.40), location: 0.5),
        .init(color: workMixColors(accent, workDeepViolet, 0.42), location: 1.0),
      ],
      startPoint: .topLeading,
      endPoint: .bottomTrailing
    )
  }

  private var userBubbleBorder: Color {
    // accent at ~26% over a faint white edge — matches the desktop bubble's
    // `--chat-user-border-accent-mix`.
    workMixColors(accent, Color.white, 0.14).opacity(0.45)
  }

  private var workViolet: Color { Color(red: 0x7c / 255.0, green: 0x3a / 255.0, blue: 0xed / 255.0) }
  private var workDeepViolet: Color { Color(red: 0x4c / 255.0, green: 0x1d / 255.0, blue: 0x95 / 255.0) }

  private var assistantRow: some View {
    // Desktop parity: the agent answer is plain markdown prose on the flat
    // canvas — NO card, NO border, NO background. Just left-aligned text that
    // reads like a document. The truncation / "Show more" affordance stays but
    // unstyled so it doesn't reintroduce a boxed feel.
    let preview = assistantPreview

    return VStack(alignment: .leading, spacing: 10) {
      if preview.isTruncated {
        Text(preview.text)
          .font(.body)
          .foregroundStyle(ADEColor.textPrimary)
          .lineSpacing(5)
          .tint(ADEColor.accent)
          .frame(maxWidth: .infinity, alignment: .leading)
          .textSelection(.enabled)
          .accessibilityLabel(workAssistantMessageAccessibilityLabel(preview))
      } else {
        WorkMarkdownRenderer(
          markdown: preview.text,
          streamingCacheKey: isStreaming ? message.id : nil
        )
          .accessibilityElement(children: .ignore)
          .accessibilityLabel(workAssistantMessageAccessibilityLabel(preview))
      }

      if preview.isTruncated {
        HStack(spacing: 12) {
          Text("\(preview.visibleLineCount) of \(preview.totalLineCount) lines")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(ADEColor.textMuted)

          Spacer(minLength: 0)

          Button {
            UIPasteboard.general.string = message.markdown
          } label: {
            Label("Copy full", systemImage: "doc.on.doc")
              .labelStyle(.titleAndIcon)
              .font(.caption2.weight(.semibold))
          }
          .buttonStyle(.plain)
          .foregroundStyle(ADEColor.textSecondary)

          if assistantLineBudget < min(preview.totalLineCount, workAssistantMessageMaxLineBudget) {
            Button {
              assistantLineBudget = min(
                assistantLineBudget + workAssistantMessageLineBudgetStep,
                workAssistantMessageMaxLineBudget
              )
            } label: {
              Label("Show more", systemImage: "chevron.down")
                .labelStyle(.titleAndIcon)
                .font(.caption2.weight(.semibold))
            }
            .buttonStyle(.plain)
            .foregroundStyle(ADEColor.accent)
          }
        }
      }
    }
      .frame(maxWidth: .infinity, alignment: .leading)
    .contextMenu {
      Button {
        UIPasteboard.general.string = message.markdown
      } label: {
        Label("Copy message", systemImage: "doc.on.doc")
      }
    }
    .accessibilityElement(children: .contain)
    .adeInspectable(
      "Work.Chat.MessageBubble.Assistant",
      metadata: [
        "messageId": message.id,
        "role": message.role,
        "turnId": message.turnId ?? "",
        "itemId": message.itemId ?? ""
      ]
    )
  }

  private var userRow: some View {
    // Desktop parity: the user message is the ONLY bubble — right-aligned, an
    // accent→violet 135° gradient, white text, inset top highlight + soft
    // drop shadow. Attachments render inside the same bubble (not below it).
    // Capped at ~92% of the measured column width on mobile so long prompts
    // use more horizontal space and less vertical scroll.
    let attachments = message.attachments ?? []
    let hasAttachments = !attachments.isEmpty
    let hasText = !message.markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    let maxBubbleWidth = maxUserBubbleWidth ?? 360

    return HStack(alignment: .top, spacing: 8) {
      Spacer(minLength: 0)
      VStack(alignment: .trailing, spacing: 6) {
        if let deliveryBadge {
          // Delivery badges only render when a non-default state applies
          // (queued/sending/failed). Successful deliveries stay silent.
          WorkDeliveryBadge(state: deliveryBadge)
        }
        if hasText || hasAttachments {
          VStack(alignment: .leading, spacing: hasText && hasAttachments ? 8 : 0) {
            if hasText {
              Text(message.markdown)
                .font(.body)
                .foregroundStyle(Color.white)
                .lineSpacing(5)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            }
            if hasAttachments {
              WorkChatAttachmentTray(
                attachments: attachments,
                alignment: .leading,
                style: .embeddedInBubble
              )
            }
          }
          .padding(.horizontal, 16)
          .padding(.vertical, 8)
          .background(userBubbleGradient, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
          .overlay(
            // Subtle inset top highlight — the desktop bubble's soft sheen.
            RoundedRectangle(cornerRadius: 16, style: .continuous)
              .fill(
                LinearGradient(
                  colors: [Color.white.opacity(0.14), .clear],
                  startPoint: .top,
                  endPoint: .center
                )
              )
              .allowsHitTesting(false)
          )
          .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
              .stroke(userBubbleBorder, lineWidth: 0.8)
          )
          .shadow(color: accent.opacity(0.34), radius: 12, y: 5)
          .frame(maxWidth: maxBubbleWidth, alignment: .trailing)
          .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
    .frame(maxWidth: .infinity)
    .contextMenu {
      Button {
        UIPasteboard.general.string = message.markdown
      } label: {
        Label("Copy message", systemImage: "doc.on.doc")
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(userMessageAccessibilityLabel)
    .adeInspectable(
      "Work.Chat.MessageBubble.User",
      metadata: [
        "messageId": message.id,
        "role": message.role,
        "turnId": message.turnId ?? "",
        "itemId": message.itemId ?? ""
      ]
    )
  }

  private var assistantPreview: WorkAssistantMessagePreview {
    if assistantLineBudget == workAssistantMessageInitialLineBudget,
       let preview = message.assistantPreview {
      return preview
    }
    return workAssistantMessagePreview(
      message.markdown,
      lineBudget: assistantLineBudget,
      characterBudget: workAssistantMessageCharacterBudget(forLineBudget: assistantLineBudget)
    )
  }

  private var userMessageAccessibilityLabel: String {
    var parts = ["Your message."]
    let preview = workChatAccessibilityPreview(message.markdown)
    if !preview.isEmpty {
      parts.append(preview)
    }
    if let attachments = message.attachments, !attachments.isEmpty {
      parts.append(workChatAttachmentAccessibilityLabel(attachments))
    }
    return parts.joined(separator: " ")
  }

  var deliveryBadge: WorkDeliveryBadge.State? {
    guard message.role == "user" else { return nil }
    if let state = message.deliveryState {
      switch state {
      case "queued": return .queued
      case "delivered":
        return message.processed == true ? nil : .delivered
      case "inline": return .inline
      case "failed": return .failed
      case "sending": return .sending
      default: return nil
      }
    }
    return nil
  }

  @ViewBuilder
  private var modelBadge: some View {
    let provider = sessionProvider?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let label = (sessionModelLabel?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 }
      ?? (provider.isEmpty ? nil : providerLabel(provider))
    if let label, !label.isEmpty {
      HStack(spacing: 5) {
        Circle()
          .fill(accent)
          .frame(width: 6, height: 6)
        Text(label)
          .font(.caption2.weight(.semibold))
          .foregroundStyle(accent)
          .lineLimit(1)
      }
      .padding(.horizontal, 7)
      .padding(.vertical, 2)
      .background(accent.opacity(0.10), in: Capsule(style: .continuous))
      .overlay(
        Capsule(style: .continuous)
          .stroke(accent.opacity(0.22), lineWidth: 0.5)
      )
      .accessibilityLabel("Written by \(label)")
    }
  }
}

/// Linearly blend two colors in sRGB. `fraction` is the weight of `other`
/// (0 → all `base`, 1 → all `other`), matching CSS `color-mix` semantics where
/// `mix(base X%, other …)` means `other` gets `1 - X` weight. Resolves both
/// colors against the dark trait so the violet base stays consistent.
func workMixColors(_ base: Color, _ other: Color, _ fraction: Double) -> Color {
  let traits = UITraitCollection(userInterfaceStyle: .dark)
  let a = UIColor(base).resolvedColor(with: traits)
  let b = UIColor(other).resolvedColor(with: traits)
  var (ar, ag, ab, aa): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
  var (br, bg, bb, ba): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
  a.getRed(&ar, green: &ag, blue: &ab, alpha: &aa)
  b.getRed(&br, green: &bg, blue: &bb, alpha: &ba)
  let t = CGFloat(max(0, min(1, fraction)))
  return Color(
    red: Double(ar + (br - ar) * t),
    green: Double(ag + (bg - ag) * t),
    blue: Double(ab + (bb - ab) * t)
  )
}

let workAssistantMessageInitialLineBudget = 48
let workAssistantMessageLineBudgetStep = 48
let workAssistantMessageMaxLineBudget = 192
let workAssistantMessageInitialCharacterBudget = 4_000
let workAssistantMessageCharacterBudgetStep = 4_000
let workChatAccessibilityPreviewLimit = 800

struct WorkAssistantMessagePreview: Equatable {
  let text: String
  let isTruncated: Bool
  let visibleLineCount: Int
  let totalLineCount: Int
}

final class WorkAssistantPreviewCache {
  private struct Entry {
    let utf8Count: Int
    let markdown: String
    let preview: WorkAssistantMessagePreview
  }

  private var entries: [String: Entry] = [:]

  func preview(for message: WorkChatMessage) -> WorkAssistantMessagePreview {
    let utf8Count = message.markdown.utf8.count
    if let entry = entries[message.id],
       entry.utf8Count == utf8Count,
       entry.markdown == message.markdown {
      return entry.preview
    }

    let preview = workInitialAssistantMessagePreview(message.markdown)
    entries[message.id] = Entry(utf8Count: utf8Count, markdown: message.markdown, preview: preview)
    return preview
  }

  func prune(keeping messageIds: Set<String>) {
    entries = entries.filter { messageIds.contains($0.key) }
  }
}

func workInitialAssistantMessagePreview(_ markdown: String) -> WorkAssistantMessagePreview {
  workAssistantMessagePreview(
    markdown,
    lineBudget: workAssistantMessageInitialLineBudget,
    characterBudget: workAssistantMessageCharacterBudget(forLineBudget: workAssistantMessageInitialLineBudget)
  )
}

func workAssistantMessageCharacterBudget(forLineBudget lineBudget: Int) -> Int {
  let extraSteps = max((lineBudget - workAssistantMessageInitialLineBudget) / workAssistantMessageLineBudgetStep, 0)
  return workAssistantMessageInitialCharacterBudget + (extraSteps * workAssistantMessageCharacterBudgetStep)
}

func workAssistantMessagePreview(
  _ markdown: String,
  lineBudget: Int,
  characterBudget: Int
) -> WorkAssistantMessagePreview {
  let normalized = markdown.replacingOccurrences(of: "\r\n", with: "\n")
  guard !normalized.isEmpty else {
    return WorkAssistantMessagePreview(text: markdown, isTruncated: false, visibleLineCount: 0, totalLineCount: 0)
  }

  let clampedLineBudget = max(lineBudget, 1)
  let clampedCharacterBudget = max(characterBudget, 256)
  let totalLineCount = workAssistantMessageLineCount(normalized)
  if totalLineCount <= clampedLineBudget && normalized.count <= clampedCharacterBudget {
    return WorkAssistantMessagePreview(
      text: markdown,
      isTruncated: false,
      visibleLineCount: totalLineCount,
      totalLineCount: totalLineCount
    )
  }

  var rendered = String()
  rendered.reserveCapacity(min(normalized.count, clampedCharacterBudget))
  var usedCharacters = 0
  var visibleLineCount = 0
  var lineStart = normalized.startIndex

  while lineStart <= normalized.endIndex, visibleLineCount < clampedLineBudget {
    let lineEnd = normalized[lineStart...].firstIndex(of: "\n") ?? normalized.endIndex
    let newlineCost = visibleLineCount == 0 ? 0 : 1
    let remaining = clampedCharacterBudget - usedCharacters - newlineCost
    guard remaining > 0 else { break }

    if visibleLineCount > 0 {
      rendered.append("\n")
      usedCharacters += 1
    }

    let lineLength = normalized.distance(from: lineStart, to: lineEnd)
    if lineLength > remaining {
      let prefixEnd = normalized.index(lineStart, offsetBy: remaining)
      rendered.append(contentsOf: normalized[lineStart..<prefixEnd])
      usedCharacters = clampedCharacterBudget
      visibleLineCount += 1
      break
    }

    rendered.append(contentsOf: normalized[lineStart..<lineEnd])
    usedCharacters += lineLength
    visibleLineCount += 1

    guard lineEnd < normalized.endIndex else { break }
    lineStart = normalized.index(after: lineEnd)
  }

  return WorkAssistantMessagePreview(
    text: rendered,
    isTruncated: visibleLineCount < totalLineCount || rendered.count < normalized.count,
    visibleLineCount: visibleLineCount,
    totalLineCount: totalLineCount
  )
}

private func workAssistantMessageLineCount(_ text: String) -> Int {
  text.reduce(1) { count, character in
    character == "\n" ? count + 1 : count
  }
}

func workAssistantMessageAccessibilityLabel(_ preview: WorkAssistantMessagePreview) -> String {
  if preview.isTruncated {
    return "Assistant response preview. \(preview.visibleLineCount) of \(preview.totalLineCount) lines shown."
  }
  let trimmed = preview.text.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else {
    return "Assistant response."
  }
  if trimmed.count <= 500 {
    return "Assistant response. \(trimmed)"
  }
  return "Assistant response preview. \(trimmed.prefix(500))"
}

func workChatAccessibilityPreview(_ markdown: String) -> String {
  guard markdown.count > workChatAccessibilityPreviewLimit else { return markdown }
  return "\(markdown.prefix(workChatAccessibilityPreviewLimit))..."
}

/// Centered time pill that introduces each turn (model lives in the usage
/// row and composer; matches desktop’s time-only turn divider).
struct WorkTurnSeparatorView: View {
  let separator: WorkTurnSeparator

  private var accent: Color {
    ADEColor.chatSurfaceAccent(modelId: separator.modelId, provider: separator.provider)
  }

  var body: some View {
    HStack(spacing: 10) {
      hairline
      HStack(spacing: 6) {
        runtimeGlyph
        Text(workTurnSeparatorTimeLabel(separator.time))
          .font(.caption2.monospacedDigit())
          .foregroundStyle(ADEColor.textMuted)
      }
      hairline
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 4)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      "New turn at \(workTurnSeparatorTimeLabel(separator.time))"
        + (separator.modelLabel.isEmpty ? "" : ". Model: \(separator.modelLabel)")
    )
  }

  /// Small per-runtime mark — the bundled provider logo when one exists,
  /// otherwise a tinted dot in the chat-surface accent. Keeps the divider
  /// quietly themed to whichever runtime drove the turn.
  @ViewBuilder
  private var runtimeGlyph: some View {
    if let asset = providerAssetName(separator.provider) {
      Image(asset)
        .resizable()
        .scaledToFit()
        .frame(width: 11, height: 11)
        .opacity(0.85)
    } else {
      Circle()
        .fill(accent.opacity(0.7))
        .frame(width: 5, height: 5)
    }
  }

  private var hairline: some View {
    Rectangle()
      .fill(ADEColor.glassBorder)
      .frame(height: 0.6)
  }
}

struct WorkTurnEndMarkerView: View {
  let marker: WorkTurnEndMarker

  var body: some View {
    HStack(spacing: 10) {
      hairline
      Text("\(workTurnSeparatorTimeLabel(marker.time)) · Worked for \(marker.workedDurationLabel)")
        .font(.caption2)
        .foregroundStyle(ADEColor.textMuted)
        .lineLimit(1)
        .minimumScaleFactor(0.9)
        .fixedSize(horizontal: true, vertical: false)
        .layoutPriority(1)
      hairline
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 8)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      "Turn ended at \(workTurnSeparatorTimeLabel(marker.time)). Worked for \(marker.workedDurationLabel)"
    )
  }

  private var hairline: some View {
    Rectangle()
      .fill(ADEColor.glassBorder)
      .frame(height: 0.6)
  }
}

private func workTurnSeparatorTimeLabel(_ iso: String) -> String {
  // Matches desktop's "01:34 AM" turn separator format. Falls back to the raw
  // string when the input isn't an ISO date so we never crash on host quirks.
  if let date = turnSeparatorIsoFormatter.date(from: iso) {
    return shortClockFormatter.string(from: date)
  }
  if let date = turnSeparatorIsoFallbackFormatter.date(from: iso) {
    return shortClockFormatter.string(from: date)
  }
  return iso
}

private let turnSeparatorIsoFormatter: ISO8601DateFormatter = {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter
}()

private let turnSeparatorIsoFallbackFormatter: ISO8601DateFormatter = {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime]
  return formatter
}()

private let shortClockFormatter: DateFormatter = {
  let f = DateFormatter()
  f.dateFormat = "hh:mm a"
  f.amSymbol = "AM"
  f.pmSymbol = "PM"
  return f
}()

/// Environment injection for the active chat session's provider/model context.
/// The session view wraps the transcript in `.environment(\.workChatProvider, …)`,
/// `.workChatModelId`, and `.workChatModelLabel` so message bubbles can render
/// the model badge tinted to the chat's accent without threading the values
/// through each call site.
private struct WorkChatProviderEnvironmentKey: EnvironmentKey {
  static let defaultValue: String? = nil
}

private struct WorkChatModelIdEnvironmentKey: EnvironmentKey {
  static let defaultValue: String? = nil
}

private struct WorkChatModelLabelEnvironmentKey: EnvironmentKey {
  static let defaultValue: String? = nil
}

extension EnvironmentValues {
  var workChatProvider: String? {
    get { self[WorkChatProviderEnvironmentKey.self] }
    set { self[WorkChatProviderEnvironmentKey.self] = newValue }
  }

  var workChatModelId: String? {
    get { self[WorkChatModelIdEnvironmentKey.self] }
    set { self[WorkChatModelIdEnvironmentKey.self] = newValue }
  }

  var workChatModelLabel: String? {
    get { self[WorkChatModelLabelEnvironmentKey.self] }
    set { self[WorkChatModelLabelEnvironmentKey.self] = newValue }
  }
}

struct WorkDeliveryBadge: View {
  enum State {
    case queued, sending, delivered, inline, failed

    var label: String {
      switch self {
      case .queued: return "Queued"
      case .sending: return "Sending"
      case .delivered: return "Delivered"
      case .inline: return "During turn"
      case .failed: return "Failed"
      }
    }

    var icon: String {
      switch self {
      case .queued: return "clock"
      case .sending: return "arrow.up.circle"
      case .delivered: return "checkmark.circle"
      case .inline: return "arrow.turn.down.right"
      case .failed: return "exclamationmark.triangle"
      }
    }

    var tint: Color {
      switch self {
      case .queued: return ADEColor.accent
      case .sending: return ADEColor.accent
      case .delivered: return ADEColor.success
      case .inline: return ADEColor.accent
      case .failed: return ADEColor.danger
      }
    }
  }

  let state: State

  var body: some View {
    HStack(spacing: 4) {
      Image(systemName: state.icon)
      Text(state.label)
    }
    .font(.caption2.weight(.semibold))
    .foregroundStyle(state.tint)
    .padding(.horizontal, 6)
    .padding(.vertical, 2)
    .background(state.tint.opacity(0.12), in: Capsule(style: .continuous))
    .accessibilityLabel("Delivery state: \(state.label)")
  }
}
