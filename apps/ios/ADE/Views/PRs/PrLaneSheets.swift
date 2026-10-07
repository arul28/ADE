import SwiftUI
import UIKit

// The PRs tab's lane sheets: create a lane from a PR (on a chosen machine)
// and link a PR to an existing lane, with their glass pieces.

// MARK: - Auto-map confirmation sheet (create lane from PR branch)
//
// Mirrors desktop's `CreateLaneFromPrBranchDialog`: a compact summary of the
// resolved preflight (PR, source branch, target lane, base branch) plus a
// blocking-conflict banner and a primary "Create lane" action. With more than
// one machine it asks which one first (least busy first), like Add lane, and
// Create stays off until one is picked. The preflight runs on the picked
// machine: branch ownership is per machine.

struct PrAutoMapSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService
  let item: GitHubPrListItem
  /// Least busy first. Empty means the focused machine only.
  let machines: [PrLaneMachine]
  let canCreate: Bool
  let onCreate: (PrLaneMachine?) -> Void
  let onCancel: () -> Void

  @State private var selectedMachineId: String?
  @State private var preflight: PrAutoMapPreflight?
  @State private var loading = false
  @State private var blockingMessage: String?

  init(
    item: GitHubPrListItem,
    machines: [PrLaneMachine],
    canCreate: Bool,
    onCreate: @escaping (PrLaneMachine?) -> Void,
    onCancel: @escaping () -> Void
  ) {
    self.item = item
    self.machines = machines
    self.canCreate = canCreate
    self.onCreate = onCreate
    self.onCancel = onCancel
    _selectedMachineId = State(initialValue: machines.count > 1 ? nil : machines.first?.id ?? "")
  }

  private var selectedMachine: PrLaneMachine? {
    machines.first { $0.id == selectedMachineId }
  }

  /// A machine is named: picked from the list, or the only one there is.
  private var hasMachine: Bool { selectedMachineId != nil }

  private var sourceBranch: String {
    preflight?.remoteBranch ?? preflight?.headBranch ?? item.headBranch ?? "—"
  }

  private var targetLane: String {
    if let name = preflight?.targetLaneName, !name.isEmpty { return name }
    let branch = (item.headBranch ?? "").replacingOccurrences(of: "refs/heads/", with: "")
    return branch.isEmpty ? "New lane" : branch
  }

  private var baseBranch: String {
    preflight?.baseBranch ?? item.baseBranch ?? "—"
  }

  private var createEnabled: Bool {
    canCreate && hasMachine && !loading && (preflight?.canCreate ?? false) && blockingMessage == nil
  }

  var body: some View {
    PrKitSheet(title: "Create lane", onCancel: { onCancel(); dismiss() }) {
      PrSheetSummary(number: item.githubPrNumber, title: item.title, state: item.isDraft ? "draft" : item.state, author: item.author)

      if machines.count > 1 {
        machinePicker
      }

      if loading {
        HStack(spacing: 10) {
          ProgressView().controlSize(.small)
          Text("Checking branch ownership and PR head…")
            .font(.system(size: 13))
            .foregroundStyle(ADEColor.textSecondary)
          Spacer(minLength: 0)
        }
        .padding(.horizontal, 4)
      } else if hasMachine {
        ADESettingsSection("Branches") {
          ADESettingsRows {
            ADESettingsValueRow(title: "Source branch", value: sourceBranch, symbol: "arrow.triangle.branch", mono: true)
            ADESettingsValueRow(title: "Target lane", value: targetLane, symbol: "rectangle.stack", mono: true)
            ADESettingsValueRow(title: "Base branch", value: baseBranch, symbol: "arrow.down.to.line", mono: true)
          }
        }
      }

      if let blockingMessage, !blockingMessage.isEmpty {
        ADESettingsNotice(message: blockingMessage, tone: .crit)
      }

      Button {
        onCreate(selectedMachine)
        dismiss()
      } label: {
        Label("Create lane", systemImage: "arrow.triangle.branch")
      }
      .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
      .disabled(!createEnabled)
      .opacity(createEnabled ? 1 : 0.45)
    }
    .task(id: selectedMachineId) {
      await runPreflight()
    }
  }

  private var machinePicker: some View {
    ADESettingsSection("Machine") {
      ADESettingsRows {
        ForEach(Array(machines.enumerated()), id: \.element.id) { index, machine in
          Button {
            selectedMachineId = machine.id
          } label: {
            ADESettingsRow(
              title: machine.name,
              hint: machineChoiceSubtitle(runningCount: machine.runningCount, isLeastBusy: index == 0),
              symbol: "desktopcomputer"
            ) {
              if selectedMachineId == machine.id {
                Image(systemName: "checkmark")
                  .font(.system(size: 14, weight: .semibold))
                  .foregroundStyle(ADEColor.accent)
              }
            }
          }
          .buttonStyle(ADEKitRowButtonStyle())
          .accessibilityAddTraits(selectedMachineId == machine.id ? .isSelected : [])
        }
      }
    }
  }

  /// Best-effort dry run on the picked machine: a failure leaves Create off
  /// with the reason shown.
  @MainActor
  private func runPreflight() async {
    preflight = nil
    blockingMessage = nil
    guard hasMachine, canCreate else {
      loading = false
      return
    }
    let machineId = selectedMachineId
    loading = true
    do {
      let result: PrAutoMapPreflightResult
      if let machine = selectedMachine {
        result = try await syncService.preflightCreateLaneFromPrBranch(
          repoOwner: item.repoOwner, repoName: item.repoName, githubPrNumber: item.githubPrNumber, on: machine
        )
      } else {
        result = try await syncService.preflightCreateLaneFromPrBranch(
          repoOwner: item.repoOwner, repoName: item.repoName, githubPrNumber: item.githubPrNumber
        )
      }
      // Ignore a stale answer when the user picked another machine meanwhile.
      guard !Task.isCancelled, selectedMachineId == machineId else { return }
      preflight = result.preflight
      blockingMessage = result.preflight.blockingConflict?.message
    } catch {
      guard !Task.isCancelled, selectedMachineId == machineId else { return }
      blockingMessage = error.localizedDescription
    }
    loading = false
  }
}


