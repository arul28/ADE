import SwiftUI
import UIKit

// ADE Cloud inside the normal Work flow: the setup card of a chat started on
// ADE Cloud (Computer started -> Cloned repo -> Sign in -> Send your
// message), the provider sign-in step a launch or a woken chat waits on, and
// the lines a cloud lane's chat shows about its computer (asleep, waking,
// refused, deleting soon). Nothing here wakes a computer by being shown.

/// What a model whose sign-in happens only in ADE desktop says (Antigravity
/// and every `remoteSignIn == "desktop"` provider). The login carries from
/// the desktop to ADE Cloud, so the model stays selectable.
func cloudDesktopSignInSentence(label: String) -> String {
  "Sign in to \(label) in ADE on your computer once. ADE Cloud then uses that sign-in."
}

struct WorkCloudLaunchCard: View {
  let entry: AccountCloudLaunchStore.Entry
  /// False on the launch's own chat page, where the message shows as its bubble.
  var showsPrompt: Bool = true
  /// The chat is running: open the project, where the chat lists.
  var onOpenChat: () -> Void = {}
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @ObservedObject private var launches = AccountCloudLaunchStore.shared
  private var syncService: SyncService { syncPublishes.service }
  @State private var retrying = false
  @State private var cancelling = false
  @State private var cancelError: String?
  @Environment(\.openURL) private var openURL

