import SwiftUI

// Side chats (`/side`). The iOS half of `apps/desktop/src/shared/sideChat.ts`.
//
// A side chat is a read-only fork of a chat, opened beside it for a quick
// question or a discussion. It knows the main chat's conversation (the brain
// forks the provider history) but its own view starts blank. It runs on the
// main chat's machine, in the same lane and folder, and a chat has at most
// one. It never edits; when the user asks, it writes a `<send_to_main>` block
// and the brain delivers that block to the main chat. It is never a Work row of
// its own: the main chat's row, header and Tools chips lead to it.

// MARK: - Contract mirror

/// Providers with a native fork (or, for Muse, a native side chat). Mirrors
/// `SIDE_CHAT_PROVIDERS` (`HANDOFF_FORK_PROVIDERS` without Cursor, whose fork
/// replays the transcript).
let workSideChatProviders: Set<String> = ["claude", "codex", "muse", "opencode", "droid", "copilot", "kimi", "pi"]

func workProviderSupportsSideChat(_ provider: String?) -> Bool {
  guard let provider = provider?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
        !provider.isEmpty
  else { return false }
  return workSideChatProviders.contains(provider)
}

/// Byte-identical to `SIDE_CHAT_UNSUPPORTED_MESSAGE`.
let workSideChatUnsupportedMessage =
  "Side chats need a provider that can fork its own history, and this one cannot. Ask the main chat instead."

/// Byte-identical to `SIDE_CHAT_WORK_ONLY_MESSAGE`: the brain's refusal for a CTO or personal chat.
let workSideChatWorkOnlyMessage = "Side chats are available in Work chats."

/// Byte-identical to `SIDE_CHAT_OF_SIDE_CHAT_MESSAGE`.
let workSideChatOfSideChatMessage = "This is a side chat. Open side chats from the main chat."

/// One sentence, everywhere the mark appears (desktop `SIDE_CHAT_PRESENCE_LABEL`).
let workSideChatPresenceLabel = "Has a side chat"

let workSideChatSymbol = "bubble.left.and.text.bubble.right"

/// The desktop mark's teal (`#5eead4`).
let workSideChatTint = Color(red: 0x5E / 255.0, green: 0xEA / 255.0, blue: 0xD4 / 255.0)

let workSideChatSendOpenTag = "<send_to_main>"
let workSideChatSendCloseTag = "</send_to_main>"

struct WorkSideSlashCommand: Equatable {
  /// What to send to the side chat. Empty for a bare `/side`, which only opens it.
  let prompt: String
}

private let workSideSlashCommandPattern = try? NSRegularExpression(
  pattern: #"^\s*/side(?:\s+([\s\S]*))?$"#,
  options: [.caseInsensitive]
)

/// `/side <prompt>` from a composer, or nil when the text is not the command.
/// Case-insensitive; the prompt keeps its own line breaks. Mirrors
/// `parseSideSlashCommand`.
func workParseSideSlashCommand(_ text: String) -> WorkSideSlashCommand? {
  guard let regex = workSideSlashCommandPattern else { return nil }
  let range = NSRange(text.startIndex..<text.endIndex, in: text)
  guard let match = regex.firstMatch(in: text, options: [], range: range) else { return nil }
  let captured = match.range(at: 1)
  guard captured.location != NSNotFound, let swiftRange = Range(captured, in: text) else {
    return WorkSideSlashCommand(prompt: "")
  }
  return WorkSideSlashCommand(prompt: String(text[swiftRange]).trimmingCharacters(in: .whitespacesAndNewlines))
}

enum WorkSideChatTextPart: Equatable {
  case text(String)
  /// `complete` is false while the block is still streaming.
  case send(text: String, complete: Bool)
}

/// Where code sits in a reply (fenced blocks and inline spans), as UTF-16
/// offsets, so a tag the side chat quotes or explains is never taken for a
/// send. Mirrors `codeRanges` in `shared/sideChat.ts`.
private func workSideChatCodeRanges(_ text: String) -> [Range<Int>] {
  let ns = text as NSString
  var ranges: [Range<Int>] = []
  let full = NSRange(location: 0, length: ns.length)
  if let fence = try? NSRegularExpression(pattern: "(^|\\n)(```|~~~)[^\\n]*\\n[\\s\\S]*?(?:\\n\\2[^\\n]*(?=\\n|$)|$)") {
    for match in fence.matches(in: text, range: full) {
      ranges.append(match.range.location..<(match.range.location + match.range.length))
    }
  }
  if let inline = try? NSRegularExpression(pattern: "`[^`\\n]+`") {
    for match in inline.matches(in: text, range: full) where !ranges.contains(where: { $0.contains(match.range.location) }) {
      ranges.append(match.range.location..<(match.range.location + match.range.length))
    }
  }
  return ranges
}

