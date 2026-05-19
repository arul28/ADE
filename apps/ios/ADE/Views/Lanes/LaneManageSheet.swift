import SwiftUI

struct LaneManageSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let snapshot: LaneListSnapshot
  let allLaneSnapshots: [LaneListSnapshot]
  let onComplete: @MainActor () async -> Void

  @State private var renameText: String
  @State private var selectedParentLaneId: String
  @State private var baseBranchOverride: String = ""
  @State private var colorText: String
  @State private var iconText: String
  @State private var tagsText: String
  @State private var deleteMode: LaneDeleteMode
  @State private var deleteRemoteName = "origin"
  @State private var deleteForce = false
  @State private var busyAction: String?
  @State private var errorMessage: String?

  init(
    snapshot: LaneListSnapshot,
    allLaneSnapshots: [LaneListSnapshot],
    onComplete: @escaping @MainActor () async -> Void
  ) {
    self.snapshot = snapshot
    self.allLaneSnapshots = allLaneSnapshots
    self.onComplete = onComplete
    let primaryLaneId = allLaneSnapshots.first(where: { $0.lane.laneType == "primary" })?.lane.id ?? ""
    _renameText = State(initialValue: snapshot.lane.name)
    _selectedParentLaneId = State(initialValue: snapshot.lane.parentLaneId ?? primaryLaneId)
    _colorText = State(initialValue: snapshot.lane.color ?? "")
    _iconText = State(initialValue: snapshot.lane.icon?.rawValue ?? "")
    _tagsText = State(initialValue: snapshot.lane.tags.joined(separator: ", "))
    _deleteMode = State(initialValue: .worktree)
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

  private var canArchive: Bool {
    snapshot.lane.laneType != "primary"
  }

  private var primaryLaneId: String {
    allLaneSnapshots.first(where: { $0.lane.laneType == "primary" })?.lane.id ?? ""
  }

  private var effectiveCurrentParentId: String {
    snapshot.lane.parentLaneId ?? primaryLaneId
  }

  /// Branch ref the host will stack onto when the override field is empty —
  /// matches desktop placeholder copy and mirrors the lanes.reparent fallback.
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
    // Empty input means "use the selected parent's current branch". That is
    // only a real change when the lane's stored base actually diverges from
    // the selected parent's effective branch — `snapshot.lane.baseRef` is a
    // non-optional string and is essentially always populated, so gating on
    // its mere presence enables Apply on initial sheet open and risks an
    // unintended rebase. Compare normalized values against the parent's
    // default to mirror the backend's normalizeBranchName (strips
    // refs/heads/ and origin/ prefixes).
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
            HStack(alignment: .top, spacing: 10) {
              Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(ADEColor.danger)
              Text(errorMessage)
                .font(.caption)
                .foregroundStyle(ADEColor.danger)
                .fixedSize(horizontal: false, vertical: true)
              Spacer(minLength: 0)
            }
            .adeGlassCard(cornerRadius: 12, padding: 12)
          }

          GlassSection(title: "Identity") {
            VStack(alignment: .leading, spacing: 12) {
              LaneTextField("Lane name", text: $renameText)
              LaneActionButton(title: "Save name", symbol: "checkmark.circle.fill", tint: ADEColor.accent) {
                Task { await performAction("rename lane") { try await syncService.renameLane(snapshot.lane.id, name: renameText) } }
              }
              .disabled(!canRunLiveActions || renameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || renameText == snapshot.lane.name)
            }
          }

          GlassSection(title: "Appearance") {
            VStack(alignment: .leading, spacing: 12) {
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
          }

          if snapshot.lane.laneType != "primary" {
            GlassSection(title: "Stack position") {
              VStack(alignment: .leading, spacing: 12) {
                Text("Parent lane is where this lane sits in the stack; the primary lane is the root. Base branch is the ref ADE uses for ahead/behind. Leave it blank to use the parent lane's current branch.")
                  .font(.caption)
                  .foregroundStyle(ADEColor.textSecondary)
                  .fixedSize(horizontal: false, vertical: true)

                HStack(alignment: .top, spacing: 10) {
                  Image(systemName: "exclamationmark.bubble.fill")
                    .foregroundStyle(ADEColor.warning)
                    .accessibilityHidden(true)
                  Text("Runs git rebase. Applying updates ADE then runs git rebase in this lane's worktree onto the resolved base commit. If rebase fails, ADE aborts and restores the previous parent and base.")
                    .font(.caption)
                    .foregroundStyle(ADEColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                  Spacer(minLength: 0)
                }
                .padding(10)
                .background(
                  RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(ADEColor.warning.opacity(0.08))
                )

                if snapshot.lane.status.dirty {
                  HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                      .foregroundStyle(ADEColor.warning)
                      .accessibilityHidden(true)
                    Text("Commit or stash changes before changing stack position.")
                      .font(.caption)
                      .foregroundStyle(ADEColor.warning)
                  }
                }

                if snapshot.lane.status.rebaseInProgress {
                  HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                      .foregroundStyle(ADEColor.warning)
                      .accessibilityHidden(true)
                    Text("Finish or abort the in-progress rebase before changing stack position.")
                      .font(.caption)
                      .foregroundStyle(ADEColor.warning)
                  }
                }

                if reparentCandidates.isEmpty {
                  Text("No valid parent")
                    .font(.caption)
                    .foregroundStyle(ADEColor.textMuted)
                } else if reparentCandidates.count > 4 {
                  ScrollView {
                    reparentCandidateStack
                  }
                  .frame(maxHeight: 320)
                  .scrollBounceBehavior(.basedOnSize)
                } else {
                  reparentCandidateStack
                }

                VStack(alignment: .leading, spacing: 4) {
                  LaneTextField(
                    defaultStackBaseBranch.isEmpty
                      ? "Base branch (optional)"
                      : "Base branch (default: \(defaultStackBaseBranch))",
                    text: $baseBranchOverride
                  )
                  .textInputAutocapitalization(.never)
                  .autocorrectionDisabled()
                  .accessibilityLabel("Base branch override")
                  if !defaultStackBaseBranch.isEmpty {
                    Text("Selected parent is on \(defaultStackBaseBranch) right now; that is used when this is empty.")
                      .font(.caption2)
                      .foregroundStyle(ADEColor.textMuted)
                  }
                }

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
            }
          }

          GlassSection(title: snapshot.lane.archivedAt == nil ? "Archive" : "Restore") {
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

          if snapshot.lane.laneType != "primary" {
            GlassSection(title: "Danger zone") {
              VStack(alignment: .leading, spacing: 12) {
                LazyVStack(spacing: 8) {
                  ForEach(LaneDeleteMode.allCases) { mode in
                    LaneOptionButton(
                      title: mode.title,
                      subtitle: mode.detail,
                      systemImage: mode.symbol,
                      isSelected: deleteMode == mode,
                      tint: ADEColor.danger
                    ) {
                      deleteMode = mode
                    }
                  }
                }

                if deleteMode == .remoteBranch {
                  LaneTextField("Remote name", text: $deleteRemoteName)
                }

                Toggle("Force delete", isOn: $deleteForce)
                  .font(.subheadline)
                  .foregroundStyle(ADEColor.textSecondary)

                Text("Hold to confirm deletion of \(snapshot.lane.name).")
                  .font(.caption)
                  .foregroundStyle(ADEColor.textSecondary)

                LaneHoldToConfirmButton(title: "Delete lane", symbol: "trash", tint: ADEColor.danger) {
                  Task {
                    await performAction("delete lane") {
                      try await syncService.deleteLane(
                        snapshot.lane.id,
                        deleteBranch: deleteMode != .worktree,
                        deleteRemoteBranch: deleteMode == .remoteBranch,
                        remoteName: deleteRemoteName,
                        force: deleteForce
                      )
                    }
                  }
                }
                .disabled(!canRunLiveActions)
              }
            }
            .overlay(
              RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(ADEColor.danger.opacity(0.4), lineWidth: 1)
                .allowsHitTesting(false)
            )
          }
        }
        .padding(16)
        .allowsHitTesting(busyAction == nil)
      }
      .adeScreenBackground()
      .overlay {
        if busyAction != nil {
          ZStack {
            ADEColor.pageBackground.opacity(0.55)
              .ignoresSafeArea()
            VStack(spacing: 10) {
              ProgressView()
                .tint(ADEColor.accent)
              Text(busyAction?.capitalized ?? "Working...")
                .font(.subheadline)
                .foregroundStyle(ADEColor.textSecondary)
            }
            .adeGlassCard(cornerRadius: 14, padding: 18)
            .fixedSize()
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }
      .adeNavigationGlass()
      .navigationTitle("Manage lane")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") { dismiss() }
            .disabled(busyAction != nil)
        }
      }
    }
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
          // Clear the override so the new parent's branch is used as
          // the default — matches desktop behavior on parent change.
          baseBranchOverride = ""
        }
      }
    }
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
