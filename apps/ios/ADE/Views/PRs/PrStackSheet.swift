import SwiftUI

/// Bottom-sheet stack visualizer for a PR group. Renders the chain returned
/// by the host: ordered lane graph with depth-based indentation, a role
/// badge (base/body/head) derived from position, a dirty-worktree warning
/// pulled from the mobile snapshot, and a PR state pill per member. Tapping
/// a member with a PR pushes into PrDetailView inside the sheet.
struct PrStackSheet: View {
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss

  let groupId: String
  let groupName: String?

  @State private var members: [PrGroupMemberSummary] = []
  @State private var stackInfo: PrStackInfo?
  @State private var isLoading = true
  @State private var errorMessage: String?
  @State private var detailPath = NavigationPath()

  var body: some View {
    NavigationStack(path: $detailPath) {
      List {
        if isLoading && members.isEmpty {
          ProgressView()
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, 24)
            .prListRow()
        } else if let errorMessage {
          ADENoticeCard(
            title: "Stack failed to load",
            message: errorMessage,
            icon: "exclamationmark.triangle.fill",
            tint: ADEColor.danger,
            actionTitle: "Retry",
            action: { Task { await reload() } }
          )
          .prListRow()
        } else if stackRows.isEmpty {
          ADEEmptyStateView(
            symbol: "list.number",
            title: "No stack members",
            message: "The host did not sync any PR chain members for this workflow yet."
          )
          .prListRow()
        } else {
          stackHeader
            .prListRow()

          ForEach(stackRows) { row in
            PrStackMemberRow(row: row) {
              guard let prId = row.prId else { return }
              detailPath.append(prId)
            }
            .prListRow()
          }
        }
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .adeScreenBackground()
      .adeNavigationGlass()
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

  private var stackHeader: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(groupName ?? "Stacked pull requests")
        .font(.headline)
        .foregroundStyle(ADEColor.textPrimary)
      Text("\(stackRows.count) lane\(stackRows.count == 1 ? "" : "s") · base at top")
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .adeGlassCard(cornerRadius: 18)
  }

  private var stackRows: [PrStackRowData] {
    buildStackRows(members: members, stackInfo: stackInfo)
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
    // Prefer the snapshot's explicit depth so sibling chains render
    // distinct indentation when the snapshot computed a richer tree.
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

// MARK: - Row view

private struct PrStackMemberRow: View {
  let row: PrStackRowData
  let onTap: () -> Void

  private var indent: CGFloat {
    CGFloat(min(row.depth, 4)) * 12
  }

  var body: some View {
    Button(action: onTap) {
      HStack(alignment: .top, spacing: 10) {
        Rectangle()
          .fill(row.role.tint.opacity(0.45))
          .frame(width: 3)
          .frame(maxHeight: .infinity)
          .clipShape(Capsule())

        VStack(alignment: .leading, spacing: 8) {
          HStack(spacing: 6) {
            ADEStatusPill(text: "#\(row.position + 1)", tint: ADEColor.textMuted)
            ADEStatusPill(text: row.role.label, tint: row.role.tint)
            if row.dirty {
              ADEStatusPill(text: "DIRTY", tint: ADEColor.warning)
            }
            Spacer(minLength: 4)
            ADEStatusPill(text: row.state.uppercased(), tint: prStateTint(row.state))
          }

          Text(row.title)
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
            .multilineTextAlignment(.leading)

          Text("#\(row.prNumber) · \(row.headBranch) → \(row.baseBranch)")
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(ADEColor.textSecondary)

          HStack(spacing: 6) {
            Text(row.laneName)
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
            Spacer(minLength: 4)
            if row.prId != nil {
              Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(ADEColor.textMuted)
            }
          }
        }
      }
      .padding(.leading, indent)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(row.prId == nil)
    .adeGlassCard(cornerRadius: 18)
  }
}
