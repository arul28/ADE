import SwiftUI
import UIKit

struct PrActionAvailability: Equatable {
  let showsMerge: Bool
  let mergeEnabled: Bool
  let showsClose: Bool
  let showsReopen: Bool
  let showsRequestReviewers: Bool

  init(prState: String) {
    switch prState {
    case "open":
      showsMerge = true
      mergeEnabled = true
      showsClose = true
      showsReopen = false
      showsRequestReviewers = true
    case "draft":
      showsMerge = true
      mergeEnabled = false
      showsClose = false
      showsReopen = false
      showsRequestReviewers = true
    case "closed":
      showsMerge = false
      mergeEnabled = false
      showsClose = false
      showsReopen = true
      showsRequestReviewers = false
    default:
      showsMerge = false
      mergeEnabled = false
      showsClose = false
      showsReopen = false
      showsRequestReviewers = false
    }
  }
}

struct PRsTabView: View {
  @EnvironmentObject private var syncService: SyncService
  @State private var prs: [PrSummary] = []
  @State private var lanes: [LaneSummary] = []
  @State private var errorMessage: String?
  @State private var createPresented = false

  private var prsStatus: SyncDomainStatus {
    syncService.status(for: .prs)
  }

  private var needsRepairing: Bool {
    syncService.activeHostProfile == nil && !prs.isEmpty
  }

  private var isLoadingSkeleton: Bool {
    prsStatus.phase == .hydrating || prsStatus.phase == .syncingInitialData
  }