/// Splits a side chat's reply into prose and send-to-main blocks. Only blocks
/// that end the reply count, and never one inside code; an open tag with no
/// close yet, at the end of a reply still streaming, is a pending block.
/// Mirrors `splitSideChatSendBlocks`.
func workSplitSideChatSendBlocks(_ text: String) -> [WorkSideChatTextPart] {
  let ns = text as NSString
  let code = workSideChatCodeRanges(text)
  let inCode = { (at: Int) in code.contains { $0.contains(at) } }
  struct Block { let open: Int; let end: Int; let body: String; let complete: Bool }
  var blocks: [Block] = []
  var cursor = 0
  let openLength = (workSideChatSendOpenTag as NSString).length
  let closeLength = (workSideChatSendCloseTag as NSString).length
  while cursor < ns.length {
    let open = ns.range(of: workSideChatSendOpenTag, range: NSRange(location: cursor, length: ns.length - cursor))
    if open.location == NSNotFound { break }
    if inCode(open.location) {
      cursor = open.location + openLength
      continue
    }
    let bodyStart = open.location + openLength
    let close = ns.range(of: workSideChatSendCloseTag, range: NSRange(location: bodyStart, length: ns.length - bodyStart))
    if close.location == NSNotFound {
      let body = ns.substring(from: bodyStart).trimmingCharacters(in: .whitespacesAndNewlines)
      blocks.append(Block(open: open.location, end: ns.length, body: body, complete: false))
      break
    }
    let body = ns.substring(with: NSRange(location: bodyStart, length: close.location - bodyStart))
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let end = close.location + closeLength
    blocks.append(Block(open: open.location, end: end, body: body, complete: true))
    cursor = end
  }
  // The trailing run: blocks with only whitespace between them and after.
  var first = blocks.count
  var tail = ns.length
  for index in stride(from: blocks.count - 1, through: 0, by: -1) {
    let between = ns.substring(with: NSRange(location: blocks[index].end, length: tail - blocks[index].end))
    if !between.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { break }
    first = index
    tail = blocks[index].open
  }
  if first == blocks.count { return text.isEmpty ? [] : [.text(text)] }
  var parts: [WorkSideChatTextPart] = []
  if blocks[first].open > 0 { parts.append(.text(ns.substring(to: blocks[first].open))) }
  for block in blocks[first...] { parts.append(.send(text: block.body, complete: block.complete)) }
  return parts.filter {
    if case .text(let value) = $0 { return !value.isEmpty }
    return true
  }
}

func workSideChatTextHasSendBlock(_ text: String) -> Bool {
  text.contains(workSideChatSendOpenTag)
}

/// The reply as markdown with each send-to-main block drawn as a quoted "Sent
/// to the main chat" note (pending while it streams). Text without a block
/// comes back unchanged. Mirrors `sideChatSendBlocksToMarkdown`.
func workSideChatSendBlocksToMarkdown(_ text: String) -> String {
  guard workSideChatTextHasSendBlock(text) else { return text }
  return workSplitSideChatSendBlocks(text).map { part in
    switch part {
    case .text(let value):
      return value
    case .send(let body, let complete):
      let heading = complete ? "**↗ Sent to the main chat**" : "**↗ Sending to the main chat…**"
      let quoted = body.split(separator: "\n", omittingEmptySubsequences: false)
        .map { "> \($0)" }
        .joined(separator: "\n")
      return "\n\n> \(heading)\n>\n\(quoted)\n\n"
    }
  }.joined()
}

/// The `/side` row that leads the `/` menu when the chat can open a side chat.
func workSideChatSlashSuggestions(offered: Bool, query: String) -> [WorkComposerSuggestion] {
  guard offered else { return [] }
  let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  guard trimmed.isEmpty || "side".hasPrefix(trimmed) else { return [] }
  return [
    WorkComposerSuggestion(
      id: "slash:/side",
      kind: .slash,
      title: "/side",
      subtitle: "Ask a side chat that knows this conversation. Read-only.",
      insertText: "/side"
    ),
  ]
}

