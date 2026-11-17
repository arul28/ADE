import SwiftUI
import UIKit

// Work rows of an ADE Cloud lane whose computer is not awake: the saved
// copy of a CLI or shell session (read-only), and a chat move from a
// computer that sleeps or was deleted. Reading never wakes a computer; only
// the buttons that say so do.

// MARK: - Saved CLI and shell copies

/// The saved copy of one CLI or shell session, read from the account server.
/// The person reads what the session showed when its computer went to
/// sleep. "Wake to use it" is the one action, and it wakes. A CLI whose
/// computer was deleted gets a composer instead: the message goes to ADE
/// Cloud's queue, and the server continues the CLI on a new computer. A
/// shell takes no messages.
struct CloudSessionCopyScreen: View {
  let row: CloudSessionRow
  /// The fleet key of the session's computer, for the wake.
  let fleetKey: String?
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @ObservedObject private var cloudStore = AccountCloudStore.shared
  private var syncService: SyncService { syncPublishes.service }
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  @State private var copy: CloudAtRestStore.Read<CloudSessionCopy>?
  @State private var waking = false
  @State private var wakeError: String?
  @State private var draft = ""
  /// The send id of the message being sent: the same id again on a retry,
  /// so the server keeps one message.
  @State private var sendId: String?
  @State private var sending = false
  @State private var sendError: String?
  #if DEBUG
  /// Fixture screens show this copy and read nothing.
  var fixtureCopy: CloudSessionCopy?
  #endif

  private func scrollToNewest(_ proxy: ScrollViewProxy) {
    let count = lines.count
    guard count > 0 else { return }
    proxy.scrollTo(count - 1, anchor: .bottomLeading)
  }

  /// The session's computer was deleted: it can't wake. A message continues a CLI.
  private var computerDeleted: Bool {
    if let fleetKey, case .deleted? = cloudLaneState(fleetKey: fleetKey, sync: syncService, store: cloudStore) { return true }
    return false
  }

  private var acceptsMessages: Bool { computerDeleted && !row.isShell }

  private var openQueuedCount: Int {
    cloudStore.openMessages(machineKey: row.machineKey, chatId: row.sessionId).count
  }

  private var lines: [String] {
    guard case .loaded(let copy) = copy else { return [] }
    return cloudSessionCopyLines(copy.text, format: copy.format)
  }

  var body: some View {
    NavigationStack {
      content
        .background(ADEColor.pageBackground.ignoresSafeArea())
        .navigationTitle(nonEmptyTrimmed(row.title) ?? (row.isShell ? "Shell" : "CLI session"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Done") { dismiss() }
          }
        }
        .safeAreaInset(edge: .top, spacing: 0) { header }
        .safeAreaInset(edge: .bottom, spacing: 0) { footer }
    }
    .task { await load() }
    // While a message waits for the new computer, follow it (the app in front only).
    .task(id: "\(acceptsMessages)|\(openQueuedCount)|\(scenePhase == .active)") {
      guard acceptsMessages, scenePhase == .active else { return }
      #if DEBUG
      if fixtureCopy != nil { return }
      #endif
      let sync = syncService
      await AccountCloudStore.shared.followQueue(machineKey: row.machineKey, chatId: row.sessionId, using: sync) {
        // The CLI continues on a new computer: its live row comes with the next read.
        sync.refreshCloudServerIfStale(force: true)
      }
    }
    .adeInspectable("Work.CloudSessionCopy")
  }

