import SwiftUI

/// The step between a pick and the move: what goes where, each chat with how
/// much of its history arrives, that the work comes along and nothing is
/// pushed, a clone when the destination has no copy, and for an ADE Cloud
/// lane, that its computer is deleted only once everything arrived. Once the
/// move starts, the same screen follows it.
struct LaneMoveReviewView: View {
  let source: LaneMoveSource
  let target: LaneMoveTarget
  /// The lane's brain for a live move; the destination for a restore.
  let route: LaneMoveRoute?
  /// A live move: what it carries, from the lane's own lists.
  let items: [LaneMoveItem]
  let changes: AgentChatCrossMachineHandoffChanges?
  let initialRunId: String?
  /// Closes the whole sheet; the move goes on.
  let close: () -> Void
  /// Wakes the asleep ADE Cloud computer, for a live move instead.
  var wake: (() -> Void)? = nil
  let backend: any LaneMoveBackend
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  /// The cloud account, for its unit.
  @ObservedObject private var cloudStore = AccountCloudStore.shared
  @ObservedObject private var runs = LaneMoveRuns.shared
  private var syncService: SyncService { syncPublishes.service }
  @State private var preview: CloudKeptLaneRestorePreview?
  @State private var previewError: String?
  @State private var runId: String?
  @State private var starting = false
  @State private var startError: String?
  @State private var retrying = false
  /// The destination refused a move from the asleep computer's saved copy
  /// before it started (the computer woke, or its copy changed): the move
  /// can wake it instead.
  @State private var startRefused = false

  private var restores: Bool { source.restores }
  private var run: LaneMoveRun? { runs.run(id: runId ?? initialRunId) }
  private var rows: [LaneMoveItem] { restores ? (preview?.items ?? []) : items }
  private var deletesComputer: Bool { !restores && source.deletesComputer }
  /// Another move of this lane is under way or waits to be closed: this
  /// review can't start a second one.
  private var otherRunOpen: Bool { run == nil && runs.openRun(source: source)?.blocksNewMove == true }

  /// The asleep computer's saved copy doesn't hold all of the lane's work,
  /// so the move wakes it instead.
  private var savedCopyIncomplete: Bool {
    source.fromComputer != nil && preview?.fromComputer?.saved == false
  }

  /// The files git ignores on the ADE Cloud computer the move deletes.
  private var ignoredNote: String? {
    guard !savedCopyIncomplete else { return nil }
    if source.fromComputer != nil {
      guard let preview else { return nil }
      return laneMoveIgnoredFilesNote(preview.fromComputer?.ignored, asleep: true)
    }
    guard deletesComputer, let instanceId = source.computer?.instanceId else { return nil }
    let ignored = syncService.cloudServerInstances.first { $0.id == instanceId }?.ignoredFiles
    return laneMoveIgnoredFilesNote(ignored, asleep: false)
  }

  var body: some View {
    List {
      if let run {
        progress(run)
      } else {
        review
      }
    }
    .listStyle(.insetGrouped)
    .scrollContentBackground(.hidden)
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .navigationTitle("Move to \(target.name)")
    .navigationBarTitleDisplayMode(.inline)
    .safeAreaInset(edge: .bottom, spacing: 0) { actionBar }
    .interactiveDismissDisabled(starting)
    .task { await loadPreview() }
    .adeInspectable(run == nil ? "Lanes.Move.Review" : "Lanes.Move.Progress")
  }

  // MARK: Review