  var body: some View {
    NavigationStack {
      List {
        if let notice = statusNotice {
          notice
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
        }

        if isLoadingSkeleton {
          ForEach(0..<2, id: \.self) { _ in
            ADECardSkeleton(rows: 3)
              .listRowBackground(Color.clear)
              .listRowSeparator(.hidden)
          }
        }

        if let errorMessage, prsStatus.phase == .ready {
          ADENoticeCard(
            title: "PR view error",
            message: errorMessage,
            icon: "exclamationmark.triangle.fill",
            tint: ADEColor.danger,
            actionTitle: "Retry",
            action: { Task { await reload(refreshRemote: true) } }
          )
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
        }

        if prsStatus.phase == .ready && prs.isEmpty {
          ADEEmptyStateView(
            symbol: "arrow.triangle.pull",
            title: "No pull requests on this host",
            message: "Open PRs will appear here once the host has GitHub-linked lane state to show."
          )
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
        }

        ForEach(prs) { pr in
          NavigationLink {
            PrDetailView(pr: pr)
          } label: {
            PrRowCard(pr: pr)
          }
          .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button("Open") {
              if let url = URL(string: pr.githubUrl) {
                UIApplication.shared.open(url)
              }
            }
            .tint(ADEColor.accent)

            if pr.state == "open" {
              Button("Close", role: .destructive) {
                Task {
                  try? await syncService.closePullRequest(prId: pr.id)
                  await reload(refreshRemote: true)
                }
              }
            } else if pr.state == "closed" {
              Button("Reopen") {
                Task {
                  try? await syncService.reopenPullRequest(prId: pr.id)
                  await reload(refreshRemote: true)
                }
              }
              .tint(ADEColor.success)
            }
          }
          .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
        }
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("PRs")
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            createPresented = true
          } label: {
            Image(systemName: "plus")
          }
        }
      }
      .sensoryFeedback(.success, trigger: prs.count)
      .task {
        await reload(refreshRemote: true)
      }
      .task(id: syncService.localStateRevision) {
        await reload()
      }
      .refreshable {
        await reload(refreshRemote: true)
      }
      .sheet(isPresented: $createPresented) {
        CreatePrView(lanes: lanes) { laneId, title, body, reviewers in
          Task {
            try? await syncService.createPullRequest(laneId: laneId, title: title, body: body, reviewers: reviewers)
            try? await syncService.refreshPullRequestSnapshots()
            createPresented = false
            await reload()
          }
        }
      }
    }
  }

  @MainActor
  private func reload(refreshRemote: Bool = false) async {
    do {
      if refreshRemote {
        try? await syncService.refreshPullRequestSnapshots()
        try? await syncService.refreshLaneSnapshots()
      }
      async let prsTask = syncService.fetchPullRequests()
      async let lanesTask = syncService.fetchLanes()
      prs = try await prsTask
      lanes = try await lanesTask
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private var statusNotice: ADENoticeCard? {
    switch prsStatus.phase {
    case .disconnected:
      return ADENoticeCard(
        title: prs.isEmpty ? "Host disconnected" : "Showing cached PRs",
        message: prs.isEmpty
          ? (syncService.activeHostProfile == nil
              ? "Pair with a host to hydrate pull requests and their latest review and checks state."
              : "Reconnect to hydrate pull requests and their latest review and checks state.")
          : (needsRepairing
              ? "Cached PR state is still visible, but the previous host trust was cleared. Pair again before trusting review or checks state."
              : "Cached PR state is available. Reconnect before trusting review and check status from the host."),
        icon: "arrow.triangle.pull",
        tint: ADEColor.warning,
        actionTitle: syncService.activeHostProfile == nil ? (needsRepairing ? "Pair again" : "Pair with host") : "Reconnect",
        action: {
          if syncService.activeHostProfile == nil {
            syncService.settingsPresented = true
          } else {
            Task {
              await syncService.reconnectIfPossible()
              await reload(refreshRemote: true)
            }
          }
        }
      )
    case .hydrating:
      return ADENoticeCard(
        title: "Hydrating pull requests",
        message: "Refreshing PR summaries and cached snapshot detail so the phone does not show partial replicated state.",
        icon: "arrow.trianglehead.2.clockwise.rotate.90",
        tint: ADEColor.accent,
        actionTitle: nil,
        action: nil
      )
    case .syncingInitialData:
      return ADENoticeCard(
        title: "Syncing initial data",
        message: "Waiting for the host to finish syncing project data before PR hydration starts.",
        icon: "arrow.trianglehead.2.clockwise.rotate.90",
        tint: ADEColor.warning,
        actionTitle: nil,
        action: nil
      )
    case .failed:
      return ADENoticeCard(
        title: "PR hydration failed",
        message: prsStatus.lastError ?? "The host PR state did not hydrate cleanly.",
        icon: "exclamationmark.triangle.fill",
        tint: ADEColor.danger,
        actionTitle: "Retry",
        action: { Task { await reload(refreshRemote: true) } }
      )
    case .ready:
      return nil
    }
  }
}

private struct PrRowCard: View {
  let pr: PrSummary

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .top, spacing: 8) {
        Text(pr.title)
          .font(.headline)
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)
        Spacer(minLength: 8)
        Text("#\(pr.githubPrNumber)")
          .font(.system(.caption, design: .monospaced))
          .foregroundStyle(ADEColor.textSecondary)
      }
      Text("\(pr.headBranch) → \(pr.baseBranch)")
        .font(.system(.caption, design: .monospaced))
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)
      HStack(spacing: 8) {
        ADEStatusPill(text: pr.checksStatus.uppercased(), tint: checksTint(for: pr.checksStatus))
        ADEStatusPill(text: pr.reviewStatus.uppercased(), tint: reviewsTint(for: pr.reviewStatus))
        Spacer()
        Text("+\(pr.additions) -\(pr.deletions)")
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .adeGlassCard(cornerRadius: 18, padding: 14)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("PR \(pr.githubPrNumber): \(pr.title), checks \(pr.checksStatus), review \(pr.reviewStatus)")
  }

  private func checksTint(for status: String) -> Color {
    switch status {
    case "passing":
      return ADEColor.success
    case "failing":
      return ADEColor.danger
    case "pending":
      return ADEColor.warning
    default:
      return ADEColor.textSecondary
    }
  }

  private func reviewsTint(for status: String) -> Color {
    switch status {
    case "approved":
      return ADEColor.success
    case "changes_requested":
      return ADEColor.danger
    case "requested":
      return ADEColor.warning
    default:
      return ADEColor.textSecondary
    }
  }
}

