import Combine
import SwiftUI

// The ADE Cloud lanes ADE kept without a computer (`GET /cloud/lanes/without-computer`):
// freed by the person, removed by the idle cleanup after their work was saved,
// freed to fit a cheaper plan, or by the old 30-day rule. A project's Lanes
// list shows each as a normal lane row with a quiet "Computer deleted"; a tap
// opens its newest saved chat, else its kept-lane page (the chat's "computer
// deleted" line, New computer on the same branch, Delete). The ADE Cloud
// page's "Lanes and computers" card lists every project's, as the desktop's
// ADE Cloud page does (`CloudDashboard.tsx`). A chat whose
// computer was deleted says what happened and what its next message does
// (`CloudDeletedComputerFacts`), in the desktop's words (`cloudLaneLife.ts`).
//
// All of it is the account's: reads and the launch go through the account
// server with the phone's own sign-in, never to a machine, so no pin is
// involved and nothing needs a computer of the person's own. A message sent
// to one of its saved chats goes to the server's queue, which makes the new
// computer and continues that chat there (`SyncService.sendChatMessage`).

// MARK: - What happened to a lane's computer

/// Why a lane's computer is gone, as people read it (the desktop's
/// `CloudComputerFate`, `apps/desktop/src/shared/cloudLaneLife.ts`).
enum CloudComputerFate: String {
  case you, freed, idle, plan, automation, project, launch, other, inactive
}

/// The fate behind a server reason. One mapping for both sources: a kept
/// lane's `reason` (`freed`, `idle_cleanup`, `plan_limit`, `inactive`: the
/// desktop's `CLOUD_KEPT_LANE_FATE`) and a saved chat's `computer.reason`
/// (`CloudComputerDeleteReason`, already a fate: `you`, `freed`, `idle`,
/// `plan`, `automation`, `project`, `launch`, `other`). Nil when the server
/// gave none; an unknown reason reads as `other`.
func cloudComputerFate(serverReason: String?) -> CloudComputerFate? {
  guard let reason = serverReason.flatMap({ nonEmptyTrimmed($0) }) else { return nil }
  switch reason {
  case "idle_cleanup": return .idle
  case "plan_limit": return .plan
  default: return CloudComputerFate(rawValue: reason) ?? .other
  }
}

/// What happened to a lane's computer, in one sentence (the desktop's
/// `cloudComputerFateSentence`, word for word). `deletedAt` is in ms; the
/// " on Nov 18" part is left out when the day is unknown.
func cloudComputerFateSentence(_ fate: CloudComputerFate?, deletedAt: Double?) -> String {
  let when = deletedAt.flatMap { $0 > 0 ? Date(timeIntervalSince1970: $0 / 1000) : nil }
    .map { " on \($0.formatted(.dateTime.month(.abbreviated).day()))" } ?? ""
  switch fate {
  case .you?: return "You deleted its computer\(when)."
  case .freed?: return "You freed its computer\(when)."
  case .idle?: return "ADE deleted its computer\(when) because it wasn't used."
  case .plan?: return "ADE deleted its computer\(when) to fit your plan."
  case .inactive?: return "ADE deleted its computer\(when) after 30 days without use."
  case .automation?: return "Its automation finished\(when), and ADE deleted its computer."
  case .project?: return "Its project's computers were deleted\(when)."
  case .launch?: return "Its launch didn't finish, so ADE deleted its computer\(when)."
  case .other?, nil: return "Its computer was deleted\(when)."
  }
}

/// What happened to the lane's computer, in one line (the desktop's `rowSentence`).
func cloudKeptLaneSentence(_ lane: CloudLaneWithoutComputer) -> String {
  let fate = cloudComputerFateSentence(cloudComputerFate(serverReason: lane.reason), deletedAt: lane.since)
  return "\(fate) Its work is on \(lane.branchName ?? "GitHub")."
}

/// Where a cloud lane's state line shows: in one of its chats, or on its lane page.
enum CloudLaneLineContext {
  case chat
  case lane
}

/// The size a message to a deleted computer's chat makes its new computer
/// at: the account's queue takes no size (the desktop's `CLOUD_QUEUE_SIZE_ID`).
let cloudQueueSizeId = "small"

/// The queue's size as a sentence says it ("Small or bigger if the project
/// needs it"): the server can start Medium, and the setup can move it up.
func cloudQueueSizeLabel(account: CloudPhoneAccount?) -> String {
  let label = cloudPhoneTiers(account?.catalog).first { $0.id == cloudQueueSizeId }?.label ?? "Small"
  return "\(label) or bigger if the project needs it"
}

