import SwiftUI

private struct PrStackPresentation: Identifiable {
  let id: String
  let groupName: String?
}

struct PrGitHubSurfaceView: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @EnvironmentObject private var syncService: SyncService

  @Binding var path: NavigationPath
  let prs: [PullRequestListItem]
  let snapshotsById: [String: PullRequestSnapshot]
  let lanes: [LaneSummary]
  @Binding var stateFilter: PrListStateFilter
  @Binding var sortOption: PrListSortOption
  let stateCounts: [PrListStateFilter: Int]
  let statusNotice: ADENoticeCard?
  let errorMessage: String?
  let isLive: Bool
  let transitionNamespace: Namespace.ID?
  let onCreatePr: () -> Void
  let onRefresh: () -> Void
  let onOpenQueue: (String) -> Void
  let onOpenRebase: (String) -> Void

  @State private var searchText = ""
  @State private var selectedPrTransitionId: String?
  @State private var externalExpanded = true
  @State private var stackPresentation: PrStackPresentation?
  @State private var linkTarget: PullRequestListItem?
  @State private var swipeActionError: String?

  private var filteredPrs: [PullRequestListItem] {
    let searchContexts = Dictionary(uniqueKeysWithValues: snapshotsById.map { key, snapshot in
      (key, PullRequestSearchContext(authorLogin: snapshot.detail?.author.login))
    })
    let filtered = filterPullRequestListItems(
      prs,
      query: searchText,
      state: stateFilter,
      contexts: searchContexts
    )
    return sortPullRequestListItems(filtered, option: sortOption)
  }

  private var sections: PrGitHubSections {
    partitionGitHubPullRequests(filteredPrs)
  }

  var body: some View {
    NavigationStack(path: $path) {
      List {
        if let statusNotice {
          statusNotice.prListRow()
        }

        PrGitHubFilterCard(
          stateFilter: $stateFilter,
          sortOption: $sortOption,
          counts: stateCounts,
          visibleCount: filteredPrs.count,
          totalCount: prs.count,
          isLive: isLive,
          onRefresh: onRefresh
        )
        .prListRow()

        if let errorMessage, syncService.status(for: .prs).phase == .ready {
          ADENoticeCard(
            title: "PR view error",
            message: errorMessage,
            icon: "exclamationmark.triangle.fill",
            tint: ADEColor.danger,
            actionTitle: "Retry",
            action: onRefresh
          )
          .prListRow()
        }

        if syncService.status(for: .prs).phase == .hydrating || syncService.status(for: .prs).phase == .syncingInitialData {
          ForEach(0..<3, id: \.self) { _ in
            ADECardSkeleton(rows: 3)
              .prListRow()
          }
        } else if filteredPrs.isEmpty {
          ADEEmptyStateView(
            symbol: searchText.isEmpty ? "arrow.triangle.pull" : "magnifyingglass",
            title: emptyStateTitle,
            message: emptyStateMessage
          )
          .prListRow()
        } else {
          if !sections.repoPullRequests.isEmpty {
            Section("Repo pull requests") {
              ForEach(sections.repoPullRequests) { pr in
                prNavigationRow(pr)
              }
            }
          }

          if !sections.externalPullRequests.isEmpty {
            Section {
              DisclosureGroup(isExpanded: $externalExpanded) {
                VStack(spacing: 12) {
                  ForEach(sections.externalPullRequests) { pr in
                    prNavigationRow(pr)
                  }
                }
                .padding(.top, 8)
              } label: {
                HStack {
                  Text("External / Unmapped")
                  Spacer()
                  Text("\(sections.externalPullRequests.count)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(ADEColor.textSecondary)
                }
              }
            }
            .prListRow()
          }
        }
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("PRs")
      .navigationBarTitleDisplayMode(.inline)
      .searchable(text: $searchText, prompt: "Search title, author, branch, or PR #")
      .toolbar(content: {
        ToolbarItemGroup(placement: .topBarTrailing) {
          Button {
            onRefresh()
          } label: {
            Image(systemName: "arrow.clockwise")
          }
          .accessibilityLabel("Refresh pull requests")

          Button {
            onCreatePr()
          } label: {
            Image(systemName: "plus")
          }
          .accessibilityLabel("Create pull request")
          .disabled(!isLive || lanes.isEmpty)
        }
      })
      .refreshable {
        onRefresh()
      }
      .navigationDestination(for: PrGitHubRoute.self) { route in
        switch route {
        case .detail(let prId):
          PrDetailView(
            prId: prId,
            transitionNamespace: transitionNamespace,
            onOpenQueue: onOpenQueue,
            onOpenRebase: onOpenRebase
          )
          .environmentObject(syncService)
        }
      }
      .sheet(item: $stackPresentation) { presentation in
        PrStackSheet(groupId: presentation.id, groupName: presentation.groupName)
          .environmentObject(syncService)
      }
      .sheet(item: $linkTarget) { pr in
        PrLinkToLaneSheet(pr: pr, lanes: lanes)
          .environmentObject(syncService)
      }
      .alert("Action failed", isPresented: Binding(
        get: { swipeActionError != nil },
        set: { if !$0 { swipeActionError = nil } }
      )) {
        Button("OK") { swipeActionError = nil }
      } message: {
        Text(swipeActionError ?? "An error occurred.")
      }
    }
  }

  @ViewBuilder
  private func prNavigationRow(_ pr: PullRequestListItem) -> some View {
    NavigationLink(value: PrGitHubRoute.detail(pr.id)) {
      PrRowCard(
        pr: pr,
        snapshot: snapshotsById[pr.id],
        transitionNamespace: transitionNamespace,
        isSelectedTransitionSource: selectedPrTransitionId == pr.id
      ) { groupId, groupName in
        stackPresentation = PrStackPresentation(id: groupId, groupName: groupName)
      }
    }
    .simultaneousGesture(TapGesture().onEnded {
      selectedPrTransitionId = pr.id
    })
    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
      Button("Open") {
        openGitHub(urlString: pr.githubUrl)
      }
      .tint(ADEColor.accent)

      if pr.state == "open" {
        Button("Close", role: .destructive) {
          Task {
            do {
              try await syncService.closePullRequest(prId: pr.id)
              onRefresh()
            } catch {
              swipeActionError = SyncUserFacingError.message(for: error)
            }
          }
        }
      } else if pr.state == "closed" {
        Button("Reopen") {
          Task {
            do {
              try await syncService.reopenPullRequest(prId: pr.id)
              onRefresh()
            } catch {
              swipeActionError = SyncUserFacingError.message(for: error)
            }
          }
        }
        .tint(ADEColor.success)
      }

      if pr.laneId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (pr.laneName?.isEmpty ?? true) {
        Button("Link") {
          linkTarget = pr
        }
        .tint(ADEColor.warning)
      }
    }
    .prListRow()
  }

  private var emptyStateTitle: String {
    if !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return "No PRs match this search"
    }

    switch stateFilter {
    case .all:
      return "No pull requests on this host"
    case .open:
      return "No open pull requests"
    case .draft:
      return "No draft pull requests"
    case .merged:
      return "No merged pull requests"
    case .closed:
      return "No closed pull requests"
    }
  }

  private var emptyStateMessage: String {
    if !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return "Try a broader title, author, branch, or PR number search."
    }
    return "Open PRs and workflow lanes will appear here once the host syncs GitHub state to iPhone."
  }

  private func openGitHub(urlString: String) {
    guard let url = URL(string: urlString) else { return }
    UIApplication.shared.open(url)
  }
}

