import SwiftUI
import UIKit

// An ADE Cloud lane whose computer is not awake (asleep, waking, deleted,
// refused). The lane detail shows what the account keeps for it with no
// computer: the Git summary its computer saved, the branch's files and
// commits from GitHub. Reading never wakes the computer. Opening a file the
// lane changed is a doing action: GitHub does not have that change, so the
// lane's computer wakes to show its own copy.

/// What a lane at rest needs to say where it is.
struct CloudLaneAtRestSubject: Equatable {
  /// The fleet key of the lane's computer (or the saved key of a deleted one).
  let fleetKey: String
  /// The account machine key its saved rows are under.
  let accountMachineKey: String
  let laneId: String
  let laneName: String
  /// The branch the lane's row names, until the Git summary says.
  let branchHint: String?
  let repo: GitHubDirectRepoRef?
}

/// Whether a lane on this computer shows the at-rest detail: an ADE Cloud
/// computer that is not up. A computer the server lists as awake connects
/// on open, so it gets the live detail.
@MainActor
func cloudLaneShowsAtRest(fleetKey: String?, sync: SyncService) -> Bool {
  guard let fleetKey, let state = cloudLaneState(fleetKey: fleetKey, sync: sync, store: AccountCloudStore.shared) else { return false }
  if case .awake = state { return false }
  return sync.cloudServerInstance(fleetKey: fleetKey)?.isAwake != true
}

/// The fleet key of the machine a lane lives on: the machine its remote id
/// names, else the focused machine (a focused ADE Cloud computer's own lanes
/// carry plain ids).
@MainActor
func cloudLaneFleetKey(_ laneId: String, sync: SyncService) -> String? {
  workParseRemoteLaneId(laneId)?.machineKey ?? sync.focusedMachineKey
}

/// Whether a lane lives on an ADE Cloud computer that is not up. Such a lane
/// offers only what needs no wake: its computer (size, free, delete) and its
/// delete. Color, rename and archive need the computer.
@MainActor
func laneRestsOnCloud(_ laneId: String, sync: SyncService) -> Bool {
  cloudLaneShowsAtRest(fleetKey: cloudLaneFleetKey(laneId, sync: sync), sync: sync)
}

/// The account server's row for the ADE Cloud computer a lane lives on, awake
/// or asleep. Nil for a lane on any other machine, or a computer that is gone.
@MainActor
func cloudLaneComputer(_ laneId: String, sync: SyncService) -> CloudServerInstance? {
  let fleetKey = cloudLaneFleetKey(laneId, sync: sync)
  guard sync.isCloudFleetKey(fleetKey),
        fleetKey?.hasPrefix(ADECloudMachine.savedFleetKeyPrefix) != true,
        let instance = sync.cloudServerInstance(fleetKey: fleetKey),
        !instance.isGone
  else { return nil }
  return instance
}

/// The account delete of a lane that lives on its own ADE Cloud computer:
/// the computer goes, and the lane and its chats with it. Nil for any other
/// lane (an older computer that holds several lanes, a lane on a machine of
/// the person's own), which the host deletes the usual way.
@MainActor
func cloudLaneDeleteTarget(
  laneId: String,
  laneName: String,
  sync: SyncService,
  onDeleted: (@MainActor () async -> Void)? = nil
) -> CloudLaneDeleteTarget? {
  guard let instance = cloudLaneComputer(laneId, sync: sync) else { return nil }
  let plain = workParseRemoteLaneId(laneId)?.laneId ?? laneId
  guard instance.laneId == plain else { return nil }
  return CloudLaneDeleteTarget(
    instanceId: instance.id,
    accountMachineKey: instance.machineKey,
    laneId: plain,
    laneName: nonEmptyTrimmed(instance.laneName) ?? laneName,
    unpushed: instance.laneWork?.unpushed,
    onDeleted: onDeleted
  )
}

@MainActor
func cloudLaneAtRestSubject(fleetKey: String, lane: LaneSummary, sync: SyncService) -> CloudLaneAtRestSubject? {
  guard let accountKey = sync.cloudAccountMachineKey(fleetKey: fleetKey) else { return nil }
  let laneId = workParseRemoteLaneId(lane.id)?.laneId ?? lane.id
  return CloudLaneAtRestSubject(
    fleetKey: fleetKey,
    accountMachineKey: accountKey,
    laneId: laneId,
    laneName: lane.displayName,
    branchHint: nonEmptyTrimmed(lane.branchRef),
    repo: sync.cloudProjectRepo
  )
}