struct PrLaneLinkSheet: View {
  @Environment(\.dismiss) private var dismiss
  let item: GitHubPrListItem
  let lanes: [LaneSummary]
  let canLink: Bool
  /// Names each lane's machine when the repository is on more than one.
  var machineContext: PrMachineContext = .single
  let onLink: (String) -> Void
  let onOpenGitHub: () -> Void
  @State private var selectedLaneId = ""

  private var availableLanes: [LaneSummary] {
    let expectedBranch = normalizedPrBranchName(item.headBranch)
    return lanes
      .filter { lane in
        guard lane.archivedAt == nil, lane.laneType != "primary" else { return false }
        guard !expectedBranch.isEmpty else { return false }
        // Git refs are case-sensitive — case-insensitive matching can offer or
        // preselect the wrong lane when two branches differ only by case.
        return normalizedPrBranchName(lane.branchRef) == expectedBranch
      }
      .sorted { lhs, rhs in lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending }
  }

  var body: some View {
    PrKitSheet(title: "Link to lane", onCancel: { dismiss() }) {
      PrSheetSummary(
        number: item.githubPrNumber,
        title: item.title,
        state: item.isDraft ? "draft" : item.state,
        detail: [item.headBranch.flatMap { head in item.baseBranch.map { "\(head) → \($0)" } }, "\(item.repoOwner)/\(item.repoName)"]
          .compactMap { $0 }
          .joined(separator: " · "),
        author: item.author
      )

      if !canLink {
        ADESettingsNotice(message: "Reconnect to a machine that supports PR lane linking.")
      }

      ADESettingsSection("Lane", hint: laneSelectionMessage) {
        if availableLanes.isEmpty {
          ADESettingsRows {
            ADESettingsRow(emptyLaneMessage, symbol: "tray", titleColor: ADEColor.textSecondary)
          }
        } else {
          ADESettingsRows {
            ForEach(availableLanes) { lane in
              Button {
                selectedLaneId = lane.id
              } label: {
                ADESettingsRow(
                  title: machineContext.machineName(forLaneId: lane.id).map { "\(lane.name) · \($0)" } ?? lane.name,
                  hint: lane.branchRef,
                  symbol: "arrow.triangle.branch"
                ) {
                  if selectedLaneId == lane.id {
                    Image(systemName: "checkmark")
                      .font(.system(size: 14, weight: .semibold))
                      .foregroundStyle(ADEColor.accent)
                  }
                }
              }
              .buttonStyle(ADEKitRowButtonStyle())
              .accessibilityAddTraits(selectedLaneId == lane.id ? .isSelected : [])
            }
          }
        }
      }

      VStack(spacing: 10) {
        Button {
          onLink(selectedLaneId)
        } label: {
          Label("Link to lane", systemImage: "link")
        }
        .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
        .disabled(!canLink || selectedLaneId.isEmpty)
        .opacity(!canLink || selectedLaneId.isEmpty ? 0.45 : 1)

        Button {
          onOpenGitHub()
        } label: {
          Label("Open on GitHub", systemImage: "arrow.up.right.square")
        }
        .buttonStyle(ADEKitButtonStyle(wide: true))
      }
    }
    .onAppear {
      if selectedLaneId.isEmpty {
        // Only honor linkedLaneId if it is still in the visible option set; otherwise
        // the primary action stays enabled with no rendered selection.
        let linkedIfVisible = item.linkedLaneId.flatMap { id in
          availableLanes.contains(where: { $0.id == id }) ? id : nil
        }
        selectedLaneId = linkedIfVisible ?? exactBranchMatchedLane?.id ?? availableLanes.first?.id ?? ""
      }
    }
  }

