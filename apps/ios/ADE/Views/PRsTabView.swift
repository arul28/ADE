import SwiftUI

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

  var body: some View {
    NavigationStack {
      List {
        if let notice = statusNotice {
          notice
            .listRowBackground(Color.clear)
        }

        if let errorMessage, prsStatus.phase == .ready {
          ADENoticeCard(
            title: "PR view error",
            message: errorMessage,
            icon: "exclamationmark.triangle.fill",
            tint: ADEPalette.danger,
            actionTitle: "Retry",
            action: { Task { await reload(refreshRemote: true) } }
          )
          .listRowBackground(Color.clear)
        }

        ForEach(prs) { pr in
          NavigationLink {
            PrDetailView(pr: pr)
          } label: {
            VStack(alignment: .leading, spacing: 6) {
              HStack(alignment: .top) {
                Text(pr.title)
                  .font(.headline)
                  .lineLimit(2)
                Spacer(minLength: 8)
                Text("#\(pr.githubPrNumber)")
                  .font(.system(.caption, design: .monospaced))
                  .foregroundStyle(.secondary)
              }
              Text("\(pr.headBranch) \u{2192} \(pr.baseBranch)")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
              HStack(spacing: 8) {
                ADEStatusPill(text: pr.checksStatus.uppercased(), tint: checksTint(for: pr.checksStatus))
                ADEStatusPill(text: pr.reviewStatus.uppercased(), tint: reviewsTint(for: pr.reviewStatus))
                Spacer()
                Text("+\(pr.additions) -\(pr.deletions)")
                  .font(.system(.caption2, design: .monospaced))
                  .foregroundStyle(ADEPalette.textMuted)
              }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("PR \(pr.githubPrNumber): \(pr.title), checks \(pr.checksStatus), review \(pr.reviewStatus)")
          }
        }
      }
      .scrollContentBackground(.hidden)
      .background(ADEPalette.pageBackground.ignoresSafeArea())
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

  private func checksTint(for status: String) -> Color {
    switch status {
    case "passing":
      return ADEPalette.success
    case "failing":
      return ADEPalette.danger
    case "pending":
      return ADEPalette.warning
    default:
      return ADEPalette.textSecondary
    }
  }

  private func reviewsTint(for status: String) -> Color {
    switch status {
    case "approved":
      return ADEPalette.success
    case "changes_requested":
      return ADEPalette.danger
    case "requested":
      return ADEPalette.warning
    default:
      return ADEPalette.textSecondary
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
        tint: ADEPalette.warning,
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
        tint: ADEPalette.accent,
        actionTitle: nil,
        action: nil
      )
    case .failed:
      return ADENoticeCard(
        title: "PR hydration failed",
        message: prsStatus.lastError ?? "The host PR state did not hydrate cleanly.",
        icon: "exclamationmark.triangle.fill",
        tint: ADEPalette.danger,
        actionTitle: "Retry",
        action: { Task { await reload(refreshRemote: true) } }
      )
    case .ready:
      guard prs.isEmpty else { return nil }
      return ADENoticeCard(
        title: "No pull requests on this host",
        message: "Open PRs will appear here once the host has GitHub-linked lane state to show.",
        icon: "arrow.triangle.pull",
        tint: ADEPalette.textSecondary,
        actionTitle: nil,
        action: nil
      )
    }
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
    List {
      if let errorMessage {
        ADENoticeCard(
          title: "PR detail failed",
          message: errorMessage,
          icon: "exclamationmark.triangle.fill",
          tint: ADEPalette.danger,
          actionTitle: "Retry",
          action: { Task { await reload(refreshRemote: true) } }
        )
        .listRowBackground(Color.clear)
      }

      Section("Summary") {
        Text(snapshot?.detail?.body ?? pr.title)
        if let status = snapshot?.status {
          Label(status.isMergeable ? "Mergeable" : "Not mergeable", systemImage: status.isMergeable ? "checkmark.circle" : "xmark.circle")
          Text("Checks: \(status.checksStatus) · Reviews: \(status.reviewStatus)")
            .foregroundStyle(.secondary)
        }
        if let detail = snapshot?.detail {
          Text("Author: \(detail.author.login)")
            .foregroundStyle(.secondary)
          if !detail.requestedReviewers.isEmpty {
            Text("Requested reviewers: \(detail.requestedReviewers.map(\.login).joined(separator: ", "))")
              .foregroundStyle(.secondary)
          }
          if let milestone = detail.milestone, !milestone.isEmpty {
            Text("Milestone: \(milestone)")
              .foregroundStyle(.secondary)
          }
        }
      }

      Section("Actions") {
        if actionAvailability.showsMerge {
          Button("Merge (squash)") {
            Task {
              try? await syncService.mergePullRequest(prId: pr.id, method: "squash")
              await reload(refreshRemote: true)
            }
          }
          .disabled(!actionAvailability.mergeEnabled)
        }

        if actionAvailability.showsClose {
          Button("Close PR", role: .destructive) {
            Task {
              try? await syncService.closePullRequest(prId: pr.id)
              await reload(refreshRemote: true)
            }
          }
        }

        if actionAvailability.showsReopen {
          Button("Reopen PR") {
            Task {
              try? await syncService.reopenPullRequest(prId: pr.id)
              await reload(refreshRemote: true)
            }
          }
        }

        if actionAvailability.showsRequestReviewers {
          TextField("Request reviewers (comma-separated)", text: $reviewerInput)
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
          .disabled(reviewerInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }

        if !actionAvailability.showsMerge && !actionAvailability.showsClose && !actionAvailability.showsReopen && !actionAvailability.showsRequestReviewers {
          Text("No baseline PR actions are available for this state on iPhone.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }

      Section("Checks") {
        ForEach(snapshot?.checks ?? []) { check in
          VStack(alignment: .leading) {
            Text(check.name)
            Text("\(check.status) · \(check.conclusion ?? "pending")")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
      }

      Section("Reviews") {
        ForEach(snapshot?.reviews ?? []) { review in
          VStack(alignment: .leading) {
            Text(review.reviewer)
            Text(review.state)
              .font(.caption)
              .foregroundStyle(.secondary)
            if let body = review.body, !body.isEmpty {
              Text(body)
                .font(.caption)
            }
          }
        }
      }

      Section("Comments") {
        ForEach(snapshot?.comments ?? []) { comment in
          VStack(alignment: .leading, spacing: 4) {
            Text(comment.author)
              .font(.headline)
            Text(comment.body ?? "")
              .font(.caption)
          }
        }
      }

      Section("Files") {
        ForEach(snapshot?.files ?? []) { file in
          VStack(alignment: .leading, spacing: 6) {
            Text(file.filename)
              .font(.headline)
            Text(file.patch ?? "No patch available")
              .font(.caption.monospaced())
              .foregroundStyle(.secondary)
          }
        }
      }
    }
    .scrollContentBackground(.hidden)
    .background(ADEPalette.pageBackground.ignoresSafeArea())
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
      Form {
        Picker("Lane", selection: $selectedLaneId) {
          ForEach(lanes) { lane in
            Text(lane.name).tag(lane.id)
          }
        }
        TextField("Title", text: $title)
        TextField("Body", text: $bodyText, axis: .vertical)
        TextField("Reviewers (comma-separated)", text: $reviewers)
      }
      .scrollContentBackground(.hidden)
      .background(ADEPalette.pageBackground.ignoresSafeArea())
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
          .disabled(title.isEmpty || (selectedLaneId.isEmpty && lanes.isEmpty))
        }
      }
      .onAppear {
        selectedLaneId = selectedLaneId.isEmpty ? (lanes.first?.id ?? "") : selectedLaneId
      }
    }
  }
}