  @ViewBuilder
  private var review: some View {
    Section {
    } header: {
      Text("From \(source.machineName). Everything on \(source.laneName) moves together.")
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
        .textCase(nil)
        .fixedSize(horizontal: false, vertical: true)
    }
    if restores, preview == nil {
      Section {
        if let previewError {
          Text(previewError)
            .font(.subheadline)
            .foregroundStyle(ADEColor.danger)
            .fixedSize(horizontal: false, vertical: true)
          Button("Try again") { Task { await loadPreview(force: true) } }
          if source.fromComputer != nil, let wake {
            Button("Wake and move") { wake() }
              .adeInspectable("Lanes.Move.WakeInstead")
          }
        } else {
          HStack(spacing: 10) {
            ProgressView()
            Text("Reading the lane…").foregroundStyle(ADEColor.textSecondary)
          }
        }
      }
    } else {
      Section {
        if rows.isEmpty {
          Text(restores
            ? "No chats or CLI sessions come back with it. The branch and its work do."
            : "This lane has no chats or CLI sessions to move.")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
        }
        ForEach(rows) { item in
          LaneMoveItemRow(item: item, state: nil)
        }
      } header: {
        Text("What moves").textCase(nil)
      } footer: {
        let deletes = deletesComputer || source.fromComputer != nil
        if let note = laneMoveSummaryNote(items: rows, sourceMachineName: source.machineName, deletesComputer: deletes, restores: restores) {
          Text(note)
            .foregroundStyle(deletes ? ADEColor.warning : ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Section {
        LaneMoveFactRow(symbol: "arrow.triangle.branch", text: laneMoveBranchSentence(workPhrase: workPhrase))
        if !restores, target.hasRepository == false {
          LaneMoveFactRow(
            symbol: "square.and.arrow.down",
            text: "\(target.name) doesn't have this project yet. \(Brand.name) clones it from GitHub first, into the folder beside its newest project. To use another folder, open the project there first."
          )
        }
        if restores, preview?.hasRepository == false {
          LaneMoveFactRow(
            symbol: "exclamationmark.triangle",
            text: "This project on \(target.name) isn't the lane's repository. Open a clone of it there, then move the lane there.",
            tone: ADEColor.warning
          )
        }
        if restores, let blocked = preview?.blocked, !blocked.isEmpty {
          LaneMoveFactRow(
            symbol: "exclamationmark.triangle",
            text: blocked.count == 1
              ? "“\(blockedTitle(blocked[0]))” is on another computer of yours now."
              : "\(blocked.count) chats are on other computers of yours now.",
            detail: "They don't come here, so the lane stays on \(ADECloudMachine.name) too. Finish their move there, then move the lane again.",
            tone: ADEColor.warning
          )
        }
        if savedCopyIncomplete {
          LaneMoveFactRow(
            symbol: "exclamationmark.triangle.fill",
            text: "\(nonEmptyTrimmed(preview?.fromComputer?.reason) ?? "The computer's saved copy doesn't hold all of this lane's work.") So \(Brand.name) wakes the computer and moves the lane from there. \(CloudBalanceWords(cloudStore.account).wakingUses)",
            tone: ADEColor.warning
          )
        } else if source.fromComputer != nil {
          LaneMoveFactRow(
            symbol: "trash",
            text: "The \(ADECloudMachine.name) computer stays asleep. It saved all of this lane's work when it went to sleep, so \(Brand.name) deletes it first and brings the lane back from that saved copy. If anything fails after that, the lane stays in your account and you can move it again."
          )
        } else if deletesComputer {
          LaneMoveFactRow(
            symbol: "trash",
            text: "When everything has arrived and \(Brand.name) has checked it, \(Brand.name) deletes this lane's \(ADECloudMachine.name) computer and the saved copies of the chats that moved. If anything fails, the computer stays."
          )
        }
        if let ignoredNote {
          LaneMoveFactRow(symbol: "eye.slash", text: ignoredNote)
        }
      }
      if otherRunOpen {
        Section {
          Text("This lane already has a move. Close it first, then pick where the lane goes.")
            .font(.subheadline)
            .foregroundStyle(ADEColor.warning)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      if let startError {
        Section {
          Text(startError)
            .font(.subheadline)
            .foregroundStyle(ADEColor.danger)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }

  private var workPhrase: String? {
    if restores {
      guard let work = preview?.work else { return nil }
      return laneMoveWorkPhrase(commits: work.unpushedCommits ?? 0, files: work.changedFiles ?? 0)
        ?? "the work this lane saved when its computer stopped"
    }
    guard let changes else { return nil }
    return laneMoveWorkPhrase(commits: changes.unpushedCommits, files: changes.changedFiles)
  }

  private var canMove: Bool {
    guard !starting, target.ready, route != nil, !otherRunOpen else { return false }
    // A move from saved copies brings the branch and work even with no chats.
    if restores { return preview?.hasRepository == true && !savedCopyIncomplete }
    return !rows.isEmpty
  }

  private func blockedTitle(_ chat: CloudKeptLaneRestorePreview.Blocked) -> String {
    nonEmptyTrimmed(chat.title) ?? (chat.kind == "cli" ? "CLI session" : "Untitled chat")
  }

  // MARK: Progress

  @ViewBuilder
  private func progress(_ run: LaneMoveRun) -> some View {
    let parts = run.kind == .live
      ? laneMoveProgressRows(batch: run.batch, review: items)
      : laneMoveProgressRows(restore: run.restore, review: preview?.items ?? [])
    let arrived = parts.filter { $0.state == .arrived }.count
    let ended = run.phase == .failed || run.phase == .deleteFailed || run.phase == .moveAgain || run.phase == .pushFirst
    let failure = parts.first(where: { $0.state == .failed && $0.error != nil })?.error ?? run.error
    Section {
      VStack(alignment: .leading, spacing: 6) {
        Text(status(run, arrived: arrived, total: parts.count))
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ended ? ADEColor.warning : ADEColor.textPrimary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityAddTraits(.updatesFrequently)
        if run.wakesInstead, let reason = nonEmptyTrimmed(failure) {
          // The server's reason; nothing moved, so there are no rows to show.
          Text(reason)
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        if run.phase == .moving || run.phase == .deleting {
          Text("You can close this. The move goes on, and each chat shows its own progress.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .padding(.vertical, 2)
    }
    // A refused release moved nothing and deleted nothing: no rows.
    if !run.wakesInstead, !parts.isEmpty {
      Section {
        ForEach(parts) { part in
          LaneMoveItemRow(item: part.item, state: part.state)
        }
      } footer: {
        if let failure, ended {
          Text(failure).fixedSize(horizontal: false, vertical: true)
        } else if run.phase == .moving, let error = run.error {
          // A read that failed: the move goes on there; this phone reads again.
          Text("Checking again soon. \(error)").fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }

  private func status(_ run: LaneMoveRun, arrived: Int, total: Int) -> String {
    let cloud = ADECloudMachine.name
    if run.wakesInstead {
      return "\(Brand.name) didn't use the saved copy, and nothing was deleted. Wake the \(cloud) computer to move the lane from there."
    }
    switch run.phase {
    case .moving:
      if run.kind == .restore, run.restore?.step == "release" {
        return "Deleting the asleep \(cloud) computer and keeping its lane…"
      }
      return total > 0 ? "Moving: \(arrived) of \(total) \(total == 1 ? "part" : "parts") arrived." : "Starting the move…"
    case .deleting: return "Everything arrived. Deleting the \(cloud) computer…"
    case .done: return run.deletesComputer ? "Moved. The \(cloud) computer is deleted." : "Moved. Everything arrived."
    case .deleteFailed: return "Everything arrived, but the \(cloud) computer is still there."
    case .moveAgain: return "Everything the move carried arrived. The lane on \(cloud) has more since, so its computer is kept. Move the lane again to bring it."
    case .pushFirst: return "Everything the move carried arrived, but the lane's files on \(cloud) may have changed since, so its computer is kept. Push to GitHub and delete commits the lane's files there, pushes them to its branch, checks nothing is left off GitHub, then deletes the computer. Then pull the branch on \(run.targetName)."
    case .failed:
      if run.computer != nil { return "Not all of it arrived. The \(cloud) computer is kept, so nothing is lost." }
      if run.kind == .restore, run.fromComputer != nil { return "Not all of it arrived. The lane stays in your account, so nothing is lost." }
      return "Not all of it arrived."
    }
  }

  // MARK: Actions

  /// The screen's one main action, below the list where the thumb is.
  @ViewBuilder
  private var actionBar: some View {
    VStack(spacing: 8) {
      if let run {
        switch run.phase {
        case .failed where run.wakesInstead:
          if let wake {
            Button {
              runs.dismiss(id: run.id)
              wake()
            } label: {
              Text("Wake and move")
            }
            .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
            .adeInspectable("Lanes.Move.WakeInstead")
          }
          Button("Close") {
            runs.dismiss(id: run.id)
            close()
          }
          .buttonStyle(ADEKitButtonStyle(wide: true))
        case .failed:
          Button {
            Task { await retry(run) }
          } label: {
            HStack(spacing: 6) {
              if retrying { ProgressView().controlSize(.small).tint(.white) }
              Text("Try again")
            }
          }
          .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
          .disabled(retrying)
          .adeInspectable("Lanes.Move.Retry")
          Button("Close") {
            runs.dismiss(id: run.id)
            close()
          }
          .buttonStyle(ADEKitButtonStyle(wide: true))
        case .deleteFailed:
          Button {
            ADEHaptics.light()
            runs.retryDelete(id: run.id)
          } label: {
            Label("Delete \(ADECloudMachine.name) computer", systemImage: "trash")
          }
          .buttonStyle(ADEKitButtonStyle(tone: .crit, wide: true))
          .adeInspectable("Lanes.Move.RetryDelete")
          Button("Close") { close() }
            .buttonStyle(ADEKitButtonStyle(wide: true))
        case .pushFirst:
          Button {
            ADEHaptics.light()
            runs.pushAndDelete(id: run.id)
          } label: {
            Label("Push to GitHub and delete", systemImage: "arrow.up.circle")
          }
          .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
          .adeInspectable("Lanes.Move.PushAndDelete")
          // Keeps the computer: the run ends; the computer's own screen can still delete it.
          Button("Keep computer") {
            runs.dismiss(id: run.id)
            close()
          }
          .buttonStyle(ADEKitButtonStyle(wide: true))
          .adeInspectable("Lanes.Move.KeepComputer")
        case .moveAgain:
          // Nothing to retry: Close ends this run, and the lane's sheet starts a fresh move.
          Button("Close") {
            runs.dismiss(id: run.id)
            close()
          }
          .buttonStyle(ADEKitButtonStyle(wide: true))
          .adeInspectable("Lanes.Move.MoveAgainClose")
        case .moving, .deleting, .done:
          Button(run.phase == .done ? "Done" : "Close") { close() }
            .buttonStyle(ADEKitButtonStyle(wide: true))
        }
      } else if savedCopyIncomplete || startRefused, let wake {
        Button {
          wake()
        } label: {
          Text("Wake and move")
        }
        .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
        .adeInspectable("Lanes.Move.WakeInstead")
        if !savedCopyIncomplete {
          Button {
            Task { await start() }
          } label: {
            HStack(spacing: 6) {
              if starting { ProgressView().controlSize(.small) }
              Text("Move from the saved copy")
            }
          }
          .buttonStyle(ADEKitButtonStyle(wide: true))
          .disabled(!canMove)
          .adeInspectable("Lanes.Move.Confirm")
        }
      } else {
        Button {
          Task { await start() }
        } label: {
          HStack(spacing: 6) {
            if starting { ProgressView().controlSize(.small).tint(.white) }
            Text(starting ? "Starting the move…" : "Move lane")
          }
        }
        .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
        .disabled(!canMove)
        .adeInspectable("Lanes.Move.Confirm")
      }
    }
    .padding(.horizontal, 16)
    .padding(.top, 10)
    .padding(.bottom, 8)
    .frame(maxWidth: 560)
    .frame(maxWidth: .infinity)
    .background(.bar)
  }

  private func loadPreview(force: Bool = false) async {
    guard restores, run == nil || force else { return }
    guard let route else {
      previewError = "\(target.name) can't be reached from the phone."
      return
    }
    previewError = nil
    do {
      preview = try await backend.preview(route: route, source: source)
    } catch {
      previewError = SyncUserFacingError.message(for: error)
    }
  }

  private func start() async {
    guard canMove, let route else { return }
    starting = true
    startError = nil
    defer { starting = false }
    do {
      let started = try await backend.start(LaneMoveStartRequest(
        source: source,
        target: target,
        route: route,
        sessionIds: rows.map(\.id),
        deletesComputer: deletesComputer
      ))
      if let started { runId = started }
      ADEHaptics.success()
    } catch {
      startError = SyncUserFacingError.message(for: error)
      ADEHaptics.error()
      if source.fromComputer != nil, wake != nil {
        // The saved copy may no longer do: offer the wake, and read the copy again.
        startRefused = true
        await loadPreview(force: true)
      }
    }
  }

  private func retry(_ run: LaneMoveRun) async {
    guard !retrying else { return }
    retrying = true
    defer { retrying = false }
    do {
      runId = try await runs.retry(id: run.id)
    } catch {
      CloudLaneActions.shared.toast = ADEToastMessage(
        text: "Couldn't try the move again",
        kind: .failure,
        detail: SyncUserFacingError.message(for: error)
      )
      ADEHaptics.error()
    }
  }
}