private struct PrDetailSectionCard<Content: View>: View {
  let title: String
  let content: Content

  init(_ title: String, @ViewBuilder content: () -> Content) {
    self.title = title
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(title)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      content
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

private struct PrDetailView: View {
  @EnvironmentObject private var syncService: SyncService
  let pr: PrSummary

  @State private var snapshot: PullRequestSnapshot?
  @State private var reviewerInput = ""
  @State private var errorMessage: String?

  private var actionAvailability: PrActionAvailability {
    PrActionAvailability(prState: snapshot?.status?.state ?? pr.state)
  }

  var body: some View {
    ScrollView {
      LazyVStack(spacing: 14) {
        if let errorMessage {
          ADENoticeCard(
            title: "PR detail failed",
            message: errorMessage,
            icon: "exclamationmark.triangle.fill",
            tint: ADEColor.danger,
            actionTitle: "Retry",
            action: { Task { await reload(refreshRemote: true) } }
          )
        }

        PrDetailSectionCard("Summary") {
          VStack(alignment: .leading, spacing: 8) {
            Text(snapshot?.detail?.body ?? pr.title)
              .foregroundStyle(ADEColor.textPrimary)
            if let status = snapshot?.status {
              Label(status.isMergeable ? "Mergeable" : "Not mergeable", systemImage: status.isMergeable ? "checkmark.circle" : "xmark.circle")
                .foregroundStyle(status.isMergeable ? ADEColor.success : ADEColor.danger)
              Text("Checks: \(status.checksStatus) · Reviews: \(status.reviewStatus)")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
            if let detail = snapshot?.detail {
              Text("Author: \(detail.author.login)")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
              if !detail.requestedReviewers.isEmpty {
                Text("Requested reviewers: \(detail.requestedReviewers.map(\.login).joined(separator: ", "))")
                  .font(.caption)
                  .foregroundStyle(ADEColor.textSecondary)
              }
              if let milestone = detail.milestone, !milestone.isEmpty {
                Text("Milestone: \(milestone)")
                  .font(.caption)
                  .foregroundStyle(ADEColor.textSecondary)
              }
            }
          }
        }

        PrDetailSectionCard("Actions") {
          VStack(alignment: .leading, spacing: 10) {
            if actionAvailability.showsMerge {
              Button("Merge (squash)") {
                Task {
                  try? await syncService.mergePullRequest(prId: pr.id, method: "squash")
                  await reload(refreshRemote: true)
                }
              }
              .buttonStyle(.glassProminent)
              .tint(ADEColor.accent)
              .disabled(!actionAvailability.mergeEnabled)
            }

            if actionAvailability.showsClose {
              Button("Close PR", role: .destructive) {
                Task {
                  try? await syncService.closePullRequest(prId: pr.id)
                  await reload(refreshRemote: true)
                }
              }
              .buttonStyle(.glass)
            }

            if actionAvailability.showsReopen {
              Button("Reopen PR") {
                Task {
                  try? await syncService.reopenPullRequest(prId: pr.id)
                  await reload(refreshRemote: true)
                }
              }
              .buttonStyle(.glass)
            }

            if actionAvailability.showsRequestReviewers {
              TextField("Request reviewers (comma-separated)", text: $reviewerInput)
                .adeInsetField()
              Button("Request review") {
                let reviewers = reviewerInput
                  .split(separator: ",")
                  .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                  .filter { !$0.isEmpty }
                Task {
                  try? await syncService.requestReviewers(prId: pr.id, reviewers: reviewers)
                  await reload(refreshRemote: true)
                }
              }
              .buttonStyle(.glass)
              .disabled(reviewerInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            if !actionAvailability.showsMerge && !actionAvailability.showsClose && !actionAvailability.showsReopen && !actionAvailability.showsRequestReviewers {
              Text("No baseline PR actions are available for this state on iPhone.")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
          }
        }

        if let checks = snapshot?.checks, !checks.isEmpty {
          PrDetailSectionCard("Checks") {
            VStack(alignment: .leading, spacing: 10) {
              ForEach(checks) { check in
                VStack(alignment: .leading, spacing: 4) {
                  Text(check.name)
                    .foregroundStyle(ADEColor.textPrimary)
                  Text("\(check.status) · \(check.conclusion ?? "pending")")
                    .font(.caption)
                    .foregroundStyle(ADEColor.textSecondary)
                }
              }
            }
          }
        }

        if let reviews = snapshot?.reviews, !reviews.isEmpty {
          PrDetailSectionCard("Reviews") {
            VStack(alignment: .leading, spacing: 10) {
              ForEach(reviews) { review in
                VStack(alignment: .leading, spacing: 4) {
                  Text(review.reviewer)
                    .foregroundStyle(ADEColor.textPrimary)
                  Text(review.state)
                    .font(.caption)
                    .foregroundStyle(ADEColor.textSecondary)
                  if let body = review.body, !body.isEmpty {
                    Text(body)
                      .font(.caption)
                      .foregroundStyle(ADEColor.textSecondary)
                  }
                }
              }
            }
          }
        }

        if let comments = snapshot?.comments, !comments.isEmpty {
          PrDetailSectionCard("Comments") {
            VStack(alignment: .leading, spacing: 10) {
              ForEach(comments) { comment in
                VStack(alignment: .leading, spacing: 4) {
                  Text(comment.author)
                    .font(.headline)
                    .foregroundStyle(ADEColor.textPrimary)
                  Text(comment.body ?? "")
                    .font(.caption)
                    .foregroundStyle(ADEColor.textSecondary)
                }
              }
            }
          }
        }

        if let files = snapshot?.files, !files.isEmpty {
          PrDetailSectionCard("Files") {
            VStack(alignment: .leading, spacing: 10) {
              ForEach(files) { file in
                VStack(alignment: .leading, spacing: 6) {
                  Text(file.filename)
                    .font(.headline)
                    .foregroundStyle(ADEColor.textPrimary)
                  Text(file.patch ?? "No patch available")
                    .font(.caption.monospaced())
                    .foregroundStyle(ADEColor.textSecondary)
                }
              }
            }
          }
        }
      }
      .padding(16)
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle(pr.title)
    .task {
      await reload(refreshRemote: true)
    }
    .task(id: syncService.localStateRevision) {
      await reload()
    }
  }

  @MainActor
  private func reload(refreshRemote: Bool = false) async {
    do {
      if refreshRemote {
        try? await syncService.refreshPullRequestSnapshots(prId: pr.id)
      }
      snapshot = try await syncService.fetchPullRequestSnapshot(prId: pr.id)
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}

private struct CreatePrView: View {
  @Environment(\.dismiss) private var dismiss
  let lanes: [LaneSummary]
  let onCreate: (String, String, String, [String]) -> Void

  @State private var selectedLaneId = ""
  @State private var title = ""
  @State private var bodyText = ""
  @State private var reviewers = ""

  var body: some View {
    NavigationStack {
      List {
        VStack(spacing: 10) {
          Picker("Lane", selection: $selectedLaneId) {
            ForEach(lanes) { lane in
              Text(lane.name).tag(lane.id)
            }
          }
          .pickerStyle(.menu)
          .adeInsetField()

          TextField("Title", text: $title)
            .adeInsetField()

          TextField("Body", text: $bodyText, axis: .vertical)
            .adeInsetField(cornerRadius: 14, padding: 12)

          TextField("Reviewers (comma-separated)", text: $reviewers)
            .adeInsetField()
        }
        .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Create PR")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Create") {
            onCreate(
              selectedLaneId.isEmpty ? (lanes.first?.id ?? "") : selectedLaneId,
              title,
              bodyText,
              reviewers.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
            )
          }
          .buttonStyle(.glassProminent)
          .disabled(title.isEmpty || (selectedLaneId.isEmpty && lanes.isEmpty))
        }
      }
      .onAppear {
        selectedLaneId = selectedLaneId.isEmpty ? (lanes.first?.id ?? "") : selectedLaneId
      }
    }
  }
}
