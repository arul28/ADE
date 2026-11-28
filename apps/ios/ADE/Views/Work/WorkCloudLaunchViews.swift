import SwiftUI

// A launch on ADE Cloud in the normal Work flow. A chat started on ADE Cloud
// has no session id until its new computer runs it. Until then it lists in
// Work as a launch row, and it opens as the launch's own chat page (the
// message, then the setup steps), the same way a chat starting in a new lane
// on a computer of your own does. When the chat runs, the page opens the real
// chat on its computer. A lane launch ("New computer" for a kept lane) shows
// the same setup card, with no message and no composer.

private let workCloudLaunchRoutePrefix = "ade-cloud-launch:"
/// The longest first line the row and the page title show.
private let workCloudLaunchTitleLimit = 72

/// The Work route id of a chat still starting on ADE Cloud. Never saved as the
/// open route or as seen: no machine knows it.
func workCloudLaunchRouteSessionId(_ launchId: String) -> String {
  workCloudLaunchRoutePrefix + launchId
}

/// The launch id behind a Work route id, or nil for a real chat.
func workCloudLaunchId(routeSessionId: String) -> String? {
  guard routeSessionId.hasPrefix(workCloudLaunchRoutePrefix) else { return nil }
  let id = String(routeSessionId.dropFirst(workCloudLaunchRoutePrefix.count))
  return id.isEmpty ? nil : id
}

/// The row and page title: the first line of the message, else the lane.
func workCloudLaunchTitle(_ entry: AccountCloudLaunchStore.Entry) -> String {
  let firstLine = entry.prompt
    .split(whereSeparator: \.isNewline)
    .first
    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) } ?? ""
  if !firstLine.isEmpty {
    return firstLine.count > workCloudLaunchTitleLimit
      ? String(firstLine.prefix(workCloudLaunchTitleLimit)) + "…"
      : firstLine
  }
  if let lane = nonEmptyTrimmed(entry.record?.laneName) ?? entry.laneName { return lane }
  return entry.isLane ? "New computer" : "New chat"
}

/// The provider the launch signs in to, in its own words.
@MainActor
func workCloudLaunchProviderLabel(_ entry: AccountCloudLaunchStore.Entry, catalog: CloudModelCatalog?) -> String {
  if let label = entry.record?.signIn?.label, !label.isEmpty { return label }
  let id = entry.provider ?? entry.record?.provider
  return catalog?.providers.first { $0.provider == id }?.label ?? (id.map { $0.capitalized } ?? "your provider")
}

/// The launch's setup steps; a start that failed failed at the computer.
func workCloudLaunchSteps(_ entry: AccountCloudLaunchStore.Entry) -> CloudSetupStepStates {
  var states = cloudSetupStepStates(entry.record)
  if entry.startError != nil { states.computer = .failed }
  return states
}

/// The step a launch is at, in the words of the row's status line.
func workCloudLaunchStatusLine(_ entry: AccountCloudLaunchStore.Entry, providerLabel: String) -> String {
  let record = entry.record
  if entry.cancelled { return entry.isLane ? "Stopped" : "Cancelled" }
  if entry.failed { return "Couldn't start" }
  if record?.state == "needs_approval" { return "Confirm the computer's sign-in" }
  if record?.state == "waiting_for_sign_in" { return "Sign in to \(providerLabel)" }
  let steps = workCloudLaunchSteps(entry)
  if entry.isLane {
    if record?.reachedRunning == true { return "Lane ready" }
    return steps.computer == .done ? "Checking out the branch" : "Starting the computer"
  }
  if record?.sessionId != nil || steps.send == .done { return "Opening the chat" }
  if steps.computer != .done { return "Starting the computer" }
  if steps.repo != .done { return "Cloning the repo" }
  return "Starting the agent"
}

/// The launch's steps as the segmented rail a launching row draws.
func workCloudLaunchRail(_ entry: AccountCloudLaunchStore.Entry) -> [ChatLaunchRailSegment] {
  let steps = workCloudLaunchSteps(entry)
  let laneReady = entry.record?.reachedRunning == true
  let states: [(String, CloudSetupStepState)] = entry.isLane
    ? [("computer", steps.computer), ("repo", steps.repo), ("lane", laneReady ? .done : steps.send)]
    : [("computer", steps.computer), ("repo", steps.repo), ("signIn", steps.signIn), ("send", steps.send)]
  return states.map { id, state in
    let status = workCloudStageStatus(state)
    return ChatLaunchRailSegment(id: id, status: status, fill: chatLaunchRailFill(status: status, percent: nil))
  }
}