// MARK: - The lane detail at rest

struct CloudLaneAtRestScreen: View {
  let subject: CloudLaneAtRestSubject
  /// The computer is up: the caller reads the lane again (its live detail shows).
  let onAwake: @MainActor () async -> Void
  /// The computer woke for a move: the caller shows the live detail and
  /// opens its move. Nil where the live detail isn't shown here; the wake
  /// then does what `onAwake` does.
  var onAwakeToMove: (@MainActor () async -> Void)? = nil
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @ObservedObject private var store = CloudAtRestStore.shared
  @ObservedObject private var cloudStore = AccountCloudStore.shared
  @Environment(\.dismiss) private var dismiss
  private var syncService: SyncService { syncPublishes.service }

  /// The lane ADE kept when its computer was deleted: New computer and Delete show here.
  private var keptLane: CloudLaneWithoutComputer? {
    guard subject.fleetKey.hasPrefix(ADECloudMachine.savedFleetKeyPrefix) else { return nil }
    return cloudStore.lanesWithoutComputer.first { $0.laneId == subject.laneId }
  }
  /// The lane's computer on the account server; none once it was deleted.
  private var manageInstanceId: String? {
    guard !subject.fleetKey.hasPrefix(ADECloudMachine.savedFleetKeyPrefix) else { return nil }
    return syncService.cloudServerInstance(fleetKey: subject.fleetKey)?.id
  }
  @State private var commits: CloudAtRestStore.Read<[GitHubDirectCommit]>?
  @State private var commitsError: GitHubDirectError?
  @State private var filesPresented = false
  @State private var waking = false
  @State private var wakeError: String?
  @State private var changedFileAsk: CloudGitChangedFile?
  @State private var movePresented = false

  /// The account delete of this lane (its computer goes with it); none once
  /// the computer was deleted or for a computer that holds other lanes.
  private var deleteTarget: CloudLaneDeleteTarget? {
    guard manageInstanceId != nil,
          let instance = syncService.cloudServerInstance(fleetKey: subject.fleetKey),
          instance.laneId == subject.laneId
    else { return nil }
    return CloudLaneDeleteTarget(
      instanceId: instance.id,
      accountMachineKey: instance.machineKey,
      laneId: subject.laneId,
      laneName: subject.laneName,
      unpushed: instance.laneWork?.unpushed,
      onDeleted: { dismiss() }
    )
  }

  private var summaryRead: CloudAtRestStore.Read<CloudGitSummary>? {
    store.summary(machineKey: subject.accountMachineKey, laneId: subject.laneId)
  }

  private var summary: CloudGitSummary? {
    if case .loaded(let summary)? = summaryRead { return summary }
    return nil
  }

  /// The account keeps at least one chat of this lane.
  private var hasSavedChats: Bool {
    let machine = subject.accountMachineKey.lowercased()
    return syncService.cloudSavedChats.contains { $0.laneId == subject.laneId && $0.machineKey.lowercased() == machine }
  }