private struct PrGitHubFilterCard: View {
  @Binding var stateFilter: PrListStateFilter
  @Binding var sortOption: PrListSortOption
  let counts: [PrListStateFilter: Int]
  let visibleCount: Int
  let totalCount: Int
  let isLive: Bool
  let onRefresh: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .top) {
        VStack(alignment: .leading, spacing: 4) {
          Text("GitHub pull requests")
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          Text("\(visibleCount) of \(totalCount) visible")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }

        Spacer(minLength: 12)

        if !isLive {
          ADEStatusPill(text: "CACHED", tint: ADEColor.warning)
        }

        Button(action: onRefresh) {
          Image(systemName: "arrow.clockwise")
            .font(.body.weight(.semibold))
        }
        .buttonStyle(.glass)
        .tint(ADEColor.accent)
      }

      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          ForEach(PrListStateFilter.allCases) { filter in
            Button {
              withAnimation(.smooth) {
                stateFilter = filter
              }
            } label: {
              HStack(spacing: 6) {
                Text(filter.title)
                Text("\(counts[filter] ?? 0)")
                  .foregroundStyle(stateFilter == filter ? Color.white.opacity(0.85) : ADEColor.textSecondary)
              }
              .font(.caption.weight(.semibold))
              .padding(.horizontal, 12)
              .padding(.vertical, 9)
              .background(
                Capsule()
                  .fill(stateFilter == filter ? ADEColor.accent : ADEColor.surfaceBackground.opacity(0.65))
              )
              .foregroundStyle(stateFilter == filter ? Color.white : ADEColor.textPrimary)
            }
            .buttonStyle(.plain)
          }
        }
      }

      HStack(spacing: 12) {
        Label("Sort", systemImage: "arrow.up.arrow.down")
          .font(.caption.weight(.medium))
          .foregroundStyle(ADEColor.textSecondary)

        Picker("Sort", selection: $sortOption) {
          ForEach(PrListSortOption.allCases) { option in
            Text(option.title).tag(option)
          }
        }
        .pickerStyle(.menu)

        Spacer(minLength: 0)
      }
      .adeInsetField(cornerRadius: 14, padding: 12)
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