  private var header: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "moon.zzz")
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)
        .frame(width: 18)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 1) {
        Text("Saved copy")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(headerDetail)
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
    .padding(.vertical, 6)
    .accessibilityElement(children: .combine)
  }

  private var headerDetail: String {
    let saved = Date(timeIntervalSince1970: row.updatedAt / 1000).formatted(.relative(presentation: .named))
    let what = row.isShell ? "this shell" : "this CLI"
    if computerDeleted {
      return row.isShell
        ? "What \(what) showed before its computer was deleted, saved \(saved). A shell can't continue on a new computer."
        : "What \(what) showed before its computer was deleted, saved \(saved). A message continues it on a new ADE Cloud computer."
    }
    return "What \(what) showed when its computer went to sleep, saved \(saved). You can't type here."
  }

  @ViewBuilder
  private var content: some View {
    switch copy {
    case nil:
      ProgressView("Loading the saved copy…")
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    case .missing?:
      ADEEmptyStateView(
        symbol: "terminal",
        title: "No saved copy",
        message: "ADE Cloud has no copy of this session. Wake the lane's computer to open it."
      )
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    case .failed(let message)?:
      ADEEmptyStateView(symbol: "exclamationmark.triangle", title: "Couldn't load the copy", message: message) {
        Button("Try again") { Task { await load(force: true) } }
          .buttonStyle(ADEKitButtonStyle(prominent: true))
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    case .loaded?:
      ScrollViewReader { proxy in
        ScrollView([.vertical, .horizontal]) {
          LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
              Text(line.isEmpty ? " " : line)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(ADEColor.textPrimary)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .id(index)
            }
          }
          .padding(12)
          .textSelection(.enabled)
        }
        // Long lines stop at the side controls (iPhone Duo closed), not under them.
        .clipped()
        // The newest output is at the bottom, as in a terminal: when the
        // screen opens, and when the copy arrives after it. The line starts
        // stay in view (a 2D scroll anchored at `.bottom` centers each line).
        .onAppear { scrollToNewest(proxy) }
        .onChange(of: lines.count) { _, _ in scrollToNewest(proxy) }
      }
    }
  }

  @ViewBuilder
  private var footer: some View {
    if acceptsMessages {
      composer
    } else if computerDeleted {
      // A shell on a deleted computer: nothing can wake or continue it.
      EmptyView()
    } else {
      wakeFooter
    }
  }

  /// A message for a CLI whose computer was deleted, with the messages ADE
  /// Cloud holds for it above (as in a chat).
  private var composer: some View {
    VStack(spacing: 0) {
      CloudQueuedMessagesView(accountMachineKey: row.machineKey, chatId: row.sessionId) { text in
        draft = nonEmptyTrimmed(draft).map { "\($0)\n\(text)" } ?? text
      }
      if let sendError {
        Text(sendError)
          .font(.caption)
          .foregroundStyle(ADEColor.danger)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 18)
          .padding(.top, 6)
      }
      HStack(alignment: .bottom, spacing: 8) {
        TextField("Message \(nonEmptyTrimmed(row.title) ?? "the CLI")", text: $draft, axis: .vertical)
          .lineLimit(1...5)
          .font(.body)
          .padding(.horizontal, 14)
          .padding(.vertical, 10)
          .disabled(sending)
          .adeInspectable("Work.CloudSessionCopy.Composer")
        Button {
          Task { await send() }
        } label: {
          Group {
            if sending {
              ProgressView().controlSize(.small).tint(.white)
            } else {
              Image(systemName: "arrow.up").font(.system(size: 15, weight: .bold))
            }
          }
          .frame(width: 34, height: 34)
          .background(Circle().fill(canSend ? ADEColor.accent : ADEColor.textMuted.opacity(0.35)))
          .foregroundStyle(.white)
        }
        .buttonStyle(.plain)
        .disabled(!canSend)
        .accessibilityLabel("Send")
        .padding(.trailing, 6)
        .padding(.bottom, 5)
      }
      .workChatGlass(in: RoundedRectangle(cornerRadius: 22, style: .continuous))
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
    }
  }

  private var canSend: Bool {
    !sending && nonEmptyTrimmed(draft) != nil
  }

  /// Hands the message to ADE Cloud's queue. The server makes a new computer
  /// for the lane and continues this CLI there, then types the message.
  private func send() async {
    guard let text = nonEmptyTrimmed(draft), !sending else { return }
    let messageId = sendId ?? "ios-\(UUID().uuidString.lowercased())"
    sendId = messageId
    sending = true
    sendError = nil
    defer { sending = false }
    #if DEBUG
    if fixtureCopy != nil { return }
    #endif
    switch await AccountCloudStore.shared.queueSend(
      machineKey: row.machineKey, chatId: row.sessionId, messageId: messageId, text: text, using: syncService
    ) {
    case .queued:
      draft = ""
      sendId = nil
      ADEHaptics.success()
    case .routeMissing:
      // An older server takes no messages for a CLI copy.
      sendError = "ADE Cloud can't continue this CLI yet. Continue it from ADE on a computer."
    case .refused(let message):
      // Nothing was kept: the next send is a new message.
      sendId = nil
      sendError = message
      ADEHaptics.error()
    case .failed(let message):
      // The server may hold it: a retry sends the same id.
      sendError = message
      ADEHaptics.error()
    }
  }

  private var wakeFooter: some View {
    VStack(spacing: 6) {
      if let wakeError {
        Text(wakeError)
          .font(.caption)
          .foregroundStyle(ADEColor.danger)
          .fixedSize(horizontal: false, vertical: true)
      }
      Button {
        Task { await wake() }
      } label: {
        HStack(spacing: 6) {
          if waking { ProgressView().controlSize(.small).tint(.white) }
          Text(waking ? "Waking the lane's computer…" : "Wake to use it")
        }
        .frame(maxWidth: .infinity)
      }
      .buttonStyle(ADEKitButtonStyle(prominent: true))
      .disabled(waking || fleetKey == nil)
      .adeInspectable("Work.CloudSessionCopy.Wake")
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
    .background(ADEColor.pageBackground.opacity(0.96))
  }

  private func load(force: Bool = false) async {
    #if DEBUG
    if let fixtureCopy {
      copy = .loaded(fixtureCopy)
      return
    }
    #endif
    if !force, copy != nil { return }
    guard let client = await syncService.cloudServerClient() else {
      copy = .failed("Sign in to ADE to read this copy.")
      return
    }
    do {
      copy = .loaded(try await client.sessionCopy(machineKey: row.machineKey, sessionId: row.sessionId))
    } catch CloudServerClient.Failure.noAccess {
      copy = .missing
    } catch {
      copy = .failed(cloudServerFailureMessage(error))
    }
  }

  /// A doing action: wakes the computer, then the live row takes this one's place.
  private func wake() async {
    guard let fleetKey, !waking else { return }
    waking = true
    wakeError = nil
    let up = await syncService.machineFleet?.connect(machineKey: fleetKey, timeout: .seconds(150)) ?? false
    waking = false
    if up {
      ADEHaptics.success()
      dismiss()
    } else {
      wakeError = syncService.cloudWakeFailure(fleetKey: fleetKey) ?? "The lane's computer didn't come up. Try again."
    }
  }
}