// MARK: - Work list

/// main chat id → side chat id from the active project's roster rows. The
/// Work list keeps the local replica's row over the roster's, so the pointer is
/// read off the roster directly.
func workRosterSideChatPointers(_ roster: RemoteRosterProject?) -> [String: String] {
  guard let roster else { return [:] }
  var pointers: [String: String] = [:]
  for chat in roster.chats {
    guard let side = chat.sideChatSessionId?.trimmingCharacters(in: .whitespacesAndNewlines),
          !side.isEmpty
    else { continue }
    pointers[chat.id] = side
  }
  return pointers
}

/// Drops side chats from the Work rows and stamps each main chat's row with
/// its side chat, so the row draws the mark. A live pointer (this phone just
/// opened or ended one) wins over the roster, the row and the summary.
func workApplySideChats(
  sessions: [TerminalSessionSummary],
  chatSummaries: [String: AgentChatSessionSummary],
  rosterPointers: [String: String],
  overrides: [String: SyncSideChatPointer],
  knownSideChatIds: Set<String>
) -> [TerminalSessionSummary] {
  func nonEmpty(_ value: String?) -> String? {
    guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
    return trimmed
  }
  var hidden = knownSideChatIds
  for (id, summary) in chatSummaries where nonEmpty(summary.sideChatParentSessionId) != nil {
    hidden.insert(id)
  }
  var resolved: [String: String?] = [:]
  for session in sessions {
    let side: String?
    // This phone's own answer wins only inside its trust window; after it the
    // roster, which the host keeps current, is the word (another device may
    // have ended or replaced the side chat).
    if let pointer = overrides[session.id], pointer.isTrusted() {
      side = pointer.sideSessionId
    } else {
      side = rosterPointers[session.id]
        ?? nonEmpty(session.sideChatSessionId)
        ?? nonEmpty(chatSummaries[session.id]?.sideChatSessionId)
    }
    resolved[session.id] = side
    if let side { hidden.insert(side) }
  }
  guard !hidden.isEmpty || resolved.contains(where: { $0.value != nil }) else { return sessions }
  var result: [TerminalSessionSummary] = []
  result.reserveCapacity(sessions.count)
  for session in sessions where !hidden.contains(session.id) {
    let side = resolved[session.id] ?? nil
    if session.sideChatSessionId == side {
      result.append(session)
    } else {
      var stamped = session
      stamped.sideChatSessionId = side
      result.append(stamped)
    }
  }
  return result
}

// MARK: - Stand-ins until the host answers

/// A stand-in summary for a side chat: its main chat's provider and model (a
/// side chat always runs on them), and the parent link that makes the composer
/// read-only. Marked `rosterDerived`, so no access mode is claimed.
func workSideChatStubSummary(
  sideSessionId: String,
  mainSessionId: String,
  created: AgentChatSession?,
  mainSummary: AgentChatSessionSummary?,
  mainSession: TerminalSessionSummary?
) -> AgentChatSessionSummary? {
  let provider = created?.provider
    ?? mainSummary?.provider
    ?? workChatProviderFamilyFromToolType(mainSession?.toolType)
  guard let provider else { return nil }
  // Stable when the host has not answered yet: a fresh `Date()` here would
  // change on every re-evaluation of the sheet and defeat its equatable gate.
  let fallbackAt = mainSummary?.lastActivityAt ?? mainSummary?.startedAt ?? "1970-01-01T00:00:00.000Z"
  var payload: [String: Any] = [
    "sessionId": sideSessionId,
    "laneId": created?.laneId ?? mainSummary?.laneId ?? mainSession?.laneId ?? "",
    "provider": provider,
    "model": created?.model ?? mainSummary?.model ?? "",
    "status": created?.status ?? "idle",
    "startedAt": created?.createdAt ?? fallbackAt,
    "lastActivityAt": created?.lastActivityAt ?? fallbackAt,
    "title": "Side chat",
    "sideChatParentSessionId": mainSessionId,
  ]
  if let modelId = created?.modelId ?? mainSummary?.modelId { payload["modelId"] = modelId }
  return rosterDerivedChatSummary(payload)
}