  private var record: CloudLaunchRecord? { entry.record }
  private var steps: CloudSetupStepStates {
    var states = cloudSetupStepStates(record)
    if entry.startError != nil { states.computer = .failed }
    return states
  }
  private var failed: Bool { entry.startError != nil || record?.failed == true }
  private var running: Bool { record?.sessionId != nil || record?.state == "running" || record?.state == "done" }
  private var providerLabel: String {
    if let label = record?.signIn?.label, !label.isEmpty { return label }
    let id = entry.provider ?? record?.provider
    return launches.catalog?.providers.first { $0.provider == id }?.label ?? (id.map { $0.capitalized } ?? "your provider")
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(title)
        .font(.system(size: 14.5, weight: .semibold))
        .foregroundStyle(ADEColor.textPrimary)

      VStack(alignment: .leading, spacing: 2) {
        stepRow("Computer started", steps.computer)
        if record?.state == "needs_approval", let link = record?.approvalUrl.flatMap(URL.init(string:)) {
          HStack(spacing: 8) {
            Text("Confirm the computer's sign-in to your account.")
              .font(.system(size: 12))
              .foregroundStyle(ADEColor.textSecondary)
            Button("Confirm") { openURL(link) }
              .buttonStyle(ADEKitButtonStyle())
          }
          .padding(.leading, 30)
          .padding(.vertical, 4)
        }
        if entry.isLane {
          // A lane alone (a kept lane's new computer): no sign-in, no message.
          stepRow("Checked out \(laneBranch ?? "its branch")", steps.repo)
          // Running: the computer has the lane and lists it (the title says so too).
          stepRow("Lane ready", running ? .done : steps.send)
        } else {
          stepRow("Cloned repo", steps.repo)
          stepRow("Sign in to \(providerLabel)", steps.signIn)
          if steps.signIn == .waiting, let signIn = record?.signIn {
            CloudSignInStepDetail(signIn: signIn, instanceId: record?.instanceId) {
              await launches.refresh(entry.launchId, using: syncService)
            }
              .padding(.leading, 30)
              .padding(.vertical, 6)
          }
          stepRow("Send your message", steps.send)
        }
      }

      if showsPrompt, !entry.prompt.isEmpty {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(entry.prompt)
            .font(.system(size: 13.5))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(3)
          Spacer(minLength: 6)
          ADEKitTag(text: messageTag.text, tone: messageTag.tone)
        }
        .padding(10)
        .background(ADEColor.textPrimary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      }

      if failed {
        VStack(alignment: .leading, spacing: 8) {
          Text("\(entry.startError ?? record?.error ?? "ADE Cloud didn't say why.")\(entry.isLane ? "" : " Your message is not sent.")")
            .font(.system(size: 13))
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
          HStack(spacing: 8) {
            Button {
              retrying = true
              Task {
                await launches.retry(entry.launchId, using: syncService)
                retrying = false
              }
            } label: {
              if retrying { ProgressView().controlSize(.small) } else { Text("Retry") }
            }
            .buttonStyle(ADEKitButtonStyle(tone: .crit))
            .disabled(retrying || (entry.body == nil && entry.record?.request == nil))
            Button("Hide") { launches.hide(entry.launchId) }
              .buttonStyle(ADEKitButtonStyle())
              .disabled(retrying)
          }
        }
      } else if running && entry.isLane {
        HStack(spacing: 8) {
          Text("It lists with your lanes again, on the same branch.")
            .font(.system(size: 12))
            .foregroundStyle(ADEColor.textSecondary)
          Spacer(minLength: 4)
          Button("Hide") { launches.hide(entry.launchId) }
            .buttonStyle(ADEKitButtonStyle())
        }
      } else if running {
        HStack(spacing: 8) {
          if record?.sessionId != nil {
            Button("Open chat", action: onOpenChat)
              .buttonStyle(ADEKitButtonStyle(prominent: true))
          } else {
            ProgressView().controlSize(.small)
            Text("Opening the chat…")
              .font(.system(size: 12))
              .foregroundStyle(ADEColor.textSecondary)
          }
          Button("Hide") { launches.hide(entry.launchId) }
            .buttonStyle(ADEKitButtonStyle())
        }
      } else {
        Text(entry.isLane
          ? "You can close the app. ADE Cloud finishes the computer on its own."
          : "You can close the app. ADE Cloud keeps your message and sends it when the agent is ready.")
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize(horizontal: false, vertical: true)
        if record != nil, record?.state != "cancelled" {
          Button {
            cancelling = true
            cancelError = nil
            Task {
              cancelError = await launches.cancel(entry.launchId, using: syncService)
              cancelling = false
            }
          } label: {
            if cancelling { ProgressView().controlSize(.small) } else { Text("Cancel") }
          }
          .buttonStyle(ADEKitButtonStyle())
          .disabled(cancelling)
        }
        if let cancelError {
          Text("The chat wasn't cancelled. \(cancelError)")
            .font(.system(size: 12))
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
    .padding(14)
    .adeKitCard(padding: nil)
  }

  /// The lane's name on a lane launch: the record's, else the one this phone sent.
  private var laneName: String { nonEmptyTrimmed(record?.laneName) ?? entry.laneName ?? "the lane" }

  /// The branch a lane launch works on, from the start it sent.
  private var laneBranch: String? {
    guard case .object(let fields)? = entry.body ?? record?.request,
          case .object(let lane)? = fields["lane"],
          case .string(let branch)? = lane["existingBranch"] else { return nil }
    return branch.hasPrefix("origin/") ? String(branch.dropFirst("origin/".count)) : branch
  }

  private var title: String {
    if entry.isLane {
      if failed { return "ADE Cloud couldn't make a computer for \(laneName)" }
      if running { return "\(laneName) has a new computer" }
      return "Making a new computer for \(laneName)"
    }
    if failed { return "ADE Cloud couldn't start this chat" }
    if running { return "The chat is running" }
    if record?.state == "waiting_for_sign_in" { return "Sign in to \(providerLabel) to go on" }
    return "Setting up ADE Cloud"
  }

  private var messageTag: (text: String, tone: ADEKitTone) {
    if failed { return ("Not sent", .crit) }
    if steps.send == .done { return ("Sent", .ok) }
    return ("Waiting", .neutral)
  }

  private func stepRow(_ label: String, _ state: CloudSetupStepState) -> some View {
    HStack(spacing: 10) {
      stepIcon(state)
        .frame(width: 20, height: 20)
      Text(label)
        .font(.system(size: 14))
        .foregroundStyle(state == .todo ? ADEColor.textSecondary : ADEColor.textPrimary)
      Spacer(minLength: 0)
    }
    .frame(minHeight: 34)
    .accessibilityElement(children: .combine)
    .accessibilityValue(stateWord(state))
  }

  @ViewBuilder
  private func stepIcon(_ state: CloudSetupStepState) -> some View {
    switch state {
    case .done:
      Image(systemName: "checkmark.circle.fill").foregroundStyle(ADEColor.success)
    case .failed:
      Image(systemName: "xmark.circle.fill").foregroundStyle(ADEColor.danger)
    case .running:
      ProgressView().controlSize(.small)
    case .waiting:
      Image(systemName: "hand.raised.circle.fill").foregroundStyle(ADEColor.warning)
    case .todo:
      Image(systemName: "circle").foregroundStyle(ADEColor.textMuted)
    }
  }

  private func stateWord(_ state: CloudSetupStepState) -> String {
    switch state {
    case .done: return "Done"
    case .failed: return "Failed"
    case .running: return "In progress"
    case .waiting: return "Waiting for you"
    case .todo: return "Not started"
    }
  }
}

// MARK: - A chat starting on ADE Cloud, in the Work list

// A chat started on ADE Cloud has no session id until its new computer runs
// it. Until then it lists in Work as a launch row, and it opens as the
// launch's own chat page (the message, then the setup steps), the same way a
// chat starting in a new lane on a computer of your own does. When the chat
// runs, the page opens the real chat on its computer.

private let workCloudLaunchRoutePrefix = "ade-cloud-launch:"

/// The Work route id of a chat still starting on ADE Cloud. Never saved as the
/// open route: no machine knows it.
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
    return firstLine.count > 72 ? String(firstLine.prefix(72)) + "…" : firstLine
  }
  if let lane = nonEmptyTrimmed(entry.record?.laneName) ?? entry.laneName { return lane }
  return entry.isLane ? "New computer" : "New chat"
}

/// The step a launch is at, in the words of the row's status line.
func workCloudLaunchStatusLine(_ entry: AccountCloudLaunchStore.Entry, providerLabel: String) -> String {
  let record = entry.record
  if entry.startError != nil || record?.failed == true { return "Couldn't start" }
  if record?.state == "needs_approval" { return "Confirm the computer's sign-in" }
  if record?.state == "waiting_for_sign_in" { return "Sign in to \(providerLabel)" }
  let steps = cloudSetupStepStates(record)
  if entry.isLane {
    if record?.state == "running" || record?.state == "done" { return "Lane ready" }
    return steps.computer == .done ? "Checking out the branch" : "Starting the computer"
  }
  if record?.sessionId != nil || steps.send == .done { return "Opening the chat" }
  if steps.computer != .done { return "Starting the computer" }
  if steps.repo != .done { return "Cloning the repo" }
  return "Starting the agent"
}

/// The launch's steps as the segmented rail a launching row draws.
func workCloudLaunchRail(_ entry: AccountCloudLaunchStore.Entry) -> [ChatLaunchRailSegment] {
  var steps = cloudSetupStepStates(entry.record)
  if entry.startError != nil { steps.computer = .failed }
  let running = entry.record?.state == "running" || entry.record?.state == "done"
  let states: [(String, CloudSetupStepState)] = entry.isLane
    ? [("computer", steps.computer), ("repo", steps.repo), ("lane", running ? .done : steps.send)]
    : [("computer", steps.computer), ("repo", steps.repo), ("signIn", steps.signIn), ("send", steps.send)]
  return states.map { id, state in
    let status = workCloudStageStatus(state)
    return ChatLaunchRailSegment(id: id, status: status, fill: chatLaunchRailFill(status: status, percent: nil))
  }
}

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

