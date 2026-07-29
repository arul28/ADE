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

/// Menu-relevant values for the chat header overflow menu, split out so the
/// menu view can be `Equatable`-gated on exactly this data.
struct WorkChatHeaderMenuModel: Equatable {
  /// Combined subagents + background + schedule count — Chat Info is the single
  /// destination for all three now that the standalone Subagents drawer is gone.
  var chatInfoCount: Int
  var artifactCount: Int
  var showsLaneActions: Bool
  var prTag: LanePrTag?
  var prGitHubUrlAvailable: Bool
  var prLinkCopied: Bool
  var laneAvailable: Bool
  var createPrBlockedReason: String?
  var sessionPinned: Bool
  var sessionIdCopied: Bool
  var sessionDeepLinkCopied: Bool
  /// Open chat's session id, used by the Mute item to toggle push prefs.
  /// Defaults to empty so the memberwise init at the call site stays source
  /// compatible; the destination view passes the real id.
  var sessionId: String = ""
  /// Mute state rides the model (not a direct singleton read in the menu body)
  /// so the `.equatable()` gate re-renders the menu when it flips — including
  /// from the Work-list row's context menu while this chat is open.
  var sessionMuted: Bool = false
  var showsProof: Bool = true
  var showsPinAction: Bool = true
  var showsSessionLink: Bool = true
}

/// Chat header overflow menu, extracted from `WorkSessionDestinationView` and
/// compared via `.equatable()` on `model` only.
///
/// The destination view re-renders continuously while a chat streams
/// (transcript signatures, artifact/subagent refreshes, PR lookup keys). Every
/// re-evaluation of an open `Menu` rebuilds the presented UIMenu, which makes
/// the liquid-glass menu flicker and instantly dismisses any open nested
/// submenu. Gating on `model` means the presented menu is only rebuilt when
/// something the menu actually displays has changed.
struct WorkChatHeaderMenu: View, Equatable {
  var model: WorkChatHeaderMenuModel
  var onShowChatInfo: () -> Void
  var onShowProof: () -> Void
  var onViewPrDetails: () -> Void
  var onOpenPrsTab: () -> Void
  var onOpenGitHub: () -> Void
  var onCopyPrLink: () -> Void
  var onOpenPrCreation: () -> Void
  var onOpenLane: () -> Void
  var onRename: () -> Void
  var onDelete: () -> Void
  var onCopySessionId: () -> Void
  var onCopySessionDeepLink: () -> Void
  var onTogglePinned: () -> Void

  static func == (lhs: WorkChatHeaderMenu, rhs: WorkChatHeaderMenu) -> Bool {
    lhs.model == rhs.model
  }

  var body: some View {
    Menu {
      Button(action: onShowChatInfo) {
        if model.chatInfoCount == 0 {
          Label("Chat Info", systemImage: "info.circle")
        } else {
          Label("Chat Info (\(model.chatInfoCount))", systemImage: "info.circle")
        }
      }

      Divider()

      if model.showsProof {
        Button(action: onShowProof) {
          if model.artifactCount == 0 {
            Label("Proof", systemImage: "cube.transparent")
          } else {
            Label("Proof (\(model.artifactCount))", systemImage: "cube.transparent")
          }
        }
        .accessibilityHint("Opens the proof drawer")
      }

      if model.showsLaneActions {
        Divider()

        pullRequestItems
      }

      Divider()

      sessionItems
    } label: {
      Image(systemName: "ellipsis")
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)
        .frame(width: 34, height: 34)
        .background(ADEColor.surfaceBackground.opacity(0.9), in: Circle())
        .overlay(
          Circle()
            .stroke(ADEColor.glassBorder.opacity(0.75), lineWidth: 0.5)
        )
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Chat actions")
  }