/// The side chat's session row stand-in: its main chat's lane, as a chat.
func workSideChatStubSession(
  summary: AgentChatSessionSummary,
  mainSession: TerminalSessionSummary?
) -> TerminalSessionSummary {
  var session = makePersonalChatSessionStub(summary)
  session.laneName = mainSession?.laneName ?? ""
  if let toolType = mainSession?.toolType { session.toolType = toolType }
  return session
}

// MARK: - Marks

/// The small side-chat mark on a Work row, in the same family as the row's
/// goal and pin glyphs.
struct WorkSideChatPresenceMark: View {
  var font: Font = .caption2

  var body: some View {
    Image(systemName: workSideChatSymbol)
      .font(font.weight(.semibold))
      .foregroundStyle(workSideChatTint)
      .fixedSize()
      .accessibilityHidden(true)
  }
}

/// The same mark as a chat-header control that opens the side chat.
struct WorkSideChatHeaderButton: View {
  let onOpen: () -> Void

  var body: some View {
    Button {
      ADEHaptics.light()
      onOpen()
    } label: {
      WorkChatGlassCircleLabel(systemName: workSideChatSymbol, glyphSize: 16, tint: workSideChatTint)
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Open side chat")
    .accessibilityHint(workSideChatPresenceLabel)
    .accessibilityIdentifier("Work.Chat.Header.SideChat")
  }
}

/// The Side chat entry in the chat's floating Tools row. Only a chat that has
/// a side chat shows it.
struct WorkSideChatChip: View {
  let onOpen: () -> Void

  var body: some View {
    WorkComposerBadgeCapsule(
      tint: workSideChatTint,
      spacing: 6,
      accessibilityLabel: "Side chat. Tap to open.",
      onOpen: {
        ADEHaptics.light()
        onOpen()
      }
    ) {
      Image(systemName: workSideChatSymbol)
        .font(.system(size: 13, weight: .semibold))
      Text("Side chat")
        .font(.caption.weight(.semibold))
        .lineLimit(1)
    }
    .accessibilityIdentifier("Work.Chat.Tools.SideChat")
  }
}

/// Over a message the side chat sent to its main chat.
struct WorkSideChatFromLabel: View {
  var body: some View {
    HStack(spacing: 4) {
      Image(systemName: workSideChatSymbol)
      Text("From side chat")
    }
    .font(.caption2.weight(.semibold))
    .foregroundStyle(workSideChatTint)
    .accessibilityElement(children: .combine)
  }
}

// MARK: - Panel

/// What the side-chat panel shows.
enum WorkSideChatPanelState: Equatable {
  /// No side chat is shown: none was opened yet, or it was just ended.
  case closed
  /// `chat.startSideChat` is in flight (the brain forks the main chat's history).
  case starting(prompt: String)
  case open(sideSessionId: String, created: AgentChatSession?)
  case failed(String)
}

/// The side chat, slid up over its main chat nearly full height. A swipe down
/// only hides it; the X asks whether to hide it or end it for good.
struct WorkSideChatPanel: View {
  let state: WorkSideChatPanelState
  let mainSessionId: String
  let mainSession: TerminalSessionSummary?
  let mainSummary: AgentChatSessionSummary?
  let crossProjectContext: WorkChatCrossProjectContext?
  let lanes: [LaneSummary]
  let isLive: Bool
  /// Ends the side chat on its machine. Throws the brain's error.
  let onEnd: @MainActor () async throws -> Void
  #if DEBUG
  /// Fixture seam for `-adePreviewScreen side-chat`: a fixture transcript in
  /// place of the live chat, which needs a brain.
  var previewContent: AnyView?
  #endif

  @Environment(\.dismiss) private var dismiss
  @State private var closeDialogPresented = false
  @State private var ending = false
  @State private var endError: String?

  var body: some View {
    content
      .safeAreaInset(edge: .top, spacing: 0) { header }
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .presentationDetents([.large])
      .presentationDragIndicator(.visible)
      .alert(
        "Couldn't end the side chat",
        isPresented: Binding(get: { endError != nil }, set: { if !$0 { endError = nil } })
      ) {
        Button("OK", role: .cancel) {}
      } message: {
        Text(endError ?? "")
      }
  }