/// The lines of a saved copy, with terminal escape codes removed. An
/// `xterm` copy is a serialized screen; the phone shows its text. Pure.
func cloudSessionCopyLines(_ text: String, format: String) -> [String] {
  var plain = text
  if format == "xterm" || plain.contains("\u{1B}") {
    let patterns = [
      "\u{1B}\\][^\u{07}\u{1B}]*(\u{07}|\u{1B}\\\\)", // OSC … BEL / ST
      "\u{1B}\\[[0-9;?<=>]*[ -/]*[@-~]",              // CSI
      "\u{1B}[()*+][A-Za-z0-9]",                       // character sets
      "\u{1B}[=>78cDEHMNOZ\\\\]",                      // single-character codes
    ]
    for pattern in patterns {
      plain = plain.replacingOccurrences(of: pattern, with: "", options: .regularExpression)
    }
  }
  plain = plain.replacingOccurrences(of: "\r\n", with: "\n")
  return plain.split(separator: "\n", omittingEmptySubsequences: false).map { line in
    // A carriage return inside a line redraws it: the last part is what shows.
    let drawn = line.split(separator: "\r", omittingEmptySubsequences: false).last.map(String.init) ?? ""
    return drawn.replacingOccurrences(of: "\t", with: "    ")
  }
}

// MARK: - Moving a chat whose computer is not awake