/// The size menu of the computer that replaces a deleted one: the sizes, the
/// pick (nil: ADE's size), and how to change it.
struct CloudNewComputerSizePick {
  let tiers: [CloudPhoneTier]
  let picked: String?
  let pick: (String?) -> Void
  /// The account's unit.
  let words: CloudBalanceWords
  /// The account's hours left, so each size says how long they last on it.
  var leftMilli: Int? = nil
}

/// The deleted-computer line's size chip: the size the next message's new
/// computer starts at. The desktop's chip in the chat's banner.
struct CloudNewComputerSizeMenu: View {
  let pick: CloudNewComputerSizePick

  var body: some View {
    let currentId = pick.picked ?? cloudQueueSizeId
    let current = pick.tiers.first { $0.id == currentId }
    Menu {
      Section("Size of the new computer") {
        ForEach(pick.tiers) { tier in
          // A button, not a picker row: a menu button shows its second line.
          Button {
            pick.pick(tier.id)
          } label: {
            Label {
              Text(tier.label)
              Text("\(tier.specs.joined(separator: ", ")). \(tier.hoursLine(leftMilli: pick.leftMilli, words: pick.words)).")
            } icon: {
              Image(systemName: tier.id == currentId ? "checkmark" : tier.symbol)
            }
          }
          .accessibilityAddTraits(tier.id == currentId ? .isSelected : [])
        }
      }
    } label: {
      HStack(spacing: 5) {
        Image(systemName: current?.symbol ?? "square")
          .font(.system(size: 11, weight: .semibold))
        Text(current?.label ?? "Small")
          .font(.caption.weight(.semibold))
        Image(systemName: "chevron.up.chevron.down")
          .font(.system(size: 9, weight: .semibold))
      }
      .foregroundStyle(ADEColor.textPrimary)
      .padding(.horizontal, 10)
      .frame(minHeight: 30)
      .background(ADEColor.textPrimary.opacity(0.06), in: Capsule())
      .contentShape(Capsule())
    }
    .accessibilityLabel("Size of the new computer")
    .accessibilityValue(current?.label ?? "Small")
    .adeInspectable("CloudLane.NewComputerSize")
  }
}

/// What a chat or lane page says once its ADE Cloud computer was deleted:
/// what happened, and what makes the new one (its branch and size), or why
/// ADE can't make one now. The desktop's `cloudLaneComputerDeletedFacts`.
struct CloudDeletedComputerFacts: Equatable {
  /// "ADE deleted its computer on Nov 18 because it wasn't used."
  var fate: String
  /// The branch a new computer starts on; nil when ADE never learned it.
  var branch: String? = nil
  /// The size it starts at ("Small", or "Small or bigger if the project needs
  /// it" through the queue); nil when no size of today's matches.
  var sizeLabel: String? = nil
  /// A message makes the new computer (the account's queue), not the lane's
  /// own New computer: true wherever the lane has a saved chat.
  var viaQueue = true
  /// Why ADE can't make a new computer for the lane now; nil when it can.
  /// The one text the line and the composer both show.
  var blocked: String? = nil
  /// The account's unit, for the Why? sentence.
  var words: CloudBalanceWords = .credits

  /// Nothing known beyond the delete.
  static let unknown = CloudDeletedComputerFacts(fate: cloudComputerFateSentence(nil, deletedAt: nil))

  var whySentence: String {
    "ADE Cloud deletes a computer that isn't used for a while, or to fit your plan, so it doesn't use your \(words.unit) and disk. Your chats and the work that isn't on GitHub stay on your account. A new computer gets them back."
  }

  var title: String {
    blocked == nil ? "This lane's ADE Cloud computer was deleted" : "ADE can't make a new computer for this lane"
  }

  func detail(_ context: CloudLaneLineContext) -> String {
    if let blocked { return blocked }
    return "\(fate) \(nextSentence(context))"
  }

  /// What the next message (in a chat) or New computer (on a lane with no chat) does.
  func nextSentence(_ context: CloudLaneLineContext) -> String {
    let on = branch ?? "the lane's branch"
    let at = sizeLabel.map { ", at \($0)," } ?? ""
    switch context {
    case .chat:
      return "Your next message makes a new computer on \(on)\(at) and continues this chat there."
    case .lane where viaQueue:
      return "A message in its chat makes a new computer on \(on)\(at) and continues the chat there."
    case .lane:
      return "A new computer for it starts on \(on)\(sizeLabel.map { ", at \($0)" } ?? "")."
    }
  }
}

