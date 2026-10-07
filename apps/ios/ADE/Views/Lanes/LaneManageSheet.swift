import SwiftUI

struct LaneManageSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let snapshot: LaneListSnapshot
  let allLaneSnapshots: [LaneListSnapshot]
  let onDeleted: (@MainActor () async -> Void)?
  let onRenamed: (@MainActor () async -> Void)?
  let onComplete: @MainActor () async -> Void

  @State private var activeTab: ManageLaneTab = .delete
  @State private var displayedName: String
  @State private var renameText: String
  @State private var renamePresented = false
  @State private var selectedParentLaneId: String
  @State private var baseBranchOverride: String = ""
  @State private var colorText: String
  @State private var iconText: String
  @State private var tagsText: String
  @State private var deleteSelection = LaneDeleteSelection()
  @State private var deleteForce = false
  @State private var busyAction: String?
  @State private var errorMessage: String?

  init(
    snapshot: LaneListSnapshot,
    allLaneSnapshots: [LaneListSnapshot],
    onDeleted: (@MainActor () async -> Void)? = nil,
    onRenamed: (@MainActor () async -> Void)? = nil,
    onComplete: @escaping @MainActor () async -> Void
  ) {
    self.snapshot = snapshot
    self.allLaneSnapshots = allLaneSnapshots
    self.onDeleted = onDeleted
    self.onRenamed = onRenamed
    self.onComplete = onComplete
    let primaryLaneId = allLaneSnapshots.first(where: { $0.lane.laneType == "primary" })?.lane.id ?? ""
    _displayedName = State(initialValue: snapshot.lane.name)
    _renameText = State(initialValue: snapshot.lane.name)
    _selectedParentLaneId = State(initialValue: snapshot.lane.parentLaneId ?? primaryLaneId)
    _colorText = State(initialValue: snapshot.lane.color ?? "")
    _iconText = State(initialValue: snapshot.lane.icon?.rawValue ?? "")
    _tagsText = State(initialValue: snapshot.lane.tags.joined(separator: ", "))
  }

  private var isPrimary: Bool { snapshot.lane.laneType == "primary" }

  private var availableTabs: [ManageLaneTab] {
    var tabs: [ManageLaneTab] = [.delete]
    tabs.append(.appearance)
    if !isPrimary { tabs.append(.stack) }
    tabs.append(.archive)
    return tabs
  }

  private var descendantIds: Set<String> {
    var result = Set<String>()
    func collectDescendants(of parentId: String) {
      for s in allLaneSnapshots where s.lane.parentLaneId == parentId {
        if result.insert(s.lane.id).inserted {
          collectDescendants(of: s.lane.id)
        }
      }
    }
    collectDescendants(of: snapshot.lane.id)
    return result
  }

  private var reparentCandidates: [LaneSummary] {
    let excluded = descendantIds
    return allLaneSnapshots
      .map(\.lane)
      .filter { $0.id != snapshot.lane.id && $0.archivedAt == nil && !excluded.contains($0.id) }
      .sorted { lhs, rhs in
        if lhs.laneType == "primary" && rhs.laneType != "primary" { return true }
        if lhs.laneType != "primary" && rhs.laneType == "primary" { return false }
        return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
      }
  }

  private var canArchive: Bool { !isPrimary }

  private var primaryLaneId: String {
    allLaneSnapshots.first(where: { $0.lane.laneType == "primary" })?.lane.id ?? ""
  }

  private var effectiveCurrentParentId: String {
    snapshot.lane.parentLaneId ?? primaryLaneId
  }

  private var defaultStackBaseBranch: String {
    reparentCandidates.first(where: { $0.id == selectedParentLaneId })?.branchRef ?? ""
  }

  private var trimmedBaseOverride: String {
    baseBranchOverride.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var reparentParentChanged: Bool {
    selectedParentLaneId != effectiveCurrentParentId
  }

  private var reparentBaseChanged: Bool {
    let normalizedOverride = LaneManageSheet.normalizeBranchRefForCompare(trimmedBaseOverride)
    let normalizedExisting = LaneManageSheet.normalizeBranchRefForCompare(snapshot.lane.baseRef)
    let normalizedDefault = LaneManageSheet.normalizeBranchRefForCompare(defaultStackBaseBranch)
    if normalizedOverride.isEmpty {
      return !normalizedExisting.isEmpty && normalizedExisting != normalizedDefault
    }
    return normalizedOverride != normalizedExisting
  }

  private static func normalizeBranchRefForCompare(_ ref: String) -> String {
    var value = ref.trimmingCharacters(in: .whitespacesAndNewlines)
    if value.hasPrefix("refs/heads/") {
      value = String(value.dropFirst("refs/heads/".count))
    }
    if value.hasPrefix("origin/") {
      value = String(value.dropFirst("origin/".count))
    }
    return value
  }

  private var canApplyReparent: Bool {
    guard canRunLiveActions else { return false }
    if snapshot.lane.status.dirty || snapshot.lane.status.rebaseInProgress { return false }
    guard !selectedParentLaneId.isEmpty else { return false }
    return reparentParentChanged || reparentBaseChanged
  }

  private var canRunLiveActions: Bool {
    laneAllowsLiveActions(connectionState: syncService.connectionState, laneStatus: syncService.status(for: .lanes))
  }

  private var showsRenameControl: Bool {
    LaneManageRename.showsRenameControl(
      laneType: snapshot.lane.laneType,
      hostSupportsRename: syncService.canInvokeRemoteAction("lanes.rename")
    )
  }

  private var liveActionNoticePresentation: LaneEmptyStatePresentation? {
    laneLiveActionNotice(
      connectionState: syncService.connectionState,
      laneStatus: syncService.status(for: .lanes),
      hasHostProfile: syncService.activeHostProfile != nil
    )
  }

  private var branchLabel: String {
    normalizedPrBranchName(snapshot.lane.branchRef)
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          if !syncService.connectionState.isHostUnreachable,
            let liveActionNoticePresentation
          {
            ADENoticeCard(
              title: liveActionNoticePresentation.title,
              message: liveActionNoticePresentation.message,
              icon: liveActionNoticePresentation.symbol,
              tint: ADEColor.warning,
              actionTitle: liveActionNoticePresentation.actionTitle,
              action: liveActionNoticePresentation.action.map { action in
                { handleNoticeAction(action) }
              }
            )
          }

          if let errorMessage {
            manageErrorBanner(errorMessage)
          }

          laneInfoHeader

          if isPrimary {
            Text("The primary lane cannot be archived or deleted.")
              .font(.system(size: 12.5))
              .foregroundStyle(ADEColor.textMuted)
              .padding(.horizontal, 4)
            appearanceTab
          } else {
            manageTabBar
            tabContent
          }
        }
        .padding(16)
        .allowsHitTesting(busyAction == nil)
      }
      .adeScreenBackground()
      .overlay { busyOverlay }
      .adeNavigationGlass()
      .navigationTitle(displayedName)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") { dismiss() }
            .disabled(busyAction != nil)
        }
        if showsRenameControl {
          ToolbarItem(placement: .confirmationAction) {
            Button {
              renameText = displayedName
              renamePresented = true
            } label: {
              Image(systemName: "pencil")
            }
            .accessibilityLabel("Rename lane")
            .disabled(busyAction != nil || !canRunLiveActions)
          }
        }
      }
      .alert("Rename lane", isPresented: $renamePresented) {
        TextField("Lane name", text: $renameText)
          .textInputAutocapitalization(.words)
        Button("Cancel", role: .cancel) {}
        Button("Save") {
          let draft = renameText
          Task { await performRename(draft: draft) }
        }
      } message: {
        Text("Changes the display name. The git branch stays the same.")
      }
      .onAppear {
        if !availableTabs.contains(activeTab) {
          activeTab = availableTabs.first ?? .appearance
        }
      }
    }
  }

  @ViewBuilder
  private var tabContent: some View {
    switch activeTab {
    case .delete:
      deleteTab
    case .appearance:
      appearanceTab
    case .stack:
      stackTab
    case .archive:
      archiveTab
    }
  }

  private var laneInfoHeader: some View {
    VStack(alignment: .leading, spacing: 10) {
      metadataRow(
        symbol: "arrow.triangle.branch",
        value: branchLabel,
        monospaced: true,
        accessibilityNoun: "Branch",
        lineLimit: 1,
        dirty: snapshot.lane.status.dirty
      ) {
        if snapshot.lane.status.dirty {
          ADEKitTag(text: "Dirty", tone: .warn)
        }
      }
      metadataRow(
        symbol: "folder",
        value: snapshot.lane.worktreePath,
        monospaced: false,
        accessibilityNoun: "Path",
        lineLimit: 2
      )
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .adeKitCard(padding: 12)
  }

  private func metadataRow(
    symbol: String,
    value: String,
    monospaced: Bool,
    accessibilityNoun: String,
    lineLimit: Int,
    dirty: Bool = false
  ) -> some View {
    metadataRow(
      symbol: symbol,
      value: value,
      monospaced: monospaced,
      accessibilityNoun: accessibilityNoun,
      lineLimit: lineLimit,
      dirty: dirty
    ) {
      EmptyView()
    }
  }

  private func metadataRow<Trailing: View>(
    symbol: String,
    value: String,
    monospaced: Bool,
    accessibilityNoun: String,
    lineLimit: Int,
    dirty: Bool = false,
    @ViewBuilder trailing: () -> Trailing
  ) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: symbol)
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(ADEColor.textMuted)
        .frame(width: 18)
        .padding(.top, 1)
        .accessibilityHidden(true)
      Text(value)
        .font(monospaced ? .adeMono(12) : .system(size: 12.5))
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(lineLimit)
        .truncationMode(.middle)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
      trailing()
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      LaneManageRename.metadataAccessibilityLabel(
        noun: accessibilityNoun,
        value: value,
        dirty: dirty
      )
    )
  }

  private var manageTabBar: some View {
    HStack(spacing: 2) {
      ForEach(availableTabs) { tab in
        Button {
          withAnimation(.smooth(duration: 0.2)) { activeTab = tab }
        } label: {
          let selected = activeTab == tab
          HStack(spacing: 4) {
            Image(systemName: tab.symbol)
              .font(.system(size: 11, weight: .medium))
            Text(tab.title)
              .font(.system(size: 12.5, weight: selected ? .semibold : .medium))
              .lineLimit(1)
          }
          // The kit segmented track; red marks only the selected Delete tab.
          .foregroundStyle(selected ? (tab == .delete ? ADEColor.danger : ADEColor.textPrimary) : ADEColor.textSecondary)
          .frame(maxWidth: .infinity, minHeight: 30)
          .background {
            if selected {
              RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(ADEKit.surface)
                .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(ADEKit.edge, lineWidth: 0.75))
            }
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(activeTab == tab ? .isSelected : [])
      }
    }
    .padding(2)
    .background(ADEKit.track, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
  }

  private var deleteTab: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Removes what you pick. Cannot be undone.")
        .font(.system(size: 12.5))
        .foregroundStyle(ADEColor.textSecondary)

      if snapshot.lane.status.dirty {
        ADESettingsNotice(message: "Uncommitted changes on this lane.", tone: .warn)
      }

      deleteChecklist

      Toggle("Force delete", isOn: $deleteForce)
        .font(.system(size: 14.5))
        .foregroundStyle(ADEColor.textPrimary)
        .tint(ADEColor.danger)

      Button {
        Task { await performDelete() }
      } label: {
        Label("Delete lane", systemImage: "trash")
      }
      .buttonStyle(ADEKitButtonStyle(tone: .crit, wide: true))
      .disabled(!canRunLiveActions || !deleteSelection.hasAny || busyAction != nil)
      .opacity(!canRunLiveActions || !deleteSelection.hasAny || busyAction != nil ? 0.5 : 1)
    }
    .adeKitCard(padding: 14)
  }

  private var deleteChecklist: some View {
    VStack(alignment: .leading, spacing: 8) {
      Button {
        deleteSelection = deleteSelection.allSelected
          ? .empty
          : LaneDeleteSelection(worktree: true, localBranch: true, remoteBranch: true)
      } label: {
        HStack(spacing: 8) {
          Image(systemName: deleteSelection.allSelected
            ? "checkmark.square.fill"
            : (deleteSelection.hasAny ? "minus.square.fill" : "square"))
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(deleteSelection.hasAny ? ADEColor.danger : ADEColor.textMuted)
          Text("Select everything")
            .font(.system(size: 13.5, weight: .medium))
            .foregroundStyle(ADEColor.textPrimary)
          Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(!canRunLiveActions || busyAction != nil)

      VStack(spacing: 0) {
        deleteChecklistRow(
          title: "Worktree",
          subtitle: "Removes the working folder and ADE registration.",
          symbol: "shippingbox",
          isSelected: deleteSelection.worktree
        ) {
          toggleDeleteTarget(.worktree, !deleteSelection.worktree)
        }

        Rectangle().fill(ADEKit.rule).frame(height: 0.75)

        deleteChecklistRow(
          title: "Local branch",
          subtitle: branchLabel,
          symbol: "arrow.triangle.branch",
          isSelected: deleteSelection.localBranch,
          monoSubtitle: true
        ) {
          toggleDeleteTarget(.localBranch, !deleteSelection.localBranch)
        }

        Rectangle().fill(ADEKit.rule).frame(height: 0.75)

        deleteChecklistRow(
          title: "Remote branch",
          subtitle: "origin · \(branchLabel)",
          symbol: "cloud",
          isSelected: deleteSelection.remoteBranch,
          monoSubtitle: true
        ) {
          toggleDeleteTarget(.remoteBranch, !deleteSelection.remoteBranch)
        }
      }
      .background(ADEKit.track.opacity(0.5), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
  }

  private enum DeleteTarget {
    case worktree, localBranch, remoteBranch
  }

  private func toggleDeleteTarget(_ key: DeleteTarget, _ next: Bool) {
    switch key {
    case .worktree:
      deleteSelection = next
        ? LaneDeleteSelection(worktree: true, localBranch: deleteSelection.localBranch, remoteBranch: deleteSelection.remoteBranch)
        : .empty
    case .localBranch:
      deleteSelection.localBranch = next
      if next { deleteSelection.worktree = true }
    case .remoteBranch:
      deleteSelection.remoteBranch = next
      if next { deleteSelection.worktree = true }
    }
  }

  private func deleteChecklistRow(
    title: String,
    subtitle: String,
    symbol: String,
    isSelected: Bool,
    isIndeterminate: Bool = false,
    monoSubtitle: Bool = false,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      HStack(spacing: 10) {
        Image(systemName: isSelected ? "checkmark.square.fill" : (isIndeterminate ? "minus.square.fill" : "square"))
          .font(.system(size: 16, weight: .semibold))
          .foregroundStyle(isSelected || isIndeterminate ? ADEColor.danger : ADEColor.textMuted)
        Image(systemName: symbol)
          .font(.system(size: 12, weight: .medium))
          .foregroundStyle(ADEColor.textMuted)
          .frame(width: 22)
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(.system(size: 13.5, weight: .medium))
            .foregroundStyle(ADEColor.textPrimary)
          Text(subtitle)
            .font(monoSubtitle ? .adeMono(11) : .system(size: 12))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(2)
        }
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(!canRunLiveActions || busyAction != nil)
  }

  private var appearanceTab: some View {
    VStack(alignment: .leading, spacing: 12) {
      VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 6) {
          ADEEyebrow("Color")
          if let name = LaneColorPalette.name(forHex: colorText) {
            Text(name)
              .font(.system(size: 12.5))
              .foregroundStyle(ADEColor.textSecondary)
          }
        }
        LaneColorSwatchPicker(
          selectedHex: colorText.isEmpty ? nil : colorText,
          usedColors: LaneColorPalette.colorsInUse(
            amongLanes: allLaneSnapshots.map(\.lane),
            excluding: snapshot.lane.id
          )
        ) { next in
          colorText = next ?? ""
        }
      }

      LaneTextField("Icon (star, flag, bolt, shield, tag)", text: $iconText).textInputAutocapitalization(.never)
      LaneTextField("Tags (comma separated)", text: $tagsText)

      LaneActionButton(title: "Save appearance", symbol: "paintpalette") {
        Task {
          let tags = tagsText.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
          await performAction("save appearance") {
            try await syncService.updateLaneAppearance(snapshot.lane.id, color: colorText, icon: iconText, tags: tags)
          }
        }
      }
      .disabled(!canRunLiveActions)
    }
    .adeKitCard(padding: 14)
  }

  @ViewBuilder
  private var stackTab: some View {
    if isPrimary {
      EmptyView()
    } else {
      VStack(alignment: .leading, spacing: 12) {
        ADEEyebrow("Parent lane")

        if snapshot.lane.status.dirty {
          ADESettingsNotice(message: "Commit or stash changes before moving this lane.", tone: .warn)
        }

        if snapshot.lane.status.rebaseInProgress {
          ADESettingsNotice(message: "Finish or abort the rebase in progress first.", tone: .warn)
        }

        if reparentCandidates.isEmpty {
          Text("No valid parent")
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.textMuted)
        } else if reparentCandidates.count > 4 {
          ScrollView {
            reparentCandidateStack
          }
          .frame(maxHeight: 280)
        } else {
          reparentCandidateStack
        }

        LaneTextField(
          defaultStackBaseBranch.isEmpty
            ? "Base branch (optional)"
            : "Base branch (default: \(defaultStackBaseBranch))",
          text: $baseBranchOverride
        )
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()

        Text("Runs git rebase; a failed rebase is rolled back.")
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textMuted)

        LaneActionButton(title: "Apply stack change", symbol: "arrow.triangle.swap") {
          Task {
            await performAction("reparent lane") {
              try await syncService.reparentLane(
                snapshot.lane.id,
                newParentLaneId: selectedParentLaneId,
                stackBaseBranchRef: trimmedBaseOverride.isEmpty ? nil : trimmedBaseOverride
              )
            }
          }
        }
        .disabled(!canApplyReparent)
      }
      .adeKitCard(padding: 14)
    }
  }

  private var archiveTab: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        Image(systemName: "archivebox")
          .font(.system(size: 16, weight: .medium))
          .foregroundStyle(ADEColor.textSecondary)
        VStack(alignment: .leading, spacing: 3) {
          Text("Hide this lane from ADE")
            .font(.system(size: 14.5, weight: .semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text("Files stay on disk until you delete them.")
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.textSecondary)
        }
      }

      if snapshot.lane.archivedAt == nil {
        LaneActionButton(title: "Archive lane", symbol: "archivebox", tint: ADEColor.warning) {
          Task { await performAction("archive lane") { try await syncService.archiveLane(snapshot.lane.id) } }
        }
        .disabled(!canRunLiveActions || !canArchive)
      } else {
        LaneActionButton(title: "Restore lane", symbol: "tray.and.arrow.up") {
          Task { await performAction("restore lane") { try await syncService.unarchiveLane(snapshot.lane.id) } }
        }
        .disabled(!canRunLiveActions)
      }
    }
    .adeKitCard(padding: 14)
  }

  private var reparentCandidateStack: some View {
    LaneChoiceList(items: reparentCandidates) { lane in
      LaneChoiceRow(
        title: lane.name,
        subtitle: normalizedPrBranchName(lane.branchRef),
        systemImage: lane.laneType == "primary" ? "house" : "arrow.triangle.branch",
        isSelected: selectedParentLaneId == lane.id
      ) {
        selectedParentLaneId = lane.id
        baseBranchOverride = ""
      }
    }
  }

  @ViewBuilder
  private var busyOverlay: some View {
    if busyAction != nil {
      ZStack {
        ADEColor.pageBackground.opacity(0.55).ignoresSafeArea()
        VStack(spacing: 10) {
          ProgressView().tint(ADEColor.accent)
          Text(busyAction?.capitalized ?? "Working...")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
        }
        .adeKitCard(padding: 18)
        .fixedSize()
      }
    }
  }

  private func manageErrorBanner(_ message: String) -> some View {
    ADESettingsNotice(message: message, tone: .crit)
  }

  @MainActor
  private func performDelete() async {
    guard deleteSelection.hasAny else { return }
    guard canRunLiveActions else {
      ADEHaptics.warning()
      errorMessage = "Reconnect to machine before you delete lane."
      return
    }
    errorMessage = nil
    guard syncService.beginLaneDeletion(
      snapshot.lane.id,
      deleteBranch: deleteSelection.localBranch,
      deleteRemoteBranch: deleteSelection.remoteBranch,
      force: deleteForce
    ) else {
      return
    }

    // Host cleanup stops sessions and removes the worktree, so it can be much
    // slower than a UI transition. Leave this sheet and the lane detail now;
    // SyncService owns the request until the host finishes.
    dismiss()
    if let onDeleted {
      await onDeleted()
    } else {
      await onComplete()
    }
  }

  @MainActor
  private func performRename(draft: String) async {
    let trimmed = LaneManageRename.trimmedName(draft)
    if trimmed.isEmpty {
      ADEHaptics.warning()
      errorMessage = "Lane name cannot be empty."
      return
    }
    if let duplicate = LaneManageRename.duplicateName(
      draft: trimmed,
      laneId: snapshot.lane.id,
      among: allLaneSnapshots.map(\.lane)
    ) {
      ADEHaptics.warning()
      errorMessage = "A lane named \"\(duplicate)\" already exists."
      return
    }
    guard LaneManageRename.canSave(draft: trimmed, currentName: displayedName) else { return }
    let renamed = await runLiveAction("rename lane") {
      try await syncService.renameLane(snapshot.lane.id, name: trimmed)
    }
    guard renamed else { return }
    displayedName = trimmed
    renameText = trimmed
    ADEHaptics.success()
    if let onRenamed {
      await onRenamed()
    }
  }

  @MainActor
  private func performAction(_ label: String, operation: () async throws -> Void) async {
    guard await runLiveAction(label, operation: operation) else { return }
    dismiss()
    await onComplete()
  }

  @MainActor
  private func runLiveAction(_ label: String, operation: () async throws -> Void) async -> Bool {
    guard canRunLiveActions else {
      ADEHaptics.warning()
      errorMessage = "Reconnect to machine before you \(label)."
      return false
    }
    do {
      busyAction = label
      errorMessage = nil
      try await operation()
      busyAction = nil
      return true
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
      busyAction = nil
      return false
    }
  }

  @MainActor
  private func handleNoticeAction(_ action: LaneConnectionNoticeAction) {
    switch action {
    case .openSettings:
      syncService.settingsPresented = true
    case .reconnect, .retry:
      Task { await syncService.reconnectIfPossible(userInitiated: true) }
    }
  }
}

enum LaneManageRename {
  static func trimmedName(_ raw: String) -> String {
    raw.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  static func canRename(laneType: String) -> Bool {
    laneType != "primary"
  }

  static func showsRenameControl(laneType: String, hostSupportsRename: Bool) -> Bool {
    canRename(laneType: laneType) && hostSupportsRename
  }

  static func duplicateName(draft: String, laneId: String, among: [LaneSummary]) -> String? {
    let trimmed = trimmedName(draft)
    guard !trimmed.isEmpty else { return nil }
    return among.first { candidate in
      candidate.id != laneId
        && candidate.archivedAt == nil
        && candidate.name.trimmingCharacters(in: .whitespacesAndNewlines)
          .localizedCaseInsensitiveCompare(trimmed) == .orderedSame
    }?.name
  }

  static func canSave(draft: String, currentName: String) -> Bool {
    let trimmed = trimmedName(draft)
    guard !trimmed.isEmpty else { return false }
    return trimmed != currentName.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  static func metadataAccessibilityLabel(noun: String, value: String, dirty: Bool) -> String {
    dirty ? "\(noun), \(value), dirty" : "\(noun), \(value)"
  }
}
