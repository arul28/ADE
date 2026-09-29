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
    PrLiquidSheetShell(
      title: "Create lane from PR branch",
      trailingLabel: "Cancel",
      onTrailing: {
        onCancel()
        dismiss()
      }
    ) {
      VStack(alignment: .leading, spacing: 16) {
        VStack(alignment: .leading, spacing: 8) {
          HStack(spacing: 8) {
            Text(verbatim: "#\(item.githubPrNumber)")
              .font(.system(size: 18, weight: .bold, design: .monospaced))
              .foregroundStyle(PrGlassPalette.purpleBright)
            Spacer(minLength: 0)
          }
          Text(item.title)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(PrsGlass.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
        }

        if machines.count > 1 {
          machinePicker
        }

        if loading {
          HStack(spacing: 10) {
            ProgressView().tint(PrGlassPalette.purpleBright)
            Text("Checking branch ownership and PR head…")
              .font(.system(size: 12))
              .foregroundStyle(PrsGlass.textSecondary)
            Spacer(minLength: 0)
          }
        } else if hasMachine {
          VStack(spacing: 8) {
            PrGlassMonoRow(eyebrow: "Source branch", value: sourceBranch, icon: "arrow.triangle.branch")
            PrGlassMonoRow(eyebrow: "Target lane", value: targetLane, icon: "rectangle.stack")
            PrGlassMonoRow(eyebrow: "Base branch", value: baseBranch, icon: "arrow.down.to.line")
          }
        }

        if let blockingMessage, !blockingMessage.isEmpty {
          HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
              .font(.system(size: 13))
              .foregroundStyle(PrGlassPalette.danger)
              .padding(.top, 1)
            Text(blockingMessage)
              .font(.system(size: 12))
              .foregroundStyle(PrGlassPalette.danger)
              .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
          }
          .padding(12)
          .frame(maxWidth: .infinity, alignment: .leading)
          .prGlassCard(cornerRadius: 12, tint: PrGlassPalette.danger.opacity(0.55), shadow: false)
        }

        Button {
          onCreate(selectedMachine)
          dismiss()
        } label: {
          Label("Create lane", systemImage: "arrow.triangle.branch")
        }
        .buttonStyle(PrGlassPrimaryButtonStyle())
        .disabled(!createEnabled)
        .opacity(createEnabled ? 1 : 0.5)
      }
      .padding(16)
    }
    .task(id: selectedMachineId) {
      await runPreflight()
    }
  }

  private var machinePicker: some View {
    VStack(alignment: .leading, spacing: 8) {
      PrsEyebrowLabel(text: "Machine")
        .padding(.horizontal, 2)
      VStack(spacing: 6) {
        ForEach(Array(machines.enumerated()), id: \.element.id) { index, machine in
          Button {
            selectedMachineId = machine.id
          } label: {
            HStack(spacing: 12) {
              Image(systemName: "desktopcomputer")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(PrGlassPalette.purpleBright)
                .frame(width: 24)
              VStack(alignment: .leading, spacing: 2) {
                Text(machine.name)
                  .font(.system(size: 13, weight: .semibold))
                  .foregroundStyle(PrsGlass.textPrimary)
                Text(machineChoiceSubtitle(runningCount: machine.runningCount, isLeastBusy: index == 0))
                  .font(.system(size: 11))
                  .foregroundStyle(PrsGlass.textSecondary)
              }
              Spacer(minLength: 0)
              if selectedMachineId == machine.id {
                Image(systemName: "checkmark")
                  .font(.system(size: 13, weight: .semibold))
                  .foregroundStyle(PrGlassPalette.purpleBright)
              }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
            .prGlassCard(cornerRadius: 12, shadow: false)
          }
          .buttonStyle(.plain)
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
    PrLiquidSheetShell(
      title: "Link to lane",
      trailingLabel: "Cancel",
      onTrailing: { dismiss() }
    ) {
      VStack(alignment: .leading, spacing: 14) {
        // PR summary card.
        VStack(alignment: .leading, spacing: 6) {
          Text(item.title)
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(PrsGlass.textPrimary)
            .fixedSize(horizontal: false, vertical: true)

          Text(verbatim: "#\(item.githubPrNumber) · \(item.repoOwner)/\(item.repoName)")
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(PrsGlass.textSecondary)

          if let head = item.headBranch, let base = item.baseBranch {
            Text("\(head) → \(base)")
              .font(.system(size: 11, design: .monospaced))
              .foregroundStyle(PrsGlass.textSecondary)
          }

          HStack(spacing: 6) {
            if let author = item.author, !author.isEmpty {
              Text("@\(author)")
            }
            Text("· updated \(prRelativeTime(item.updatedAt))")
          }
          .font(.system(size: 11, design: .monospaced))
          .foregroundStyle(PrsGlass.textMuted)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .prGlassCard(cornerRadius: 14, shadow: false)

        if !canLink {
          HStack(alignment: .center, spacing: 10) {
            Image(systemName: "wifi.exclamationmark")
              .font(.system(size: 13, weight: .semibold))
              .foregroundStyle(PrGlassPalette.warning)
            Text("Reconnect to a machine that supports PR lane linking.")
              .font(.system(size: 11))
              .foregroundStyle(PrGlassPalette.warning)
              .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
          }
          .padding(.horizontal, 12)
          .padding(.vertical, 10)
          .frame(maxWidth: .infinity, alignment: .leading)
          .prGlassCard(cornerRadius: 12, tint: PrGlassPalette.warning.opacity(0.45), shadow: false)
        }

        VStack(alignment: .leading, spacing: 8) {
          PrsEyebrowLabel(text: "Lane")
            .padding(.horizontal, 2)

          Text(laneSelectionMessage)
            .font(.system(size: 11))
            .foregroundStyle(laneSelectionTint)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 2)
            .padding(.bottom, 2)

          if availableLanes.isEmpty {
            HStack(spacing: 10) {
              Image(systemName: "tray")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(PrsGlass.textMuted)
              Text(emptyLaneMessage)
                .font(.system(size: 12))
                .foregroundStyle(PrsGlass.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
              Spacer(minLength: 0)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .prGlassCard(cornerRadius: 12, shadow: false)
          } else {
            VStack(spacing: 6) {
              ForEach(availableLanes) { lane in
                PrGlassLaneRow(
                  name: machineContext.machineName(forLaneId: lane.id).map { "\(lane.name) · \($0)" } ?? lane.name,
                  branch: lane.branchRef,
                  isSelected: selectedLaneId == lane.id
                ) {
                  selectedLaneId = lane.id
                }
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
          .buttonStyle(PrGlassPrimaryButtonStyle())
          .disabled(!canLink || selectedLaneId.isEmpty)

          Button {
            onOpenGitHub()
          } label: {
            Label("Open on GitHub", systemImage: "arrow.up.right.square")
          }
          .buttonStyle(PrGlassOutlineButtonStyle())
        }
        .padding(.top, 4)
      }
      .padding(16)
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

  private var laneSelectionTint: Color {
    selectedLaneId.isEmpty ? PrGlassPalette.warning : PrsGlass.textSecondary
  }

  private var emptyLaneMessage: String {
    let expectedBranch = normalizedPrBranchName(item.headBranch)
    guard !expectedBranch.isEmpty else {
      return "This PR does not include a head branch."
    }
    return "No ADE lane is on \(expectedBranch)."
  }
}

// MARK: - File-private liquid-glass primitives (sheets)

/// Standard liquid-glass sheet shell: deep-ink backdrop, 36×5 grab handle,
/// inline title bar with a single trailing label (Done/Cancel).
private struct PrLiquidSheetShell<Content: View>: View {
  let title: String
  let trailingLabel: String
  let onTrailing: () -> Void
  @ViewBuilder let content: () -> Content

  var body: some View {
    ZStack {
      prLiquidGlassBackdrop().ignoresSafeArea()

      VStack(spacing: 0) {
        Capsule(style: .continuous)
          .fill(Color.white.opacity(0.25))
          .frame(width: 36, height: 5)
          .padding(.top, 8)
          .padding(.bottom, 8)

        HStack {
          Text(title)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(PrsGlass.textPrimary)
          Spacer(minLength: 0)
          Button(action: onTrailing) {
            Text(trailingLabel)
              .font(.system(size: 14, weight: .semibold))
              .foregroundStyle(PrGlassPalette.purpleBright)
          }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .overlay(alignment: .bottom) {
          Rectangle()
            .fill(Color.white.opacity(0.06))
            .frame(height: 0.5)
        }

        ScrollView {
          content()
        }
      }
    }
    .presentationDetents([.large])
    .presentationDragIndicator(.hidden)
  }
}

/// Small "EXTERNAL" info chip used on the GitHub PR detail sheet.
private struct PrExternalInfoChip: View {
  var body: some View {
    HStack(spacing: 4) {
      Image(systemName: "arrow.up.right.square.fill")
        .font(.system(size: 9, weight: .bold))
      Text("EXTERNAL")
        .font(.system(size: 9, weight: .bold))
        .tracking(1.0)
    }
    .foregroundStyle(PrGlassPalette.blue)
    .padding(.horizontal, 8)
    .padding(.vertical, 4)
    .background(
      Capsule(style: .continuous)
        .fill(PrGlassPalette.blue.opacity(0.18))
    )
    .overlay(
      Capsule(style: .continuous)
        .strokeBorder(PrGlassPalette.blue.opacity(0.35), lineWidth: 0.75)
    )
  }
}

/// Glass row: eyebrow label + monospaced value, with a small glyph disc.
private struct PrGlassMonoRow: View {
  let eyebrow: String
  let value: String
  let icon: String

  var body: some View {
    HStack(alignment: .center, spacing: 12) {
      ZStack {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(Color.white.opacity(0.06))
          .frame(width: 30, height: 30)
        Image(systemName: icon)
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(PrsGlass.textSecondary)
      }

      VStack(alignment: .leading, spacing: 2) {
        Text(eyebrow.uppercased())
          .font(.system(size: 9, weight: .bold))
          .tracking(1.0)
          .foregroundStyle(PrsGlass.textMuted)
        Text(value)
          .font(.system(size: 12, design: .monospaced))
          .foregroundStyle(PrsGlass.textPrimary)
          .lineLimit(1)
          .truncationMode(.middle)
      }

      Spacer(minLength: 0)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .prGlassCard(cornerRadius: 12, shadow: false)
  }
}

/// Lane row for the Lane-Link sheet: lane-icon disc + name + mono branch +
/// selection checkmark.
private struct PrGlassLaneRow: View {
  let name: String
  let branch: String
  let isSelected: Bool
  let onTap: () -> Void

  var body: some View {
    Button(action: onTap) {
      HStack(alignment: .center, spacing: 12) {
        ZStack {
          if isSelected {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
              .fill(PrGlassPalette.accentGradient)
          } else {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
              .fill(Color.white.opacity(0.06))
          }
          Image(systemName: "arrow.triangle.branch")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(isSelected ? Color.white : PrsGlass.textSecondary)
        }
        .frame(width: 32, height: 32)

        VStack(alignment: .leading, spacing: 2) {
          Text(name)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(PrsGlass.textPrimary)
            .lineLimit(1)
          Text(branch)
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(PrsGlass.textSecondary)
            .lineLimit(1)
            .truncationMode(.middle)
        }

        Spacer(minLength: 0)

        if isSelected {
          Image(systemName: "checkmark.circle.fill")
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(PrGlassPalette.purpleBright)
        } else {
          Circle()
            .strokeBorder(Color.white.opacity(0.18), lineWidth: 1)
            .frame(width: 17, height: 17)
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .prGlassCard(
        cornerRadius: 12,
        tint: isSelected ? PrGlassPalette.purple.opacity(0.55) : nil,
        strokeOpacity: isSelected ? 0.22 : 0.10,
        shadow: false
      )
    }
    .buttonStyle(.plain)
  }
}

/// Gradient primary CTA (purple, with glow + inner highlight).
private struct PrGlassPrimaryButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 14, weight: .semibold))
      .foregroundStyle(Color.white)
      .frame(maxWidth: .infinity)
      .frame(height: 44)
      .background(
        ZStack {
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(PrGlassPalette.accentGradient)
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .stroke(
              LinearGradient(
                colors: [Color.white.opacity(0.45), Color.white.opacity(0.05)],
                startPoint: .top,
                endPoint: .bottom
              ),
              lineWidth: 1
            )
        }
      )
      .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1.0) : 0.45)
      .shadow(
        color: PrGlassPalette.purpleDeep.opacity(isEnabled ? 0.45 : 0.0),
        radius: 16,
        x: 0,
        y: 6
      )
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}

/// Glass-outline secondary CTA.
private struct PrGlassOutlineButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 14, weight: .semibold))
      .foregroundStyle(PrsGlass.textPrimary)
      .frame(maxWidth: .infinity)
      .frame(height: 44)
      .background(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(.ultraThinMaterial)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
      )
      .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1.0) : 0.45)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}

// MARK: - Wizard-surfaced errors