/// The facts from what the phone holds: the kept lane when there is one,
/// else a saved chat's word on its computer. Reads no server. `viaQueue`:
/// a message makes the new computer, at the queue's size, and only the
/// account can refuse it; false is the kept lane's own New computer, at its
/// old size, which also needs its branch and repository.
@MainActor
func cloudDeletedComputerFacts(
  kept: CloudLaneWithoutComputer?,
  computer: CloudSavedChatComputer?,
  viaQueue: Bool,
  store: AccountCloudStore
) -> CloudDeletedComputerFacts {
  let fate = kept.map { cloudComputerFateSentence(cloudComputerFate(serverReason: $0.reason), deletedAt: $0.since) }
    ?? cloudComputerFateSentence(cloudComputerFate(serverReason: computer?.reason), deletedAt: computer?.deletedAt)
  guard let kept, !viaQueue else {
    return CloudDeletedComputerFacts(
      fate: fate,
      branch: kept?.branchName,
      sizeLabel: cloudQueueSizeLabel(account: store.account),
      viaQueue: true,
      blocked: store.doingRefusal,
      words: CloudBalanceWords(store.account)
    )
  }
  return CloudDeletedComputerFacts(
    fate: fate,
    branch: kept.branchName,
    sizeLabel: cloudKeptLaneRestartTier(kept, account: store.account)?.label,
    viaQueue: false,
    blocked: cloudKeptLaneRestartProblem(kept),
    words: CloudBalanceWords(store.account)
  )
}

/// The facts for a deleted computer's fleet key (`cloud-saved:<machine key>`),
/// whose saved chats list it, so a message makes the new computer. The kept
/// lane matches by the old computer's machine key or by the chats' lane. Nil
/// for any other key.
@MainActor
func cloudDeletedComputerFacts(fleetKey: String?, sync: SyncService, store: AccountCloudStore) -> CloudDeletedComputerFacts? {
  guard let fleetKey, fleetKey.hasPrefix(ADECloudMachine.savedFleetKeyPrefix),
        let accountKey = sync.cloudAccountMachineKey(fleetKey: fleetKey)?.lowercased()
  else { return nil }
  let chats = sync.cloudSavedChats.filter { $0.machineKey.lowercased() == accountKey }
  let laneIds = Set(chats.compactMap { nonEmptyTrimmed($0.laneId) })
  let kept = store.lanesWithoutComputer.first { $0.formerMachineKey?.lowercased() == accountKey }
    ?? store.lanesWithoutComputer.first { laneIds.contains($0.laneId) }
  let computer = chats.lazy.compactMap(\.computer).first { $0.isDeleted }
  var facts = cloudDeletedComputerFacts(kept: kept, computer: computer, viaQueue: true, store: store)
  // The size picked in the chat's line, else ADE's.
  if let picked = store.newComputerSizes[accountKey],
     let tier = cloudPhoneTiers(store.account?.catalog).first(where: { $0.id == picked }) {
    facts.sizeLabel = tier.label
  }
  return facts
}

/// Why a message can't make a new computer for this chat's deleted one, in
/// the sentence the chat's line shows; nil when it can, and for a computer
/// that is not deleted.
@MainActor
func cloudLaneNewComputerProblem(fleetKey: String?, sync: SyncService, store: AccountCloudStore) -> String? {
  guard case .deleted? = cloudLaneState(fleetKey: fleetKey, sync: sync, store: store) else { return nil }
  return cloudDeletedComputerFacts(fleetKey: fleetKey, sync: sync, store: store)?.blocked
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
  cloudKeptLaneRestartTier(lane, account: account)?.id
}

/// The size `cloudKeptLaneRestartSizeId` names, with its label.
func cloudKeptLaneRestartTier(_ lane: CloudLaneWithoutComputer, account: CloudPhoneAccount?) -> CloudPhoneTier? {
  guard let cpu = lane.cpu, let memory = lane.memoryGb else { return nil }
  let type = lane.type ?? "default"
  return cloudPhoneTiers(account?.catalog).first { $0.type == type && $0.cpu == cpu && $0.memoryGb == memory }
}

// MARK: - Doing, for a kept lane

