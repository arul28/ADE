import SwiftUI
import UIKit

// ADE Cloud inside the normal Work flow: the provider sign-in step a launch
// or a woken chat waits on, and the lines a cloud lane's chat shows about its
// computer (asleep, waking, deleted, refused, deleting soon). A launch's row, page and
// setup card are in `WorkCloudLaunchViews.swift`. Nothing here wakes a
// computer by being shown.

/// What a model whose sign-in happens only in ADE desktop says (Antigravity
/// and every `remoteSignIn == "desktop"` provider). The login carries from
/// the desktop to ADE Cloud, so the model stays selectable.
func cloudDesktopSignInSentence(label: String) -> String {
  "Sign in to \(label) in ADE on your computer once. ADE Cloud then uses that sign-in."
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
  /// A chat says what its next message does; a lane page what New computer does.
  var context: CloudLaneLineContext = .chat
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @ObservedObject private var store = AccountCloudStore.shared
  private var syncService: SyncService { syncPublishes.service }
  @State private var keeping = false
  @State private var keepError: String?

  var body: some View {
    let instance = syncService.cloudServerInstance(fleetKey: fleetKey)
    let deleting = store.deletingSoon(instanceId: instance?.id)
    let state = cloudLaneState(fleetKey: fleetKey, sync: syncService, store: store)
    // A chat's next message makes the new computer: its line offers the size,
    // once the account's sizes are known (no menu with nothing in it).
    let tiers = cloudPhoneTiers(store.account?.catalog)
    let sizeKey = state == .deleted && context == .chat && !tiers.isEmpty
      ? fleetKey.flatMap { syncService.cloudAccountMachineKey(fleetKey: $0)?.lowercased() }
      : nil
    CloudLaneStateLinesContent(
      state: state,
      deletingDays: deleting.map { cloudDeletingSoonDays(deletesAt: $0.deletesAt) },
      deletingSizeLabel: cloudQueueSizeLabel(account: store.account),
      deleted: state == .deleted
        ? cloudDeletedComputerFacts(fleetKey: fleetKey, sync: syncService, store: store) ?? .unknown
        : .unknown,
      context: context,
      sizePick: sizeKey.map { key in
        CloudNewComputerSizePick(
          tiers: tiers,
          picked: store.newComputerSizes[key],
          pick: { store.pickNewComputerSize(machineKey: key, sizeId: $0) }
        )
      },
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
  /// The size a message after that delete starts the new computer at ("Small").
  var deletingSizeLabel: String? = nil
  /// What the `.deleted` line says: what happened and what makes the new
  /// computer, or why ADE can't make one.
  var deleted: CloudDeletedComputerFacts = .unknown
  var context: CloudLaneLineContext = .chat
  /// The `.deleted` chat line's size menu for the new computer; nil shows none.
  var sizePick: CloudNewComputerSizePick? = nil
  var keeping = false
  var keepError: String?
  var onDismissFailure: () -> Void = {}
  var onKeep: () -> Void = {}
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var whyOpen = false

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
        deletedLine
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
    .stateLineChrome()
    .accessibilityElement(children: .combine)
    .adeInspectable("CloudLane.State")
  }

  /// The computer was deleted: what happened and what the next message (or
  /// New computer) does, with a "Why?" that opens two lines in place. When
  /// ADE can't make a new computer, the reason instead, in the warning tone.
  private var deletedLine: some View {
    let blocked = deleted.blocked != nil
    return VStack(alignment: .leading, spacing: 8) {
      deletedText(blocked: blocked)
      if !blocked, let sizePick {
        // Its own control, outside the combined text: VoiceOver reaches it on its own.
        CloudNewComputerSizeMenu(pick: sizePick)
          .padding(.leading, 28)
      }
    }
    .stateLineChrome()
    .adeInspectable(blocked ? "CloudLane.Blocked" : "CloudLane.Deleted")
  }

  private func deletedText(blocked: Bool) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: blocked ? "exclamationmark.icloud" : "icloud.slash")
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(blocked ? ADEColor.warning : ADEColor.textSecondary)
        .frame(width: 18)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 1) {
        Text(deleted.title)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .fixedSize(horizontal: false, vertical: true)
        Text(deleted.detail(context))
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        if !blocked {
          Button {
            if reduceMotion {
              whyOpen.toggle()
            } else {
              withAnimation(.snappy(duration: 0.2)) { whyOpen.toggle() }
            }
          } label: {
            Text("Why?")
              .font(.caption.weight(.semibold))
              .padding(.vertical, 4)
              .contentShape(Rectangle())
          }
          .buttonStyle(.borderless)
          .tint(ADEColor.accent)
          .accessibilityValue(whyOpen ? "Open" : "Closed")
          .adeInspectable("CloudLane.Why")
          if whyOpen {
            Text(CloudDeletedComputerFacts.whySentence)
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
              .transition(.opacity)
          }
        }
      }
      Spacer(minLength: 0)
    }
    // One element: the title and what happened, then Why? (activating it
    // opens the two lines, which then read as part of it).
    .accessibilityElement(children: .combine)
  }

  private func deletingSoonLine(days: Int) -> some View {
    HStack(alignment: .center, spacing: 10) {
      Image(systemName: "clock.badge.exclamationmark")
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(ADEColor.warning)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text("This lane's cloud computer is deleted in \(days) \(days == 1 ? "day" : "days") because it is unused. Your work is pushed first. After that, your next message makes a new computer\(deletingSizeLabel.map { " at \($0)" } ?? "").")
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
    .stateLineChrome()
    .accessibilityElement(children: .contain)
    .adeInspectable("CloudLane.DeletingSoon")
  }
}

private extension View {
  /// One state line's glass card, inset from the pane's edges.
  func stateLineChrome() -> some View {
    padding(.horizontal, 14)
      .padding(.vertical, 10)
      .workChatGlass(in: RoundedRectangle(cornerRadius: 14, style: .continuous))
      .padding(.horizontal, 12)
      .padding(.top, 6)
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