  private var failed: Bool { entry.startError != nil || entry.record?.failed == true }
  private var waitsForPerson: Bool {
    entry.record?.state == "waiting_for_sign_in" || entry.record?.state == "needs_approval"
  }
  private var running: Bool { entry.record?.state == "running" || entry.record?.state == "done" }
  private var providerLabel: String {
    if let label = entry.record?.signIn?.label, !label.isEmpty { return label }
    let id = entry.provider ?? entry.record?.provider
    return launches.catalog?.providers.first { $0.provider == id }?.label ?? (id.map { $0.capitalized } ?? "your provider")
  }
  private var laneName: String {
    nonEmptyTrimmed(entry.record?.laneName) ?? entry.laneName ?? "New lane"
  }
  private var statusLine: String { workCloudLaunchStatusLine(entry, providerLabel: providerLabel) }
  private var statusTint: Color {
    if failed { return ADEColor.warning }
    if waitsForPerson { return ADEColor.warning }
    return ADEColor.textSecondary
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
              if failed || waitsForPerson {
                Image(systemName: failed ? "exclamationmark.triangle.fill" : "hand.raised.fill")
                  .font(.caption2)
              } else if !running || entry.record?.sessionId == nil || !entry.isLane {
                ProgressView().controlSize(.mini)
              }
              Text(statusLine)
                .font(.caption2.weight(.semibold))
                .lineLimit(1)
            }
            .foregroundStyle(statusTint)
            .fixedSize()
          }
          if !failed {
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
      if failed {
        Button {
          Task { await launches.retry(entry.launchId, using: syncService) }
        } label: {
          Label("Retry", systemImage: "arrow.clockwise")
        }
        .disabled(entry.body == nil && entry.record?.request == nil)
        Button {
          launches.hide(entry.launchId)
        } label: {
          Label("Hide", systemImage: "eye.slash")
        }
      } else if running {
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
    .accessibilityLabel("\(workCloudLaunchTitle(entry)), ADE Cloud, \(laneName), \(statusLine)")
    .accessibilityHint("Opens the chat's setup")
    .adeInspectable("Work.CloudLaunch.Row", metadata: ["launchId": entry.launchId])
  }
}

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
  @State private var draft = ""
  @State private var sending = false
  @State private var composerFocused = false
  @State private var noAttachments: [WorkChatInputAttachment] = []
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
      subtitle: "ADE Cloud",
      onBack: onBack,
      trailingControls: { EmptyView() }
    )
    .task(id: readyChatId) { await openChat() }
    // The messages again when the launch moves on (the computer claims them).
    .task(id: "\(launchId)|\(entry?.record?.state ?? "")|\(entry?.record?.stages.count ?? 0)") {
      guard entry?.isLane == false else { return }
      await launches.loadMessages(launchId, using: syncService)
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
              deliveryError: message.state == "failed" ? (message.error ?? "ADE Cloud couldn't send it.") : nil
            ))
            .transition(.opacity.combined(with: .move(edge: .bottom)))
          }
          WorkCloudLaunchSetupCard(entry: entry, opening: opening) {
            Task { await openChat() }
          }
          .id("cloud-launch-card")
          if openFailed {
            Text("The chat runs on ADE Cloud, but this phone can't reach its computer yet. Tap Open chat to try again.")
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
        composer(entry)
      }
    }
  }

  // MARK: Composer

  /// Sends wait on ADE Cloud until the agent runs, as on a launch of your own.
  private func canType(_ entry: AccountCloudLaunchStore.Entry) -> Bool {
    entry.startError == nil && entry.record?.inProgress == true
  }

  private func composer(_ entry: AccountCloudLaunchStore.Entry) -> some View {
    let open = canType(entry)
    let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    return VStack(alignment: .leading, spacing: 6) {
      Text(composerHint(entry))
        .font(.caption2)
        .foregroundStyle(ADEColor.textMuted)
        .padding(.horizontal, 4)
      ADEPlainGlassComposer(
        text: $draft,
        isFocused: $composerFocused,
        attachments: $noAttachments,
        placeholder: "Message",
        acceptsPastedImages: false,
        sendEnabled: open && !trimmed.isEmpty && !sending,
        sending: sending,
        sendAccessibilityLabel: "Queue message",
        disabledSendAccessibilityLabel: "Enter a message to queue",
        dictationTargetId: "cloud-launch-\(launchId)",
        onSend: { Task { await sendQueuedMessage() } },
        menu: { startDictation in
          Menu {
            if SpeechDictationService.isAvailable {
              Button(action: startDictation) {
                Label("Dictate", systemImage: "mic")
              }
            }
          } label: {
            Image(systemName: "ellipsis")
              .font(.system(size: 15, weight: .semibold))
              .foregroundStyle(ADEColor.textSecondary)
              .frame(width: 36, height: 36)
              .contentShape(Circle())
              .frame(minWidth: 44, minHeight: 44)
          }
          .disabled(!open || !SpeechDictationService.isAvailable)
          .accessibilityLabel("Composer options")
        },
        controls: { EmptyView() }
      )
      .disabled(!open)
      .accessibilityHint("Queued until the agent starts")
    }
    .padding(.horizontal, 12)
    .padding(.top, 6)
    .padding(.bottom, 8)
    .workLaunchComposerScrollEdge()
  }

  private func composerHint(_ entry: AccountCloudLaunchStore.Entry) -> String {
    if entry.record?.state == "cancelled" { return "This chat was cancelled." }
    if entry.startError != nil || entry.record?.failed == true { return "Setup failed. Retry it to send your messages." }
    if entry.record?.sessionId != nil { return "The chat is running. It opens in a moment." }
    return "Messages you send now are queued and go out once the agent starts. You can close the app."
  }

  @MainActor
  private func sendQueuedMessage() async {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, !sending else { return }
    sending = true
    errorMessage = nil
    draft = ""
    defer { sending = false }
    if let refusal = await launches.addMessage(launchId, text: text, using: syncService) {
      ADEHaptics.error()
      let typedSince = draft.trimmingCharacters(in: .whitespacesAndNewlines)
      draft = typedSince.isEmpty ? text : "\(text)\n\n\(draft)"
      errorMessage = "Couldn't send — \(refusal)"
    } else {
      ADEHaptics.light()
    }
  }

  @MainActor
  private func openChat() async {
    guard let chatId = readyChatId, !opening else { return }
    opening = true
    openFailed = false
    let opened = await onChatReady(chatId)
    guard !Task.isCancelled else {
      opening = false
      return
    }
    opening = false
    openFailed = !opened
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

/// The setup card of a chat starting on ADE Cloud, drawn with the parts of
/// the launch card a chat starting in a new lane of your own shows
/// (`WorkChatLaunchSetupCard`): the header with its time and lane, the
/// segmented rail, one row per step, and the actions under a hairline. The
/// sign-in step holds what the person does for it.
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
  private var steps: CloudSetupStepStates {
    var states = cloudSetupStepStates(record)
    if entry.startError != nil { states.computer = .failed }
    return states
  }
  private var failed: Bool { entry.startError != nil || record?.failed == true }
  private var running: Bool { record?.sessionId != nil || record?.state == "running" || record?.state == "done" }
  private var providerLabel: String {
    if let label = record?.signIn?.label, !label.isEmpty { return label }
    let id = entry.provider ?? record?.provider
    return launches.catalog?.providers.first { $0.provider == id }?.label ?? (id.map { $0.capitalized } ?? "your provider")
  }
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
            capsuleButton("Confirm", symbol: "checkmark", primary: true) { openURL(link) }
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
      if failed {
        Text(entry.startError ?? record?.error ?? "ADE Cloud didn't say why.")
          .font(.caption)
          .foregroundStyle(ADEColor.warning)
          .fixedSize(horizontal: false, vertical: true)
          .textSelection(.enabled)
          .padding(.top, 8)
      }
      if let cancelError {
        Text("The chat wasn't cancelled. \(cancelError)")
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
      if failed {
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
        ? "ADE Cloud deletes the new computer. The lane stays."
        : "ADE Cloud deletes the new computer. Your messages are not sent.")
    }
    .accessibilityElement(children: .contain)
  }

  // MARK: Header

  private var phaseStatus: ChatLaunchStageStatus {
    if failed { return .failed }
    if running { return .done }
    return .running
  }

  private var title: String {
    if entry.isLane {
      if failed { return "Couldn't make the computer" }
      if running { return "Lane ready" }
      return "Making a new computer"
    }
    if failed { return "Couldn't start the chat" }
    if record?.sessionId != nil { return "Opening the chat" }
    if record?.state == "needs_approval" { return "Confirm the computer" }
    if record?.state == "waiting_for_sign_in" { return "Sign in to \(providerLabel) to go on" }
    return "Setting up ADE Cloud"
  }

  private var header: some View {
    HStack(alignment: .top, spacing: 10) {
      WorkChatLaunchStageTile(
        symbol: failed ? "exclamationmark.triangle.fill" : running ? "checkmark" : "cloud",
        status: phaseStatus,
        size: 26
      )
      VStack(alignment: .leading, spacing: 6) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(failed ? ADEColor.warning : ADEColor.textPrimary)
            .lineLimit(1)
            .contentTransition(.opacity)
          Spacer(minLength: 8)
          WorkChatLaunchDurationText(
            startedAt: workCloudLaunchStartedAt(entry),
            endedAt: nil,
            isLive: !failed && !running
          )
          .accessibilityLabel("Elapsed")
        }
        HStack(spacing: 6) {
          if !laneName.isEmpty {
            chip(mono: false) {
              WorkLaneLogoMark(color: WorkChatLaunchTone.running, size: 9)
              Text(laneName)
                .lineLimit(1)
                .truncationMode(.middle)
            }
            .layoutPriority(1)
            .accessibilityLabel("Lane \(laneName)")
          }
          chip(mono: false) {
            Image(systemName: "cloud")
              .font(.system(size: 8, weight: .semibold))
              .foregroundStyle(ADEColor.textMuted)
            Text("ADE Cloud")
              .lineLimit(1)
          }
        }
      }
    }
  }

  private func chip<Content: View>(mono: Bool, @ViewBuilder _ content: () -> Content) -> some View {
    HStack(spacing: 4) {
      content()
    }
    .font(mono ? .caption2.monospaced() : .caption2.weight(.medium))
    .foregroundStyle(ADEColor.textSecondary)
    .padding(.horizontal, 7)
    .padding(.vertical, 2.5)
    .background(ADEColor.recessedBackground.opacity(0.5), in: Capsule(style: .continuous))
    .overlay(Capsule(style: .continuous).strokeBorder(ADEColor.glassBorder, lineWidth: 1))
  }

  // MARK: Steps

  private func stepLine(_ symbol: String, _ label: String, _ state: CloudSetupStepState, detail: String? = nil) -> some View {
    WorkChatLaunchStageLine(symbol: symbol, status: workCloudStageStatus(state), label: label, detail: detail)
      .accessibilityElement(children: .combine)
  }

  // MARK: Actions

  @ViewBuilder
  private var footer: some View {
    let canCancel = !failed && !running && record != nil && record?.state != "cancelled"
    let canRetry = failed && record?.state != "cancelled"
    if canCancel || canRetry || running || failed {
      VStack(alignment: .leading, spacing: 0) {
        WorkChatLaunchHairline()
          .padding(.top, 8)
        HStack(spacing: 6) {
          Spacer(minLength: 0)
          if running && !entry.isLane && record?.sessionId != nil {
            capsuleButton(opening ? "Opening…" : "Open chat", symbol: "bubble.left.and.bubble.right", primary: true, busy: opening, action: onOpenChat)
          }
          if canRetry {
            capsuleButton("Retry", symbol: "arrow.clockwise", primary: true, busy: busy == "retry") {
              busy = "retry"
              Task {
                await launches.retry(entry.launchId, using: syncService)
                busy = nil
              }
            }
            .disabled(entry.body == nil && record?.request == nil)
          }
          if failed || (running && entry.isLane) {
            capsuleButton("Hide", symbol: "eye.slash", primary: false) { launches.hide(entry.launchId) }
          }
          if canCancel {
            capsuleButton("Cancel", symbol: "xmark", primary: false, busy: busy == "cancel") {
              cancelConfirmationPresented = true
            }
          }
        }
        .padding(.top, 6)
      }
    }
  }

  /// The launch card's text action: a capsule, tinted when primary.
  private func capsuleButton(_ title: String, symbol: String, primary: Bool, busy isBusy: Bool = false, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 4) {
        if isBusy {
          ProgressView().controlSize(.mini)
        } else {
          Image(systemName: symbol)
            .font(.system(size: 9, weight: .bold))
        }
        Text(title)
      }
      .font(.caption.weight(.semibold))
      .foregroundStyle(primary ? WorkChatLaunchTone.running : ADEColor.textSecondary)
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .background(primary ? WorkChatLaunchTone.running.opacity(0.12) : Color.clear, in: Capsule(style: .continuous))
      .overlay(
        Capsule(style: .continuous)
          .strokeBorder(primary ? WorkChatLaunchTone.running.opacity(0.32) : ADEColor.glassBorder, lineWidth: 1)
      )
      .contentShape(Capsule(style: .continuous))
    }
    .buttonStyle(.plain)
    .disabled(busy != nil)
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