/// What a kept lane's row (on the ADE Cloud page) and its lane page both do:
/// New computer, Delete, and opening a saved chat. One copy of each.
@MainActor
enum KeptCloudLane {
  /// Its saved chats, newest first (readable from the account, no computer needed).
  static func savedChats(_ lane: CloudLaneWithoutComputer, sync: SyncService) -> [CloudSavedChatRow] {
    sync.cloudSavedChats.filter { $0.laneId == lane.laneId }.sorted { $0.updatedAt > $1.updatedAt }
  }

  /// The newest top-level saved chat of a lane, on one computer's rows when
  /// `accountMachineKey` names it, else on any. A subagent chat only when
  /// the lane has no other.
  static func newestChat(laneId: String, accountMachineKey: String? = nil, sync: SyncService) -> CloudSavedChatRow? {
    let machine = accountMachineKey?.lowercased()
    let rows = sync.cloudSavedChats.filter { row in
      row.laneId == laneId && (machine == nil || row.machineKey.lowercased() == machine)
    }
    let newest = { (list: [CloudSavedChatRow]) in list.max { $0.updatedAt < $1.updatedAt } }
    return newest(rows.filter { nonEmptyTrimmed($0.parentChatId) == nil }) ?? newest(rows)
  }

  /// A launch for it runs, or finished and its lane hasn't left the list yet.
  static func launchHolds(_ launch: AccountCloudLaunchStore.Entry?) -> Bool {
    guard let launch else { return false }
    return launch.startError == nil && launch.record?.failed != true
  }

  /// One label in every case, as on the desktop: the confirm says what goes.
  static let deleteLabel = "Delete lane"

  static func deleteMessage(chatCount: Int) -> String {
    let what = chatCount == 0 ? "any saved chats it has" : chatCount == 1 ? "its chat" : "its \(chatCount) chats"
    return "ADE stops listing the lane and deletes \(what) and its saved work that isn't on GitHub. Download that work first if you need it. Its branch stays on GitHub."
  }

  /// New computer: a lane launch on the same branch, at the old size.
  static func startNewComputer(_ lane: CloudLaneWithoutComputer, sync: SyncService) async {
    guard cloudKeptLaneRestartProblem(lane) == nil else { return }
    ADEHaptics.light()
    let sizeId = cloudKeptLaneRestartSizeId(lane, account: AccountCloudStore.shared.account)
    guard let launchId = await AccountCloudLaunchStore.shared.startLaneOnNewComputer(lane, sizeId: sizeId, using: sync) else { return }
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

  /// Delete: the lane's record, its saved work and its saved chats. Its branch stays on GitHub.
  static func delete(_ lane: CloudLaneWithoutComputer, sync: SyncService) async {
    let hadChats = !savedChats(lane, sync: sync).isEmpty
    if let failure = await AccountCloudStore.shared.forgetLaneWithoutComputer(lane, using: sync) {
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
    sync.refreshCloudServerIfStale(force: true)
  }

  /// Opens a saved chat in Work, through the lane's former computer's rows:
  /// read from the account, and a message there makes the new computer.
  static func openChat(_ chat: CloudSavedChatRow, laneId: String, sync: SyncService) {
    let fleetKey = sync.cloudFleetKey(accountMachineKey: chat.machineKey)
    sync.requestedWorkSessionNavigation = WorkSessionNavigationRequest(
      sessionId: chat.chatId,
      laneId: workRemoteLaneId(machineKey: fleetKey, laneId: laneId)
    )
  }
}

// MARK: - Following the kept lanes while a page shows them

extension View {
  /// Reads the kept lanes and the lane launches when a page that shows them
  /// opens (at most every 15 s and 20 s), again on a pull (`refreshToken`),
  /// and once a New computer's computer is up. No timer of its own.
  func followsKeptCloudLanes(refreshToken: Int, onComputerUp: (() async -> Void)? = nil) -> some View {
    modifier(KeptCloudLanesFollowModifier(refreshToken: refreshToken, onComputerUp: onComputerUp))
  }
}

private struct KeptCloudLanesFollowModifier: ViewModifier {
  let refreshToken: Int
  let onComputerUp: (() async -> Void)?
  @ObservedObject private var cloudStore = AccountCloudStore.shared
  @ObservedObject private var launches = AccountCloudLaunchStore.shared
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }

  /// Each lane launch's id and state: one turning running or done means its lane is back among the live ones.
  private var laneLaunchStates: [String] {
    launches.entries.filter(\.isLane).map { "\($0.launchId):\($0.record?.state ?? "")" }
  }

  func body(content: Content) -> some View {
    content
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
        // The new computer is up: the account lists it, and the kept lane leaves the list.
        Task { @MainActor in
          await syncService.readCloudForLaunchedChat()
          await cloudStore.refreshLanesWithoutComputer(using: syncService, force: true)
          await onComputerUp?()
        }
      }
  }
}

