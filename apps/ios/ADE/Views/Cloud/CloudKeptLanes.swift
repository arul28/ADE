import SwiftUI

// The ADE Cloud lanes ADE kept without a computer (`GET /cloud/lanes/without-computer`):
// freed by the person, removed by the idle cleanup after their work was saved,
// freed to fit a cheaper plan, or by the old 30-day rule. The desktop's
// `CloudLanesWithoutComputerBlock.tsx` on the phone: one folded block in the
// project's Lanes list (that project's lanes, matched by origin) and on the
// ADE Cloud page's "Lanes and computers" card (every project's). Each row says
// what happened in one line, offers "New computer" (a lane launch on the same
// branch, `AccountCloudLaunchStore.startLaneOnNewComputer`), opens its saved
// chats, and keeps Delete behind its ⋯ menu.
//
// All of it is the account's: reads and the launch go through the account
// server with the phone's own sign-in, never to a machine, so no pin is
// involved and nothing needs a computer of the person's own. A message sent
// to one of its saved chats goes to the server's queue, which makes the new
// computer and continues that chat there (`SyncService.sendChatMessage`).

/// What happened to the lane's computer, in one line (the desktop's `rowSentence`).
func cloudKeptLaneSentence(_ lane: CloudLaneWithoutComputer) -> String {
  let day = lane.since.flatMap { $0 > 0 ? Date(timeIntervalSince1970: $0 / 1000) : nil }
    .map { " on \($0.formatted(.dateTime.month(.abbreviated).day()))" } ?? ""
  let fate: String
  switch lane.reason {
  case "freed": fate = "You freed its computer\(day)."
  case "idle_cleanup": fate = "ADE deleted its computer\(day) because it wasn't used."
  case "plan_limit": fate = "ADE deleted its computer\(day) to fit your plan."
  case "inactive": fate = "ADE deleted its computer\(day) after 30 days without use."
  default: fate = "Its computer was deleted\(day)."
  }
  return "\(fate) Its work is on \(lane.branchName ?? "GitHub")."
}

/// Why "New computer" can't start for this lane, in one sentence; nil when it can.
@MainActor
func cloudKeptLaneRestartProblem(_ lane: CloudLaneWithoutComputer) -> String? {
  if lane.branchName == nil { return "ADE never learned this lane's branch. Start a new lane on ADE Cloud instead." }
  if lane.projectOrigin.flatMap({ nonEmptyTrimmed($0) }) == nil {
    return "ADE doesn't know this lane's repository, so it can't make a computer for it."
  }
  return AccountCloudStore.shared.doingRefusal
}

/// The size the old computer had, as one of today's sizes; nil (ADE Cloud's default) when none matches.
func cloudKeptLaneRestartSizeId(_ lane: CloudLaneWithoutComputer, account: CloudPhoneAccount?) -> String? {
  guard let cpu = lane.cpu, let memory = lane.memoryGb else { return nil }
  let type = lane.type ?? "default"
  return cloudPhoneTiers(account?.catalog).first { $0.type == type && $0.cpu == cpu && $0.memoryGb == memory }?.id
}

/// The block: a folded head ("1 cloud lane without a computer") opened to a
/// row per lane, then the cards of lane launches whose lane has left the list
/// (its new computer is coming up). Nothing when there are none.
struct CloudKeptLanesBlock: View {
  /// `github.com/owner/repo`: that project's lanes. Nil: every project's.
  let origin: String?
  /// Bumped by the host's pull to refresh: the list reads again.
  var refreshToken = 0
  /// A new computer for one of these lanes is up: the host reads its own list again.
  var onComputerUp: (() async -> Void)? = nil
  /// Around the block when it shows; nothing when it's empty.
  var insets = EdgeInsets()
  /// Rows open their saved chats in Work. Off in a sheet that would cover Work.
  var opensChats = true
  @ObservedObject private var cloudStore = AccountCloudStore.shared
  @ObservedObject private var launches = AccountCloudLaunchStore.shared
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @State private var open = false
  private var syncService: SyncService { syncPublishes.service }

  private var lanes: [CloudLaneWithoutComputer] {
    let key = origin?.lowercased()
    return cloudStore.lanesWithoutComputer
      .filter { key == nil || $0.projectOrigin == key }
      .sorted { ($0.since ?? 0) > ($1.since ?? 0) }
  }

  /// Each lane launch's id and state: one turning running or done means its lane is back among the live ones.
  private var laneLaunchStates: [String] {
    launches.entries.filter(\.isLane).map { "\($0.launchId):\($0.record?.state ?? "")" }
  }