  private var branch: String? {
    summary?.branch.flatMap { nonEmptyTrimmed($0) }
      ?? store.lane(machineKey: subject.accountMachineKey, laneId: subject.laneId)?.branch.flatMap { nonEmptyTrimmed($0) }
      ?? subject.branchHint
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        header
        // A deleted computer's lane ADE kept: New computer on the same
        // branch, its saved chats and Delete (the line above says what happened).
        if let keptLane {
          CloudKeptLaneActionsCard(
            lane: keptLane,
            lineReason: cloudDeletedComputerFacts(fleetKey: subject.fleetKey, sync: syncService, store: cloudStore)?.blocked
          )
        }
        gitCard
        // The work its computer saved at its last rest, as a patch: a download
        // with no wake, also once the computer was deleted.
        CloudSavedWorkRow(syncService: syncService, laneId: subject.laneId, framed: true)
        filesCard
        historyCard
        if let wakeError {
          Text(wakeError)
            .font(.footnote)
            .foregroundStyle(ADEColor.danger)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
      .frame(maxWidth: 760, alignment: .leading)
      .frame(maxWidth: .infinity)
    }
    .refreshable { await load(force: true) }
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .navigationTitle(subject.laneName)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        Button {
          Task { await wake() }
        } label: {
          if waking { ProgressView().controlSize(.small) } else { Label("Wake", systemImage: "power") }
        }
        .disabled(waking || subject.fleetKey.hasPrefix(ADECloudMachine.savedFleetKeyPrefix))
        .accessibilityLabel("Wake the lane's computer")
        .adeInspectable("CloudLane.AtRest.Wake")
      }
      // Size, free and delete are account actions: none of them wakes the
      // computer, so a resting lane manages it from here.
      if let manageInstanceId {
        ToolbarItem(placement: .secondaryAction) {
          Button("Manage computer", systemImage: "slider.horizontal.3") {
            CloudLaneActions.shared.manageComputer(instanceId: manageInstanceId, showsOpenWork: false)
          }
          .adeInspectable("CloudLane.AtRest.Manage")
        }
      }
      if let deleteTarget {
        ToolbarItem(placement: .secondaryAction) {
          Button("Delete lane", systemImage: "trash", role: .destructive) {
            CloudLaneActions.shared.delete(deleteTarget)
          }
          .adeInspectable("CloudLane.AtRest.Delete")
        }
      }
      // The system puts a secondary action in the bar's ⋯ menu. An asleep
      // lane moves from its computer's saved copy, with no wake (the review
      // says when that copy won't do and offers the wake); a kept lane comes
      // back from its saved copies, branch and work too.
      if hasSavedChats || keptLane != nil || manageInstanceId != nil {
        ToolbarItem(placement: .secondaryAction) {
          Button("Move to…", systemImage: "arrow.right.circle") { movePresented = true }
            .adeInspectable("CloudLane.AtRest.Move")
        }
      }
    }
    .sheet(isPresented: $movePresented) {
      CloudLaneRestingMoveSheet(
        laneId: subject.laneId,
        laneName: subject.laneName,
        fleetKey: subject.fleetKey,
        onAwake: onAwakeToMove ?? onAwake
      )
    }
    .task(id: subject.laneId) { await load(force: false) }
    .sheet(isPresented: $filesPresented) {
      if let repo = subject.repo, let branch {
        CloudLaneFilesSheet(
          repo: repo,
          branch: branch,
          summary: summary,
          fleetKey: subject.fleetKey,
          onAwake: onAwake
        )
      }
    }
    .confirmationDialog(
      "Open the lane's copy?",
      isPresented: Binding(get: { changedFileAsk != nil }, set: { if !$0 { changedFileAsk = nil } }),
      titleVisibility: .visible,
      presenting: changedFileAsk
    ) { _ in
      Button("Wake and open") { Task { await wake() } }
      Button("Cancel", role: .cancel) {}
    } message: { file in
      Text("\(file.path) changed on the lane and GitHub doesn't have the change. Opening it wakes the lane's computer, which uses \(CloudBalanceWords.current.cloudUnit).")
    }
    .adeInspectable("CloudLane.AtRest")
  }

  // MARK: Parts

  private var header: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 6) {
        Image(systemName: ADECloudMachine.symbol)
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
          .accessibilityHidden(true)
        Text(ADECloudMachine.name)
          .font(.caption.weight(.medium))
          .foregroundStyle(ADEColor.textSecondary)
        if let branch {
          ADEKitChip(symbol: "arrow.triangle.branch", text: branch, mono: true)
        }
      }
      Text("You're reading what ADE Cloud keeps for this lane. Nothing here wakes its computer.")
        .font(.caption)
        .foregroundStyle(ADEColor.textMuted)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  @ViewBuilder
  private var gitCard: some View {
    ADEKitCard(title: "Git", symbol: "arrow.triangle.branch", hint: summaryHint) {
      switch summaryRead {
      case nil:
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text("Reading the saved Git state…").font(.subheadline).foregroundStyle(ADEColor.textSecondary)
        }
      case .missing?:
        Text("This lane's computer saved no Git state yet. It saves one each time it goes to sleep.")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      case .failed(let message)?:
        VStack(alignment: .leading, spacing: 8) {
          Text(message).font(.subheadline).foregroundStyle(ADEColor.textSecondary)
          Button("Try again") { Task { await load(force: true) } }
            .buttonStyle(ADEKitButtonStyle())
        }
      case .loaded(let summary)?:
        CloudGitSummaryView(summary: summary, onOpenFile: { changedFileAsk = $0 })
      }
    }
  }

  private var summaryHint: String? {
    guard let summary, summary.checkedAt > 0 else { return nil }
    return "As of \(cloudAtRestTime(ms: summary.checkedAt))"
  }

  @ViewBuilder
  private var filesCard: some View {
    ADEKitCard(title: "Files", symbol: "folder") {
      VStack(alignment: .leading, spacing: 10) {
        if subject.repo == nil {
          Text("This project has no GitHub repository, so its files show only when the lane's computer is awake.")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        } else if branch == nil {
          Text("This lane names no branch yet. Its files show when the lane's computer is awake.")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        } else {
          Text("The branch as GitHub has it. Changes the lane didn't push show in Git above.")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
          Button {
            filesPresented = true
          } label: {
            Label("Browse files on GitHub", systemImage: "folder")
          }
          .buttonStyle(ADEKitButtonStyle(prominent: true))
          .adeInspectable("CloudLane.AtRest.Files")
        }
      }
    }
  }

  @ViewBuilder
  private var historyCard: some View {
    ADEKitCard(title: "History", symbol: "clock.arrow.circlepath", hint: historyHint) {
      VStack(alignment: .leading, spacing: 0) {
        if let summary, summary.ahead > 0 || summary.dirty {
          unpushedLine(summary)
            .padding(.bottom, 8)
        }
        if let commitsError, let copy = cloudGitHubReadCopy(commitsError, repo: subject.repo) {
          GitHubStateCard(copy: copy)
        } else {
          switch commits {
          case nil:
            if subject.repo != nil, branch != nil {
              HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Reading the branch's commits…").font(.subheadline).foregroundStyle(ADEColor.textSecondary)
              }
            }
          case .missing?:
            Text("\(branch ?? "This branch") isn't on GitHub yet, so the Git state above is all ADE has. Wake the lane's computer to push it.")
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          case .failed(let message)?:
            Text(message).font(.subheadline).foregroundStyle(ADEColor.textSecondary)
          case .loaded(let list)?:
            if list.isEmpty {
              Text("No commits on this branch yet.").font(.subheadline).foregroundStyle(ADEColor.textSecondary)
            }
            ForEach(list) { commit in
              CloudCommitRow(commit: commit)
              if commit.id != list.last?.id { Divider().opacity(0.5) }
            }
          }
        }
      }
    }
  }

  private var historyHint: String? {
    guard case .loaded? = commits else { return nil }
    return "Pushed commits, from GitHub"
  }

  private func unpushedLine(_ summary: CloudGitSummary) -> some View {
    var parts: [String] = []
    if summary.ahead > 0 { parts.append("\(summary.ahead) \(summary.ahead == 1 ? "commit" : "commits") not pushed") }
    if summary.dirty { parts.append("changes not committed") }
    return HStack(alignment: .top, spacing: 8) {
      Image(systemName: "arrow.up.circle")
        .foregroundStyle(ADEColor.warning)
        .accessibilityHidden(true)
      Text("On the lane only: \(parts.joined(separator: ", ")). They show on GitHub after the lane's computer pushes.")
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  // MARK: Reads and the one action

  private func load(force: Bool) async {
    await store.refreshSummary(machineKey: subject.accountMachineKey, laneId: subject.laneId, using: syncService, force: force)
    await loadCommits(force: force)
  }

  private func loadCommits(force: Bool) async {
    guard let repo = subject.repo, let branch else { return }
    if !force, commits != nil || commitsError != nil { return }
    switch await GitHubDirectClient.shared.listCommits(repo, ref: branch) {
    case .success(let list):
      commits = .loaded(list)
      commitsError = nil
    case .failure(let error):
      if githubDirectIsMissingRef(error) {
        commits = .missing
        commitsError = nil
      } else if cloudGitHubReadCopy(error, repo: repo) != nil {
        commitsError = error
      } else {
        commits = .failed("GitHub didn't answer. Pull down to try again.")
      }
    }
  }

  /// A doing action: wakes the lane's computer. Once it is up, the lane's
  /// live detail takes this one's place.
  private func wake() async {
    guard !waking else { return }
    waking = true
    wakeError = nil
    let up = await syncService.machineFleet?.connect(machineKey: subject.fleetKey, timeout: .seconds(150)) ?? false
    waking = false
    if up {
      ADEHaptics.success()
      await onAwake()
    } else {
      wakeError = syncService.cloudWakeFailure(fleetKey: subject.fleetKey) ?? "The lane's computer didn't come up. Try again."
    }
  }
}

// MARK: - Git summary

/// Branch, ahead and behind, and the changed files with their line counts.
struct CloudGitSummaryView: View {
  let summary: CloudGitSummary
  var onOpenFile: (CloudGitChangedFile) -> Void = { _ in }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 14) {
        figure("Ahead", summary.ahead, symbol: "arrow.up")
        figure("Behind", summary.behind, symbol: "arrow.down")
        figure("Changed", summary.changed.count, symbol: "doc.badge.ellipsis", suffix: summary.truncated ? "+" : "")
        Spacer(minLength: 0)
        if !summary.changed.isEmpty {
          Text("+\(summary.addedLines) −\(summary.removedLines)")
            .font(.adeMono(12))
            .foregroundStyle(ADEColor.textSecondary)
        }
      }
      if let upstream = nonEmptyTrimmed(summary.upstream) {
        Text("Tracks \(upstream)")
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
      }
      if summary.changed.isEmpty {
        Text(summary.dirty ? "The lane has changes, but its computer saved no file list." : "No changes that GitHub doesn't have.")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
      } else {
        VStack(spacing: 0) {
          ForEach(summary.changed, id: \.path) { file in
            Button { onOpenFile(file) } label: { CloudChangedFileRow(file: file) }
              .buttonStyle(.plain)
              .accessibilityHint("Wakes the lane's computer to open its copy")
            if file.path != summary.changed.last?.path { Divider().opacity(0.5) }
          }
        }
        if summary.truncated {
          Text("More files changed than ADE Cloud keeps. Wake the lane's computer for the full list.")
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }

  private func figure(_ label: String, _ value: Int, symbol: String, suffix: String = "") -> some View {
    HStack(spacing: 4) {
      Image(systemName: symbol)
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(ADEColor.textMuted)
        .accessibilityHidden(true)
      Text("\(value)\(suffix)")
        .font(.system(size: 15, weight: .semibold, design: .monospaced))
        .foregroundStyle(ADEColor.textPrimary)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(label): \(value)\(suffix)")
  }
}

struct CloudChangedFileRow: View {
  let file: CloudGitChangedFile

  var body: some View {
    HStack(spacing: 10) {
      Text(cloudChangeLetter(file.kind))
        .font(.system(size: 11, weight: .bold, design: .monospaced))
        .foregroundStyle(cloudChangeColor(file.kind))
        .frame(width: 16)
        .accessibilityLabel(cloudChangeWord(file.kind))
      VStack(alignment: .leading, spacing: 1) {
        Text((file.path as NSString).lastPathComponent)
          .font(.system(size: 14))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        let folder = (file.path as NSString).deletingLastPathComponent
        if !folder.isEmpty {
          Text(folder)
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
            .truncationMode(.head)
        }
      }
      Spacer(minLength: 8)
      Text("+\(file.added) −\(file.removed)")
        .font(.adeMono(11))
        .foregroundStyle(ADEColor.textSecondary)
    }
    .padding(.vertical, 8)
    .contentShape(Rectangle())
  }
}

func cloudChangeLetter(_ kind: CloudGitChangedFile.Kind) -> String {
  switch kind {
  case .added: return "A"
  case .modified: return "M"
  case .deleted: return "D"
  case .renamed: return "R"
  }
}

func cloudChangeWord(_ kind: CloudGitChangedFile.Kind) -> String {
  switch kind {
  case .added: return "Added"
  case .modified: return "Changed"
  case .deleted: return "Deleted"
  case .renamed: return "Renamed"
  }
}

func cloudChangeColor(_ kind: CloudGitChangedFile.Kind) -> Color {
  switch kind {
  case .added: return ADEColor.success
  case .modified: return ADEColor.warning
  case .deleted: return ADEColor.danger
  case .renamed: return ADEColor.accent
  }
}

struct CloudCommitRow: View {
  let commit: GitHubDirectCommit
  @Environment(\.openURL) private var openURL

  var body: some View {
    Button {
      if let url = commit.htmlUrl { openURL(url) }
    } label: {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Text(commit.shortSha)
          .font(.adeMono(11))
          .foregroundStyle(ADEColor.textMuted)
        VStack(alignment: .leading, spacing: 2) {
          Text(commit.title)
            .font(.system(size: 14))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(2)
          Text([commit.author, commit.date.map { $0.formatted(.relative(presentation: .named)) }].compactMap { $0 }.joined(separator: ", "))
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
        Spacer(minLength: 0)
      }
      .padding(.vertical, 8)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(commit.htmlUrl == nil)
  }
}

/// "As of 3 min ago" for a time the server gives in ms.
func cloudAtRestTime(ms: Double, now: Date = Date()) -> String {
  Date(timeIntervalSince1970: ms / 1000).formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
}

/// What a GitHub read of a lane's branch says when ADE can't read the
/// repository: the person fixes it with Connect or on GitHub. Nil for a
/// read that failed for any other reason. Pure.
func cloudGitHubReadCopy(_ error: GitHubDirectError, repo: GitHubDirectRepoRef?) -> GitHubDirectStateCopy? {
  if error.kind == .rateLimited {
    let time = error.retryAt.map { $0.formatted(date: .omitted, time: .shortened) }
    return GitHubDirectStateCopy(
      title: "GitHub rate limit reached",
      body: time.map { "GitHub asks ADE to wait. Files and commits load again at \($0)." } ?? "GitHub asks ADE to wait. Try again in a few minutes."
    )
  }
  guard githubDirectIsPersonState(error.kind),
        let copy = githubDirectStateCopy(error, owner: repo?.owner, name: repo?.name) else { return nil }
  return GitHubDirectStateCopy(
    title: "ADE can't read this repository on GitHub",
    body: copy.body,
    primary: copy.primary ?? .connect("Connect GitHub"),
    secondary: copy.primary == nil ? nil : copy.secondary
  )
}

// MARK: - Files from GitHub

/// The branch's files on GitHub, one folder at a time, in a sheet of its
/// own. Files the lane changed carry a mark from the Git summary; opening
/// one is a doing action that wakes the lane's computer.
struct CloudLaneFilesSheet: View {
  let repo: GitHubDirectRepoRef
  let branch: String
  let summary: CloudGitSummary?
  let fleetKey: String
  let onAwake: @MainActor () async -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var path: [CloudFilesRoute] = []

  var body: some View {
    NavigationStack(path: $path) {
      CloudLaneFolderScreen(
        repo: repo, branch: branch, folder: "", summary: summary, fleetKey: fleetKey,
        onAwake: {
          dismiss()
          await onAwake()
        }
      )
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button(role: .close) { dismiss() }
            .accessibilityLabel("Close")
        }
      }
      .navigationDestination(for: CloudFilesRoute.self) { route in
        switch route {
        case .folder(let folder):
          CloudLaneFolderScreen(
            repo: repo, branch: branch, folder: folder, summary: summary, fleetKey: fleetKey,
            onAwake: {
              dismiss()
              await onAwake()
            }
          )
        case .file(let filePath):
          CloudGitHubFileScreen(repo: repo, branch: branch, path: filePath, changed: summary?.changed.first { $0.path == filePath })
        }
      }
    }
    .adeInspectable("CloudLane.Files")
  }
}

enum CloudFilesRoute: Hashable {
  case folder(String)
  case file(String)
}

struct CloudLaneFolderScreen: View {
  let repo: GitHubDirectRepoRef
  let branch: String
  /// The folder's path in the repository; "" for the top.
  let folder: String
  let summary: CloudGitSummary?
  let fleetKey: String
  let onAwake: @MainActor () async -> Void
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }
  @State private var entries: [GitHubDirectContentEntry]?
  @State private var error: GitHubDirectError?
  @State private var missingBranch = false
  @State private var changedFileAsk: CloudGitChangedFile?
  @State private var waking = false
  @State private var wakeError: String?
  /// A changed file the person chose to read as GitHub has it.
  @State private var gitHubCopyPath: String?

  private var changedByPath: [String: CloudGitChangedFile] {
    Dictionary((summary?.changed ?? []).map { ($0.path, $0) }, uniquingKeysWith: { first, _ in first })
  }

  /// Folders that hold a changed file, at any depth.
  private var changedFolders: Set<String> {
    var out = Set<String>()
    for path in changedByPath.keys {
      var parts = path.split(separator: "/").map(String.init)
      parts.removeLast()
      while !parts.isEmpty {
        out.insert(parts.joined(separator: "/"))
        parts.removeLast()
      }
    }
    return out
  }

  /// Changed files in this folder that GitHub doesn't list (new on the lane).
  private var laneOnlyFiles: [CloudGitChangedFile] {
    guard let entries else { return [] }
    let listed = Set(entries.map(\.path))
    return (summary?.changed ?? []).filter { file in
      (file.path as NSString).deletingLastPathComponent == folder && !listed.contains(file.path) && file.kind != .deleted
    }
  }

  var body: some View {
    List {
      if folder.isEmpty {
        Section {
          HStack(spacing: 6) {
            ADEBrandTile(brand: .github, size: 20)
            Text("\(repo.owner)/\(repo.name)")
              .font(.subheadline.weight(.medium))
              .foregroundStyle(ADEColor.textPrimary)
            ADEKitChip(symbol: "arrow.triangle.branch", text: branch, mono: true)
          }
          .listRowBackground(Color.clear)
        }
      }
      if let error, let copy = cloudGitHubReadCopy(error, repo: repo) {
        Section {
          GitHubStateCard(copy: copy)
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            .listRowBackground(Color.clear)
        }
      } else if missingBranch {
        Section {
          Text("\(branch) isn't on GitHub yet. Here are the lane's changes as its computer saved them. Wake the lane's computer to push the branch.")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
          if let summary {
            CloudGitSummaryView(summary: summary, onOpenFile: { changedFileAsk = $0 })
          }
        }
      } else if error != nil {
        Section {
          Text("GitHub didn't answer. Pull down to try again.")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
        }
      } else if let entries {
        if !laneOnlyFiles.isEmpty {
          Section("New on the lane") {
            ForEach(laneOnlyFiles, id: \.path) { file in
              Button { changedFileAsk = file } label: { CloudChangedFileRow(file: file) }
                .buttonStyle(.plain)
            }
          }
        }
        Section {
          if entries.isEmpty {
            Text("This folder is empty on GitHub.")
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)
          }
          ForEach(entries) { entry in
            entryRow(entry)
          }
        }
      } else {
        Section {
          HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text("Reading the folder from GitHub…").foregroundStyle(ADEColor.textSecondary)
          }
        }
      }
      if let wakeError {
        Section {
          Text(wakeError).font(.footnote).foregroundStyle(ADEColor.danger)
        }
      }
    }
    .listStyle(.insetGrouped)
    .scrollContentBackground(.hidden)
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .navigationTitle(folder.isEmpty ? "Files" : (folder as NSString).lastPathComponent)
    .navigationBarTitleDisplayMode(.inline)
    .refreshable { await load() }
    .task { if entries == nil, error == nil, !missingBranch { await load() } }
    .overlay {
      if waking {
        ProgressView("Waking the lane's computer…")
          .padding(20)
          .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
      }
    }
    .navigationDestination(item: $gitHubCopyPath) { filePath in
      CloudGitHubFileScreen(repo: repo, branch: branch, path: filePath, changed: changedByPath[filePath])
    }
    .confirmationDialog(
      "Open the lane's copy?",
      isPresented: Binding(get: { changedFileAsk != nil }, set: { if !$0 { changedFileAsk = nil } }),
      titleVisibility: .visible,
      presenting: changedFileAsk
    ) { file in
      Button("Wake and open") { Task { await wake() } }
      if file.kind != .added, !missingBranch {
        Button("Open the GitHub copy") { gitHubCopyPath = file.path }
      }
      Button("Cancel", role: .cancel) {}
    } message: { file in
      Text("\(file.path) changed on the lane and GitHub doesn't have the change. Opening the lane's copy wakes its computer, which uses \(CloudBalanceWords.current.cloudUnit).")
    }
  }

  @ViewBuilder
  private func entryRow(_ entry: GitHubDirectContentEntry) -> some View {
    let changed = changedByPath[entry.path]
    let row = HStack(spacing: 10) {
      Image(systemName: entry.isFolder ? "folder.fill" : "doc.text")
        .font(.system(size: 14))
        .foregroundStyle(entry.isFolder ? ADEColor.accent : ADEColor.textMuted)
        .frame(width: 20)
        .accessibilityHidden(true)
      Text(entry.name)
        .font(.system(size: 15))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
        .truncationMode(.middle)
      Spacer(minLength: 6)
      if let changed {
        Text("+\(changed.added) −\(changed.removed)")
          .font(.adeMono(11))
          .foregroundStyle(ADEColor.textSecondary)
        ADEKitDot(color: cloudChangeColor(changed.kind), size: 7)
          .accessibilityLabel("\(cloudChangeWord(changed.kind)) on the lane")
      } else if entry.isFolder, changedFolders.contains(entry.path) {
        ADEKitDot(color: ADEColor.warning, size: 7)
          .accessibilityLabel("Holds changes on the lane")
      }
    }
    .contentShape(Rectangle())
    if entry.isFolder {
      NavigationLink(value: CloudFilesRoute.folder(entry.path)) { row }
    } else if let changed {
      Button { changedFileAsk = changed } label: { row }
        .buttonStyle(.plain)
    } else if entry.type == "file" {
      NavigationLink(value: CloudFilesRoute.file(entry.path)) { row }
    } else {
      row.opacity(0.6)
    }
  }

  private func load() async {
    switch await GitHubDirectClient.shared.listFolder(repo, path: folder, ref: branch) {
    case .success(let list):
      entries = list
      error = nil
      missingBranch = false
    case .failure(let failure):
      if githubDirectIsMissingRef(failure), folder.isEmpty {
        // The branch was never pushed: the summary is all there is.
        missingBranch = true
        error = nil
      } else {
        error = failure
      }
    }
  }

  private func wake() async {
    guard !waking else { return }
    waking = true
    wakeError = nil
    let up = await syncService.machineFleet?.connect(machineKey: fleetKey, timeout: .seconds(150)) ?? false
    waking = false
    if up {
      ADEHaptics.success()
      await onAwake()
    } else {
      wakeError = syncService.cloudWakeFailure(fleetKey: fleetKey) ?? "The lane's computer didn't come up. Try again."
    }
  }
}

