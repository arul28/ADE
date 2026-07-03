import SwiftUI

struct LaneManageSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let snapshot: LaneListSnapshot
  let allLaneSnapshots: [LaneListSnapshot]
  let onDeleted: (@MainActor () async -> Void)?
  let onComplete: @MainActor () async -> Void

  @State private var activeTab: ManageLaneTab = .delete
  @State private var renameText: String
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
    onComplete: @escaping @MainActor () async -> Void
  ) {
    self.snapshot = snapshot
    self.allLaneSnapshots = allLaneSnapshots
    self.onDeleted = onDeleted
    self.onComplete = onComplete
    let primaryLaneId = allLaneSnapshots.first(where: { $0.lane.laneType == "primary" })?.lane.id ?? ""
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
        VStack(spacing: 14) {
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
            Text("Primary lane cannot be archived or deleted.")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(12)
              .background(ADEColor.surfaceBackground.opacity(0.35), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            appearanceTab
          } else {
            // Matches the host's adoptableAttached derivation (attached AND not
            // archived) — an archived attached lane can't be adopted.
            if snapshot.adoptableAttached {
              adoptSection
            }
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
      .navigationTitle("Manage lane")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") { dismiss() }
            .disabled(busyAction != nil)
        }
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
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        WorkLaneLogoMark(
          color: laneSurfaceTint(forHex: snapshot.lane.color).text ?? ADEColor.accent,
          laneIcon: snapshot.lane.icon,
          size: 13
        )
        Text(snapshot.lane.name)
          .font(.headline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        if snapshot.lane.status.dirty {
          Text("DIRTY")
            .font(.caption2.weight(.bold))
            .foregroundStyle(ADEColor.warning)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(ADEColor.warning.opacity(0.14), in: Capsule())
        }
      }
      LabeledContent("Branch") {
        Text(branchLabel)
          .font(.system(.caption, design: .monospaced))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
      }
      .font(.caption)
      LabeledContent("Path") {
        Text(snapshot.lane.worktreePath)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .multilineTextAlignment(.trailing)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(12)
    .background(ADEColor.surfaceBackground.opacity(0.35), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
  }

  private var manageTabBar: some View {
    HStack(spacing: 4) {
      ForEach(availableTabs) { tab in
        Button {
          withAnimation(.smooth(duration: 0.2)) { activeTab = tab }
        } label: {
          HStack(spacing: 4) {
            Image(systemName: tab.symbol)
              .font(.system(size: 11, weight: .semibold))
            Text(tab.title)
              .font(.caption.weight(.semibold))
              .lineLimit(1)
          }
          .foregroundStyle(activeTab == tab ? tabForeground(tab) : ADEColor.textMuted)
          .frame(maxWidth: .infinity)
          .padding(.vertical, 8)
          .background(activeTab == tab ? tabBackground(tab) : Color.clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
      }
    }
    .padding(4)
    .background(ADEColor.surfaceBackground.opacity(0.45), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
  }

  private func tabForeground(_ tab: ManageLaneTab) -> Color {
    tab == .delete ? ADEColor.danger : ADEColor.accent
  }

  private func tabBackground(_ tab: ManageLaneTab) -> Color {
    tab == .delete ? ADEColor.danger.opacity(0.16) : ADEColor.accent.opacity(0.16)
  }

  private var deleteTab: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Stops lane activity and removes what you pick below. Cannot be undone.")
        .font(.caption)
        .foregroundStyle(ADEColor.danger.opacity(0.85))

      if snapshot.lane.status.dirty {
        HStack(spacing: 8) {
          Image(systemName: "exclamationmark.triangle.fill")
            .foregroundStyle(ADEColor.warning)
          Text("Uncommitted changes on this lane.")
            .font(.caption)
            .foregroundStyle(ADEColor.warning)
        }
        .padding(10)
        .background(ADEColor.warning.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      }

      deleteChecklist

      Toggle("Force delete", isOn: $deleteForce)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        .tint(ADEColor.danger)

      Button {
        Task { await performDelete() }
      } label: {
        Label("Delete lane", systemImage: "trash")
          .font(.subheadline.weight(.semibold))
          .frame(maxWidth: .infinity)
          .padding(.vertical, 12)
      }
      .buttonStyle(.borderedProminent)
      .tint(ADEColor.danger)
      .disabled(!canRunLiveActions || !deleteSelection.hasAny || busyAction != nil)
    }
    .padding(14)
    .background(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .fill(ADEColor.danger.opacity(0.06))
        .overlay(
          RoundedRectangle(cornerRadius: 14, style: .continuous)
            .stroke(ADEColor.danger.opacity(0.25), lineWidth: 1)
        )
    )
  }

  private var deleteChecklist: some View {
    VStack(spacing: 0) {
      deleteChecklistRow(
        title: "Select everything",
        subtitle: "Worktree, local & remote branch",
        symbol: "checkmark.circle",
        isSelected: deleteSelection.allSelected,
        isIndeterminate: deleteSelection.hasAny && !deleteSelection.allSelected
      ) {
        deleteSelection = deleteSelection.allSelected ? .empty : LaneDeleteSelection(worktree: true, localBranch: true, remoteBranch: true)
      }

      Divider().opacity(0.2)

      deleteChecklistRow(
        title: snapshot.lane.laneType == "attached" ? "Unlink from ADE" : "Worktree",
        subtitle: snapshot.lane.laneType == "attached"
          ? "Stops ADE managing this lane. Keeps the folder + branch."
          : "Removes the working folder and ADE registration.",
        symbol: "shippingbox",
        isSelected: deleteSelection.worktree
      ) {
        toggleDeleteTarget(.worktree, !deleteSelection.worktree)
      }

      Divider().opacity(0.2)

      deleteChecklistRow(
        title: "Local branch",
        subtitle: branchLabel,
        symbol: "arrow.triangle.branch",
        isSelected: deleteSelection.localBranch,
        monoSubtitle: true
      ) {
        toggleDeleteTarget(.localBranch, !deleteSelection.localBranch)
      }

      Divider().opacity(0.2)

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
    .background(ADEColor.surfaceBackground.opacity(0.35), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(ADEColor.border.opacity(0.16), lineWidth: 0.5)
    )
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
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(isSelected ? ADEColor.danger : ADEColor.textMuted)
          .frame(width: 22)
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(subtitle)
            .font(monoSubtitle ? .system(.caption2, design: .monospaced) : .caption2)
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(2)
        }
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .background(isSelected ? ADEColor.danger.opacity(0.08) : Color.clear)
    }
    .buttonStyle(.plain)
    .disabled(!canRunLiveActions || busyAction != nil)
  }

  private var appearanceTab: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Lane color in tabs and stack. No git changes.")
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)

      LaneTextField("Lane name", text: $renameText)
      LaneActionButton(title: "Save name", symbol: "checkmark.circle.fill", tint: ADEColor.accent) {
        Task { await performAction("rename lane") { try await syncService.renameLane(snapshot.lane.id, name: renameText) } }
      }
      .disabled(!canRunLiveActions || renameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || renameText == snapshot.lane.name)

      VStack(alignment: .leading, spacing: 6) {
        Text("Color")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
        if let name = LaneColorPalette.name(forHex: colorText) {
          Text(name)
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
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

      LaneActionButton(title: "Save appearance", symbol: "paintpalette", tint: ADEColor.accent) {
        Task {
          let tags = tagsText.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
          await performAction("save appearance") {
            try await syncService.updateLaneAppearance(snapshot.lane.id, color: colorText, icon: iconText, tags: tags)
          }
        }
      }
      .disabled(!canRunLiveActions)
    }
    .padding(14)
    .background(ADEColor.accent.opacity(0.06), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.accent.opacity(0.22), lineWidth: 1)
    )
  }

  @ViewBuilder
  private var stackTab: some View {
    if isPrimary {
      EmptyView()
    } else {
      VStack(alignment: .leading, spacing: 12) {
        Text("Parent lane is where this lane sits in the stack. Base branch is the ref ADE uses for ahead/behind. Leave it blank to use the parent lane's current branch.")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)

        Text("Runs git rebase. If rebase fails, ADE aborts and restores the previous parent and base.")
          .font(.caption)
          .foregroundStyle(ADEColor.warning)
          .padding(10)
          .background(ADEColor.warning.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

        if snapshot.lane.status.dirty {
          Text("Commit or stash changes before changing stack position.")
            .font(.caption)
            .foregroundStyle(ADEColor.warning)
        }

        if snapshot.lane.status.rebaseInProgress {
          Text("Finish or abort the in-progress rebase before changing stack position.")
            .font(.caption)
            .foregroundStyle(ADEColor.warning)
        }

        if reparentCandidates.isEmpty {
          Text("No valid parent")
            .font(.caption)
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

        LaneActionButton(title: "Apply stack change", symbol: "arrow.triangle.swap", tint: ADEColor.accent) {
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
      .padding(14)
      .background(Color.purple.opacity(0.06), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .stroke(Color.purple.opacity(0.22), lineWidth: 1)
      )
    }
  }

  private var adoptSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: "arrow.up.forward.app")
          .font(.system(size: 18, weight: .semibold))
          .foregroundStyle(ADEColor.accent)
        VStack(alignment: .leading, spacing: 4) {
          Text("Move to ADE-managed worktree")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text("Copies registration into .ade/worktrees so ADE can manage this lane's lifecycle like the others. Does not rewrite git history.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
      }
      LaneActionButton(title: "Move", symbol: "arrow.up.forward.app", tint: ADEColor.accent) {
        Task { await performAdopt() }
      }
      .disabled(!canRunLiveActions || busyAction != nil)
    }
    .padding(14)
    .background(ADEColor.accent.opacity(0.06), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.accent.opacity(0.22), lineWidth: 1)
    )
  }

  private var archiveTab: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        Image(systemName: "archivebox")
          .font(.system(size: 18, weight: .semibold))
          .foregroundStyle(ADEColor.accent)
        VStack(alignment: .leading, spacing: 4) {
          Text("Hide this lane from ADE")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text("Files stay on disk until you delete them.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
      }

      if snapshot.lane.archivedAt == nil {
        LaneActionButton(title: "Archive lane", symbol: "archivebox", tint: ADEColor.warning) {
          Task { await performAction("archive lane") { try await syncService.archiveLane(snapshot.lane.id) } }
        }
        .disabled(!canRunLiveActions || !canArchive)
      } else {
        LaneActionButton(title: "Restore lane", symbol: "tray.and.arrow.up", tint: ADEColor.accent) {
          Task { await performAction("restore lane") { try await syncService.unarchiveLane(snapshot.lane.id) } }
        }
        .disabled(!canRunLiveActions)
      }
    }
    .padding(14)
    .background(ADEColor.surfaceBackground.opacity(0.35), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.border.opacity(0.16), lineWidth: 0.5)
    )
  }

  private var reparentCandidateStack: some View {
    LazyVStack(spacing: 8) {
      ForEach(reparentCandidates) { lane in
        LaneOptionButton(
          title: lane.name,
          subtitle: lane.laneType == "primary" ? "Primary root · \(lane.branchRef)" : lane.branchRef,
          systemImage: lane.laneType == "primary" ? "house.fill" : "arrow.triangle.branch",
          isSelected: selectedParentLaneId == lane.id
        ) {
          selectedParentLaneId = lane.id
          baseBranchOverride = ""
        }
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
        .adeGlassCard(cornerRadius: 14, padding: 18)
        .fixedSize()
      }
    }
  }

  private func manageErrorBanner(_ message: String) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(ADEColor.danger)
      Text(message)
        .font(.caption)
        .foregroundStyle(ADEColor.danger)
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
    }
    .adeGlassCard(cornerRadius: 12, padding: 12)
  }

  @MainActor
  private func performDelete() async {
    guard deleteSelection.hasAny else { return }
    guard canRunLiveActions else {
      ADEHaptics.warning()
      errorMessage = "Reconnect to machine before you delete lane."
      return
    }
    do {
      busyAction = "delete lane"
      errorMessage = nil
      try await syncService.deleteLane(
        snapshot.lane.id,
        deleteBranch: deleteSelection.localBranch,
        deleteRemoteBranch: deleteSelection.remoteBranch,
        force: deleteForce
      )
      dismiss()
      if let onDeleted {
        await onDeleted()
      } else {
        await onComplete()
      }
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
    busyAction = nil
  }

  @MainActor
  private func performAdopt() async {
    await performAction("move lane") { _ = try await syncService.adoptAttachedLane(snapshot.lane.id) }
  }

  @MainActor
  private func performAction(_ label: String, operation: () async throws -> Void) async {
    guard canRunLiveActions else {
      ADEHaptics.warning()
      errorMessage = "Reconnect to machine before you \(label)."
      return
    }
    do {
      busyAction = label
      errorMessage = nil
      try await operation()
      dismiss()
      await onComplete()
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
    busyAction = nil
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
