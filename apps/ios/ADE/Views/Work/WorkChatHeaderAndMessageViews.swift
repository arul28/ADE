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
  var canAttachIssue: Bool = false
  /// False for Cursor Cloud chats — Cursor owns the agent name.
  var showsRename: Bool = true
  /// The host has `chat.restartSession`.
  var showsRestartAgent: Bool = false
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
  /// Fresh provider process, same conversation: picks up new skills, plugins,
  /// and MCP servers (desktop "Restart agent session").
  var onRestartAgent: (() -> Void)? = nil
  var onAttachIssue: (() -> Void)? = nil

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

      if model.canAttachIssue {
        Button(action: { onAttachIssue?() }) {
          Label("Attach issue", systemImage: "link.badge.plus")
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
      WorkChatGlassCircleLabel(systemName: "ellipsis", glyphSize: 17)
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
    if model.showsRename {
      Button(action: onRename) {
        Label("Rename", systemImage: "pencil")
      }
    }

    if model.showsRestartAgent, let onRestartAgent {
      Button(action: onRestartAgent) {
        Label("Restart agent session", systemImage: "arrow.clockwise")
      }
      .accessibilityHint("Starts a fresh agent process on the next message, with new skills, plugins, and MCP servers. The conversation is kept.")
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
struct WorkChatMessageBubble: View, Equatable {
  /// Rows are compared, not re-rendered. Closures are excluded on purpose: they
  /// are rebuilt on every parent body pass and never change what is drawn.
  static func == (lhs: WorkChatMessageBubble, rhs: WorkChatMessageBubble) -> Bool {
    lhs.message == rhs.message
      && lhs.isStreaming == rhs.isStreaming
      && lhs.maxUserBubbleWidth == rhs.maxUserBubbleWidth
      && lhs.userSegment == rhs.userSegment
  }

  let message: WorkChatMessage
  /// True only for the assistant message still receiving streaming deltas.
  /// Switches its markdown block parsing to the bounded streaming parser so
  /// each delta re-parses only the visible preview instead of the full message.
  var isStreaming: Bool = false
  /// Computed once by the parent transcript view. Avoids installing one
  /// GeometryReader per user row while preserving the desktop-style max width.
  var maxUserBubbleWidth: CGFloat? = nil
  /// Set when this row draws one piece of a long user message. The pieces are
  /// separate transcript rows that draw as one bubble: only the outer ends are
  /// rounded, the fill runs through the row margins between them, and the
  /// attachments, delivery badge and actions sit under the last piece.
  var userSegment: WorkUserBubbleSegment? = nil
  var onRunUnprocessed: (@MainActor (WorkChatMessage) async throws -> Void)? = nil
  var onEditUnprocessed: (@MainActor (WorkChatMessage) async throws -> Void)? = nil
  var onDismissUnprocessed: (@MainActor (WorkChatMessage) async throws -> Void)? = nil
  /// Opens the whole assistant answer in the full-screen output viewer: a very
  /// long answer is easier to read, search and scroll there than inside the
  /// transcript. Only the assistant row surfaces it; the user bubble ignores it.
  var onOpenFullOutput: () -> Void
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

  /// Flat stand-in for the desktop bubble gradient: each branch below is that
  /// gradient's midpoint stop, which is the colour a small mobile bubble reads
  /// as anyway. Kept in step with `CHAT_USER_BUBBLE_GRADIENT_*` in
  /// `apps/desktop/src/renderer/components/chat/chatSurfaceTheme.ts`.
  private var userBubbleFill: Color {
    // Claude and Codex shipped looking right, so they keep the original stops,
    // which mix toward a fixed violet.
    if ADEColor.chatAccentKeepsOriginalBubble(accent) {
      return isCodexChat
        ? workMixColors(accent, workViolet, 0.44)
        : workMixColors(accent, workViolet, 0.36)
    }
    // Near-black accents (Cursor, Pi) lift toward white instead — mixing them
    // toward violet turned two different runtimes into the same purple, and
    // deepening them would sink the bubble into the transcript background.
    if ADEColor.isDeepChatAccent(accent) {
      return workMixColors(accent, Color.white, 0.14)
    }
    // Everything else shades from its own accent, so a per-provider colour is
    // actually visible as that colour.
    return accent
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
    // reads like a document. It renders whole: there is no line budget, no
    // "Show more" step, and no summary row counting what is missing, because
    // nothing is missing.
    let preview = assistantPreview

    return VStack(alignment: .leading, spacing: 10) {
      if preview.usesMonospacedRendering {
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
    }
      .frame(maxWidth: .infinity, alignment: .leading)
    .workAssistantMessageContextMenu(
      onCopy: { UIPasteboard.general.string = message.markdown },
      onOpenFullOutput: onOpenFullOutput
    )
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
    let segment = userSegment
    let isLastPiece = segment?.isLast ?? true
    let attachments = isLastPiece ? (message.attachments ?? []) : []
    let hasAttachments = !attachments.isEmpty
    let bubbleText = segment?.text ?? message.markdown
    let hasText = !bubbleText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    let maxBubbleWidth = maxUserBubbleWidth ?? 360
    let shape = WorkUserBubbleShape(segment: segment)

    return HStack(alignment: .top, spacing: 8) {
      Spacer(minLength: 0)
      VStack(alignment: .trailing, spacing: 6) {
        if hasText || hasAttachments {
          VStack(alignment: .leading, spacing: hasText && hasAttachments ? 8 : 0) {
            if hasText {
              if segment == nil, let parts = workUserMessageParts(bubbleText) {
                // Sent thread comments draw as a card, and desktop quotes as
                // quotes, instead of their raw `<ade-…>` tags.
                WorkUserMessageStructuredBody(parts: parts)
              } else if workUserTextLooksLikeMarkdown(message.markdown) {
                // A handoff brief or pasted spec: render it, don't print raw
                // `###` and `**`. Chat lines keep their exact text.
                WorkMarkdownRenderer(markdown: bubbleText)
                  .environment(\.workMarkdownForeground, .white)
                  .foregroundStyle(.white)
              } else {
                WorkChipMessageText(text: bubbleText)
              }
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
          .padding(.top, segment?.isFirst == false ? 0 : 8)
          .padding(.bottom, isLastPiece ? 8 : 0)
          // Every piece spans the full bubble width, so a short last
          // paragraph does not leave a ragged edge.
          .frame(maxWidth: segment == nil ? nil : .infinity, alignment: .leading)
          .background(alignment: .top) {
            // Through the row margins at a join (see `WorkUserBubbleShape`).
            shape.fill(userBubbleFill)
              .padding(.top, -shape.extensionAbove)
              .padding(.bottom, -shape.extensionBelow)
          }
          .overlay {
            WorkUserBubbleOutline(segment: segment)
              .stroke(userBubbleBorder, lineWidth: 0.8)
              .padding(.top, -shape.extensionAbove)
              .padding(.bottom, -shape.extensionBelow)
          }
          .frame(maxWidth: maxBubbleWidth, alignment: .trailing)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityElement(children: .combine)
          .accessibilityLabel(userMessageAccessibilityLabel)
          // One accessibility element per message: the first piece speaks it.
          .accessibilityHidden(segment.map { !$0.isFirst } ?? false)
        }
        if isLastPiece, let deliveryBadge {
          WorkDeliveryBadge(state: deliveryBadge)
            .frame(maxWidth: maxBubbleWidth, alignment: .trailing)
        }
        if isLastPiece, message.deliveryState == "unprocessed" {
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

  /// Always the preview the transcript computed for this message. Re-slicing it
  /// here would be a second, disagreeing source of truth — and O(message) on the
  /// main thread for every body pass.
  private var assistantPreview: WorkAssistantMessagePreview {
    message.assistantPreview ?? workAssistantMessagePreview(message.markdown)
  }

  private var userMessageAccessibilityLabel: String {
    var parts = ["Your message."]
    // Comment cards and quotes read as words, not as their raw tags.
    let preview = workChatAccessibilityPreview(workUserMessageAccessibilityText(message.markdown) ?? message.markdown)
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
      processed: message.processed,
      steerId: message.steerId
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

// MARK: - Inline chips in a sent message

/// Where a chip tap goes. ADE links resolve in-app; everything else is a real
/// web address and goes to the system.
///
/// A terminal mention returns nil on purpose: no `ade://` shape addresses a
/// terminal session on ANY surface, so it stays a readable pointer rather than
/// a tap target that silently does nothing.
func workChipNavigationURL(_ chip: WorkChip) -> URL? {
  switch chip.origin {
  case .link(let link):
    return URL(string: link.url)
  case .model, .permission, .skill:
    // A model, permission or skill chip names a setting, not a place.
    return nil
  case .browserTab:
    // The tab is a live host-side resource, not an iOS deeplink target.
    return nil
  case .path:
    // Same reasoning as a terminal mention: the desktop routes a path chip to
    // its in-app Files view, and iOS has no counterpart to navigate to from a
    // chat bubble. A readable pointer beats a tap that silently does nothing.
    return nil
  case .mention(let mention):
    switch mention.kind {
    case .lane:
      return URL(string: LaneDeeplinkHelpers.laneLink(laneId: mention.id, form: .ade))
    case .chat:
      return URL(string: LaneDeeplinkHelpers.sessionLink(sessionId: mention.id, laneId: nil, form: .ade))
    case .terminal:
      return nil
    }
  }
}

/// Glyph + label, the compact form the desktop's `ChipText` draws.
func workChipInlineLabel(_ chip: WorkChip) -> String {
  "\(chip.glyph) \(chip.label)"
}

/// One chip as a styled, tappable run: glyph + label. A lane or chat this
/// device knows shows its real name (not "Lane b7ffb312"), a lane takes its own
/// colour, and a running or waiting chat carries a live dot. The desktop's dot
/// pulses; a `Text` run cannot animate, so this one is steady.
func workChipPill(
  _ chip: WorkChip,
  facts: WorkThreadEntityFacts?,
  foreground: Color,
  background: Color,
  font: Font? = nil,
  emphasized: Bool = false
) -> AttributedString {
  let factLabel = facts?.label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  let label = factLabel.isEmpty ? chip.label : factLabel
  let laneColor = LaneColorPalette.color(forHex: facts?.colorHex)
  let fill = laneColor.map { $0.opacity(0.2) } ?? background

  var pill = AttributedString("\(chip.glyph) \(label)")
  pill.foregroundColor = laneColor.map { workMixColors($0, Color.white, 0.38) } ?? foreground
  pill.backgroundColor = fill
  if let live = facts?.live {
    var dot = AttributedString(" ●")
    dot.foregroundColor = live == .running ? ADEColor.success : ADEColor.warning
    dot.backgroundColor = fill
    pill.append(dot)
  }
  if let font { pill.font = font }
  if emphasized { pill.inlinePresentationIntent = .stronglyEmphasized }
  if let url = workChipNavigationURL(chip) {
    pill.link = url
  }
  return pill
}

/// Where a chip tap lands. A lane opens its section in Work; every other
/// `ade://` target goes through the app's deep-link router; a web address goes
/// to the system.
@MainActor
func workOpenChipURL(_ url: URL) -> OpenURLAction.Result {
  guard url.scheme?.lowercased() == "ade" else { return .systemAction }
  if url.host?.lowercased() == "lane",
     let laneId = url.pathComponents.first(where: { $0 != "/" })?.removingPercentEncoding,
     UUID(uuidString: laneId) != nil,
     let syncService = SyncService.shared {
    syncService.requestedWorkLaneNavigation = WorkLaneNavigationRequest(laneId: laneId)
    return .handled
  }
  DeepLinkRouter.shared.handle(url)
  return .handled
}

/// Build the message body with its chips as styled, tappable runs.
///
/// A partition of the original string: every character of `text` is either in a
/// plain run or replaced by exactly one chip's display label, so nothing is
/// dropped and nothing is invented.
func workChipAttributedMessage(
  _ text: String,
  chipForeground: Color,
  chipBackground: Color,
  lookup: WorkThreadEntityLookup = .empty,
  limit: Int = WorkChipDetector.defaultLimit
) -> AttributedString {
  var out = AttributedString()
  for part in WorkChipDetector.parts(in: text, limit: limit) {
    switch part {
    case .text(let run):
      out.append(AttributedString(run))
    case .chip(let chip):
      out.append(
        workChipPill(
          chip,
          facts: lookup.facts(for: chip),
          foreground: chipForeground,
          background: chipBackground,
          font: WorkChatTypography.chip
        )
      )
    }
  }
  return out
}

/// A sent message body, with `@chat:` / `@lane:` / `@term:` mentions and links
/// drawn as compact chips.
///
/// One `Text` over an `AttributedString` rather than a flow layout of pill
/// views. A message is prose with chips *inside* it, so soft wrapping, hard
/// newlines, and drag-selection all have to keep working — and a layout that
/// makes each word its own subview loses every one of them, plus it turns a
/// long prompt into hundreds of views on a scrolling transcript.
///
/// The raw text is never rewritten. "Copy message" in the bubble's context menu
/// still copies `message.markdown` verbatim, which is the canonical token form.
/// The fill of a user bubble, or of one piece of a split user message.
///
/// Transcript rows sit `rowSpacing / 2` (7 pt) inside their cell on each side,
/// so two pieces are 14 pt apart. A piece extends its fill 7 pt into each
/// margin at a join, and the two pieces meet with no gap.
struct WorkUserBubbleShape: Shape {
  static let cornerRadius: CGFloat = 16
  static let joinExtension: CGFloat = 7

  let segment: WorkUserBubbleSegment?

  var extensionAbove: CGFloat { segment.map { $0.isFirst ? 0 : Self.joinExtension } ?? 0 }
  var extensionBelow: CGFloat { segment.map { $0.isLast ? 0 : Self.joinExtension } ?? 0 }

  func path(in rect: CGRect) -> Path {
    let top = segment?.isFirst ?? true ? Self.cornerRadius : 0
    let bottom = segment?.isLast ?? true ? Self.cornerRadius : 0
    return UnevenRoundedRectangle(
      topLeadingRadius: top,
      bottomLeadingRadius: bottom,
      bottomTrailingRadius: bottom,
      topTrailingRadius: top,
      // A split piece uses circular corners, the same arcs its outline draws.
      style: segment == nil ? .continuous : .circular
    ).path(in: rect)
  }
}

/// The border of a user bubble. A piece of a split message leaves its join
/// edges open, so no line crosses the bubble between two pieces.
struct WorkUserBubbleOutline: Shape {
  let segment: WorkUserBubbleSegment?

  func path(in rect: CGRect) -> Path {
    guard let segment, !(segment.isFirst && segment.isLast) else {
      return RoundedRectangle(cornerRadius: WorkUserBubbleShape.cornerRadius, style: .continuous).path(in: rect)
    }
    let r = min(WorkUserBubbleShape.cornerRadius, rect.width / 2, rect.height / 2)
    var path = Path()
    // Leading edge, top to bottom.
    if segment.isFirst {
      path.move(to: CGPoint(x: rect.minX, y: rect.minY + r))
    } else {
      path.move(to: CGPoint(x: rect.minX, y: rect.minY))
    }
    if segment.isLast {
      path.addArc(tangent1End: CGPoint(x: rect.minX, y: rect.maxY), tangent2End: CGPoint(x: rect.maxX, y: rect.maxY), radius: r)
      path.addArc(tangent1End: CGPoint(x: rect.maxX, y: rect.maxY), tangent2End: CGPoint(x: rect.maxX, y: rect.minY), radius: r)
    } else {
      path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
      path.move(to: CGPoint(x: rect.maxX, y: rect.maxY))
    }
    // Trailing edge, bottom to top.
    if segment.isFirst {
      path.addArc(tangent1End: CGPoint(x: rect.maxX, y: rect.minY), tangent2End: CGPoint(x: rect.minX, y: rect.minY), radius: r)
      path.addArc(tangent1End: CGPoint(x: rect.minX, y: rect.minY), tangent2End: CGPoint(x: rect.minX, y: rect.maxY), radius: r)
    } else {
      path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
    }
    return path
  }
}

private let workUserMarkdownHeadingLine = try! NSRegularExpression(pattern: "^#{1,6}\\s+\\S", options: [.anchorsMatchLines])
private let workUserMarkdownFenceLine = try! NSRegularExpression(pattern: "^\\s*(```|~~~)", options: [.anchorsMatchLines])
private let workUserMarkdownListLine = try! NSRegularExpression(
  pattern: "^\\s*(?:[-*+]|\\d+[.)])\\s+\\S",
  options: [.anchorsMatchLines]
)

/// True when a user message is a markdown DOCUMENT (a handoff brief, a pasted
/// spec), not a chat line that happens to contain an asterisk. Mirrors
/// `userTextLooksLikeMarkdown` on the desktop.
func workUserTextLooksLikeMarkdown(_ text: String) -> Bool {
  let ns = text as NSString
  guard ns.length >= 80 else { return false }
  let full = NSRange(location: 0, length: ns.length)
  if workUserMarkdownHeadingLine.firstMatch(in: text, range: full) != nil { return true }
  if workUserMarkdownFenceLine.firstMatch(in: text, range: full) != nil { return true }
  return workUserMarkdownListLine.numberOfMatches(in: text, range: full) >= 3
}

struct WorkChipMessageText: View {
  let text: String
  var foreground: Color = .white
  var chipBackground: Color = Color.white.opacity(0.22)
  /// Lane names, colours and chat titles for the chips. Republishes only when
  /// one of those changes.
  @ObservedObject private var entities = WorkThreadEntityDirectory.shared

  /// One cheap scan before any regex runs. The overwhelming majority of
  /// messages contain no chip at all, and this view is rebuilt for every
  /// visible bubble on every transcript pass.
  private var mayContainChip: Bool {
    text.contains("@") || text.contains("://")
  }

  var body: some View {
    Group {
      if mayContainChip {
        Text(
          workChipAttributedMessage(
            text,
            chipForeground: foreground,
            chipBackground: chipBackground,
            lookup: entities.lookup
          )
        )
        .environment(\.openURL, OpenURLAction { url in workOpenChipURL(url) })
      } else {
        Text(text)
      }
    }
    .font(WorkChatTypography.body)
    .foregroundStyle(foreground)
    .lineSpacing(5)
    .multilineTextAlignment(.leading)
    .fixedSize(horizontal: false, vertical: true)
    .textSelection(.enabled)
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

/// Ceiling on the text an accessibility label carries for one message.
let workChatAccessibilityPreviewLimit = 800

/// The whole assistant message plus the facts the rows render from.
///
/// There is no "visible vs total" axis and no anchor: assistant answers render
/// whole, so `text` IS the message. (Tool output still truncates — that lives in
/// `WorkOutputViewerScreen`/`WorkChatRichCardViews` and is a separate path.)
struct WorkAssistantMessagePreview: Equatable {
  let text: String
  /// Classification of the complete authoritative message. Cached with the
  /// preview so streaming rows do not rescan a growing answer several times
  /// per render.
  let usesMonospacedRendering: Bool
  let totalLineCount: Int
  let totalCharacterCount: Int
}

/// Previews for the visible assistant messages, keyed by message id.
///
/// Every entry is invalidated by identity, never by re-hashing: the message's
/// stamped `markdownDigest` (a short string) decides a hit, so a cache HIT costs
/// nothing proportional to the message. The previous version recomputed
/// `markdown.utf8.count` and `markdown.hashValue` on every lookup, so the hot
/// path — presentation refresh, several times a second, over every visible
/// message — was O(total visible text) even when nothing had changed.
///
/// One preview per message identity: the preview is the whole message, so
/// there is nothing else that could key a second entry.
final class WorkAssistantPreviewCache {
  private final class Entry {
    var identity: String
    var preview: WorkAssistantMessagePreview?

    init(identity: String) {
      self.identity = identity
    }
  }

  private var entries: [String: Entry] = [:]
  /// Cheap stand-in for the message text. Prefers the digest stamped by the
  /// snapshot fold; messages built outside it use their streaming revision or
  /// a raw fallback only until the next snapshot fold.
  private func identity(for message: WorkChatMessage) -> String {
    if let digest = message.markdownDigest {
      return "\(digest):revision=\(message.markdownRevision)"
    }
    if message.markdownRevision > 0 {
      // Incremental messages have not gone through the snapshot fold yet. Do
      // not interpolate the growing markdown here: the revision already gives
      // this cache a unique content identity for the current message.
      return "streaming:\(message.id):revision=\(message.markdownRevision)"
    }
    return "raw:\(message.markdown.utf8.count):\(message.markdown.hashValue)"
  }

  func preview(
    for message: WorkChatMessage,
    classification: Bool? = nil
  ) -> WorkAssistantMessagePreview {
    let identity = identity(for: message)
    let entry: Entry
    if let existing = entries[message.id], existing.identity == identity {
      entry = existing
      if let cached = entry.preview { return cached }
    } else {
      entry = Entry(identity: identity)
      entries[message.id] = entry
    }

    let preview = workAssistantMessagePreview(
      message.markdown,
      classification: classification ?? message.markdownMonospacedClassifier?.usesMonospacedRendering,
      knownLineCount: message.markdownLineCount,
      knownCharacterCount: message.markdownCharacterCount,
      knownMarkdownHasCarriageReturn: message.markdownHasCarriageReturn
    )
    entry.preview = preview
    return preview
  }

  func prune(keeping messageIds: Set<String>) {
    entries = entries.filter { messageIds.contains($0.key) }
  }
}

/// The whole assistant message, plus the counts and the monospaced
/// classification the rows render from.
///
/// There is no line/character budget and no anchor: assistant answers render
/// whole, however long they are. Tool output still truncates; that lives in
/// `WorkOutputViewerScreen`/`WorkChatRichCardViews` and is a separate path.
func workAssistantMessagePreview(
  _ markdown: String,
  classification: Bool? = nil,
  knownLineCount: Int? = nil,
  knownCharacterCount: Int? = nil,
  knownMarkdownHasCarriageReturn: Bool? = nil
) -> WorkAssistantMessagePreview {
  // `replacingOccurrences` allocates a second copy of the whole message even
  // when there is nothing to replace, which is the overwhelmingly common case
  // (host transcripts are LF). Scan first, copy only when it would change
  // something.
  let normalized = (knownMarkdownHasCarriageReturn ?? markdown.utf8.contains(0x0D))
    ? markdown.replacingOccurrences(of: "\r\n", with: "\n")
    : markdown
  guard !normalized.isEmpty else {
    return WorkAssistantMessagePreview(
      text: markdown,
      usesMonospacedRendering: false,
      totalLineCount: 0,
      totalCharacterCount: 0
    )
  }

  let usesMonospacedPreview = classification ?? workAssistantMessageUsesMonospacedPreview(normalized)
  let totalLineCount = knownLineCount ?? workAssistantMessageLineCount(normalized)
  let totalCharacterCount = knownCharacterCount ?? normalized.count
  return WorkAssistantMessagePreview(
    text: markdown,
    usesMonospacedRendering: usesMonospacedPreview,
    totalLineCount: totalLineCount,
    totalCharacterCount: totalCharacterCount
  )
}

func workAssistantMessageLineCount(_ text: String) -> Int {
  text.reduce(1) { count, character in
    character == "\n" ? count + 1 : count
  }
}

func workAssistantMessageAccessibilityLabel(_ preview: WorkAssistantMessagePreview) -> String {
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

/// Provider handoff divider: the transcript's "a different agent picked this
/// thread up" marker. Mirrors desktop `AgentChatMessageList` — hairline, the
/// outgoing provider's logo, a small uppercase "handoff" label, an arrow, the
/// incoming provider's logo, hairline. Takes the two providers directly; the
/// same-provider filter and the `metadata` unpack live in `eventCard` and the
/// timeline call site, not here.
struct WorkModelHandoffDivider: View {
  let fromProvider: String
  let toProvider: String
  let accessibilityLabel: String

  var body: some View {
    HStack(spacing: 10) {
      hairline
      HStack(spacing: 8) {
        providerMark(fromProvider)
        Text("Handoff")
          .font(.system(size: 10, weight: .semibold))
          .textCase(.uppercase)
          .tracking(1.4)
          .foregroundStyle(ADEColor.textMuted)
        Image(systemName: "arrow.right")
          .font(.system(size: 10, weight: .bold))
          .foregroundStyle(ADEColor.textMuted)
        providerMark(toProvider)
      }
      hairline
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 6)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityLabel)
  }

  private func providerMark(_ provider: String) -> some View {
    WorkProviderBareLogo(
      provider: provider,
      fallbackSymbol: "terminal.fill",
      tint: ADEColor.textMuted,
      size: 15
    )
    .opacity(0.9)
  }

  private var hairline: some View {
    Rectangle()
      .fill(ADEColor.glassBorder)
      .frame(height: 0.6)
  }
}

/// "Codex hit its limit. A reset credit is banked." — with the way to spend it.
///
/// Desktop parity with `ResetCreditNoticeRow` in `AgentChatMessageList.tsx`:
/// the credit is the one usage notice with something to DO, so the action rides
/// the notice instead of living only in the Limits module a tab away. The
/// outcome REPLACES the button rather than sitting beside it — the credit is
/// gone either way, and a live button invites a second spend.
struct WorkResetCreditNoticeView: View {
  let card: WorkEventCardModel

  /// Not `@EnvironmentObject`: renders inside a transcript cell (see
  /// `WorkSyncServiceReference`).
  @Environment(\.workSyncService) private var syncReference
  @State private var spending = false
  @State private var outcome: String?

  /// Absent when the host omitted `detail.accountId`. The sentence is still
  /// worth reading; there is simply no account to spend against.
  private var accountId: String? { card.metadata.first }

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: card.icon)
        .font(.system(size: 11, weight: .bold))
        .foregroundStyle(card.tint.color)
      Text(card.title)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 6)
      if let outcome {
        Text(outcome)
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize(horizontal: false, vertical: true)
      } else if let accountId, syncReference.service?.canInvokeRemoteAction("usage.consumeResetCredit") == true {
        Button("Use reset") {
          Task { await spend(accountId: accountId) }
        }
        .buttonStyle(.plain)
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .disabled(spending)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityHint("Clears this account's limit windows now.")
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .background(ADEColor.warning.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .stroke(ADEColor.warning.opacity(0.18), lineWidth: 0.8)
    )
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  /// The host names the outcome; the phone only phrases it. A failure is never
  /// dressed up as a reset — see `workResetCreditOutcomeText`.
  @MainActor
  private func spend(accountId: String) async {
    guard let syncService = syncReference.service else { return }
    spending = true
    defer { spending = false }
    do {
      outcome = workResetCreditOutcomeText(
        try await syncService.consumeUsageResetCredit(accountId: accountId)
      )
    } catch {
      ADEHaptics.error()
      outcome = error.localizedDescription
    }
  }
}

/// Desktop `formatTurnTokenParts`: `12.3k`, `1.2M`; nil for zero.
func workTurnTokenCount(_ value: Int) -> String? {
  guard value > 0 else { return nil }
  if value >= 1_000_000 { return String(format: "%.1fM", Double(value) / 1_000_000) }
  if value >= 1_000 { return String(format: "%.1fk", Double(value) / 1_000) }
  return String(value)
}

/// Desktop `formatDoneTurnTokenLine`: the usage-limit footer's details line.
func workDoneTurnTokenLine(_ usage: WorkUsageSummary?) -> String? {
  guard let usage else { return nil }
  var segments: [String] = []
  if let value = workTurnTokenCount(usage.inputTokens) { segments.append("in \(value)") }
  if let value = workTurnTokenCount(usage.outputTokens) { segments.append("out \(value)") }
  if let value = workTurnTokenCount(usage.cacheReadTokens) { segments.append("cached \(value) ✶") }
  if let value = workTurnTokenCount(usage.cacheCreationTokens) { segments.append("cache write \(value)") }
  if let value = workTurnTokenCount(usage.reasoningTokens) { segments.append("reasoning \(value)") }
  return segments.isEmpty ? nil : segments.joined(separator: " · ")
}

/// The turn-end line (desktop `DoneTurnDivider` + `ChatTurnWorkSummary`): one
/// row that never wraps —
/// `🕐 ran 4m 30s · 02:15 AM  [2 proof] [3 sources] · ↑IN 12k/↓OUT 3k/~40k   🔧 4 tools ›  ± 3 files ›`.
/// A failed or interrupted turn leads with the model and reads the status in
/// place of the time. A turn that folded keeps only time, usage, proof and
/// sources (its tools and files moved up to the fold row). A usage-limit turn
/// collapses to one quiet `Paused · usage limit · 4m` line with its token
/// usage behind a details toggle. The tools and files toggles open the turn's
/// lists inline, and the proof chip opens the turn's filmstrip, as on desktop.
/// The context meter lives in the composer (desktop parity).
struct WorkTurnEndMarkerView: View {
  let marker: WorkTurnEndMarker
  var work: WorkTurnWorkDisclosure = .none
  var onToggleWork: (WorkTurnWorkSection) -> Void = { _ in }
  var onToggleWorkItem: (String) -> Void = { _ in }
  var proofOpen = false
  var onToggleProof: (() -> Void)? = nil
  /// Loaded previews by artifact id, for the filmstrip thumbnails.
  var proofContent: [String: WorkLoadedArtifactContent] = [:]
  var onLoadProof: (ComputerUseArtifactSummary) -> Void = { _ in }
  var onOpenProofDrawer: (() -> Void)? = nil

  @State private var usageLimitDetailsExpanded = false

  private var status: String {
    marker.status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  }

  private var completed: Bool {
    status.isEmpty || status == "completed" || status == "complete" || status == "succeeded" || status == "success"
  }

  private var statusTint: Color {
    status == "failed" ? ADEColor.danger : ADEColor.warning
  }

  private var ranFor: String? { marker.workedDurationLabel.map { "ran \($0)" } }

  private var showsWorkToggles: Bool { !marker.workSummaryInFold }

  private var usageLimitLine: String {
    marker.workedDurationLabel.map { "Paused · usage limit · \($0)" } ?? "Paused · usage limit"
  }

  private var tokenLine: String? { workDoneTurnTokenLine(marker.usage) }

  private var markerAccessibilityLabel: String {
    if marker.usageLimitPaused { return usageLimitLine }
    var parts: [String] = []
    if completed {
      parts.append("Turn ended at \(workTurnSeparatorTimeLabel(marker.time))")
    } else {
      parts.append(contentsOf: [marker.modelLabel, "Turn \(status)", marker.terminalReasonLabel].compactMap { $0?.isEmpty == false ? $0 : nil })
    }
    if let ranFor { parts.append(ranFor) }
    if let tokenLine { parts.append(tokenLine) }
    if marker.proofCount > 0 { parts.append("\(marker.proofCount) proof") }
    if marker.sourceCount > 0 { parts.append(workPluralCount(marker.sourceCount, "source")) }
    if showsWorkToggles, let summary = workFormatTurnWorkSummaryLabel(toolCount: work.toolCount, fileCount: work.fileStat?.count ?? 0) {
      parts.append(summary)
    }
    return parts.joined(separator: ". ")
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 8) {
        HStack(spacing: 8) {
          if marker.usageLimitPaused {
            usageLimitLead
            chips
          } else {
            lead
            chips
            if let usage = marker.usage, workTurnTokenCount(usage.inputTokens) != nil
                || workTurnTokenCount(usage.outputTokens) != nil
                || workTurnTokenCount(usage.cacheReadTokens) != nil {
              separator
              tokens(usage)
            }
          }
        }
        .lineLimit(1)
        // Desktop keeps the line on one row and lets the time/usage side clip
        // (`overflow-hidden`) so the toggles always fit; laid out at its ideal
        // width, pinned leading, and clipped to what the toggles leave.
        .fixedSize(horizontal: true, vertical: false)
        .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
        .clipped()
        if showsWorkToggles {
          WorkTurnWorkToggles(disclosure: work, filesLabelSuffix: "", onToggle: onToggleWork)
        }
      }
      .font(.caption2)
      .foregroundStyle(ADEColor.textMuted)
      .frame(minHeight: 44)
      if marker.usageLimitPaused, usageLimitDetailsExpanded, let tokenLine {
        Text(tokenLine)
          .font(.caption2.monospacedDigit())
          .foregroundStyle(ADEColor.textMuted)
          .padding(.leading, 12)
          .overlay(alignment: .leading) {
            Rectangle().fill(ADEColor.glassBorder).frame(width: 0.6)
          }
          .padding(.bottom, 6)
      }
      if showsWorkToggles, work.open != nil {
        WorkTurnWorkInlineDetails(disclosure: work, onToggleItem: onToggleWorkItem)
      }
      if proofOpen, !marker.proofArtifacts.isEmpty {
        WorkTurnProofFilmstrip(
          artifacts: marker.proofArtifacts,
          content: proofContent,
          onLoad: onLoadProof,
          onOpen: onOpenProofDrawer
        )
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(markerAccessibilityLabel)
  }

  @ViewBuilder
  private var lead: some View {
    HStack(spacing: 6) {
      if !completed, !marker.modelLabel.isEmpty {
        HStack(spacing: 4) {
          runtimeGlyph
          Text(marker.modelLabel).fontWeight(.medium)
        }
      }
      if let ranFor {
        HStack(spacing: 3) {
          Image(systemName: "clock").font(.system(size: 9, weight: .bold))
          Text(ranFor)
        }
        separator
      }
      if completed {
        Text(workTurnSeparatorTimeLabel(marker.time))
      } else {
        Text(status.uppercased()).fontWeight(.medium).tracking(0.4)
        if let reason = marker.terminalReasonLabel {
          separator
          Text(reason)
        }
      }
    }
    .font(.caption2.monospacedDigit())
    .foregroundStyle(completed ? ADEColor.textMuted : statusTint.opacity(0.9))
    .fixedSize(horizontal: true, vertical: false)
  }

  private var usageLimitLead: some View {
    Button {
      usageLimitDetailsExpanded.toggle()
    } label: {
      HStack(spacing: 5) {
        Text(usageLimitLine)
        if tokenLine != nil {
          Image(systemName: usageLimitDetailsExpanded ? "chevron.down" : "chevron.right")
            .font(.system(size: 8, weight: .bold))
            .opacity(0.55)
        }
      }
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(tokenLine == nil)
    .accessibilityHint(tokenLine == nil ? "" : "Shows this turn's token usage.")
  }

  @ViewBuilder
  private var chips: some View {
    if marker.proofCount > 0 {
      Button {
        onToggleProof?()
      } label: {
        chip(icon: "cube", text: "\(marker.proofCount) proof")
          .frame(minHeight: 44)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(onToggleProof == nil)
      .accessibilityLabel("\(proofOpen ? "Hide" : "Show") the proof captured in this turn")
    }
    if marker.sourceCount > 0 {
      chip(icon: "globe", text: workPluralCount(marker.sourceCount, "source"))
    }
  }

  private func chip(icon: String, text: String) -> some View {
    HStack(spacing: 3) {
      Image(systemName: icon).font(.system(size: 8, weight: .bold))
      Text(text).font(.caption2.monospacedDigit())
    }
    .padding(.horizontal, 5)
    .padding(.vertical, 1)
    .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).stroke(ADEColor.glassBorder, lineWidth: 0.6))
    .fixedSize()
  }

  /// `↑IN 12k / ↓OUT 3k / ~40k`, in desktop's amber / red / emerald.
  private func tokens(_ usage: WorkUsageSummary) -> some View {
    let input = workTurnTokenCount(usage.inputTokens)
    let output = workTurnTokenCount(usage.outputTokens)
    let cached = workTurnTokenCount(usage.cacheReadTokens)
    return HStack(spacing: 3) {
      if let input {
        HStack(spacing: 1) {
          Image(systemName: "arrow.up").font(.system(size: 7, weight: .bold))
          Text("IN").font(.system(size: 8, weight: .semibold))
          Text(input)
        }
        .foregroundStyle(ADEColor.warning.opacity(0.9))
      }
      if input != nil, output != nil || cached != nil { Text("/").opacity(0.4) }
      if let output {
        HStack(spacing: 1) {
          Image(systemName: "arrow.down").font(.system(size: 7, weight: .bold))
          Text("OUT").font(.system(size: 8, weight: .semibold))
          Text(output)
        }
        .foregroundStyle(ADEColor.danger.opacity(0.9))
      }
      if output != nil, cached != nil { Text("/").opacity(0.4) }
      if let cached {
        Text("~\(cached)").foregroundStyle(ADEColor.success.opacity(0.9))
      }
    }
    .font(.caption2.monospacedDigit())
    .fixedSize(horizontal: true, vertical: false)
    .layoutPriority(-1)
  }

  private var separator: some View {
    Text("·").opacity(0.45)
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
        .fill(ADEColor.chatSurfaceAccent(modelId: marker.modelId, provider: marker.provider).opacity(0.75))
        .frame(width: 5, height: 5)
    }
  }
}

/// The chat's goal as the composer chip (desktop `GoalChip`): Codex
/// `thread/goal` or Claude's native `/goal`. Codex goals that finished drop it.
struct WorkChatGoalModel: Equatable {
  enum Provider: Equatable { case claude, codex }
  let provider: Provider
  let objective: String
  /// Codex goal status; Claude goals are `active` while they exist.
  let status: String
  let iterations: Int?
  let tokensUsed: Double?
  let lastReason: String?

  var paused: Bool { provider == .codex && status == "paused" }

  var statusLabel: String {
    switch status {
    case "usage_limited": return "waiting on usage limit"
    case "budget_limited": return "budget reached"
    case "complete": return "reached"
    default: return status.replacingOccurrences(of: "_", with: " ")
    }
  }

  var progressLabel: String? {
    if let iterations, iterations > 0 { return "iteration \(iterations)" }
    guard let tokensUsed, tokensUsed.isFinite, tokensUsed > 0 else { return nil }
    if tokensUsed >= 1_000_000 { return String(format: "%.1fM tokens", tokensUsed / 1_000_000) }
    if tokensUsed >= 1_000 { return "\(Int((tokensUsed / 1_000).rounded()))k tokens" }
    return "\(Int(tokensUsed)) tokens"
  }
}

/// Desktop's pick, in its order: a live Codex goal on a Codex chat, else a
/// Claude `/goal` condition.
func workChatGoalModel(
  provider: String,
  claudeGoal: AgentChatClaudeGoal?,
  codexGoal: AgentChatCodexGoal?
) -> WorkChatGoalModel? {
  let family = provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  if family == "codex", let codexGoal, codexGoal.isLive {
    return WorkChatGoalModel(
      provider: .codex,
      objective: codexGoal.objective?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
      status: codexGoal.status ?? "active",
      iterations: nil,
      tokensUsed: codexGoal.tokensUsed,
      lastReason: nil
    )
  }
  if let claudeGoal {
    let condition = claudeGoal.condition.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !condition.isEmpty else { return nil }
    return WorkChatGoalModel(
      provider: .claude,
      objective: condition,
      status: "active",
      iterations: claudeGoal.iterations,
      tokensUsed: nil,
      lastReason: claudeGoal.lastReason?.trimmingCharacters(in: .whitespacesAndNewlines)
    )
  }
  return nil
}

/// One-line goal chip above the composer. Tap opens a sheet with the full
/// objective and the controls the provider has: Codex goals pause and resume;
/// Claude goals (its `/goal`) can only be changed or cleared, between turns.
/// A nil closure hides its button (the host lacks that command).
struct WorkChatGoalChip: View {
  let goal: WorkChatGoalModel
  /// Claude takes `/goal` only between turns.
  let turnActive: Bool
  var onEdit: ((String) -> Void)? = nil
  var onClear: (() -> Void)? = nil
  var onSetPaused: ((Bool) -> Void)? = nil

  @State private var sheetPresented = false
  @State private var pulse = false

  /// Amber while working toward the goal, grey when paused.
  private var dotColor: Color { goal.paused ? ADEColor.textMuted : ADEColor.warning }

  var body: some View {
    Button {
      ADEHaptics.light()
      sheetPresented = true
    } label: {
      HStack(spacing: 5) {
        Image(systemName: "target")
          .font(.caption2.weight(.bold))
          .foregroundStyle(ADEColor.warning)
        Text("Goal")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
        Circle()
          .fill(dotColor)
          .frame(width: 5, height: 5)
          .opacity(!goal.paused && pulse ? 0.35 : 1)
          .animation(goal.paused ? nil : .easeInOut(duration: 0.9).repeatForever(autoreverses: true), value: pulse)
          .onAppear { pulse = true }
          .accessibilityHidden(true)
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .background(ADEColor.warning.opacity(0.07), in: Capsule(style: .continuous))
      .overlay(Capsule(style: .continuous).stroke(ADEColor.warning.opacity(0.18), lineWidth: 0.5))
      .contentShape(Capsule(style: .continuous))
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Goal, \(goal.statusLabel): \(goal.objective)")
    .accessibilityHint("Opens goal controls")
    .accessibilityIdentifier("Work.Chat.GoalChip")
    .sheet(isPresented: $sheetPresented) {
      WorkChatGoalSheet(
        goal: goal,
        turnActive: turnActive,
        onEdit: onEdit,
        onClear: onClear,
        onSetPaused: onSetPaused
      )
      .presentationDetents([.height(340), .medium])
      .presentationDragIndicator(.visible)
    }
  }
}

private struct WorkChatGoalSheet: View {
  let goal: WorkChatGoalModel
  let turnActive: Bool
  let onEdit: ((String) -> Void)?
  let onClear: (() -> Void)?
  let onSetPaused: ((Bool) -> Void)?

  @Environment(\.dismiss) private var dismiss
  @State private var editing = false
  @State private var draft = ""

  private var claudeLocked: Bool { goal.provider == .claude && turnActive }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Text(goal.objective)
            .font(.body)
            .textSelection(.enabled)
          if let lastReason = goal.lastReason, !lastReason.isEmpty {
            Text("Last check: \(lastReason)")
              .font(.footnote)
              .foregroundStyle(ADEColor.textMuted)
          }
        } header: {
          Text(["Goal · \(goal.statusLabel)", goal.progressLabel].compactMap { $0 }.joined(separator: " · "))
        } footer: {
          if claudeLocked {
            Text("Claude takes goal changes between turns.")
          }
        }

        if editing, let onEdit {
          Section("Edit goal") {
            TextField("Goal", text: $draft, axis: .vertical)
              .lineLimit(2...6)
            let normalizedDraft = draft
              .replacingOccurrences(of: "\\s*[\\r\\n]+\\s*", with: " ", options: .regularExpression)
              .trimmingCharacters(in: .whitespacesAndNewlines)
            Button("Set goal") {
              guard !normalizedDraft.isEmpty, normalizedDraft != goal.objective else { return }
              onEdit(normalizedDraft)
              dismiss()
            }
            .disabled(claudeLocked || normalizedDraft.isEmpty || normalizedDraft == goal.objective)
          }
        } else {
          Section {
            if onEdit != nil {
              Button {
                draft = goal.objective
                editing = true
              } label: {
                Label("Edit", systemImage: "pencil")
              }
              .disabled(claudeLocked)
            }
            if goal.provider == .codex, let onSetPaused {
              Button {
                onSetPaused(!goal.paused)
                dismiss()
              } label: {
                Label(goal.paused ? "Resume" : "Pause", systemImage: goal.paused ? "play.fill" : "pause.fill")
              }
            }
            if let onClear {
              Button(role: .destructive) {
                onClear()
                dismiss()
              } label: {
                Label("Clear", systemImage: "xmark")
              }
              .disabled(claudeLocked)
            }
          }
        }
      }
      .navigationTitle("Goal")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
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
    case sending, steering, steered, sentAfterTurn, notSteered, steerFailed, sendFailed

    var label: String {
      switch self {
      case .sending: return "Sending"
      case .steering: return "Steering…"
      case .steered: return "Steered"
      case .sentAfterTurn: return "Sent after turn"
      case .notSteered: return "Not steered — turn ended first"
      case .steerFailed: return "Steer failed"
      case .sendFailed: return "Couldn't send"
      }
    }

    var icon: String {
      switch self {
      case .sending: return "arrow.up.circle"
      case .steering, .steered, .notSteered, .steerFailed: return "steeringwheel"
      case .sentAfterTurn: return "clock"
      case .sendFailed: return "exclamationmark.triangle"
      }
    }

    var tint: Color {
      switch self {
      case .sending: return ADEColor.accent
      case .steering: return ADEColor.accent
      case .steered: return ADEColor.textMuted
      case .sentAfterTurn: return ADEColor.textMuted
      case .notSteered: return ADEColor.warning
      case .steerFailed, .sendFailed: return ADEColor.warning
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
    .padding(.horizontal, 2)
    .padding(.top, 1)
    .accessibilityLabel(state.label)
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
  processed: Bool?,
  steerId: String? = nil
) -> WorkDeliveryBadge.State? {
  switch deliveryState {
  case "queued": return nil
  case "accepted": return .steering
  case "processed": return .steered
  case "unprocessed": return .notSteered
  case "delivered":
    return steerId?.isEmpty == false ? .sentAfterTurn : nil
  case "inline":
    return .steered
  case "failed": return steerId?.isEmpty == false ? .steerFailed : .sendFailed
  case "sending": return .sending
  default:
    return processed == true && steerId?.isEmpty == false ? .steered : nil
  }
}

// MARK: - Shared assistant message context menu

extension View {
  /// The long-press menu every assistant row carries — the whole-message copy
  /// and the full-output viewer. Shared so the bubble and the split markdown /
  /// monospaced rows of the same message cannot drift apart in wording or in
  /// which actions they offer.
  func workAssistantMessageContextMenu(
    onCopy: @escaping () -> Void,
    onOpenFullOutput: @escaping () -> Void
  ) -> some View {
    contextMenu {
      Button(action: onCopy) {
        Label("Copy message", systemImage: "doc.on.doc")
      }
      Button(action: onOpenFullOutput) {
        Label("Open full response", systemImage: "arrow.up.left.and.arrow.down.right")
      }
    }
  }
}