  var body: some View {
    let rows = lanes
    let laneIds = Set(rows.map(\.laneId))
    let following = launches.openLaneLaunches(origin: origin).filter { !laneIds.contains($0.laneId ?? "") }
    Group {
      if rows.isEmpty && following.isEmpty {
        // Nothing to show, but the read below still runs.
        Color.clear.frame(height: 0)
      } else {
        content(rows: rows, following: following)
          .padding(insets)
      }
    }
    .task {
      await cloudStore.refreshLanesWithoutComputer(using: syncService)
      // A New computer started on another device shows its card here too.
      await launches.refreshActive(using: syncService)
    }
    .onChange(of: refreshToken) { _, _ in
      Task {
        await cloudStore.refreshLanesWithoutComputer(using: syncService, force: true)
        await launches.refreshActive(using: syncService, force: true)
      }
    }
    .onChange(of: laneLaunchStates) { old, new in
      let wasUp = Set(old.filter { $0.hasSuffix(":running") || $0.hasSuffix(":done") })
      guard new.contains(where: { ($0.hasSuffix(":running") || $0.hasSuffix(":done")) && !wasUp.contains($0) }) else { return }
      // The new computer is up: the account lists it, and the kept lane leaves this list.
      Task { @MainActor in
        await syncService.readCloudForLaunchedChat()
        await cloudStore.refreshLanesWithoutComputer(using: syncService, force: true)
        await onComputerUp?()
      }
    }
  }

  private func content(rows: [CloudLaneWithoutComputer], following: [AccountCloudLaunchStore.Entry]) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      if !rows.isEmpty {
        Button {
          ADEHaptics.light()
          withAnimation(.snappy(duration: 0.2)) { open.toggle() }
        } label: {
          HStack(spacing: 7) {
            Image(systemName: open ? "chevron.down" : "chevron.right")
              .font(.system(size: 10, weight: .bold))
              .foregroundStyle(ADEColor.textMuted)
              .frame(width: 12)
            Image(systemName: ADECloudMachine.symbol)
              .font(.system(size: 12, weight: .semibold))
              .foregroundStyle(ADEColor.accent)
            Text(rows.count == 1 ? "1 cloud lane without a computer" : "\(rows.count) cloud lanes without a computer")
              .font(.system(size: 13.5, weight: .semibold))
              .foregroundStyle(ADEColor.textPrimary)
            Spacer(minLength: 0)
          }
          .frame(minHeight: 32)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(rows.count == 1 ? "1 cloud lane without a computer" : "\(rows.count) cloud lanes without a computer")
        .accessibilityValue(open ? "Open" : "Closed")
        if open {
          VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.laneId) { index, lane in
              if index > 0 { Divider().opacity(0.5).padding(.vertical, 10) }
              CloudKeptLaneRow(lane: lane, launch: launches.laneLaunch(for: lane), opensChats: opensChats)
            }
          }
        }
      }
      ForEach(following) { entry in
        WorkCloudLaunchCard(entry: entry)
      }
    }
  }
}

/// One kept lane: its name, branch and what happened, "New computer", its
/// saved chats, and Delete in its ⋯ menu.
struct CloudKeptLaneRow: View {
  let lane: CloudLaneWithoutComputer
  /// This lane's launch from "New computer", while the phone shows it.
  let launch: AccountCloudLaunchStore.Entry?
  var opensChats = true
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @State private var starting = false
  @State private var deleting = false
  @State private var deleteAsk = false
  @State private var chatsOpen = false
  private var syncService: SyncService { syncPublishes.service }

  /// Its saved chats, newest first (readable from the account, no computer needed).
  private var chats: [CloudSavedChatRow] {
    syncService.cloudSavedChats.filter { $0.laneId == lane.laneId }.sorted { $0.updatedAt > $1.updatedAt }
  }

  /// A launch for it runs, or finished and its lane hasn't left the list yet.
  private var launchHoldsIt: Bool {
    guard let launch else { return false }
    return launch.startError == nil && launch.record?.failed != true
  }

  private var deleteLabel: String { chats.isEmpty ? "Delete lane" : "Delete lane and chats" }

