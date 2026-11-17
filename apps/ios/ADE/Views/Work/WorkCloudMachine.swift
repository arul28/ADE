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

      if !entry.prompt.isEmpty {
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
          Text("\(entry.startError ?? record?.error ?? "ADE Cloud didn't say why.") Your message is not sent.")
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
      } else if running {
        HStack(spacing: 8) {
          Button("Open chat", action: onOpenChat)
            .buttonStyle(ADEKitButtonStyle(prominent: true))
          Button("Hide") { launches.hide(entry.launchId) }
            .buttonStyle(ADEKitButtonStyle())
        }
      } else {
        Text("You can close the app. ADE Cloud keeps your message and sends it when the agent is ready.")
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

  private var title: String {
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
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @ObservedObject private var store = AccountCloudStore.shared
  private var syncService: SyncService { syncPublishes.service }
  @State private var cancelling: String?

  var body: some View {
    let messages = (store.queued[AccountCloudStore.chatKey(machineKey: accountMachineKey, chatId: chatId)] ?? [])
      .filter { $0.isOpen || $0.state == "failed" }
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
            Task {
              _ = await store.cancelQueued(machineKey: accountMachineKey, chatId: chatId, messageId: message.messageId, using: syncService)
              cancelling = nil
            }
          }
          .font(.caption.weight(.semibold))
          .buttonStyle(.borderless)
          .tint(ADEColor.accent)
          .disabled(cancelling != nil)
        }
      }
      if message.state == "waiting_for_sign_in", let signIn = message.signIn {
        CloudSignInStepDetail(signIn: signIn, instanceId: syncService.cloudServerInstances.first { $0.machineKey == accountMachineKey }?.id) {
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
  func followsCloudQueue(fleetKey: String?, sessionId: String) -> some View {
    modifier(CloudQueueFollowModifier(fleetKey: fleetKey, sessionId: sessionId))
  }
}

private struct CloudQueueFollowModifier: ViewModifier {
  let fleetKey: String?
  let sessionId: String
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
          CloudQueuedMessagesView(accountMachineKey: accountKey, chatId: sessionId)
        }
      }
      // Runs again when a send queues a message, and when the app comes back.
      .task(id: "\(accountKey ?? "")|\(sessionId)|\(scenePhase == .active)|\(store.openMessages(machineKey: accountKey ?? "", chatId: sessionId).count)") {
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

/// The models ADE Cloud runs, from the account server's catalog, one
/// section per provider. A provider that signs in only in ADE desktop
/// stays selectable: the desktop's sign-in carries to ADE Cloud.
struct CloudModelPickerSheet: View {
  let provider: String
  let modelId: String
  let onPick: (String, String) -> Void
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @ObservedObject private var launches = AccountCloudLaunchStore.shared
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      List {
        if let catalog = launches.catalog {
          if catalog.providers.isEmpty {
            Text("ADE Cloud lists no models for this account.")
              .foregroundStyle(ADEColor.textSecondary)
          }
          ForEach(catalog.providers, id: \.provider) { entry in
            Section {
              ForEach(entry.models, id: \.id) { model in
                Button {
                  onPick(entry.provider, model.id)
                  dismiss()
                } label: {
                  HStack {
                    Text(model.displayName)
                      .foregroundStyle(ADEColor.textPrimary)
                    Spacer(minLength: 8)
                    if entry.provider == provider && model.id == modelId {
                      Image(systemName: "checkmark")
                        .foregroundStyle(ADEColor.accent)
                        .accessibilityLabel("Selected")
                    }
                  }
                  .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
              }
            } header: {
              Text(entry.label)
            } footer: {
              if entry.remoteSignIn == "desktop" {
                Text(cloudDesktopSignInSentence(label: entry.label))
              }
            }
          }
        } else if let error = launches.catalogError {
          Text(error).foregroundStyle(ADEColor.danger)
        } else {
          HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text("Loading ADE Cloud's models…").foregroundStyle(ADEColor.textSecondary)
          }
        }
      }
      .navigationTitle("Models on ADE Cloud")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
    .presentationDetents([.medium, .large])
    .task { await launches.loadCatalogIfNeeded(using: syncPublishes.service) }
    .adeInspectable("Work.NewChat.CloudModels")
  }
}
