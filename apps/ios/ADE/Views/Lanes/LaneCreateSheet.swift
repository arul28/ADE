import SwiftUI

/// Where a new lane is created: a project on another machine.
struct LaneCreateTarget: Equatable {
  /// A machine-marked project id (`syncFleetMarkedProjectId`).
  let projectId: String
  let rootPath: String?
}

/// Machines to create a lane on, least busy first; ties keep the given order
/// (the focused machine first).
func machineChoicesLeastBusyFirst<Choice>(_ choices: [Choice], runningCount: (Choice) -> Int) -> [Choice] {
  choices.enumerated()
    .sorted { (runningCount($0.element), $0.offset) < (runningCount($1.element), $1.offset) }
    .map(\.element)
}

/// A machine choice's second line: its running chats, and "least busy" first.
func machineChoiceSubtitle(runningCount: Int, isLeastBusy: Bool) -> String {
  let running = runningCount == 0 ? "Nothing running" : "\(runningCount) running"
  return isLeastBusy ? "\(running) · least busy" : running
}

/// A branch name as the user would type it: no `refs/heads/`, `refs/remotes/<remote>/`
/// or `origin/` prefix (`plainLaneStartBranch` in `shared/laneStart.ts`).
func plainLaneStartBranch(_ value: String?) -> String {
  var name = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  if name.hasPrefix("refs/heads/") {
    name = String(name.dropFirst("refs/heads/".count))
  } else if name.hasPrefix("refs/remotes/") {
    name = String(name.dropFirst("refs/remotes/".count))
    if let slash = name.firstIndex(of: "/") {
      name = String(name[name.index(after: slash)...])
    }
  } else if name.hasPrefix("origin/") {
    name = String(name.dropFirst("origin/".count))
  }
  return name
}

/// The lane that has `branch` checked out: the folder "Local + uncommitted"
/// copies from, and the lane an existing branch is already open in.
func laneHoldingBranch(_ branch: String, lanes: [LaneSummary]) -> LaneSummary? {
  guard !branch.isEmpty else { return nil }
  return lanes.first { $0.archivedAt == nil && plainLaneStartBranch($0.branchRef) == branch }
}

/// How a lane reads in a sentence: the primary lane is "Primary".
func laneHolderLabel(_ lane: LaneSummary) -> String {
  lane.laneType == "primary" ? "Primary" : lane.name
}

/// What each "Bring" choice means for the branch the lane starts from.
func laneStartBringHint(_ bring: LaneStart.Bring, refLabel: String, holder: LaneSummary?) -> String {
  switch bring {
  case .pushed:
    return refLabel.isEmpty
      ? "Fetches first, then branches from the remote copy."
      : "Fetches first, then branches from \(refLabel)."
  case .local:
    return refLabel.isEmpty
      ? "Branches from your local copy, including commits you haven't pushed."
      : "Branches from your local \(refLabel), including commits you haven't pushed."
  case .uncommitted:
    guard let holder else { return "Copies uncommitted changes from the lane that has this branch open." }
    let place = laneHolderLabel(holder)
    return "Branches from your local \(refLabel) and copies the uncommitted changes in \(place). \(place) keeps them too."
  }
}