/// A chat on an ADE Cloud computer that sleeps or was deleted, for Hand off
/// › Another machine.
struct WorkCloudRestingMoveTarget: Identifiable, Equatable {
  var id: String { sessionId }
  let sessionId: String
  let title: String
  let fleetKey: String
  /// The computer was deleted: the next message forks the chat on a new one.
  let deleted: Bool
}

/// The ADE Cloud computer a Work row's chat lives on, when it is not awake.
@MainActor
func workCloudRestingMoveTarget(session: TerminalSessionSummary, title: String, sync: SyncService) -> WorkCloudRestingMoveTarget? {
  guard isChatSession(session),
        let fleetKey = workParseRemoteLaneId(session.laneId)?.machineKey,
        sync.isCloudFleetKey(fleetKey) else { return nil }
  switch cloudLaneState(fleetKey: fleetKey, sync: sync, store: AccountCloudStore.shared) {
  case .asleep?, .wakeFailed?:
    return WorkCloudRestingMoveTarget(sessionId: session.id, title: title, fleetKey: fleetKey, deleted: false)
  case .deleted?:
    return WorkCloudRestingMoveTarget(sessionId: session.id, title: title, fleetKey: fleetKey, deleted: true)
  case .awake?, .waking?, .refused?, nil:
    return nil
  }
}

/// Hand off › Another machine for a chat whose computer is not awake. A
/// move needs the chat's own computer, so an asleep one wakes first (a
/// doing action), then the usual move sheet opens. A deleted computer can't
/// pack the chat: the next message continues it on a new computer, with its
/// whole history.
struct WorkCloudRestingMoveSheet: View {
  let target: WorkCloudRestingMoveTarget
  /// The computer is up: open the usual move sheet.
  let onAwake: () -> Void
  /// Open the chat to write the message that continues it.
  let onOpenChat: () -> Void
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }
  @Environment(\.dismiss) private var dismiss
  @State private var waking = false
  @State private var error: String?

  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 14) {
        HStack(alignment: .top, spacing: 12) {
          Image(systemName: target.deleted ? "icloud.slash" : "moon.zzz")
            .font(.system(size: 20, weight: .semibold))
            .foregroundStyle(ADEColor.textSecondary)
            .frame(width: 28)
            .accessibilityHidden(true)
          VStack(alignment: .leading, spacing: 4) {
            Text(target.deleted ? "This chat's computer was deleted" : "This chat's computer is asleep")
              .font(.headline)
              .foregroundStyle(ADEColor.textPrimary)
            Text(target.deleted
              ? "A deleted computer can't pack the chat for a move. Send a message instead: ADE Cloud continues the chat on a new computer, with its whole history."
              : "To move the chat, its computer packs it first. Waking it uses ADE Cloud hours.")
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        if let error {
          Text(error)
            .font(.footnote)
            .foregroundStyle(ADEColor.danger)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 0)
        if target.deleted {
          Button {
            dismiss()
            onOpenChat()
          } label: {
            Text("Write a message").frame(maxWidth: .infinity)
          }
          .buttonStyle(ADEKitButtonStyle(prominent: true))
          .adeInspectable("Work.CloudMove.OpenChat")
        } else {
          Button {
            Task { await wakeThenMove() }
          } label: {
            HStack(spacing: 6) {
              if waking { ProgressView().controlSize(.small).tint(.white) }
              Text(waking ? "Waking the computer…" : "Wake and move")
            }
            .frame(maxWidth: .infinity)
          }
          .buttonStyle(ADEKitButtonStyle(prominent: true))
          .disabled(waking)
          .adeInspectable("Work.CloudMove.Wake")
        }
      }
      .padding(20)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationTitle("Move to another machine")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
      }
    }
    .presentationDetents([.medium])
    .interactiveDismissDisabled(waking)
  }

  private func wakeThenMove() async {
    waking = true
    error = nil
    let up = await syncService.machineFleet?.connect(machineKey: target.fleetKey, timeout: .seconds(150)) ?? false
    waking = false
    guard up else {
      error = syncService.cloudWakeFailure(fleetKey: target.fleetKey) ?? "The computer didn't come up. Try again."
      return
    }
    dismiss()
    onAwake()
  }
}