/// A cloud setup step's state as the launch card's stage status.
func workCloudStageStatus(_ state: CloudSetupStepState) -> ChatLaunchStageStatus {
  switch state {
  case .todo: return .pending
  case .running, .waiting: return .running
  case .done: return .done
  case .failed: return .failed
  }
}

/// ms since 1970 as the ISO time the transcript views read.
func workCloudLaunchIso(ms: Double?) -> String? {
  guard let ms, ms > 0 else { return nil }
  return ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: ms / 1000))
}

/// When the launch started: the server's time, else when this phone first knew it.
func workCloudLaunchStartedAt(_ entry: AccountCloudLaunchStore.Entry) -> String {
  workCloudLaunchIso(ms: entry.record?.createdAt) ?? ISO8601DateFormatter().string(from: entry.startedAt)
}

// MARK: - Work row

/// A chat starting on ADE Cloud as one Work row: the provider mark, the
/// message's first line, the lane and the step it is at, and the setup rail.
struct WorkCloudLaunchRow: View {
  let entry: AccountCloudLaunchStore.Entry
  /// The Duo's (and an iPad's) wide sessions column.
  var duoRow: Bool = false
  var selected: Bool = false
  let onOpen: () -> Void
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @ObservedObject private var launches = AccountCloudLaunchStore.shared
  private var syncService: SyncService { syncPublishes.service }

  private var waitsForPerson: Bool { entry.record?.waitsForPerson == true }
  private var laneName: String {
    nonEmptyTrimmed(entry.record?.laneName) ?? entry.laneName ?? "New lane"
  }
  private var statusLine: String {
    workCloudLaunchStatusLine(entry, providerLabel: workCloudLaunchProviderLabel(entry, catalog: launches.catalog))
  }