private struct PrRowCard: View {
  let pr: PullRequestListItem
  let snapshot: PullRequestSnapshot?
  let transitionNamespace: Namespace.ID?
  let isSelectedTransitionSource: Bool
  let onShowStack: (String, String?) -> Void

  private var authorAvatarURL: URL? {
    guard let value = snapshot?.detail?.author.avatarUrl else { return nil }
    return URL(string: value)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 12) {
        PrAvatarView(url: authorAvatarURL, fallbackText: snapshot?.detail?.author.login ?? "PR")

        VStack(alignment: .leading, spacing: 6) {
          Text(pr.title)
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(2)
            .adeMatchedGeometry(id: isSelectedTransitionSource ? "pr-title-\(pr.id)" : nil, in: transitionNamespace)

          HStack(spacing: 8) {
            Text("#\(pr.githubPrNumber)")
              .font(.system(.caption, design: .monospaced))
              .foregroundStyle(ADEColor.textSecondary)

            if let author = snapshot?.detail?.author.login, !author.isEmpty {
              Text(author)
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }

            if let laneName = pr.laneName, !laneName.isEmpty {
              Text(laneName)
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
                .lineLimit(1)
            } else {
              Text("Unmapped")
                .font(.caption.weight(.semibold))
                .foregroundStyle(ADEColor.warning)
            }
          }
        }

        Spacer(minLength: 8)

        VStack(alignment: .trailing, spacing: 6) {
          ADEStatusPill(text: pr.state.uppercased(), tint: prStateTint(pr.state))
            .adeMatchedGeometry(id: isSelectedTransitionSource ? "pr-status-\(pr.id)" : nil, in: transitionNamespace)

          if let adeKindLabel = prAdeKindLabel(pr.adeKind) {
            ADEStatusPill(text: adeKindLabel, tint: ADEColor.accent)
          }
        }
      }

      HStack(spacing: 8) {
        Text("\(pr.repoOwner)/\(pr.repoName)")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)

        Spacer(minLength: 0)

        Text(prRelativeTime(pr.updatedAt))
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
      }

      Text("\(pr.headBranch) → \(pr.baseBranch)")
        .font(.system(.caption, design: .monospaced))
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)

      HStack(spacing: 10) {
        PrSignalChip(icon: "circle.fill", text: prChecksLabel(pr.checksStatus), tint: prChecksTint(pr.checksStatus))
        PrSignalChip(icon: reviewSymbol(pr.reviewStatus), text: prReviewLabel(pr.reviewStatus), tint: prReviewTint(pr.reviewStatus))

        if let groupId = pr.linkedGroupId, pr.linkedGroupCount > 1 {
          Button {
            onShowStack(groupId, pr.linkedGroupName)
          } label: {
            Label("\(pr.linkedGroupCount)", systemImage: "list.number")
              .font(.caption.weight(.semibold))
          }
          .buttonStyle(.glass)
          .tint(ADEColor.textSecondary)
        }

        Spacer(minLength: 0)

        Text("+\(pr.additions) -\(pr.deletions)")
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .adeListCard()
    .adeMatchedTransitionSource(id: isSelectedTransitionSource ? "pr-container-\(pr.id)" : nil, in: transitionNamespace)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("PR #\(pr.githubPrNumber): \(pr.title), state \(pr.state), checks \(pr.checksStatus), review \(pr.reviewStatus), \(pr.additions) additions, \(pr.deletions) deletions\(pr.laneName.map { ", lane \($0)" } ?? "")")
  }
}

private struct PrSignalChip: View {
  let icon: String
  let text: String
  let tint: Color

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: icon)
        .font(.caption2.weight(.bold))
      Text(text)
        .font(.caption2.weight(.semibold))
    }
    .foregroundStyle(tint)
  }
}

private struct PrAvatarView: View {
  let url: URL?
  let fallbackText: String