  @ViewBuilder
  private var pullRequestItems: some View {
    if let tag = model.prTag {
      Menu {
        Button(action: onViewPrDetails) {
          Label("View PR details", systemImage: "sidebar.trailing")
        }

        Button(action: onOpenPrsTab) {
          Label("PRs tab", systemImage: "rectangle.grid.1x2")
        }
        .accessibilityHint("Opens \(formatLanePrBadgeLabel(tag)) in the PRs tab")

        Button(action: onOpenGitHub) {
          Label("Open on GitHub", systemImage: "link")
        }
        .disabled(!model.prGitHubUrlAvailable)
      } label: {
        Label(formatLanePrBadgeLabel(tag), systemImage: "arrow.triangle.pull")
      }

      Button(action: onCopyPrLink) {
        if model.prLinkCopied {
          Label("Copied link", systemImage: "checkmark")
        } else {
          Label("Copy link", systemImage: "doc.on.doc")
        }
      }
      .disabled(!model.prGitHubUrlAvailable)
    } else {
      Button(action: onViewPrDetails) {
        Label("View PR details", systemImage: "sidebar.trailing")
      }

      Button(action: onOpenPrCreation) {
        Label("Open PR in PRs tab", systemImage: "rectangle.grid.1x2")
      }
      .disabled(!model.laneAvailable)

      if let blockedReason = model.createPrBlockedReason {
        Button {} label: {
          Label(blockedReason, systemImage: "info.circle")
        }
        .disabled(true)
      }
    }

    Button(action: onOpenLane) {
      Label("Open lane", systemImage: "arrow.triangle.branch")
    }
  }

