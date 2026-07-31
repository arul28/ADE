import SwiftUI

/// Bottom-sheet stack visualizer for a PR group. Renders the chain returned
/// by the host as a vertical-rail DAG (`PrStackDiagramView`) and offers a
/// rebase action for its integration lanes. Tapping a member with a PR pushes
/// into PrDetailView inside the sheet.
struct PrStackSheet: View {
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss

  let groupId: String
  let groupName: String?

  @State private var members: [PrGroupMemberSummary] = []
  @State private var stackInfo: PrStackInfo?
  @State private var isLoading = true
  @State private var errorMessage: String?
  @State private var actionErrorMessage: String?
  @State private var detailPath = NavigationPath()
  @State private var isDispatchingStackAction = false
  @State private var actionMessage: String?

  var body: some View {
    NavigationStack(path: $detailPath) {
      ZStack {
        prLiquidGlassBackdrop()

        // 4x5 grab handle at the top of the sheet — pure visual affordance,
        // matching the frame `2pDr5` in the pencil.
        VStack {
          RoundedRectangle(cornerRadius: 2.5, style: .continuous)
            .fill(Color.white.opacity(0.25))
            .frame(width: 36, height: 5)
            .padding(.top, 6)
          Spacer(minLength: 0)
        }
        .allowsHitTesting(false)

        contentView
      }
      .navigationTitle(groupName ?? "PR stack")
      .navigationBarTitleDisplayMode(.inline)
      .navigationDestination(for: String.self) { prId in
        PrDetailView(prId: prId, transitionNamespace: nil)
          .environmentObject(syncService)
      }
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") { dismiss() }
        }
      }
      .task {
        await reload()
      }
    }
  }

  // MARK: - Content

  @ViewBuilder
  private var contentView: some View {
    Group {
      if isLoading && members.isEmpty {
        VStack {
          ProgressView()
            .padding(.vertical, 32)
        }
        .frame(maxWidth: .infinity)
      } else if let errorMessage, !syncService.connectionState.isHostUnreachable {
          ScrollView {
            ADENoticeCard(
              title: "Stack failed to load",
              message: errorMessage,
              icon: "exclamationmark.triangle.fill",
              tint: ADEColor.danger,
              actionTitle: "Retry",
              action: { Task { await reload() } }
            )
            .padding(16)
          }
        } else if stackRows.isEmpty {
          ScrollView {
            ADEEmptyStateView(
              symbol: syncService.connectionState.isHostUnreachable ? "wifi.exclamationmark" : "list.number",
              title: syncService.connectionState.isHostUnreachable ? "Offline" : "No stack members",
              message: syncService.connectionState.isHostUnreachable
                ? "Reconnect to the machine to load this PR stack."
                : "The machine did not sync any PR chain members for this workflow yet."
            )
            .padding(16)
          }
        } else {
          ScrollView {
            VStack(alignment: .leading, spacing: 14) {
              if let actionMessage {
                ADENoticeCard(
                  title: "Stack action",
                  message: actionMessage,
                  icon: "checkmark.circle.fill",
                  tint: ADEColor.success,
                  actionTitle: nil,
                  action: nil
                )
                .padding(.horizontal, 16)
              }

              if let actionErrorMessage {
                ADENoticeCard(
                  title: "Stack action failed",
                  message: actionErrorMessage,
                  icon: "exclamationmark.triangle.fill",
                  tint: ADEColor.danger,
                  actionTitle: nil,
                  action: nil
                )
                .padding(.horizontal, 16)
              }

              stackHero
                .padding(.horizontal, 16)
                .padding(.top, 20) // clearance for grab handle

              PrSectionHdr(title: "Stack")

              VStack(alignment: .leading, spacing: 0) {
                PrStackDiagramView(nodes: diagramNodes)
              }
              .padding(.vertical, 4)
              .prGlassCard(cornerRadius: 18)
              .padding(.horizontal, 16)

              Color.clear.frame(height: 90) // leave room for sticky bar
            }
            .frame(maxWidth: .infinity, alignment: .leading)
          }
          .safeAreaInset(edge: .bottom) {
            PrStickyActionBar {
              Button("Rebase stack") {
                dispatchRebaseStack()
              }
              .buttonStyle(.glassProminent)
              .tint(PrGlassPalette.purpleBright)
              .frame(maxWidth: .infinity)
              .disabled(isDispatchingStackAction || rebaseTargetLaneId == nil)
            }
          }
        }
    }
  }

  // MARK: - Hero

  private var stackHero: some View {
    let readyCount = stackRows.filter { $0.state == "open" || $0.state == "merged" }.count
    let totalCount = stackRows.count
    let commitCount = stackInfo?.members.count ?? totalCount
    let baseBranch = stackRows.first?.baseBranch ?? "main"
    let headBranch = stackRows.last?.headBranch ?? (groupName ?? "stack")
    let readyTint: Color = readyCount == totalCount ? PrGlassPalette.success : PrGlassPalette.warning
    return VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 6) {
        PrTagChip(label: "integration", color: PrGlassPalette.blue)
        if totalCount > 0 {
          HStack(spacing: 4) {
            Circle()
              .fill(readyTint)
              .frame(width: 5, height: 5)
            Text("\(readyCount) of \(totalCount) ready")
              .font(.system(size: 10, weight: .bold))
              .foregroundStyle(readyTint)
          }
          .padding(.horizontal, 9)
          .padding(.vertical, 4)
          .background(Capsule(style: .continuous).fill(readyTint.opacity(0.14)))
          .overlay(Capsule(style: .continuous).strokeBorder(readyTint.opacity(0.4), lineWidth: 0.5))
        }
        Spacer(minLength: 0)
      }
      Text(groupName ?? "Stacked pull requests")
        .font(.system(size: 24, weight: .bold))
        .foregroundStyle(ADEColor.textPrimary)
        .multilineTextAlignment(.leading)
        .lineLimit(2)
      Text("\(headBranch) → \(baseBranch) · \(totalCount) child\(totalCount == 1 ? "" : "ren") · \(commitCount) commits")
        .font(.system(size: 11, weight: .medium, design: .monospaced))
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  // MARK: - Data

  private var stackRows: [PrStackRowData] {
    buildStackRows(members: members, stackInfo: stackInfo)
  }

  private var diagramNodes: [PrStackNode] {
    let rows = stackRows
    guard !rows.isEmpty else { return [] }
    return rows.enumerated().map { index, row in
      let diagramState: String
      if row.state == "draft" { diagramState = "draft" }
      else if row.state == "closed" { diagramState = "blocked" }
      else if row.role == .base { diagramState = "base" }
      else { diagramState = "open" }

      let adeKind: String?
      let kindColor: Color
      switch row.role {
      case .base:
        adeKind = "integration"
        kindColor = PrGlassPalette.warning
      case .body:
        adeKind = "lane"
        kindColor = PrGlassPalette.blue
      case .head:
        adeKind = "lane"
        kindColor = PrGlassPalette.purple
      }

      let sub: String?
      if row.dirty {
        sub = "dirty worktree"
      } else if row.state == "draft" {
        sub = "draft"
      } else if row.state == "merged" {
        sub = "merged"
      } else {
        sub = row.state
      }

      return PrStackNode(
        id: row.id,
        label: "#\(row.prNumber) · \(row.title)",
        branch: row.headBranch,
        state: diagramState,
        adeKind: adeKind,
        kindColor: kindColor,
        subMetric: sub,
        indent: min(row.depth, 2),
        isRoot: row.role == .base,
        isLast: index == rows.count - 1
      )
    }
  }

  /// Lane to rebase when the user taps "Rebase stack". We prefer the head of
  /// the stack (the most-child PR) because rebasing the head cascades through
  /// ancestors via auto-rebase. Falls back to the first non-base row.
  private var rebaseTargetLaneId: String? {
    let rows = stackRows
    if let head = rows.last(where: { $0.role != .base }) {
      return head.laneId
    }
    return rows.first(where: { $0.role != .base })?.laneId
  }

  private func dispatchRebaseStack() {
    guard !isDispatchingStackAction, let laneId = rebaseTargetLaneId else { return }
    isDispatchingStackAction = true
    errorMessage = nil
    actionMessage = nil
    actionErrorMessage = nil
    Task { @MainActor in
      defer { isDispatchingStackAction = false }
      do {
        try await syncService.startLaneRebase(laneId: laneId)
        actionMessage = "Rebase started."
      } catch {
        actionErrorMessage = error.localizedDescription
      }
    }
  }

  @MainActor
  private func reload() async {
    isLoading = true
    defer { isLoading = false }
    do {
      async let membersTask: [PrGroupMemberSummary] = syncService.fetchPullRequestGroupMembers(groupId: groupId)
      async let snapshotTask: PrMobileSnapshot? = {
        do {
          return try await syncService.fetchPrMobileSnapshot()
        } catch {
          return nil
        }
      }()

      let fetchedMembers = try await membersTask
      let snapshot = await snapshotTask

      members = fetchedMembers
      stackInfo = selectStackInfo(from: snapshot, forMembers: fetchedMembers)
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  /// Match by laneId overlap: the snapshot's stack whose members cover the
  /// most group member laneIds wins. This tolerates stack data that was
  /// computed with different grouping semantics than the PR group.
  private func selectStackInfo(
    from snapshot: PrMobileSnapshot?,
    forMembers members: [PrGroupMemberSummary]
  ) -> PrStackInfo? {
    guard let snapshot, !members.isEmpty else { return nil }
    let memberLaneIds = Set(members.map(\.laneId))
    var bestMatch: (stack: PrStackInfo, overlap: Int)?
    for stack in snapshot.stacks {
      let overlap = stack.members.reduce(0) { count, entry in
        memberLaneIds.contains(entry.laneId) ? count + 1 : count
      }
      if overlap == 0 { continue }
      if let current = bestMatch, overlap <= current.overlap { continue }
      bestMatch = (stack, overlap)
    }
    return bestMatch?.stack
  }
}

// MARK: - Row data

/// Flattened row model that joins a PrGroupMemberSummary (title + PR number +
/// grouping) with optional PrStackMember data (dirty flag + explicit depth).
struct PrStackRowData: Identifiable, Equatable {
  let id: String
  let prId: String?
  let title: String
  let laneId: String
  let laneName: String
  let prNumber: Int
  let state: String
  let baseBranch: String
  let headBranch: String
  let position: Int
  let depth: Int
  let role: PrStackRowRole
  let dirty: Bool
}

enum PrStackRowRole: String, Equatable {
  case base
  case body
  case head

  var label: String {
    switch self {
    case .base: return "BASE"
    case .body: return "BODY"
    case .head: return "HEAD"
    }
  }

  var tint: Color {
    switch self {
    case .base: return ADEColor.textSecondary
    case .body: return ADEColor.accent
    case .head: return ADEColor.success
    }
  }
}

func buildStackRows(
  members: [PrGroupMemberSummary],
  stackInfo: PrStackInfo?
) -> [PrStackRowData] {
  let ordered = members.sorted(by: { $0.position < $1.position })
  guard !ordered.isEmpty else { return [] }

  let stackByLaneId: [String: PrStackMember] = Dictionary(
    (stackInfo?.members ?? []).map { ($0.laneId, $0) },
    uniquingKeysWith: { _, new in new }
  )

  let lastIndex = ordered.count - 1
  return ordered.enumerated().map { index, member in
    let stackMember = stackByLaneId[member.laneId]
    let role: PrStackRowRole
    if index == 0 {
      role = .base
    } else if index == lastIndex {
      role = .head
    } else {
      role = .body
    }
    let depth = stackMember?.depth ?? index
    return PrStackRowData(
      id: member.prId.isEmpty ? "lane:\(member.laneId)" : member.prId,
      prId: member.prId.isEmpty ? nil : member.prId,
      title: member.title,
      laneId: member.laneId,
      laneName: member.laneName,
      prNumber: member.githubPrNumber,
      state: member.state,
      baseBranch: member.baseBranch,
      headBranch: member.headBranch,
      position: member.position,
      depth: depth,
      role: role,
      dirty: stackMember?.dirty ?? false
    )
  }
}