/// What the person does for the provider sign-in a launch or a woken chat
/// waits on (`CloudLaunchSignIn`). The same step on every client.
struct CloudSignInStepDetail: View {
  let signIn: CloudLaunchSignIn
  let instanceId: String?
  /// The code or key went through: read the launch or the chat again.
  var onDone: @MainActor () async -> Void = {}
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }
  @Environment(\.openURL) private var openURL
  @State private var value = ""
  @State private var busy = false
  @State private var error: String?
  @State private var sent = false
  /// Dropped on send: the keyboard would hide the answer under the field.
  @FocusState private var fieldFocused: Bool

  private var needsInput: Bool { signIn.kind == "api_key" || signIn.kind == "url_paste" || signIn.needsPastedCode }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if signIn.kind == "desktop" {
        Text(cloudDesktopSignInSentence(label: signIn.label))
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      } else {
        if signIn.kind == "device", let code = signIn.userCode {
          HStack(spacing: 8) {
            Text(code)
              .font(.system(size: 17, weight: .semibold, design: .monospaced))
              .foregroundStyle(ADEColor.textPrimary)
              .textSelection(.enabled)
              .accessibilityLabel("Sign-in code \(code)")
            Button {
              UIPasteboard.general.string = code
            } label: {
              Image(systemName: "doc.on.doc")
            }
            .buttonStyle(ADEKitButtonStyle())
            .accessibilityLabel("Copy the code")
          }
        }
        if let reason = signIn.reason {
          Text(reason)
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        if let link = signIn.url.flatMap(URL.init(string:)) {
          Button {
            openURL(link)
          } label: {
            Label("Open sign-in", systemImage: "arrow.up.right.square")
          }
          .buttonStyle(ADEKitButtonStyle())
        }
        if needsInput && !sent {
          HStack(spacing: 8) {
            SecureField(signIn.kind == "api_key" ? "API key" : "Code from the page", text: $value)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .font(.system(size: 14))
              .padding(.horizontal, 10)
              .frame(minHeight: 36)
              .background(ADEColor.recessedBackground, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
              .focused($fieldFocused)
              .onSubmit(submit)
            Button(signIn.kind == "api_key" ? "Save" : "Send code", action: submit)
              .buttonStyle(ADEKitButtonStyle(prominent: true))
              .disabled(busy || value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          }
        }
        if sent {
          Text(signIn.kind == "api_key" ? "Key saved. The chat starts when the computer reads it." : "Code sent. The chat starts when the sign-in is done.")
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.textSecondary)
        }
        if let error {
          Text(error)
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.danger)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }

  private func submit() {
    let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, !busy else { return }
    busy = true
    error = nil
    fieldFocused = false
    Task {
      defer { busy = false }
      guard let client = await syncService.cloudServerClient() else {
        error = "Sign in to ADE again, then try again."
        return
      }
      do {
        if signIn.kind == "api_key" {
          guard let signInId = signIn.signInId else {
            error = "ADE Cloud didn't say which key to save."
            return
          }
          _ = try await client.saveAccountSignIn(signInId, key: text)
        } else {
          guard let instanceId, let jobId = signIn.jobId else {
            error = "The computer isn't ready for the code yet. Try again in a moment."
            return
          }
          if let refusal = try await client.sendSignInCode(instanceId: instanceId, jobId: jobId, code: text) {
            error = refusal
            return
          }
        }
        value = ""
        sent = true
        await onDone()
      } catch {
        self.error = cloudServerFailureMessage(error)
      }
    }
  }
}

// MARK: - A cloud lane's computer, as its chats and lane detail show it

/// What a cloud lane's chat or lane detail says about the lane's computer.
/// Read from state only: showing it never wakes anything.
enum CloudLaneState: Equatable {
  /// Up and connected: nothing to say.
  case awake
  /// Resting. The screen shows the saved copy; a send wakes the computer.
  case asleep
  /// A wake is on its way (from this phone, another device, or a timed wake).
  case waking
  /// The computer was deleted; the next send continues on a new computer.
  case deleted
  /// A wake of this computer failed: the server's sentence. The person can close it.
  case wakeFailed(String)
  /// ADE Cloud refuses work for the account now (blocked, out of hours): the
  /// server's sentence. It stays while the account state holds.
  case refused(String)
}

@MainActor
func cloudLaneState(fleetKey: String?, sync: SyncService, store: AccountCloudStore) -> CloudLaneState? {
  guard let fleetKey, sync.isCloudFleetKey(fleetKey) else { return nil }
  if sync.machineFleet?.isLive(fleetKey) == true || (fleetKey == sync.focusedMachineKey && sync.connectionState == .connected) {
    return .awake
  }
  if let failure = sync.cloudWakeFailure(fleetKey: fleetKey) { return .wakeFailed(failure) }
  if sync.wakingCloudMachineKeys.contains(fleetKey) { return .waking }
  if fleetKey.hasPrefix(ADECloudMachine.savedFleetKeyPrefix) { return .deleted }
  let instance = sync.cloudServerInstance(fleetKey: fleetKey)
  if instance?.isComingUp == true { return .waking }
  if let refusal = store.doingRefusal { return .refused(refusal) }
  // Up with no link from this phone (a send through the account woke it): not asleep.
  if instance?.isAwake == true { return .awake }
  return .asleep
}

/// "Deleted in N days" for the idle cleanup's warning, in whole days (at least 1).
func cloudDeletingSoonDays(deletesAt: Double, now: Date = Date()) -> Int {
  let left = deletesAt / 1000 - now.timeIntervalSince1970
  return max(1, Int((left / 86_400).rounded(.up)))
}

/// The lines at the top of a cloud lane's chat or lane detail: the
/// computer's state, and the idle cleanup's "deleting soon" notice with
/// Keep it. Lives in the pane's top inset, never across the fold.
struct CloudLaneStateLines: View {
  let fleetKey: String?
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @ObservedObject private var store = AccountCloudStore.shared
  private var syncService: SyncService { syncPublishes.service }
  @State private var keeping = false
  @State private var keepError: String?

  var body: some View {
    let instance = syncService.cloudServerInstance(fleetKey: fleetKey)
    let deleting = store.deletingSoon(instanceId: instance?.id)
    CloudLaneStateLinesContent(
      state: cloudLaneState(fleetKey: fleetKey, sync: syncService, store: store),
      deletingDays: deleting.map { cloudDeletingSoonDays(deletesAt: $0.deletesAt) },
      keeping: keeping,
      keepError: keepError,
      onDismissFailure: {
        if let fleetKey { syncService.clearCloudWakeFailure(fleetKey: fleetKey) }
      },
      onKeep: {
        guard let instanceId = instance?.id else { return }
        keeping = true
        keepError = nil
        Task {
          keepError = await store.keep(instanceId: instanceId, using: syncService)
          keeping = false
          if keepError == nil { ADEHaptics.success() }
        }
      }
    )
  }
}

/// The drawn part of `CloudLaneStateLines`, from plain values.
struct CloudLaneStateLinesContent: View {
  let state: CloudLaneState?
  /// Days until the idle cleanup deletes the computer; nil when none is due.
  let deletingDays: Int?
  var keeping = false
  var keepError: String?
  var onDismissFailure: () -> Void = {}
  var onKeep: () -> Void = {}

  var body: some View {
    VStack(spacing: 6) {
      switch state {
      case .waking?:
        CloudComputerWakeBanner(machineName: "your ADE Cloud computer")
      case .wakeFailed(let message)?:
        CloudComputerWakeFailedBanner(message: message, action: .dismiss(onDismissFailure))
      case .refused(let message)?:
        CloudComputerWakeFailedBanner(message: message, action: .none)
      case .asleep?:
        line(
          symbol: "moon.zzz",
          title: "Asleep on ADE Cloud",
          detail: "You're reading the saved copy. Sending a message wakes this lane's computer."
        )
      case .deleted?:
        line(
          symbol: "icloud.slash",
          title: "This lane's cloud computer was deleted",
          detail: "You're reading the saved copy. Your next message continues this chat on a new computer."
        )
      case .awake?, nil:
        EmptyView()
      }
      if let deletingDays {
        deletingSoonLine(days: deletingDays)
      }
    }
  }

  private func line(symbol: String, title: String, detail: String) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: symbol)
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)
        .frame(width: 18)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 1) {
        Text(title)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(detail)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .workChatGlass(in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .padding(.horizontal, 12)
    .padding(.top, 6)
    .accessibilityElement(children: .combine)
    .adeInspectable("CloudLane.State")
  }

  private func deletingSoonLine(days: Int) -> some View {
    HStack(alignment: .center, spacing: 10) {
      Image(systemName: "clock.badge.exclamationmark")
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(ADEColor.warning)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text("This lane's cloud computer is deleted in \(days) \(days == 1 ? "day" : "days") because it is unused. Your work is pushed first.")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textPrimary)
          .fixedSize(horizontal: false, vertical: true)
        if let keepError {
          Text(keepError)
            .font(.caption)
            .foregroundStyle(ADEColor.danger)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      Button(action: onKeep) {
        if keeping { ProgressView().controlSize(.small) } else { Text("Keep it") }
      }
      .buttonStyle(ADEKitButtonStyle())
      .disabled(keeping)
      .adeInspectable("CloudLane.KeepIt")
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .workChatGlass(in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .padding(.horizontal, 12)
    .padding(.top, 6)
    .accessibilityElement(children: .contain)
    .adeInspectable("CloudLane.DeletingSoon")
  }
}

/// The messages ADE Cloud holds for this chat until its computer is up,
/// read from the server so a send from another device shows too. Each one
/// says where it is; one waiting on a provider sign-in shows that step.
struct CloudQueuedMessagesView: View {
  /// The account machine key the chat is saved under, and the chat id.
  let accountMachineKey: String
  let chatId: String
  /// Puts a failed message's text back in the composer. Nil: no "Put back".
  var onPutBack: ((String) -> Void)? = nil
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @ObservedObject private var store = AccountCloudStore.shared
  private var syncService: SyncService { syncPublishes.service }
  @State private var cancelling: String?
  /// Why the last Cancel did not work, by message id (the server's sentence).
  @State private var cancelError: (messageId: String, message: String)?

  var body: some View {
    let messages = store.visibleMessages(machineKey: accountMachineKey, chatId: chatId)
    if !messages.isEmpty {
      VStack(alignment: .trailing, spacing: 8) {
        ForEach(messages, id: \.messageId) { message in
          row(message)
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 6)
      // The transcript scrolls under this inset: keep the rows readable.
      .background(ADEColor.pageBackground.opacity(0.94))
      .adeInspectable("CloudLane.Queued")
    }
  }

  private func row(_ message: CloudChatQueuedMessage) -> some View {
    VStack(alignment: .trailing, spacing: 6) {
      if let text = message.text, !text.isEmpty {
        Text(text)
          .font(.body)
          .foregroundStyle(ADEColor.textPrimary)
          .padding(.horizontal, 12)
          .padding(.vertical, 8)
          .background(ADEColor.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
          .frame(maxWidth: .infinity, alignment: .trailing)
      }
      HStack(spacing: 6) {
        if message.state == "queued" || message.state == "sending" {
          ProgressView().controlSize(.mini)
        }
        Text(statusText(message))
          .font(.caption)
          .foregroundStyle(message.state == "failed" ? ADEColor.danger : ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        if message.state == "queued" {
          Button(cancelling == message.messageId ? "Cancelling…" : "Cancel") {
            cancelling = message.messageId
            cancelError = nil
            Task {
              if let failure = await store.cancelQueued(machineKey: accountMachineKey, chatId: chatId, messageId: message.messageId, using: syncService) {
                cancelError = (message.messageId, failure)
                // The computer may have taken it meanwhile: show its state now.
                await store.reconcile(machineKey: accountMachineKey, chatId: chatId, using: syncService)
              }
              cancelling = nil
            }
          }
          .font(.caption.weight(.semibold))
          .buttonStyle(.borderless)
          .tint(ADEColor.accent)
          .disabled(cancelling != nil)
        }
        if message.state == "failed" {
          if let onPutBack, let text = message.text, !text.isEmpty {
            Button("Put back") {
              onPutBack(text)
              store.hideFailedMessage(message.messageId)
            }
            .font(.caption.weight(.semibold))
            .buttonStyle(.borderless)
            .tint(ADEColor.accent)
            .adeInspectable("CloudLane.Queued.PutBack")
          }
          Button("Dismiss") { store.hideFailedMessage(message.messageId) }
            .font(.caption.weight(.semibold))
            .buttonStyle(.borderless)
            .tint(ADEColor.accent)
            .adeInspectable("CloudLane.Queued.Dismiss")
        }
      }
      if let cancelError, cancelError.messageId == message.messageId {
        Text(cancelError.message)
          .font(.caption)
          .foregroundStyle(ADEColor.danger)
          .fixedSize(horizontal: false, vertical: true)
      }
      if message.state == "waiting_for_sign_in", let signIn = message.signIn {
        CloudSignInStepDetail(signIn: signIn, instanceId: syncService.cloudServerInstances.first { $0.machineKey?.lowercased() == accountMachineKey.lowercased() }?.id) {
          await store.reconcile(machineKey: accountMachineKey, chatId: chatId, using: syncService)
        }
        .padding(12)
        .adeKitCard(padding: nil)
      }
    }
  }

  private func statusText(_ message: CloudChatQueuedMessage) -> String {
    switch message.state {
    case "queued": return "Queued · waking your ADE Cloud computer…"
    case "sending": return "Sending to the agent…"
    case "waiting_for_sign_in": return "Waiting for a sign-in"
    case "failed": return message.error ?? "Not sent. ADE Cloud didn't say why."
    default: return "Waiting"
    }
  }
}

extension View {
  /// The messages ADE Cloud holds for a cloud chat, above its composer, and
  /// the follow that reads them while the chat is open and the app is in
  /// front. When one leaves the queue the chat reads again: from the
  /// computer once it is up, else from the saved copy.
  /// `onPutBack` puts a failed message's text back in the chat's composer.
  func followsCloudQueue(fleetKey: String?, sessionId: String, onPutBack: @escaping (String) -> Void) -> some View {
    modifier(CloudQueueFollowModifier(fleetKey: fleetKey, sessionId: sessionId, onPutBack: onPutBack))
  }
}

private struct CloudQueueFollowModifier: ViewModifier {
  let fleetKey: String?
  let sessionId: String
  let onPutBack: (String) -> Void
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @ObservedObject private var store = AccountCloudStore.shared
  @Environment(\.scenePhase) private var scenePhase

  private var accountKey: String? {
    let sync = syncPublishes.service
    guard let fleetKey, sync.isCloudFleetKey(fleetKey) else { return nil }
    return sync.cloudAccountMachineKey(fleetKey: fleetKey)
  }

  func body(content: Content) -> some View {
    content
      .safeAreaInset(edge: .bottom, spacing: 0) {
        if let accountKey {
          CloudQueuedMessagesView(accountMachineKey: accountKey, chatId: sessionId, onPutBack: onPutBack)
        }
      }
      // Runs again when a send queues a message, when a sign-in lets one
      // move again, and when the app comes back.
      .task(id: "\(accountKey ?? "")|\(sessionId)|\(scenePhase == .active)|\(store.movingMessageCount(machineKey: accountKey ?? "", chatId: sessionId))") {
        guard let accountKey, let fleetKey, scenePhase == .active else { return }
        let sync = syncPublishes.service
        await AccountCloudStore.shared.followQueue(machineKey: accountKey, chatId: sessionId, using: sync) {
          // A message left the queue: the computer is up. Read the server's
          // list, connect with no wake, and read the chat again.
          sync.refreshCloudServerIfStale(force: true)
          await sync.cloudServerReadTask?.value
          if sync.cloudServerInstance(fleetKey: fleetKey)?.isAwake == true {
            if fleetKey == sync.focusedMachineKey {
              // The phone's own link: the fleet never dials it.
              await sync.reconnectIfPossible()
            } else {
              _ = await sync.machineFleet?.connect(machineKey: fleetKey, timeout: .seconds(20), wake: false)
            }
          }
          if let key = sync.chatThreadKey(for: sessionId) {
            sync.chatThreadRequestSnapshot(key, reason: "cloud queue delivered")
          }
        }
      }
  }
}