  var body: some View {
    Button(action: onOpen) {
      HStack(alignment: .top, spacing: 10) {
        WorkProviderBareLogo(
          provider: entry.provider ?? entry.record?.provider,
          fallbackSymbol: entry.isLane ? "cloud" : "bubble.left.and.bubble.right",
          tint: ADEColor.accent,
          size: 20
        )
        .fixedSize()
        .padding(.top, 1)
        VStack(alignment: .leading, spacing: 3) {
          Text(workCloudLaunchTitle(entry))
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(duoRow ? 2 : 1)
            .truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
          HStack(spacing: 6) {
            HStack(spacing: 4) {
              Image(systemName: "cloud")
                .font(.caption2.weight(.semibold))
              Text(laneName)
                .font(.caption2)
                .lineLimit(1)
                .truncationMode(.tail)
            }
            .foregroundStyle(ADEColor.textMuted)
            .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 4) {
              if entry.failed || waitsForPerson {
                Image(systemName: entry.failed ? "exclamationmark.triangle.fill" : "hand.raised.fill")
                  .font(.caption2)
              } else {
                ProgressView().controlSize(.mini)
              }
              Text(statusLine)
                .font(.caption2.weight(.semibold))
                .lineLimit(1)
            }
            .foregroundStyle(entry.failed || waitsForPerson ? ADEColor.warning : ADEColor.textSecondary)
            .fixedSize()
          }
          if !entry.failed {
            WorkChatLaunchRowRail(segments: workCloudLaunchRail(entry))
          }
        }
      }
      .padding(.horizontal, duoRow ? 10 : 4)
      .padding(.vertical, duoRow ? 11 : 10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        selected ? ADEColor.accent.opacity(duoRow ? 0.14 : 0.12) : .clear,
        in: RoundedRectangle(cornerRadius: duoRow ? 14 : 12, style: .continuous)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .contextMenu {
      if entry.failed {
        if !entry.cancelled {
          Button {
            Task { await launches.retry(entry.launchId, using: syncService) }
          } label: {
            Label("Retry", systemImage: "arrow.clockwise")
          }
          .disabled(entry.body == nil && entry.record?.request == nil)
        }
        Button {
          launches.hide(entry.launchId)
        } label: {
          Label("Hide", systemImage: "eye.slash")
        }
      } else if entry.record?.reachedRunning == true || entry.record?.sessionId != nil {
        Button {
          launches.hide(entry.launchId)
        } label: {
          Label("Hide", systemImage: "eye.slash")
        }
      } else if entry.record != nil {
        Button(role: .destructive) {
          Task { _ = await launches.cancel(entry.launchId, using: syncService) }
        } label: {
          Label("Cancel", systemImage: "xmark.circle")
        }
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(workCloudLaunchTitle(entry)), \(Brand.cloudName), \(laneName), \(statusLine)")
    .accessibilityHint("Opens the chat's setup")
    .adeInspectable("Work.CloudLaunch.Row", metadata: ["launchId": entry.launchId])
  }
}

// MARK: - Launch page

/// The page of a chat starting on ADE Cloud. It is the same page as a chat
/// starting in a new lane of your own (`WorkChatLaunchPendingScreen`): the
/// message as your bubble, the messages you add meanwhile, the setup card,
/// and a composer whose sends wait for the agent. When the chat runs, it
/// opens the real chat on its computer in this page's place.
struct WorkCloudLaunchPendingScreen: View {
  let launchId: String
  var navigationChrome: WorkSessionNavigationChrome = .pushedDetail
  /// The Duo's column: Back clears the column's selection.
  var onBack: (() -> Void)? = nil
  /// Opens the running chat on its computer. False when it is not listed yet.
  let onChatReady: @MainActor (String) async -> Bool

  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @ObservedObject private var launches = AccountCloudLaunchStore.shared
  private var syncService: SyncService { syncPublishes.service }
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.dismiss) private var dismiss
  @State private var draft = ""
  @State private var sending = false
  @State private var composerFocused = false
  @State private var errorMessage: String?
  @State private var opening = false
  @State private var openFailed = false

  private var entry: AccountCloudLaunchStore.Entry? { launches.entries.first { $0.launchId == launchId } }
  /// The chat to open: a chat launch the computer runs.
  private var readyChatId: String? {
    guard let entry, !entry.isLane else { return nil }
    return entry.record?.sessionId
  }
  private var laterMessages: [CloudLaunchMessage] { launches.laterMessages[launchId] ?? [] }

  var body: some View {
    Group {
      if let entry {
        content(entry)
      } else {
        WorkChatOpeningSessionPlaceholder()
      }
    }
    .workSessionNavigationChrome(
      mode: navigationChrome,
      title: entry.map(workCloudLaunchTitle) ?? "New chat",
      subtitle: "\(Brand.cloudName)",
      onBack: onBack,
      trailingControls: { EmptyView() }
    )
    .task(id: readyChatId) { await openChat() }
    // The messages again when the launch moves on (the computer claims them).
    .task(id: "\(launchId)|\(entry?.record?.state ?? "")|\(entry?.record?.stages.count ?? 0)") {
      guard entry?.isLane == false else { return }
      await launches.loadMessages(launchId, using: syncService)
    }
    // Hide, here or on the launch's row: the page goes with it.
    .onChange(of: launches.isHidden(launchId)) { _, hidden in
      guard hidden else { return }
      if let onBack { onBack() } else { dismiss() }
    }
  }

  private func content(_ entry: AccountCloudLaunchStore.Entry) -> some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          if !entry.prompt.isEmpty {
            WorkChatMessageBubble(
              message: WorkChatMessage(
                id: "cloud-launch-prompt-\(entry.launchId)",
                role: "user",
                markdown: entry.prompt,
                timestamp: workCloudLaunchStartedAt(entry),
                turnId: nil,
                itemId: nil,
                attachments: nil
              ),
              maxUserBubbleWidth: 320,
              onOpenFullOutput: {}
            )
          }
          ForEach(laterMessages) { message in
            WorkChatLaunchQueuedMessageView(message: ChatLaunchQueuedMessage(
              id: message.messageId,
              text: message.text,
              createdAt: workCloudLaunchIso(ms: message.createdAt) ?? workCloudLaunchStartedAt(entry),
              deliveryError: message.state == "failed" ? (message.error ?? "\(Brand.cloudName) couldn't send it.") : nil
            ), retries: false)
            .transition(.opacity.combined(with: .move(edge: .bottom)))
          }
          if launches.messageReadFailed.contains(launchId) {
            HStack(spacing: 8) {
              Text("Couldn't read the messages you queued.")
                .font(.caption)
                .foregroundStyle(ADEColor.warning)
                .fixedSize(horizontal: false, vertical: true)
              Spacer(minLength: 4)
              WorkChatLaunchCapsuleButton(title: "Try again", symbol: "arrow.clockwise") {
                Task { await launches.loadMessages(launchId, using: syncService) }
              }
            }
          }
          WorkCloudLaunchSetupCard(entry: entry, opening: opening) {
            Task { await openChat() }
          }
          .id("cloud-launch-card")
          if openFailed {
            Text("The chat runs on \(Brand.cloudName), but this phone can't reach its computer yet. Tap Open chat to try again.")
              .font(.caption)
              .foregroundStyle(ADEColor.warning)
              .fixedSize(horizontal: false, vertical: true)
          }
          if let errorMessage {
            Text(errorMessage)
              .font(.caption)
              .foregroundStyle(ADEColor.warning)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 16)
        .animation(ADEMotion.standard(reduceMotion: reduceMotion), value: laterMessages)
      }
      // Open at the newest content, as a chat does, and keep it in view while the card grows.
      .defaultScrollAnchor(.bottom, for: .initialOffset)
      .defaultScrollAnchor(.bottom, for: .sizeChanges)
      .scrollDismissesKeyboard(.interactively)
      .onChange(of: laterMessages.count) { _, _ in
        withAnimation(ADEMotion.standard(reduceMotion: reduceMotion)) {
          proxy.scrollTo("cloud-launch-card", anchor: .bottom)
        }
      }
    }
    .adeScreenBackground()
    .environment(\.workChatProvider, entry.provider ?? entry.record?.provider)
    .environment(\.workChatModelId, entry.modelId ?? entry.record?.modelId)
    .safeAreaInset(edge: .bottom, spacing: 0) {
      if !entry.isLane {
        WorkChatLaunchQueueComposer(
          draft: $draft,
          focused: $composerFocused,
          hint: composerHint(entry),
          // Locked while the chat opens: the text already went to the chat as its draft.
          canType: entry.canQueueMessages && !opening,
          sending: sending,
          dictationTargetId: "cloud-launch-\(launchId)",
          onSend: { Task { await sendQueuedMessage() } }
        )
      }
    }
  }

  private func composerHint(_ entry: AccountCloudLaunchStore.Entry) -> String {
    if entry.cancelled { return "This chat was cancelled." }
    if entry.failed { return "Setup failed. Retry it to send your messages." }
    if entry.record?.sessionId != nil { return "The chat is running. It opens in a moment." }
    return "Messages you send now are queued and go out once the agent starts. You can close the app."
  }

  @MainActor
  private func sendQueuedMessage() async {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, !sending, !opening else { return }
    sending = true
    errorMessage = nil
    draft = ""
    if let refusal = await launches.addMessage(launchId, text: text, using: syncService) {
      ADEHaptics.error()
      draft = workChatLaunchRestoredDraft(text, typedSince: draft)
      errorMessage = "Couldn't send — \(refusal)"
    } else {
      ADEHaptics.light()
    }
    sending = false
    // The chat may have started during the send (a `chat_ready` refusal
    // reads the launch again): open it now, with the restored text as its draft.
    if readyChatId != nil { await openChat() }
  }

  /// Opens the running chat. A message still in the composer goes with it:
  /// the chat's composer starts with it, as its own saved draft.
  @MainActor
  private func openChat() async {
    // A send still out may hand its text back: the send opens the chat after it.
    guard let chatId = readyChatId, !opening, !sending else { return }
    opening = true
    openFailed = false
    let unsent = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    let chatDraftKey = WorkComposerDraftStore.chatKey(sessionId: chatId)
    if !unsent.isEmpty { WorkComposerDraftStore.save(draft, for: chatDraftKey) }
    let opened = await onChatReady(chatId)
    if !unsent.isEmpty {
      if opened { draft = "" } else { WorkComposerDraftStore.clear(chatDraftKey) }
    }
    guard !Task.isCancelled else {
      opening = false
      return
    }
    opening = false
    openFailed = !opened
  }
}