  private var exactBranchMatchedLane: LaneSummary? {
    matchedLaneForExactBranch(item.headBranch, lanes: availableLanes)
  }

  private var laneSelectionMessage: String {
    if let exactBranchMatchedLane, selectedLaneId == exactBranchMatchedLane.id {
      return "Preselected because the PR branch matches \(exactBranchMatchedLane.branchRef)."
    }
    if !canLink {
      return "Reconnect before linking this PR."
    }
    let expectedBranch = normalizedPrBranchName(item.headBranch)
    if expectedBranch.isEmpty {
      return "This PR is missing a head branch, so ADE cannot choose a lane."
    }
    if availableLanes.isEmpty {
      return "Create or import a lane on \(expectedBranch), then refresh PRs."
    }
    if selectedLaneId.isEmpty {
      return "Choose the lane on \(expectedBranch)."
    }
    return "Confirm this lane before linking; ADE will attach this GitHub PR to the selected lane."
  }

  private var emptyLaneMessage: String {
    let expectedBranch = normalizedPrBranchName(item.headBranch)
    guard !expectedBranch.isEmpty else {
      return "This PR does not include a head branch."
    }
    return "No ADE lane is on \(expectedBranch)."
  }
}

// MARK: - Sheet pieces

/// A PR sheet on the kit: inline title, Cancel, one calm column of sections.
struct PrKitSheet<Content: View>: View {
  let title: String
  let onCancel: () -> Void
  @ViewBuilder let content: () -> Content

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 22) {
          content()
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 24)
      }
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", action: onCancel)
        }
      }
    }
    .presentationDetents([.large])
  }
}

/// The PR a sheet acts on: state icon, number, title, one detail line, author.
struct PrSheetSummary: View {
  let number: Int
  let title: String
  var state: String = "open"
  var detail: String? = nil
  var author: String? = nil
  var avatarUrl: String? = nil

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      PrStateIcon(state: state, size: 26)
      VStack(alignment: .leading, spacing: 4) {
        Text("\(Text(verbatim: "#\(number)").font(.adeMono(14, weight: .medium)).foregroundStyle(ADEColor.textMuted)) \(title)")
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .fixedSize(horizontal: false, vertical: true)
        if let detail, !detail.isEmpty {
          Text(verbatim: detail)
            .font(.adeMono(11))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(2)
            .truncationMode(.middle)
        }
      }
      Spacer(minLength: 0)
      if let author, !author.isEmpty {
        PrAvatar(login: author, avatarUrl: avatarUrl, size: 22)
      }
    }
    .adeKitCard()
  }
}

// MARK: - Wizard-surfaced errors