  @ViewBuilder
  private var content: some View {
    switch state {
    case .closed:
      Color.clear
    case .starting(let prompt):
      VStack(spacing: 12) {
        ProgressView()
        Text("Opening a side chat…")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        if !prompt.isEmpty {
          Text(prompt)
            .font(.footnote)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(4)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 32)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    case .failed(let message):
      VStack(spacing: 12) {
        Image(systemName: "exclamationmark.bubble")
          .font(.title3.weight(.semibold))
          .foregroundStyle(ADEColor.warning)
        Text("Couldn't open a side chat")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(message)
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
          .multilineTextAlignment(.center)
          .padding(.horizontal, 32)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    case .open(let sideSessionId, let created):
      #if DEBUG
      if let previewContent {
        previewContent
      } else {
        liveSideChat(sideSessionId: sideSessionId, created: created)
      }
      #else
      liveSideChat(sideSessionId: sideSessionId, created: created)
      #endif
    }
  }

  @ViewBuilder
  private func liveSideChat(sideSessionId: String, created: AgentChatSession?) -> some View {
      let summary = workSideChatStubSummary(
        sideSessionId: sideSessionId,
        mainSessionId: mainSessionId,
        created: created,
        mainSummary: mainSummary,
        mainSession: mainSession
      )
      WorkSessionDestinationView(
        sessionId: sideSessionId,
        initialOpeningPrompt: nil,
        initialSession: summary.map { workSideChatStubSession(summary: $0, mainSession: mainSession) },
        initialChatSummary: summary,
        transitionNamespace: nil,
        isLive: isLive,
        navigationChrome: .embedded,
        showsLaneActions: false,
        navigationTitleOverride: "Side chat",
        lanes: lanes,
        crossProjectContext: crossProjectContext,
        sideChatParentSessionId: mainSessionId
      )
      .equatable()
      .id(sideSessionId)
      .disabled(ending)
  }

  private var header: some View {
    HStack(alignment: .center, spacing: 10) {
      Image(systemName: workSideChatSymbol)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(workSideChatTint)
        .frame(width: 32, height: 32)
        .background(workSideChatTint.opacity(0.14), in: Circle())
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 1) {
        HStack(spacing: 6) {
          Text("Side chat")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text("read-only")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(ADEColor.textSecondary)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(ADEColor.textMuted.opacity(0.16), in: Capsule(style: .continuous))
        }
        Text("Knows this conversation")
          .font(.caption2)
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
          .truncationMode(.tail)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityElement(children: .combine)
      .accessibilityAddTraits(.isHeader)
      if ending {
        ProgressView()
          .frame(width: 44, height: 44)
      } else {
        Button {
          closeDialogPresented = true
        } label: {
          WorkChatGlassCircleLabel(systemName: "xmark", size: 36, glyphSize: 14)
        }
        .buttonStyle(.plain)
        .confirmationDialog(
          "Close the side chat?",
          isPresented: $closeDialogPresented,
          titleVisibility: .visible
        ) {
          Button("Hide") { dismiss() }
          if case .open = state {
            Button("End side chat", role: .destructive) {
              Task { await end() }
            }
          }
          Button("Cancel", role: .cancel) {}
        } message: {
          Text("Hide keeps it, and you can reopen it from Tools. Ending it deletes it and can't be undone.")
        }
        .accessibilityLabel("Close side chat")
        .accessibilityIdentifier("Work.SideChat.Close")
      }
    }
    .padding(.horizontal, 16)
    .padding(.top, 14)
    .padding(.bottom, 8)
    // Opaque: the side transcript scrolls under the header, and the title
    // must not sit on top of its text.
    .background(ADEColor.pageBackground)
    .overlay(alignment: .bottom) {
      Rectangle()
        .fill(ADEColor.textMuted.opacity(0.18))
        .frame(height: 0.5)
    }
  }

  @MainActor
  private func end() async {
    guard !ending else { return }
    ending = true
    defer { ending = false }
    do {
      try await onEnd()
      ADEHaptics.success()
      dismiss()
    } catch {
      ADEHaptics.error()
      endError = error.localizedDescription
    }
  }
}

// MARK: - Main chat side

extension WorkSessionDestinationView {
  /// This destination is the side chat itself, inside its main chat's panel.
  var isSideChatSurface: Bool {
    sideChatParentSessionId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
  }

  /// This chat's side chat right now, or nil. Never for a side chat.
  var currentSideChatSessionId: String? {
    guard !isSideChatSurface, !personalChat, !compactComposer else { return nil }
    return syncService.sideChatSessionId(forMainSession: sessionId, summary: composerChatSummary)
  }

  /// Why `/side` cannot open here, or nil when it can (desktop
  /// `sideChatUnavailableReason`).
  var sideChatUnavailableReason: String? {
    if isSideChatSurface { return workSideChatOfSideChatMessage }
    if personalChat || compactComposer { return workSideChatWorkOnlyMessage }
    let provider = composerChatSummary?.provider
      ?? workChatProviderFamilyFromToolType((session ?? initialSession)?.toolType)
    guard workProviderSupportsSideChat(provider) else { return workSideChatUnsupportedMessage }
    guard syncService.supportsSideChat(mainSessionId: sessionId) else {
      return "This machine's ADE doesn't support side chats yet. Update ADE there to use /side."
    }
    return nil
  }

  /// The composer offers `/side`: a Work chat whose provider can fork, on a
  /// brain that has the command.
  var offersSideChat: Bool {
    sideChatUnavailableReason == nil
  }

  /// Slides the panel up onto the chat's side chat (header mark, Tools chip).
  @MainActor
  func openSideChatPanel() {
    guard let sideId = currentSideChatSessionId else { return }
    syncService.adoptSideChatScope(sideSessionId: sideId, mainSessionId: sessionId)
    if case .open(let current, _) = sideChatPanelState, current == sideId {
      // Keep the creation answer the panel already has.
    } else {
      sideChatPanelState = .open(sideSessionId: sideId, created: nil)
    }
    sideChatPanelPresented = true
  }

  /// `/side` or `/side <prompt>` from this chat's composer. The panel slides up
  /// at once; the side chat is opened (or the prompt sent to the one it has)
  /// on the main chat's machine. False keeps the draft, as a failed send does.
  @MainActor
  func openSideChatFromComposer(prompt: String) async -> Bool {
    if let reason = sideChatUnavailableReason {
      ADEHaptics.error()
      errorMessage = reason
      return false
    }
    // A bare `/side` with a side chat already open needs no round-trip.
    if prompt.isEmpty, currentSideChatSessionId != nil {
      openSideChatPanel()
      return true
    }
    if let existing = currentSideChatSessionId {
      syncService.adoptSideChatScope(sideSessionId: existing, mainSessionId: sessionId)
      sideChatPanelState = .open(sideSessionId: existing, created: nil)
    } else {
      sideChatPanelState = .starting(prompt: prompt)
    }
    sideChatPanelPresented = true
    do {
      let result = try await syncService.startSideChat(mainSessionId: sessionId, text: prompt)
      if case .open(let current, _) = sideChatPanelState, current == result.session.sessionId {
        // Already showing it; the prompt arrives on its transcript.
      } else {
        sideChatPanelState = .open(sideSessionId: result.session.sessionId, created: result.session)
      }
      return true
    } catch {
      ADEHaptics.error()
      sideChatPanelState = .failed(error.localizedDescription)
      return false
    }
  }

  /// The panel the sheet presents.
  @MainActor
  var sideChatPanel: some View {
    WorkSideChatPanel(
      state: sideChatPanelState,
      mainSessionId: sessionId,
      mainSession: session ?? initialSession,
      mainSummary: composerChatSummary,
      crossProjectContext: crossProjectContext,
      lanes: lanes,
      isLive: isLive,
      onEnd: {
        let shownSideSessionId: String? = {
          if case .open(let sideId, _) = sideChatPanelState { return sideId }
          return nil
        }()
        try await syncService.endSideChat(mainSessionId: sessionId, expectedSideSessionId: shownSideSessionId)
        // A summary read that started before End still names the side chat.
        chatSummaryRefreshGeneration &+= 1
        // Once the pointer ages out, the lookup falls back to this view's
        // summaries, so none of them may still name the ended side chat.
        if let shownSideSessionId,
           var summary = composerChatSummary,
           summary.sideChatSessionId == shownSideSessionId {
          summary.sideChatSessionId = nil
          chatSummary = summary
          if var known = lastKnownChatSummary, known.sideChatSessionId == shownSideSessionId {
            known.sideChatSessionId = nil
            lastKnownChatSummary = known
          }
        }
        sideChatPanelState = .closed
      }
    )
    .environmentObject(syncService)
  }
}