/// One file's text as GitHub has it at the branch, read-only.
struct CloudGitHubFileScreen: View {
  let repo: GitHubDirectRepoRef
  let branch: String
  let path: String
  /// Set when the lane changed this file: the GitHub copy is the older one.
  let changed: CloudGitChangedFile?
  @Environment(\.openURL) private var openURL
  @State private var file: GitHubDirectFile?
  @State private var error: GitHubDirectError?

  private var lines: [Substring] {
    file?.text?.split(separator: "\n", omittingEmptySubsequences: false) ?? []
  }

  var body: some View {
    Group {
      if let error {
        VStack {
          if let copy = cloudGitHubReadCopy(error, repo: repo) {
            GitHubStateCard(copy: copy).padding(16)
          } else {
            ADEEmptyStateView(symbol: "doc.badge.questionmark", title: "File unavailable", message: "GitHub has no file at \(path) on \(branch).")
          }
          Spacer(minLength: 0)
        }
      } else if let file {
        if file.tooLarge || file.text == nil {
          ADEEmptyStateView(
            symbol: "doc",
            title: file.tooLarge ? "Too large to show here" : "Not a text file",
            message: file.tooLarge
              ? "Files over 1 MB open on GitHub."
              : "This file isn't text, so it opens on GitHub."
          ) {
            if let url = file.htmlUrl {
              Button("Open on GitHub") { openURL(url) }
                .buttonStyle(ADEKitButtonStyle(prominent: true))
            }
          }
        } else {
          ScrollView([.vertical, .horizontal]) {
            LazyVStack(alignment: .leading, spacing: 0) {
              ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                  Text("\(index + 1)")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(ADEColor.textMuted)
                    .frame(minWidth: 32, alignment: .trailing)
                  Text(line.isEmpty ? " " : String(line))
                    .font(.system(size: 12.5, design: .monospaced))
                    .foregroundStyle(ADEColor.textPrimary)
                    .fixedSize(horizontal: true, vertical: false)
                }
              }
            }
            .padding(12)
            .textSelection(.enabled)
          }
          // Long lines stop at the side controls (iPhone Duo closed), not under them.
          .clipped()
        }
      } else {
        ProgressView("Reading the file from GitHub…")
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .safeAreaInset(edge: .top, spacing: 0) {
      if changed != nil {
        HStack(alignment: .top, spacing: 8) {
          Image(systemName: "exclamationmark.circle")
            .foregroundStyle(ADEColor.warning)
            .accessibilityHidden(true)
          Text("This is the GitHub copy. The lane changed this file, and the change isn't on GitHub yet.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
          Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(ADEColor.recessedBackground)
      }
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .navigationTitle((path as NSString).lastPathComponent)
    .navigationBarTitleDisplayMode(.inline)
    .task {
      guard file == nil, error == nil else { return }
      switch await GitHubDirectClient.shared.fileContent(repo, path: path, ref: branch) {
      case .success(let value): file = value
      case .failure(let failure): error = failure
      }
    }
  }
}