/// The cards of a project's lane launches (New computer) while they come up
/// or after one failed, above the Lanes list. Each kept lane is a row of the
/// list itself; this only follows the launches.
struct CloudKeptLaneLaunchCards: View {
  /// `github.com/owner/repo`: that project's launches.
  let origin: String
  var refreshToken = 0
  var onComputerUp: (() async -> Void)? = nil
  @ObservedObject private var launches = AccountCloudLaunchStore.shared

  var body: some View {
    let entries = launches.openLaneLaunches(origin: origin)
    Group {
      if entries.isEmpty {
        // Nothing to show, but the reads still run.
        Color.clear.frame(height: 0)
      } else {
        VStack(alignment: .leading, spacing: 10) {
          ForEach(entries) { entry in
            WorkCloudLaunchSetupCard(entry: entry)
          }
        }
        .padding(EdgeInsets(top: 4, leading: 16, bottom: 8, trailing: 16))
      }
    }
    .followsKeptCloudLanes(refreshToken: refreshToken, onComputerUp: onComputerUp)
  }
}

// MARK: - The ADE Cloud page's block

/// The block: a folded head ("1 cloud lane without a computer") opened to a
/// row per lane, then the cards of lane launches whose lane has left the list
/// (its new computer is coming up). Nothing when there are none. The ADE
/// Cloud page's account overview; a project's Lanes list shows its kept
/// lanes as rows instead.
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
  @State private var open = false

  private var lanes: [CloudLaneWithoutComputer] {
    let key = origin?.lowercased()
    return cloudStore.lanesWithoutComputer
      .filter { key == nil || $0.projectOrigin == key }
      .sorted { ($0.since ?? 0) > ($1.since ?? 0) }
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
    .followsKeptCloudLanes(refreshToken: refreshToken, onComputerUp: onComputerUp)
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
        WorkCloudLaunchSetupCard(entry: entry)
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

  private var chats: [CloudSavedChatRow] { KeptCloudLane.savedChats(lane, sync: syncService) }
  private var launchHoldsIt: Bool { KeptCloudLane.launchHolds(launch) }

  var body: some View {
    let problem = cloudKeptLaneRestartProblem(lane)
    let savedChats = chats
    let deleteLabel = KeptCloudLane.deleteLabel
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
        Button {
          Task {
            starting = true
            await KeptCloudLane.startNewComputer(lane, sync: syncService)
            starting = false
          }
        } label: {
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
          Button { KeptCloudLane.openChat(chat, laneId: lane.laneId, sync: syncService) } label: { Label("Open chat", systemImage: "bubble.left") }
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
        CloudKeptLaneChatList(chats: savedChats) { chat in
          KeptCloudLane.openChat(chat, laneId: lane.laneId, sync: syncService)
        }
        .padding(.leading, 4)
      }
      if let launch {
        WorkCloudLaunchSetupCard(entry: launch)
      }
    }
    .confirmationDialog(
      "Delete \(lane.laneName)?",
      isPresented: $deleteAsk,
      titleVisibility: .visible
    ) {
      Button(deleteLabel, role: .destructive) {
        Task {
          deleting = true
          await KeptCloudLane.delete(lane, sync: syncService)
          deleting = false
        }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(KeptCloudLane.deleteMessage(chatCount: chats.count))
    }
  }
}