  var body: some View {
    let problem = cloudKeptLaneRestartProblem(lane)
    let savedChats = chats
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .top, spacing: 10) {
        VStack(alignment: .leading, spacing: 3) {
          Text(lane.laneName)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          if let branch = lane.branchName {
            HStack(spacing: 4) {
              Image(systemName: "arrow.triangle.branch")
                .font(.system(size: 10.5, weight: .medium))
              Text(branch)
                .font(.system(size: 12, design: .monospaced))
                .lineLimit(1)
            }
            .foregroundStyle(ADEColor.textSecondary)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Branch \(branch)")
          }
        }
        Spacer(minLength: 6)
        Menu {
          Button(role: .destructive) { deleteAsk = true } label: {
            Label(deleteLabel, systemImage: "trash")
          }
        } label: {
          Group {
            if deleting { ProgressView().controlSize(.small) } else { Image(systemName: "ellipsis") }
          }
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(ADEColor.textSecondary)
          .frame(width: 36, height: 30)
          .contentShape(Rectangle())
        }
        .disabled(deleting || starting || launchHoldsIt)
        .accessibilityLabel("More for \(lane.laneName)")
      }
      Text(cloudKeptLaneSentence(lane))
        .font(.system(size: 12.5))
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
      if let problem {
        Text(problem)
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize(horizontal: false, vertical: true)
      }
      HStack(spacing: 8) {
        Button { Task { await start() } } label: {
          HStack(spacing: 5) {
            if starting { ProgressView().controlSize(.small) } else { Image(systemName: "plus") }
            Text(starting || launchHoldsIt ? "Starting…" : "New computer")
          }
        }
        .buttonStyle(ADEKitButtonStyle(prominent: true))
        .disabled(problem != nil || starting || deleting || launchHoldsIt)
        .accessibilityHint("A new computer on the same branch")
        if !opensChats {
          if !savedChats.isEmpty {
            Text(savedChats.count == 1 ? "1 saved chat, in Work" : "\(savedChats.count) saved chats, in Work")
              .font(.system(size: 12))
              .foregroundStyle(ADEColor.textMuted)
          }
        } else if savedChats.count == 1, let chat = savedChats.first {
          Button { openChat(chat) } label: { Label("Open chat", systemImage: "bubble.left") }
            .buttonStyle(ADEKitButtonStyle())
            .disabled(deleting)
        } else if savedChats.count > 1 {
          Button {
            withAnimation(.snappy(duration: 0.2)) { chatsOpen.toggle() }
          } label: {
            Label("\(savedChats.count) chats", systemImage: chatsOpen ? "chevron.down" : "chevron.right")
          }
          .buttonStyle(ADEKitButtonStyle())
          .disabled(deleting)
        }
      }
      if opensChats, savedChats.count > 1, chatsOpen {
        VStack(alignment: .leading, spacing: 2) {
          ForEach(savedChats, id: \.chatId) { chat in
            Button { openChat(chat) } label: {
              HStack(spacing: 8) {
                Image(systemName: "bubble.left")
                  .font(.system(size: 11))
                  .foregroundStyle(ADEColor.textMuted)
                Text(nonEmptyTrimmed(chat.title) ?? "Saved chat")
                  .font(.system(size: 13.5))
                  .foregroundStyle(ADEColor.textPrimary)
                  .lineLimit(1)
                Spacer(minLength: 4)
                Text(Date(timeIntervalSince1970: chat.updatedAt / 1000).formatted(.relative(presentation: .named)))
                  .font(.system(size: 11.5))
                  .foregroundStyle(ADEColor.textMuted)
              }
              .frame(minHeight: 34)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
          }
        }
        .padding(.leading, 4)
      }
      if let launch {
        WorkCloudLaunchCard(entry: launch)
      }
    }
    .confirmationDialog(
      "Delete \(lane.laneName)?",
      isPresented: $deleteAsk,
      titleVisibility: .visible
    ) {
      Button(deleteLabel, role: .destructive) { Task { await delete() } }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(deleteMessage)
    }
  }

  private var deleteMessage: String {
    let count = chats.count
    let what = count == 0 ? "any saved chats it has" : count == 1 ? "its chat" : "its \(count) chats"
    return "ADE stops listing the lane and deletes \(what) and its saved work that isn't on GitHub. Its branch stays on GitHub."
  }

  private func start() async {
    guard cloudKeptLaneRestartProblem(lane) == nil else { return }
    starting = true
    defer { starting = false }
    ADEHaptics.light()
    let sizeId = cloudKeptLaneRestartSizeId(lane, account: AccountCloudStore.shared.account)
    guard let launchId = await AccountCloudLaunchStore.shared.startLaneOnNewComputer(lane, sizeId: sizeId, using: syncService) else { return }
    // A refused start shows on its card, with Retry.
    if AccountCloudLaunchStore.shared.entries.first(where: { $0.launchId == launchId })?.startError != nil {
      ADEHaptics.error()
      return
    }
    ADEHaptics.success()
    CloudLaneActions.shared.toast = ADEToastMessage(
      text: "Making a new computer for \(lane.laneName)",
      detail: "It starts on \(lane.branchName ?? "the same branch"). Its steps show here."
    )
  }

  private func delete() async {
    deleting = true
    defer { deleting = false }
    let hadChats = !chats.isEmpty
    if let failure = await AccountCloudStore.shared.forgetLaneWithoutComputer(lane, using: syncService) {
      ADEHaptics.error()
      CloudLaneActions.shared.toast = ADEToastMessage(text: "Couldn't delete \(lane.laneName)", kind: .failure, detail: failure)
      return
    }
    ADEHaptics.success()
    CloudLaneActions.shared.toast = ADEToastMessage(
      text: "Deleted \(lane.laneName)",
      detail: hadChats ? "The lane and its chats are gone." : "The lane is gone."
    )
    // The saved chats it had leave Work too.
    syncService.refreshCloudServerIfStale(force: true)
  }

  /// Opens a saved chat in Work, through the lane's former computer's rows:
  /// read from the account, and a message there makes the new computer.
  private func openChat(_ chat: CloudSavedChatRow) {
    let fleetKey = syncService.cloudFleetKey(accountMachineKey: chat.machineKey)
    syncService.requestedWorkSessionNavigation = WorkSessionNavigationRequest(
      sessionId: chat.chatId,
      laneId: workRemoteLaneId(machineKey: fleetKey, laneId: lane.laneId)
    )
  }
}