  var body: some View {
    Group {
      if let url {
        AsyncImage(url: url) { phase in
          switch phase {
          case .success(let image):
            image
              .resizable()
              .scaledToFill()
          default:
            fallback
          }
        }
      } else {
        fallback
      }
    }
    .frame(width: 40, height: 40)
    .clipShape(Circle())
    .overlay(Circle().stroke(ADEColor.border.opacity(0.35), lineWidth: 1))
  }

  private var fallback: some View {
    ZStack {
      Circle()
        .fill(ADEColor.surfaceBackground.opacity(0.85))
      Text(String(fallbackText.prefix(2)).uppercased())
        .font(.caption.weight(.bold))
        .foregroundStyle(ADEColor.textSecondary)
    }
  }
}

private struct PrStackSheet: View {
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss

  let groupId: String
  let groupName: String?
  @State private var members: [PrGroupMemberSummary] = []

  var body: some View {
    NavigationStack {
      List {
        if members.isEmpty {
          ADEEmptyStateView(
            symbol: "list.number",
            title: "No stack members",
            message: "The host did not sync any PR chain members for this workflow yet."
          )
          .prListRow()
        } else {
          ForEach(members) { member in
            Button {
              syncService.requestedPrNavigation = PrNavigationRequest(prId: member.prId)
              dismiss()
            } label: {
              VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top) {
                  ADEStatusPill(text: "#\(member.position + 1)", tint: ADEColor.accent)
                  Spacer(minLength: 8)
                  ADEStatusPill(text: member.state.uppercased(), tint: prStateTint(member.state))
                }
                Text(member.title)
                  .font(.headline)
                  .foregroundStyle(ADEColor.textPrimary)
                Text("#\(member.githubPrNumber) · \(member.headBranch) → \(member.baseBranch)")
                  .font(.system(.caption, design: .monospaced))
                  .foregroundStyle(ADEColor.textSecondary)
                Text(member.laneName)
                  .font(.caption)
                  .foregroundStyle(ADEColor.textSecondary)
              }
              .adeGlassCard(cornerRadius: 18)
            }
            .buttonStyle(.plain)
            .prListRow()
          }
        }
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle(groupName ?? "PR stack")
      .toolbar(content: {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") {
            dismiss()
          }
        }
      })
      .task {
        members = (try? await syncService.fetchPullRequestGroupMembers(groupId: groupId)) ?? []
      }
    }
  }
}

private struct PrLinkToLaneSheet: View {
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss

  let pr: PullRequestListItem
  let lanes: [LaneSummary]

  @State private var selectedLaneId = ""
  @State private var errorMessage: String?
  @State private var isSubmitting = false

  private var supportsLinking: Bool {
    syncService.supportsRemoteAction("prs.linkToLane")
  }

  private var selectedLane: LaneSummary? {
    lanes.first(where: { $0.id == selectedLaneId }) ?? lanes.first
  }

  var body: some View {
    NavigationStack {
      List {
        PrDetailSectionCard("Link pull request") {
          VStack(alignment: .leading, spacing: 12) {
            Text(pr.title)
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
            Text("#\(pr.githubPrNumber) · \(pr.headBranch) → \(pr.baseBranch)")
              .font(.system(.caption, design: .monospaced))
              .foregroundStyle(ADEColor.textSecondary)

            Picker("Lane", selection: $selectedLaneId) {
              ForEach(lanes) { lane in
                Text("\(lane.name) · \(lane.branchRef)").tag(lane.id)
              }
            }
            .pickerStyle(.menu)
            .adeInsetField()

            if !supportsLinking {
              Text("This host has not exposed PR lane-linking to the mobile sync channel yet.")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }

            if let errorMessage {
              Text(errorMessage)
                .font(.caption)
                .foregroundStyle(ADEColor.danger)
            }
          }
        }
        .prListRow()
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Link to lane")
      .toolbar(content: {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") {
            dismiss()
          }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(isSubmitting ? "Linking…" : "Link") {
            Task { await link() }
          }
          .disabled(isSubmitting || selectedLane == nil || !supportsLinking)
        }
      })
      .onAppear {
        selectedLaneId = selectedLaneId.isEmpty ? (lanes.first?.id ?? "") : selectedLaneId
      }
    }
  }

  @MainActor
  private func link() async {
    guard let selectedLane else { return }
    isSubmitting = true
    defer { isSubmitting = false }

    do {
      _ = try await syncService.linkPullRequestToLane(laneId: selectedLane.id, prUrlOrNumber: pr.githubUrl)
      dismiss()
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}