/// A kept lane's saved chats, one tappable line each, newest first.
struct CloudKeptLaneChatList: View {
  let chats: [CloudSavedChatRow]
  let onOpen: (CloudSavedChatRow) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      ForEach(chats, id: \.chatId) { chat in
        Button { onOpen(chat) } label: {
          HStack(spacing: 8) {
            Image(systemName: "bubble.left")
              .font(.system(size: 11))
              .foregroundStyle(ADEColor.textMuted)
              .accessibilityHidden(true)
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
  }
}

/// A kept lane's actions on its lane page: New computer on the same branch
/// (only for a lane with no saved chat, as on the desktop: one with chats
/// gets its new computer from a message in its chat), its saved chats, and
/// Delete. Its state line (what happened, or why ADE can't make a computer)
/// sits in the page's top inset.
struct CloudKeptLaneActionsCard: View {
  let lane: CloudLaneWithoutComputer
  /// What the page's state line already says is wrong: New computer's own
  /// problem shows under it only when it is something else.
  var lineReason: String? = nil
  @ObservedObject private var launches = AccountCloudLaunchStore.shared
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @State private var starting = false
  @State private var deleting = false
  @State private var deleteAsk = false
  private var syncService: SyncService { syncPublishes.service }

  @ViewBuilder
  private func newComputerButton(problem: String?, holds: Bool) -> some View {
    Button {
      Task {
        starting = true
        await KeptCloudLane.startNewComputer(lane, sync: syncService)
        starting = false
      }
    } label: {
      HStack(spacing: 6) {
        if starting { ProgressView().controlSize(.small).tint(.white) } else { Image(systemName: "plus") }
        Text(starting || holds ? "Starting…" : "New computer on the same branch")
      }
    }
    .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
    .disabled(problem != nil || starting || deleting || holds)
    .adeInspectable("CloudLane.Kept.NewComputer")
    if let problem, problem != lineReason {
      Text(problem)
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  var body: some View {
    let launch = launches.laneLaunch(for: lane)
    let holds = KeptCloudLane.launchHolds(launch)
    let problem = cloudKeptLaneRestartProblem(lane)
    let chats = KeptCloudLane.savedChats(lane, sync: syncService)
    let deleteLabel = KeptCloudLane.deleteLabel
    VStack(alignment: .leading, spacing: 12) {
      if chats.isEmpty {
        newComputerButton(problem: problem, holds: holds)
      }
      if let launch {
        WorkCloudLaunchSetupCard(entry: launch)
      }
      if !chats.isEmpty {
        VStack(alignment: .leading, spacing: 4) {
          Text(chats.count == 1 ? "Its saved chat" : "Its \(chats.count) saved chats")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(ADEColor.textSecondary)
          CloudKeptLaneChatList(chats: chats) { chat in
            KeptCloudLane.openChat(chat, laneId: lane.laneId, sync: syncService)
          }
        }
      }
      Button(role: .destructive) { deleteAsk = true } label: {
        HStack(spacing: 6) {
          if deleting { ProgressView().controlSize(.small) } else { Image(systemName: "trash") }
          Text(deleteLabel)
        }
      }
      .buttonStyle(ADEKitButtonStyle(tone: .crit, wide: true))
      .disabled(deleting || starting || holds)
      .adeInspectable("CloudLane.Kept.Delete")
    }
    .confirmationDialog(
      "Delete \(lane.laneName)?",
      isPresented: $deleteAsk,
      titleVisibility: .visible
    ) {
      Button(deleteLabel, role: .destructive) {
        Task {
          deleting = true
          await KeptCloudLane.delete(lane, sync: syncService)
          deleting = false
        }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(KeptCloudLane.deleteMessage(chatCount: chats.count))
    }
  }
}

/// A lane link (`ade link`, a push, the share sheet) to a lane ADE Cloud kept
/// without a computer. `DeepLinkRouter` finds it in the account's kept lanes.
struct KeptLaneLinkTarget: Identifiable, Equatable {
  let laneId: String
  var id: String { laneId }
}

/// The kept lane's own page (New computer, Delete) over whatever is on screen,
/// with no project or computer open: all of it is the account's. It closes
/// when the lane leaves the kept list after it showed (deleted, or its new
/// computer is up), or when one of its saved chats opens in Work.
struct KeptLaneLinkSheet: View {
  let laneId: String
  let onClose: () -> Void
  @ObservedObject private var cloudStore = AccountCloudStore.shared
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @State private var shown = false

  private var kept: Bool { cloudStore.lanesWithoutComputer.contains { $0.laneId == laneId } }

  var body: some View {
    NavigationStack {
      UnavailableLaneDestination(laneId: laneId)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Done", action: onClose)
          }
        }
    }
    .onChange(of: kept, initial: true) { _, isKept in
      if isKept { shown = true } else if shown { onClose() }
    }
    // The first value is what was pending before the page opened.
    .onReceive(syncPublishes.service.$requestedWorkSessionNavigation.dropFirst().compactMap { $0 }) { _ in onClose() }
  }
}