// MARK: - Setup card

/// The setup card of a launch on ADE Cloud, drawn with the parts of the launch
/// card a chat starting in a new lane of your own shows
/// (`WorkChatLaunchSetupCard`): the header with its time and lane, the
/// segmented rail, one row per step, and the actions under a hairline. The
/// sign-in step holds what the person does for it. Work's launch page and a
/// kept lane's "New computer" on Lanes both show it.
struct WorkCloudLaunchSetupCard: View {
  let entry: AccountCloudLaunchStore.Entry
  var opening = false
  var onOpenChat: () -> Void = {}

  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @ObservedObject private var launches = AccountCloudLaunchStore.shared
  private var syncService: SyncService { syncPublishes.service }
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.openURL) private var openURL
  @State private var busy: String?
  @State private var cancelError: String?
  @State private var cancelConfirmationPresented = false

  private var record: CloudLaunchRecord? { entry.record }
  private var steps: CloudSetupStepStates { workCloudLaunchSteps(entry) }
  /// A chat launch is done once its chat exists; a lane launch once its computer has the lane.
  private var running: Bool { record?.sessionId != nil || record?.reachedRunning == true }
  private var providerLabel: String { workCloudLaunchProviderLabel(entry, catalog: launches.catalog) }
  private var laneName: String { nonEmptyTrimmed(record?.laneName) ?? entry.laneName ?? "" }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
      WorkChatLaunchProgressRail(segments: workCloudLaunchRail(entry))
        .padding(.top, 12)
        .padding(.bottom, 4)
      VStack(alignment: .leading, spacing: 0) {
        stepLine("cloud", "Start computer", steps.computer, detail: record?.state == "needs_approval" ? "Waiting for you" : nil)
        if record?.state == "needs_approval", let link = record?.approvalUrl.flatMap(URL.init(string:)) {
          HStack(spacing: 8) {
            Text("Confirm the computer's sign-in to your account.")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            WorkChatLaunchCapsuleButton(title: "Confirm", symbol: "checkmark", primary: true) { openURL(link) }
          }
          .padding(.leading, 32)
          .padding(.bottom, 8)
        }
        WorkChatLaunchHairline()
        if entry.isLane {
          stepLine("arrow.triangle.branch", "Check out the branch", steps.repo)
          WorkChatLaunchHairline()
          stepLine("checkmark", "Lane ready", running ? .done : steps.send)
        } else {
          stepLine("icloud.and.arrow.down", "Clone repository", steps.repo)
          WorkChatLaunchHairline()
          stepLine("person.badge.key", "Sign in to \(providerLabel)", steps.signIn,
                   detail: steps.signIn == .waiting ? "Waiting for you" : nil)
          if steps.signIn == .waiting, let signIn = record?.signIn {
            CloudSignInStepDetail(signIn: signIn, instanceId: record?.instanceId) {
              await launches.refresh(entry.launchId, using: syncService)
            }
            .padding(.leading, 32)
            .padding(.bottom, 8)
          }
          WorkChatLaunchHairline()
          stepLine("sparkles", "Start agent", steps.send)
        }
      }
      if let note {
        Text(note)
          .font(.caption)
          .foregroundStyle(entry.failed && !entry.cancelled ? ADEColor.warning : ADEColor.textMuted)
          .fixedSize(horizontal: false, vertical: true)
          .textSelection(.enabled)
          .padding(.top, 8)
      }
      if let cancelError {
        Text("\(entry.isLane ? "The computer wasn't stopped." : "The chat wasn't cancelled.") \(cancelError)")
          .font(.caption)
          .foregroundStyle(ADEColor.warning)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.top, 8)
      }
      footer
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .adeGlassCard(cornerRadius: 16, padding: 14)
    .overlay {
      if entry.failed && !entry.cancelled {
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .strokeBorder(ADEColor.warning.opacity(0.28), lineWidth: 1)
          .allowsHitTesting(false)
      }
    }
    .animation(ADEMotion.quick(reduceMotion: reduceMotion), value: record)
    .confirmationDialog(
      entry.isLane ? "Stop making this computer?" : "Cancel this chat?",
      isPresented: $cancelConfirmationPresented,
      titleVisibility: .visible
    ) {
      Button(entry.isLane ? "Stop it" : "Cancel chat", role: .destructive) {
        busy = "cancel"
        cancelError = nil
        Task {
          cancelError = await launches.cancel(entry.launchId, using: syncService)
          busy = nil
        }
      }
      Button("Keep", role: .cancel) {}
    } message: {
      Text(entry.isLane
        ? "\(Brand.cloudName) deletes the new computer. The lane stays."
        : "\(Brand.cloudName) deletes the new computer. Your messages are not sent.")
    }
    .accessibilityElement(children: .contain)
  }

  /// The line under the steps: why it failed or stopped, else what happens
  /// next on a lane launch (a chat launch says it above its composer).
  private var note: String? {
    if entry.cancelled {
      return entry.isLane ? "Making this computer was stopped." : "This chat was cancelled. Its messages were not sent."
    }
    if entry.failed { return entry.startError ?? record?.error ?? "\(Brand.cloudName) didn't say why." }
    guard entry.isLane else { return nil }
    return running
      ? "It lists with your lanes again, on the same branch."
      : "You can close the app. \(Brand.cloudName) finishes the computer on its own."
  }

  // MARK: Header

  private var phaseStatus: ChatLaunchStageStatus {
    if entry.cancelled { return .skipped }
    if entry.failed { return .failed }
    if running { return .done }
    return .running
  }

  private var title: String {
    if entry.isLane {
      if entry.cancelled { return "Computer stopped" }
      if entry.failed { return "Couldn't make the computer" }
      if running { return "Lane ready" }
      return "Making a new computer"
    }
    if entry.cancelled { return "Chat cancelled" }
    if entry.failed { return "Couldn't start the chat" }
    if record?.sessionId != nil { return "Opening the chat" }
    if record?.state == "needs_approval" { return "Confirm the computer" }
    if record?.state == "waiting_for_sign_in" { return "Sign in to \(providerLabel) to go on" }
    return "Setting up \(Brand.cloudName)"
  }

  private var headerSymbol: String {
    if entry.cancelled { return "minus" }
    if entry.failed { return "exclamationmark.triangle.fill" }
    return running ? "checkmark" : "cloud"
  }

  private var header: some View {
    HStack(alignment: .top, spacing: 10) {
      WorkChatLaunchStageTile(symbol: headerSymbol, status: phaseStatus, size: 26)
      VStack(alignment: .leading, spacing: 6) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(entry.failed && !entry.cancelled ? ADEColor.warning : ADEColor.textPrimary)
            .lineLimit(1)
            .contentTransition(.opacity)
          Spacer(minLength: 8)
          // Only while it runs: ADE Cloud keeps no end time to measure a finished one to.
          if !entry.failed && !running {
            WorkChatLaunchDurationText(startedAt: workCloudLaunchStartedAt(entry), endedAt: nil, isLive: true)
              .accessibilityLabel("Elapsed")
          }
        }
        HStack(spacing: 6) {
          if !laneName.isEmpty {
            WorkChatLaunchChip {
              WorkLaneLogoMark(color: WorkChatLaunchTone.running, size: 9)
              Text(laneName)
                .lineLimit(1)
                .truncationMode(.middle)
            }
            .layoutPriority(1)
            .accessibilityLabel("Lane \(laneName)")
          }
          WorkChatLaunchChip {
            Image(systemName: "cloud")
              .font(.system(size: 8, weight: .semibold))
              .foregroundStyle(ADEColor.textMuted)
            Text(Brand.cloudName)
              .lineLimit(1)
          }
        }
      }
    }
  }

  // MARK: Steps

  private func stepLine(_ symbol: String, _ label: String, _ state: CloudSetupStepState, detail: String? = nil) -> some View {
    WorkChatLaunchStageLine(symbol: symbol, status: workCloudStageStatus(state), label: label, detail: detail)
      .accessibilityElement(children: .combine)
  }

  // MARK: Actions

  @ViewBuilder
  private var footer: some View {
    let canCancel = !entry.failed && !running && record != nil
    let canRetry = entry.failed && !entry.cancelled
    let canOpen = running && !entry.isLane && record?.sessionId != nil
    let canHide = entry.failed || (running && entry.isLane)
    if canCancel || canRetry || canOpen || canHide {
      VStack(alignment: .leading, spacing: 0) {
        WorkChatLaunchHairline()
          .padding(.top, 8)
        HStack(spacing: 6) {
          Spacer(minLength: 0)
          if canOpen {
            WorkChatLaunchCapsuleButton(
              title: opening ? "Opening…" : "Open chat",
              symbol: "bubble.left.and.bubble.right",
              primary: true,
              busy: opening,
              action: onOpenChat
            )
          }
          if canRetry {
            WorkChatLaunchCapsuleButton(title: "Retry", symbol: "arrow.clockwise", primary: true, busy: busy == "retry") {
              busy = "retry"
              Task {
                await launches.retry(entry.launchId, using: syncService)
                busy = nil
              }
            }
            .disabled(entry.body == nil && record?.request == nil)
          }
          if canHide {
            WorkChatLaunchCapsuleButton(title: "Hide", symbol: "eye.slash") { launches.hide(entry.launchId) }
          }
          if canCancel {
            WorkChatLaunchCapsuleButton(
              title: entry.isLane ? "Stop" : "Cancel",
              symbol: "xmark",
              busy: busy == "cancel"
            ) {
              cancelConfirmationPresented = true
            }
          }
        }
        .disabled(busy != nil)
        .padding(.top, 6)
      }
    }
  }
}