  @ViewBuilder
  private var sessionItems: some View {
    Button(action: onRename) {
      Label("Rename", systemImage: "pencil")
    }

    Button(role: .destructive, action: onDelete) {
      Label("Delete chat", systemImage: "trash")
    }

    Button(action: onCopySessionId) {
      Label(model.sessionIdCopied ? "Copied session ID" : "Copy session ID",
            systemImage: model.sessionIdCopied ? "checkmark" : "doc.on.doc")
    }

    if model.showsSessionLink {
      Button(action: onCopySessionDeepLink) {
        Label(model.sessionDeepLinkCopied ? "Copied session link" : "Copy session link",
              systemImage: model.sessionDeepLinkCopied ? "checkmark" : "link")
      }
    }

    if model.showsPinAction {
      Button(action: onTogglePinned) {
        Label(model.sessionPinned ? "Unpin from front" : "Pin to front",
              systemImage: model.sessionPinned ? "pin.slash" : "pin")
      }
    }

    if !model.sessionId.isEmpty {
      Button {
        PushNotificationService.shared.setMuted(!model.sessionMuted, sessionId: model.sessionId)
      } label: {
        Label(model.sessionMuted ? "Unmute notifications" : "Mute notifications",
              systemImage: model.sessionMuted ? "bell" : "bell.slash")
      }
    }
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
  var onRunUnprocessed: (@MainActor (WorkChatMessage) async throws -> Void)? = nil
  var onEditUnprocessed: (@MainActor (WorkChatMessage) async throws -> Void)? = nil
  var onDismissUnprocessed: (@MainActor (WorkChatMessage) async throws -> Void)? = nil
  @State private var assistantLineBudget = workAssistantMessageInitialLineBudget

  /// Provider string for the current chat session (e.g. "claude", "codex", "cursor").
  /// Injected via `.environment(\.workChatProvider, ...)` by the session view.
  @Environment(\.workChatProvider) private var sessionProvider
  /// Active session model id, used to resolve the per-model accent for the
  /// model badge chip and card border tint.
  @Environment(\.workChatModelId) private var sessionModelId
  /// Pretty model label ("Claude Sonnet 5"), injected by the session view
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

  private var isCodexChat: Bool {
    let provider = (message.turnProvider ?? sessionProvider ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased()
    let model = (message.turnModelId ?? sessionModelId ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased()
    return provider == "codex"
      || provider == "openai"
      || model.contains("codex")
      || model.hasPrefix("gpt-")
      || model.hasPrefix("openai/gpt-")
  }

  private var userBubbleFill: Color {
    isCodexChat
      ? workMixColors(accent, workViolet, 0.44)
      : workMixColors(accent, workViolet, 0.36)
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
    let usesMonospacedPreview = preview.usesMonospacedRendering

    return VStack(alignment: .leading, spacing: 10) {
      if preview.isTruncated {
        if usesMonospacedPreview {
          WorkAssistantMonospacedPreview(text: preview.text)
            .accessibilityLabel(workAssistantMessageAccessibilityLabel(preview))
        } else {
          WorkMarkdownRenderer(
            markdown: preview.text,
            streamingCacheKey: isStreaming ? message.id : nil
          )
            .accessibilityLabel(workAssistantMessageAccessibilityLabel(preview))
        }
      } else if usesMonospacedPreview {
        WorkAssistantMonospacedPreview(text: preview.text)
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
              Text(workAssistantMessagePreviewSummaryText(preview))
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

          // Anything still truncated can still be expanded: one more step per
          // tap, with no ceiling to strand the reader partway through.
          Button {
            assistantLineBudget += workAssistantMessageLineBudgetStep
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
          // Follow-up delivery is a durable lifecycle. Showing the precise
          // state prevents "accepted by the server" from being mistaken for
          // "the agent actually processed this message."
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
          .background(userBubbleFill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
              .stroke(userBubbleBorder, lineWidth: 0.8)
          )
          .frame(maxWidth: maxBubbleWidth, alignment: .trailing)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityElement(children: .combine)
          .accessibilityLabel(userMessageAccessibilityLabel)
        }
        if message.deliveryState == "unprocessed" {
          WorkUnprocessedMessageActions(
            message: message,
            onRun: onRunUnprocessed,
            onEdit: onEditUnprocessed,
            onDismiss: onDismissUnprocessed
          )
          .frame(maxWidth: maxBubbleWidth, alignment: .trailing)
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
    .accessibilityElement(children: .contain)
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
      characterBudget: workAssistantMessageCharacterBudget(forLineBudget: assistantLineBudget),
      anchor: .head,
      classification: message.assistantPreview?.usesMonospacedRendering
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
    return workDeliveryBadgeState(
      deliveryState: message.deliveryState,
      processed: message.processed
    )
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

struct WorkAssistantMonospacedPreview: View {
  let text: String

  var body: some View {
    Text(text)
      .font(.system(.caption, design: .monospaced))
      .foregroundStyle(ADEColor.textPrimary)
      .lineSpacing(3)
      .multilineTextAlignment(.leading)
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .leading)
      .textSelection(.enabled)
      .padding(.vertical, 2)
    .tint(ADEColor.accent)
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

// Assistant answers are revealed in bounded increments, never capped.
//
// There is deliberately NO terminal ceiling here: a long tool dump or a
// thousand-line answer must be readable in place, so "Show more" keeps
// stepping until the whole message is on screen. The steps below bound the
// cost of a single tap (one extra slice per render), not the total.
let workAssistantMessageInitialLineBudget = 48
/// Lines added to the requested budget by one "Show more" tap.
let workAssistantMessageLineBudgetStep = 48
let workAssistantMessageInitialCharacterBudget = 1_600
/// Characters added to the budget by one "Show more" tap.
let workAssistantMessageCharacterBudgetStep = 2_400
/// Once the user has asked for more, the line budget is the promise the
/// "N of M lines" summary makes, so the character budget has to be able to
/// carry that many lines of ordinary prose instead of quietly capping the
/// reveal well below the advertised line count.
let workAssistantMessageExpandedCharactersPerLine = 96
let workAssistantMessageSmallFullCharacterBudget = 6_000
let workAssistantMessageTailFullLineBudget = 128
let workAssistantMessageTailFullCharacterBudget = 12_000
/// Wide/monospaced answers (wireframes, tables, tree output) cost far more
/// vertical space per line, so they walk a slower ladder: they start at 24
/// lines and gain 24 per tap. Slower, still unbounded.
let workAssistantMessageWideInitialLineBudget = 24
let workAssistantMessageWideLineBudgetStep = 24
let workChatAccessibilityPreviewLimit = 800

enum WorkAssistantMessagePreviewAnchor: Equatable {
  case head
  case tail
}

struct WorkAssistantMessagePreview: Equatable {
  let text: String
  let isTruncated: Bool
  /// Classification of the complete authoritative message, never the sliced
  /// preview text. Cached with the preview so streaming rows do not rescan a
  /// growing answer several times per render.
  let usesMonospacedRendering: Bool
  let visibleLineCount: Int
  let totalLineCount: Int
  let visibleCharacterCount: Int
  let totalCharacterCount: Int
  let anchor: WorkAssistantMessagePreviewAnchor
}

final class WorkAssistantPreviewCache {
  private struct Entry {
    let utf8Count: Int
    let textHash: Int
    let anchor: WorkAssistantMessagePreviewAnchor
    let preview: WorkAssistantMessagePreview
  }

  private var entries: [String: Entry] = [:]

  func preview(for message: WorkChatMessage, anchor: WorkAssistantMessagePreviewAnchor = .head) -> WorkAssistantMessagePreview {
    let utf8Count = message.markdown.utf8.count
    let textHash = message.markdown.hashValue
    if let entry = entries[message.id],
       entry.utf8Count == utf8Count,
       entry.textHash == textHash,
       entry.anchor == anchor,
       entry.preview.anchor == anchor {
      return entry.preview
    }

    let preview = workInitialAssistantMessagePreview(message.markdown, anchor: anchor)
    entries[message.id] = Entry(utf8Count: utf8Count, textHash: textHash, anchor: anchor, preview: preview)
    return preview
  }

  func prune(keeping messageIds: Set<String>) {
    entries = entries.filter { messageIds.contains($0.key) }
  }
}

func workInitialAssistantMessagePreview(
  _ markdown: String,
  anchor: WorkAssistantMessagePreviewAnchor = .head
) -> WorkAssistantMessagePreview {
  workAssistantMessagePreview(
    markdown,
    lineBudget: workAssistantMessageInitialLineBudget,
    characterBudget: workAssistantMessageCharacterBudget(forLineBudget: workAssistantMessageInitialLineBudget),
    anchor: anchor
  )
}

func workAssistantMessageCharacterBudget(forLineBudget lineBudget: Int) -> Int {
  let extraSteps = max((lineBudget - workAssistantMessageInitialLineBudget) / workAssistantMessageLineBudgetStep, 0)
  let steppedBudget = workAssistantMessageInitialCharacterBudget + (extraSteps * workAssistantMessageCharacterBudgetStep)
  // The first render keeps its tight budget so hydrating a long transcript
  // stays cheap. Every expansion past it honours the line budget the summary
  // advertises — otherwise a message of long lines would step in characters
  // only, stranding the reader far short of the line count on screen.
  guard extraSteps > 0 else { return steppedBudget }
  return max(steppedBudget, lineBudget * workAssistantMessageExpandedCharactersPerLine)
}

func workAssistantMessageCharacterBudget(forLineBudget lineBudget: Int, tailCanRenderFull: Bool) -> Int {
  let steppedBudget = workAssistantMessageCharacterBudget(forLineBudget: lineBudget)
  return tailCanRenderFull ? max(steppedBudget, workAssistantMessageTailFullCharacterBudget) : steppedBudget
}

func workAssistantMessagePreview(
  _ markdown: String,
  lineBudget: Int,
  characterBudget: Int,
  anchor: WorkAssistantMessagePreviewAnchor = .head,
  classification: Bool? = nil
) -> WorkAssistantMessagePreview {
  let normalized = markdown.replacingOccurrences(of: "\r\n", with: "\n")
  guard !normalized.isEmpty else {
    return WorkAssistantMessagePreview(
      text: markdown,
      isTruncated: false,
      usesMonospacedRendering: false,
      visibleLineCount: 0,
      totalLineCount: 0,
      visibleCharacterCount: 0,
      totalCharacterCount: 0,
      anchor: anchor
    )
  }

  let usesMonospacedPreview = classification ?? workAssistantMessageUsesMonospacedPreview(normalized)
  let clampedLineBudget = workAssistantMessageEffectiveLineBudget(
    requestedLineBudget: max(lineBudget, 1),
    usesMonospacedPreview: usesMonospacedPreview
  )
  let clampedCharacterBudget = max(
    usesMonospacedPreview
      ? max(characterBudget, workAssistantMessageWideCharacterBudget(forLineBudget: clampedLineBudget))
      : characterBudget,
    256
  )
  let totalLineCount = workAssistantMessageLineCount(normalized)
  let totalCharacterCount = normalized.count
  let smallFullCharacterBudget = max(clampedCharacterBudget, workAssistantMessageSmallFullCharacterBudget)
  if totalLineCount <= clampedLineBudget && normalized.count <= smallFullCharacterBudget {
    return WorkAssistantMessagePreview(
      text: markdown,
      isTruncated: false,
      usesMonospacedRendering: usesMonospacedPreview,
      visibleLineCount: totalLineCount,
      totalLineCount: totalLineCount,
      visibleCharacterCount: totalCharacterCount,
      totalCharacterCount: totalCharacterCount,
      anchor: anchor
    )
  }

  if anchor == .tail {
    return workAssistantMessageTailPreview(
      normalized,
      lineBudget: clampedLineBudget,
      characterBudget: clampedCharacterBudget,
      totalLineCount: totalLineCount,
      totalCharacterCount: totalCharacterCount,
      usesMonospacedRendering: usesMonospacedPreview
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
    usesMonospacedRendering: usesMonospacedPreview,
    visibleLineCount: visibleLineCount,
    totalLineCount: totalLineCount,
    visibleCharacterCount: rendered.count,
    totalCharacterCount: totalCharacterCount,
    anchor: .head
  )
}

private func workAssistantMessageTailPreview(
  _ normalized: String,
  lineBudget: Int,
  characterBudget: Int,
  totalLineCount: Int,
  totalCharacterCount: Int,
  usesMonospacedRendering: Bool
) -> WorkAssistantMessagePreview {
  var segments: [Substring] = []
  segments.reserveCapacity(min(lineBudget, 16))
  var usedCharacters = 0
  var visibleLineCount = 0
  var lineEnd = normalized.endIndex

  while lineEnd >= normalized.startIndex, visibleLineCount < lineBudget {
    let lineStart = normalized[..<lineEnd]
      .lastIndex(of: "\n")
      .map { normalized.index(after: $0) }
      ?? normalized.startIndex
    let newlineCost = segments.isEmpty ? 0 : 1
    let remaining = characterBudget - usedCharacters - newlineCost
    guard remaining > 0 else { break }

    let lineLength = normalized.distance(from: lineStart, to: lineEnd)
    if lineLength > remaining {
      let suffixStart = normalized.index(lineEnd, offsetBy: -remaining)
      segments.append(normalized[suffixStart..<lineEnd])
      usedCharacters = characterBudget
      visibleLineCount += 1
      break
    }

    segments.append(normalized[lineStart..<lineEnd])
    usedCharacters += lineLength + newlineCost
    visibleLineCount += 1

    guard lineStart > normalized.startIndex else { break }
    lineEnd = normalized.index(before: lineStart)
  }

  let sourceRendered = segments.reversed().joined(separator: "\n")
  let openingFence = workOpeningMarkdownFenceBeforeTail(
    in: normalized,
    tailStart: segments.last?.startIndex ?? normalized.endIndex
  )
  let rendered = openingFence.map { "\($0)\n\(sourceRendered)" } ?? sourceRendered
  return WorkAssistantMessagePreview(
    text: rendered,
    isTruncated: visibleLineCount < totalLineCount || sourceRendered.count < normalized.count,
    usesMonospacedRendering: usesMonospacedRendering,
    visibleLineCount: visibleLineCount,
    totalLineCount: totalLineCount,
    visibleCharacterCount: sourceRendered.count,
    totalCharacterCount: totalCharacterCount,
    anchor: .tail
  )
}

/// If a bounded tail begins inside a fenced block, restore the authoritative
/// opening marker (including its language). Without it, the original closing
/// fence is parsed as a new opener and trailing prose is swallowed into code.
private func workOpeningMarkdownFenceBeforeTail(
  in normalized: String,
  tailStart: String.Index
) -> String? {
  guard tailStart > normalized.startIndex else { return nil }
  var openingFence: String?
  for line in normalized[..<tailStart].split(separator: "\n", omittingEmptySubsequences: false) {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    guard trimmed.hasPrefix("```") else { continue }
    if openingFence == nil {
      openingFence = trimmed
    } else {
      openingFence = nil
    }
  }
  return openingFence
}

/// Translate the shared requested budget (48 + 48 per tap) into the budget the
/// layout can actually afford.
///
/// Wide/monospaced answers walk their own slower ladder — 24 lines, then 24
/// more per tap — because each of their lines eats far more vertical space.
/// It is a pace, not a cap: the ladder has no top, so repeated taps still
/// reach the end of any message.
func workAssistantMessageEffectiveLineBudget(
  requestedLineBudget: Int,
  usesMonospacedPreview: Bool
) -> Int {
  guard usesMonospacedPreview else {
    return requestedLineBudget
  }
  if requestedLineBudget <= workAssistantMessageInitialLineBudget {
    return min(requestedLineBudget, workAssistantMessageWideInitialLineBudget)
  }
  let steps = (requestedLineBudget - workAssistantMessageInitialLineBudget) / workAssistantMessageLineBudgetStep
  return workAssistantMessageWideInitialLineBudget + (steps * workAssistantMessageWideLineBudgetStep)
}

private func workAssistantMessageWideCharacterBudget(forLineBudget lineBudget: Int) -> Int {
  let extraSteps = max((lineBudget - workAssistantMessageWideInitialLineBudget) / workAssistantMessageWideLineBudgetStep, 0)
  let steppedBudget = workAssistantMessageInitialCharacterBudget + (extraSteps * workAssistantMessageCharacterBudgetStep)
  return max(steppedBudget, lineBudget * workAssistantMessageExpandedCharactersPerLine)
}

func workAssistantMessageLineCount(_ text: String) -> Int {
  text.reduce(1) { count, character in
    character == "\n" ? count + 1 : count
  }
}

func workAssistantMessageAccessibilityLabel(_ preview: WorkAssistantMessagePreview) -> String {
  if preview.isTruncated {
    return "Assistant response preview. \(workAssistantMessagePreviewSummaryText(preview)) shown."
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

func workAssistantMessagePreviewSummaryText(_ preview: WorkAssistantMessagePreview) -> String {
  if preview.visibleLineCount < preview.totalLineCount {
    switch preview.anchor {
    case .head:
      return "\(preview.visibleLineCount) of \(preview.totalLineCount) lines"
    case .tail:
      return "Latest \(preview.visibleLineCount) of \(preview.totalLineCount) lines"
    }
  }

  if preview.visibleCharacterCount < preview.totalCharacterCount {
    let visible = workAssistantCompactCount(preview.visibleCharacterCount)
    let total = workAssistantCompactCount(preview.totalCharacterCount)
    switch preview.anchor {
    case .head:
      return "\(visible) of \(total) characters"
    case .tail:
      return "Latest \(visible) of \(total) characters"
    }
  }

  return "\(preview.totalLineCount) line\(preview.totalLineCount == 1 ? "" : "s")"
}

private func workAssistantCompactCount(_ count: Int) -> String {
  if count >= 1_000_000 {
    return String(format: "%.1fM", Double(count) / 1_000_000.0)
  }
  if count >= 1_000 {
    return String(format: "%.1fK", Double(count) / 1_000.0)
  }
  return "\(count)"
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
  var toolCount: Int = 0
  var onOpenActivity: (() -> Void)? = nil

  private var status: String {
    marker.status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  }

  private var completed: Bool {
    status.isEmpty || status == "completed" || status == "complete" || status == "succeeded" || status == "success"
  }

  private var statusTint: Color {
    status == "failed" ? ADEColor.danger : ADEColor.warning
  }

  private var accent: Color {
    ADEColor.chatSurfaceAccent(modelId: marker.modelId, provider: marker.provider)
  }

  private var markerAccessibilityLabel: String {
    let activityLabel = toolCount > 0
      ? "\(toolCount) \(toolCount == 1 ? "action" : "actions"). Opens activity details."
      : nil
    if completed {
      return [
        "Turn ended at \(workTurnSeparatorTimeLabel(marker.time)). Ran for \(marker.workedDurationLabel)",
        activityLabel,
      ].compactMap { $0 }.joined(separator: ". ")
    }
    return [
      "Turn \(status)",
      marker.terminalReasonLabel,
      marker.modelLabel.isEmpty ? nil : marker.modelLabel,
      "Elapsed \(marker.workedDurationLabel)",
      activityLabel,
    ].compactMap { $0 }.joined(separator: ". ")
  }

  var body: some View {
    HStack(spacing: 10) {
      hairline
      if let onOpenActivity, toolCount > 0 {
        Button(action: onOpenActivity) {
          HStack(spacing: 5) {
            content
            Image(systemName: "chevron.up.chevron.down")
              .font(.system(size: 8, weight: .semibold))
              .opacity(0.55)
          }
        }
        .buttonStyle(.plain)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityHint("Opens activity details.")
      } else {
        content
      }
      hairline
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 8)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(markerAccessibilityLabel)
  }

  @ViewBuilder
  private var content: some View {
    if completed {
      Text("\(workTurnSeparatorTimeLabel(marker.time)) · Ran for \(marker.workedDurationLabel)")
        .font(.caption2)
        .foregroundStyle(ADEColor.textMuted)
        .lineLimit(1)
        .minimumScaleFactor(0.9)
        .fixedSize(horizontal: true, vertical: false)
        .layoutPriority(1)
    } else {
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 6) {
          runtimeGlyph
          if !marker.modelLabel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            Text(marker.modelLabel)
              .font(.caption2.weight(.semibold))
          }
          Text(status.uppercased())
            .font(.caption2.weight(.semibold))
            .tracking(0.5)
          if let terminalReasonLabel = marker.terminalReasonLabel {
            Text("·")
              .opacity(0.42)
            Text(terminalReasonLabel)
              .font(.caption2)
          }
          Text("·")
            .opacity(0.42)
          Text("Elapsed \(marker.workedDurationLabel)")
            .font(.caption2)
        }
        .fixedSize(horizontal: true, vertical: false)

        HStack(spacing: 5) {
          runtimeGlyph
          Text(status.uppercased())
            .font(.caption2.weight(.semibold))
            .tracking(0.4)
          Text("·")
            .opacity(0.42)
          Text("Elapsed \(marker.workedDurationLabel)")
            .font(.caption2)
        }
        .lineLimit(1)
        .minimumScaleFactor(0.82)
      }
      .foregroundStyle(statusTint.opacity(0.9))
      .lineLimit(1)
      .minimumScaleFactor(0.82)
      .layoutPriority(1)
    }
  }

  @ViewBuilder
  private var runtimeGlyph: some View {
    if let asset = providerAssetName(marker.provider) {
      Image(asset)
        .resizable()
        .scaledToFit()
        .frame(width: 11, height: 11)
        .opacity(0.9)
    } else {
      Circle()
        .fill(accent.opacity(0.75))
        .frame(width: 5, height: 5)
    }
  }

  private var hairline: some View {
    Rectangle()
      .fill(ADEColor.glassBorder)
      .frame(height: 0.6)
  }
}

struct WorkClaudeGoalPill: View {
  let goal: AgentChatClaudeGoal

  private var iterationLabel: String {
    "\(goal.iterations) iteration\(goal.iterations == 1 ? "" : "s")"
  }

  var body: some View {
    HStack(spacing: 7) {
      Image(systemName: "target")
        .font(.caption2.weight(.bold))
      Text(goal.condition)
        .font(.caption.weight(.medium))
        .lineLimit(1)
      Text("·")
        .foregroundStyle(ADEColor.textMuted)
      Text(iterationLabel)
        .font(.caption2.monospacedDigit())
        .foregroundStyle(ADEColor.textMuted)
        .lineLimit(1)
    }
    .foregroundStyle(ADEColor.textSecondary)
    .padding(.horizontal, 10)
    .padding(.vertical, 6)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(ADEColor.accent.opacity(0.07), in: Capsule(style: .continuous))
    .overlay(Capsule(style: .continuous).stroke(ADEColor.accent.opacity(0.16), lineWidth: 0.5))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Goal: \(goal.condition). \(iterationLabel).")
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
  enum State: Equatable {
    case queued, sending, accepted, processed, unprocessed, failed

    var label: String {
      switch self {
      case .queued: return "Queued"
      case .sending: return "Sending"
      case .accepted: return "Accepted"
      case .processed: return "Processed"
      case .unprocessed: return "Not processed"
      case .failed: return "Failed"
      }
    }

    var icon: String {
      switch self {
      case .queued: return "clock"
      case .sending: return "arrow.up.circle"
      case .accepted: return "tray.and.arrow.down"
      case .processed: return "checkmark.circle"
      case .unprocessed: return "arrow.clockwise.circle"
      case .failed: return "exclamationmark.triangle"
      }
    }

    var tint: Color {
      switch self {
      case .queued: return ADEColor.accent
      case .sending: return ADEColor.accent
      case .accepted: return ADEColor.accent
      case .processed: return ADEColor.success
      case .unprocessed: return ADEColor.warning
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

private struct WorkUnprocessedMessageActions: View {
  let message: WorkChatMessage
  let onRun: (@MainActor (WorkChatMessage) async throws -> Void)?
  let onEdit: (@MainActor (WorkChatMessage) async throws -> Void)?
  let onDismiss: (@MainActor (WorkChatMessage) async throws -> Void)?

  @State private var pendingAction: String?
  @State private var optimisticResolution: String?
  @State private var errorMessage: String?

  private var settledAction: String? {
    message.unprocessedResolution?.action ?? optimisticResolution
  }

  private var hasDurableSteerId: Bool {
    !(message.steerId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
  }

  var body: some View {
    if let settledAction {
      Text(settledAction == "run_next" ? "Started as the next turn" : "Dismissed")
        .font(.caption2)
        .foregroundStyle(ADEColor.textMuted)
        .accessibilityLabel(
          settledAction == "run_next"
            ? "This message started as the next turn."
            : "This message was dismissed."
        )
    } else {
      VStack(alignment: .trailing, spacing: 6) {
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 6) { actionButtons }
          VStack(alignment: .trailing, spacing: 6) { actionButtons }
        }
        if let errorMessage {
          Text(errorMessage)
            .font(.caption2)
            .foregroundStyle(ADEColor.danger)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isStaticText)
        }
      }
    }
  }

  @ViewBuilder
  private var actionButtons: some View {
    if hasDurableSteerId, onRun != nil {
      actionButton(
        title: pendingAction == "run_next" ? "Starting…" : "Run next",
        systemImage: "play.fill",
        action: "run_next",
        primary: true,
        accessibilityHint: "Starts this message as a new turn when the current turn is idle."
      )
    }
    if onEdit != nil {
      actionButton(
        title: "Edit",
        systemImage: "pencil",
        action: "edit",
        primary: false,
        accessibilityHint: "Replaces the composer draft with this message for editing."
      )
    }
    if hasDurableSteerId, onDismiss != nil {
      actionButton(
        title: "Dismiss",
        systemImage: "xmark",
        action: "dismiss",
        primary: false,
        accessibilityHint: "Marks this unprocessed message as dismissed."
      )
    }
  }

  private func actionButton(
    title: String,
    systemImage: String,
    action: String,
    primary: Bool,
    accessibilityHint: String
  ) -> some View {
    Button {
      Task { await perform(action) }
    } label: {
      Label(title, systemImage: systemImage)
        .font(.caption.weight(.semibold))
        .foregroundStyle(primary ? Color.white : ADEColor.textSecondary)
        .frame(minWidth: 44, minHeight: 44)
        .padding(.horizontal, 10)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .background(
      primary ? ADEColor.warning : ADEColor.cardBackground.opacity(0.42),
      in: RoundedRectangle(cornerRadius: 10, style: .continuous)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .stroke(primary ? ADEColor.warning.opacity(0.4) : ADEColor.glassBorder, lineWidth: 0.8)
    )
    .disabled(pendingAction != nil)
    .accessibilityLabel(title)
    .accessibilityHint(accessibilityHint)
  }

  @MainActor
  private func perform(_ action: String) async {
    guard pendingAction == nil else { return }
    let handler: (@MainActor (WorkChatMessage) async throws -> Void)?
    switch action {
    case "run_next": handler = onRun
    case "edit": handler = onEdit
    case "dismiss": handler = onDismiss
    default: return
    }
    guard let handler else { return }
    pendingAction = action
    errorMessage = nil
    defer { pendingAction = nil }
    do {
      try await handler(message)
      if action == "run_next" || action == "dismiss" {
        optimisticResolution = action
      }
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }
}

func workDeliveryBadgeState(
  deliveryState: String?,
  processed: Bool?
) -> WorkDeliveryBadge.State? {
  switch deliveryState {
  case "queued": return .queued
  case "accepted": return .accepted
  case "processed": return .processed
  case "unprocessed": return .unprocessed
  case "delivered":
    return processed == true ? .processed : .accepted
  case "inline":
    return .processed
  case "failed": return .failed
  case "sending": return .sending
  default:
    return processed == true ? .processed : nil
  }
}