struct LaneCreateSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let primaryLane: LaneSummary?
  let lanes: [LaneSummary]
  let showsModePicker: Bool
  /// The project on another machine that a new lane goes to (a machine-marked
  /// project id). Nil for the focused machine.
  let target: LaneCreateTarget?
  let onComplete: @MainActor (String) async -> Void

  @State private var name = ""
  @State private var description = ""
  @State private var createMode: LaneCreateMode
  /// New branch: where it starts and what it brings. Pre-filled from the
  /// project's saved defaults unless the caller passed a start.
  @State private var start: LaneStart
  @State private var startIsPreset: Bool
  @State private var defaults: NewLaneDefaultsSnapshot?
  @State private var showsBranchList = false
  @State private var branchQuery = ""
  /// Existing branch: the branch the lane works on.
  @State private var selectedImportBranch = ""
  @State private var autoNameFromBranch: String?
  @State private var templates: [LaneTemplate] = []
  @State private var selectedTemplateId: String?
  @State private var branches: [GitBranchSummary] = []
  @State private var errorMessage: String?
  @State private var queuedNotice: String?
  @State private var busy = false
  @State private var envProgress: LaneEnvInitProgress?
  @State private var envPhase: EnvSetupPhase = .form
  @State private var envPolling = false
  @State private var envPollTask: Task<Void, Never>?
  @State private var selectedColorHex: String?

  private enum EnvSetupPhase {
    case form
    case progress
  }

  init(
    primaryLane: LaneSummary?,
    lanes: [LaneSummary],
    initialMode: LaneCreateMode = .newBranch,
    initialStart: LaneStart? = nil,
    showsModePicker: Bool = true,
    target: LaneCreateTarget? = nil,
    onComplete: @escaping @MainActor (String) async -> Void
  ) {
    self.primaryLane = primaryLane
    self.lanes = lanes
    self.showsModePicker = showsModePicker
    self.target = target
    self.onComplete = onComplete
    _createMode = State(initialValue: initialMode)
    _start = State(initialValue: initialStart ?? .builtInDefault)
    _startIsPreset = State(initialValue: initialStart != nil)
    _showsBranchList = State(initialValue: initialStart?.from == .branch)
  }

  var body: some View {
    Group {
      if showsModePicker {
        NavigationStack {
          content
        }
      } else {
        content
      }
    }
  }

  @ViewBuilder
  private var content: some View {
    if envPhase == .progress {
      envProgressContent
    } else {
      formContent
    }
  }

  @ViewBuilder
  private var envProgressContent: some View {
    ScrollView {
      VStack(spacing: 14) {
        LaneEnvInitProgressPanel(
          progress: envProgress,
          isPolling: envPolling,
          onDone: {
            envPollTask?.cancel()
            envPollTask = nil
            dismiss()
          }
        )
      }
      .padding(16)
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle("Setting up lane")
    .navigationBarTitleDisplayMode(.inline)
    .interactiveDismissDisabled(envProgress?.overallStatus == "running")
    .onDisappear {
      envPollTask?.cancel()
      envPollTask = nil
    }
  }

  @ViewBuilder
  private var formContent: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        LaneFormSection(title: "Create lane", subtitle: createMode.help) {
          VStack(alignment: .leading, spacing: 10) {
            if showsModePicker {
              ADEKitSegmented(
                selection: $createMode,
                options: LaneCreateMode.allCases.map { (value: $0, title: $0.title) }
              )
            }
            LaneTextField("Lane name", text: $name)
            LaneTextField("Description", text: $description)
          }
        }

        switch createMode {
        case .newBranch:
          startFromSection
          bringSection
        case .existingBranch:
          existingBranchSection
        }

        LaneFormSection(title: "Color") {
          VStack(alignment: .leading, spacing: 8) {
            if let hex = selectedColorHex, let name = LaneColorPalette.name(forHex: hex) {
              Text(name)
                .font(.system(size: 12.5))
                .foregroundStyle(ADEColor.textSecondary)
            }
            LaneColorSwatchPicker(
              selectedHex: selectedColorHex,
              usedColors: LaneColorPalette.colorsInUse(amongLanes: lanes)
            ) { next in
              selectedColorHex = next
            }
          }
        }

        LaneFormSection(title: "Template") {
          VStack(spacing: 0) {
            templateRow(id: nil, name: "None", description: "Skip environment setup.")
            ForEach(templates) { template in
              Rectangle().fill(ADEKit.rule).frame(height: 0.75)
              templateRow(id: template.id, name: template.name, description: template.description)
            }
          }
        }

        if let notice = queuedNotice {
          ADENoticeCard(
            title: "Queued on machine",
            message: notice,
            icon: "arrow.trianglehead.2.clockwise.rotate.90",
            tint: ADEColor.warning,
            actionTitle: "Dismiss",
            action: { self.queuedNotice = nil }
          )
        }

        if let errorMessage {
          ADESettingsNotice(message: errorMessage, tone: .crit)
        }
      }
      .padding(16)
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle(showsModePicker ? "New lane" : createMode.title)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .cancellationAction) {
        Button("Cancel") { dismiss() }
          .disabled(busy)
      }
      ToolbarItem(placement: .confirmationAction) {
        Button("Create") {
          Task { await submit() }
        }
        .disabled(!canSubmit || busy)
      }
    }
    .task {
      await loadOptions()
    }
  }

  // MARK: - New branch

  /// The branch the start points at right now: the project's default branch,
  /// the primary lane's branch, or the one picked.
  private var startSourceBranch: String {
    switch start.from {
    case .branch:
      return plainLaneStartBranch(start.branch)
    case .primary:
      if let defaults { return plainLaneStartBranch(defaults.primaryBranch) }
      return plainLaneStartBranch(primaryLane?.branchRef)
    case .default:
      if let defaults { return plainLaneStartBranch(defaults.defaultBranch) }
      return plainLaneStartBranch(primaryLane?.baseRef)
    }
  }

  /// `origin/main` or `main`: where the new branch begins.
  private var startRefLabel: String {
    let source = startSourceBranch
    guard !source.isEmpty else { return "" }
    return start.bring == .pushed ? "origin/\(source)" : source
  }

  /// The lane whose uncommitted changes "Local + uncommitted" copies.
  private var startHolder: LaneSummary? {
    laneHoldingBranch(startSourceBranch, lanes: lanes)
  }

  private var uncommittedBlocked: Bool { startHolder == nil }

  private var uncommittedBlockedReason: String {
    let source = startSourceBranch
    return "\(source.isEmpty ? "This branch" : source) isn't open in any lane, so there are no uncommitted changes to copy."
  }

  private var startFromSection: some View {
    LaneFormSection(title: "Start from") {
      VStack(alignment: .leading, spacing: 10) {
        LaneChoiceRow(
          title: "Default branch",
          subtitle: defaultBranchLabel,
          systemImage: "arrow.triangle.branch",
          isSelected: start.from == .default
        ) {
          chooseStart(.default)
        }
        Rectangle().fill(ADEKit.rule).frame(height: 0.75)
        LaneChoiceRow(
          title: "Primary lane's branch",
          subtitle: primaryBranchLabel,
          systemImage: "house",
          isSelected: start.from == .primary
        ) {
          chooseStart(.primary)
        }
        Rectangle().fill(ADEKit.rule).frame(height: 0.75)
        LaneChoiceRow(
          title: "A specific branch",
          subtitle: start.from == .branch ? plainLaneStartBranch(start.branch) : nil,
          systemImage: "list.bullet",
          isSelected: start.from == .branch
        ) {
          showsBranchList = true
          if start.from != .branch {
            start = LaneStart(from: .branch, branch: start.branch, bring: start.bring)
          }
        }
        if showsBranchList && start.from == .branch {
          branchSearchField
          branchOptionList(
            items: startBranchItems,
            emptyText: branches.isEmpty ? "No branches found." : "No branches match.",
            selected: plainLaneStartBranch(start.branch)
          ) { item in
            start = LaneStart(from: .branch, branch: item.id, bring: start.bring)
          }
        }
      }
    }
  }

  private var defaultBranchLabel: String? {
    let branch = defaults.map { plainLaneStartBranch($0.defaultBranch) } ?? plainLaneStartBranch(primaryLane?.baseRef)
    return branch.isEmpty ? nil : branch
  }

  private var primaryBranchLabel: String {
    let branch = defaults.map { plainLaneStartBranch($0.primaryBranch) } ?? plainLaneStartBranch(primaryLane?.branchRef)
    return branch.isEmpty ? "no branch checked out" : branch
  }

  private func chooseStart(_ from: LaneStart.From) {
    showsBranchList = false
    start = LaneStart(from: from, bring: start.bring)
  }

  private var bringSection: some View {
    LaneFormSection(title: "Bring") {
      VStack(alignment: .leading, spacing: 8) {
        ADEKitSegmented(
          selection: Binding(
            get: { start.bring },
            set: { bring in
              // "Local + uncommitted" needs a lane with this branch open.
              if bring == .uncommitted && uncommittedBlocked {
                ADEHaptics.warning()
                return
              }
              start.bring = bring
            }
          ),
          options: LaneStart.Bring.allCases.map { (value: $0, title: $0.title) }
        )
        if start.bring == .uncommitted && uncommittedBlocked {
          hintText(uncommittedBlockedReason, warn: true)
        } else {
          hintText(laneStartBringHint(start.bring, refLabel: startRefLabel, holder: startHolder), warn: false)
          if uncommittedBlocked {
            hintText("Local + uncommitted is off: \(uncommittedBlockedReason)", warn: false)
          }
        }
      }
    }
  }

  // MARK: - Existing branch

  /// A branch already open in a lane is that lane; it cannot get a second one.
  private var importHolder: LaneSummary? {
    laneHoldingBranch(plainLaneStartBranch(selectedImportBranch), lanes: lanes)
  }

  private var existingBranchSection: some View {
    LaneFormSection(title: "Branch") {
      VStack(alignment: .leading, spacing: 10) {
        branchSearchField
        branchOptionList(
          items: importBranchItems,
          emptyText: branches.isEmpty ? "No branches found." : "No branches match.",
          selected: selectedImportBranch
        ) { item in
          chooseImportBranch(item.id)
        }
        if let importHolder, !selectedImportBranch.isEmpty {
          hintText(
            "\(plainLaneStartBranch(selectedImportBranch)) is already open in \(laneHolderLabel(importHolder)). A branch can only be open in one lane at a time.",
            warn: true
          )
        } else if !selectedImportBranch.isEmpty {
          hintText("No new branch is made. The lane's commits go onto \(plainLaneStartBranch(selectedImportBranch)).", warn: false)
        } else {
          hintText("The lane works directly on the branch you pick.", warn: false)
        }
      }
    }
  }

  /// Picking a branch names the lane after it, until the user types a name.
  private func chooseImportBranch(_ branch: String) {
    selectedImportBranch = branch
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty || trimmed == autoNameFromBranch {
      let next = plainLaneStartBranch(branch)
      name = next
      autoNameFromBranch = next
    }
  }

  // MARK: - Branch lists

  private struct BranchItem: Identifiable {
    /// The value the choice stores: a plain name (new branch) or the ref (existing branch).
    let id: String
    let title: String
    let subtitle: String?
    let isRemote: Bool
  }

  /// Every branch a lane can start from, once each: local branches, plus
  /// remote branches with no local copy, by plain name.
  private var startBranchItems: [BranchItem] {
    var seen = Set<String>()
    var items: [BranchItem] = []
    for branch in branches where !branch.isRemote {
      let plain = plainLaneStartBranch(branch.name)
      guard !plain.isEmpty, seen.insert(plain).inserted else { continue }
      items.append(BranchItem(id: plain, title: plain, subtitle: branchSubtitle(plain: plain, isCurrent: branch.isCurrent), isRemote: false))
    }
    for branch in branches where branch.isRemote {
      let plain = plainLaneStartBranch(branch.name)
      guard !plain.isEmpty, plain != "HEAD", seen.insert(plain).inserted else { continue }
      items.append(BranchItem(id: plain, title: plain, subtitle: "remote only", isRemote: true))
    }
    return filteredBranchItems(items)
  }

  /// Every branch as git lists it, local first.
  private var importBranchItems: [BranchItem] {
    let ordered = branches.filter { !$0.isRemote } + branches.filter(\.isRemote)
    let items = ordered
      .filter { !$0.name.hasSuffix("/HEAD") }
      .map { branch in
        BranchItem(
          id: branch.name,
          title: branch.name,
          subtitle: branch.isRemote ? "remote" : branchSubtitle(plain: plainLaneStartBranch(branch.name), isCurrent: branch.isCurrent),
          isRemote: branch.isRemote
        )
      }
    return filteredBranchItems(items)
  }

  private func branchSubtitle(plain: String, isCurrent: Bool) -> String? {
    if let holder = laneHoldingBranch(plain, lanes: lanes) {
      return "in \(laneHolderLabel(holder))"
    }
    return isCurrent ? "current" : nil
  }

  private func filteredBranchItems(_ items: [BranchItem]) -> [BranchItem] {
    let query = branchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else { return items }
    return items.filter { $0.title.localizedCaseInsensitiveContains(query) }
  }

  @ViewBuilder
  private var branchSearchField: some View {
    if branches.count > 6 {
      LaneTextField("Search branches", text: $branchQuery)
    }
  }

  @ViewBuilder
  private func branchOptionList(
    items: [BranchItem],
    emptyText: String,
    selected: String,
    onSelect: @escaping (BranchItem) -> Void
  ) -> some View {
    if items.isEmpty {
      Text(emptyText)
        .font(.caption)
        .foregroundStyle(ADEColor.textMuted)
    } else if items.count > 4 {
      ScrollView {
        branchOptionStack(items: items, selected: selected, onSelect: onSelect)
      }
      .frame(maxHeight: 320)
      .scrollBounceBehavior(.basedOnSize)
    } else {
      branchOptionStack(items: items, selected: selected, onSelect: onSelect)
    }
  }

  private func branchOptionStack(
    items: [BranchItem],
    selected: String,
    onSelect: @escaping (BranchItem) -> Void
  ) -> some View {
    LaneChoiceList(items: items) { item in
      LaneChoiceRow(
        title: item.title,
        subtitle: item.subtitle,
        systemImage: item.isRemote ? "cloud" : "arrow.triangle.branch",
        isSelected: selected == item.id
      ) {
        onSelect(item)
      }
    }
  }

  private func hintText(_ text: String, warn: Bool) -> some View {
    Text(text)
      .font(.system(size: 12.5))
      .foregroundStyle(warn ? ADEColor.warning : ADEColor.textSecondary)
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .leading)
  }

  // MARK: - Load and submit

  /// The lane whose checkout lists the branches: the primary lane, else any
  /// lane of the same machine.
  private var branchListLaneId: String? {
    primaryLane?.id ?? lanes.first { $0.archivedAt == nil }?.id
  }

  @MainActor
  private func loadOptions() async {
    if selectedColorHex == nil {
      selectedColorHex = LaneColorPalette.nextAvailableColor(amongLanes: lanes)
    }
    // An older brain has no saved defaults: keep the built-in start.
    let snapshot = await syncService.fetchNewLaneDefaults(
      targetProjectId: target?.projectId,
      targetProjectRootPath: target?.rootPath
    )
    defaults = snapshot
    if let snapshot, !startIsPreset {
      start = snapshot.defaults.start
      showsBranchList = snapshot.defaults.start.from == .branch
    }
    do {
      let loadedTemplates = try await syncService.fetchLaneTemplates()
      templates = loadedTemplates
      let defaultTemplateId: String?
      if let snapshot {
        defaultTemplateId = snapshot.defaults.templateId
      } else {
        defaultTemplateId = try? await syncService.fetchDefaultLaneTemplateId()
      }
      if let defaultTemplateId, loadedTemplates.contains(where: { $0.id == defaultTemplateId }) {
        selectedTemplateId = defaultTemplateId
      } else {
        selectedTemplateId = nil
      }
      if let branchListLaneId {
        branches = try await syncService.listBranches(laneId: branchListLaneId)
      }
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func submit() async {
    do {
      busy = true
      errorMessage = nil
      let created: LaneSummary
      switch createMode {
      case .newBranch:
        created = try await syncService.createLane(
          name: name,
          description: description,
          start: start,
          targetProjectId: target?.projectId,
          targetProjectRootPath: target?.rootPath
        )
      case .existingBranch:
        created = try await syncService.importBranch(
          branchRef: selectedImportBranch,
          name: name,
          description: description,
          targetProjectId: target?.projectId,
          targetProjectRootPath: target?.rootPath
        )
      }

      if let hex = selectedColorHex, !hex.isEmpty {
        do {
          try await syncService.updateLaneAppearance(created.id, color: hex)
        } catch {
          // Non-fatal: lane was created, color failed (likely uniqueness collision).
        }
      }

      await onComplete(created.id)

      if let templateId = selectedTemplateId {
        envProgress = nil
        envPhase = .progress
        busy = false
        startEnvProgress(laneId: created.id, templateId: templateId)
        return
      }

      dismiss()
    } catch let queuedError as QueuedRemoteCommandError {
      queuedNotice = queuedError.errorDescription
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
    busy = false
  }

  private var canSubmit: Bool {
    guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
    switch createMode {
    case .newBranch:
      if start.from == .branch && plainLaneStartBranch(start.branch).isEmpty { return false }
      if start.bring == .uncommitted && uncommittedBlocked { return false }
      return true
    case .existingBranch:
      return !selectedImportBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && importHolder == nil
    }
  }

  @ViewBuilder
  private func templateRow(id: String?, name: String, description: String?) -> some View {
    let isSelected = (selectedTemplateId ?? "") == (id ?? "")
    Button {
      selectedTemplateId = id
    } label: {
      HStack(alignment: .top, spacing: 12) {
        VStack(alignment: .leading, spacing: 4) {
          Text(name)
            .font(.system(size: 14.5, weight: isSelected ? .semibold : .regular))
            .foregroundStyle(ADEColor.textPrimary)
          if let description, !description.isEmpty {
            Text(description)
              .font(.system(size: 12.5))
              .foregroundStyle(ADEColor.textSecondary)
              .lineLimit(2)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        Spacer(minLength: 8)
        if isSelected {
          Image(systemName: "checkmark")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(ADEColor.accent)
            .padding(.top, 2)
        }
      }
      .padding(.vertical, 9)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(isSelected ? [.isSelected, .isButton] : [.isButton])
  }

  private func startEnvProgress(laneId: String, templateId: String) {
    envPollTask?.cancel()
    envPolling = true
    let task = Task { @MainActor in
      do {
        envProgress = try await syncService.applyLaneTemplate(laneId: laneId, templateId: templateId)
      } catch let queuedError as QueuedRemoteCommandError {
        queuedNotice = queuedError.errorDescription
        envPolling = false
        return
      } catch {
        ADEHaptics.error()
        errorMessage = error.localizedDescription
        envPolling = false
        return
      }

      while !Task.isCancelled {
        if let progress = envProgress, progress.overallStatus != "running" {
          break
        }
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        if Task.isCancelled { break }
        do {
          if let next = try await syncService.fetchLaneEnvStatus(laneId: laneId) {
            envProgress = next
            if next.overallStatus != "running" { break }
          }
        } catch is CancellationError {
          break
        } catch {
          if Task.isCancelled { break }
          ADEHaptics.error()
          errorMessage = error.localizedDescription
          break
        }
      }
      envPolling = false
    }
    envPollTask = task
  }
}
