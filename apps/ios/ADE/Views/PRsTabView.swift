import SwiftUI

struct PRsTabView: View {
  @EnvironmentObject private var syncService: SyncService
  @State private var prs: [PrSummary] = []
  @State private var lanes: [LaneSummary] = []
  @State private var errorMessage: String?
  @State private var createPresented = false

  var body: some View {
    NavigationStack {
      List {
        if let errorMessage {
          Text(errorMessage).foregroundStyle(.red)
        }

        ForEach(prs) { pr in
          NavigationLink {
            PrDetailView(pr: pr)
          } label: {
            VStack(alignment: .leading, spacing: 5) {
              HStack {
                Text(pr.title)
                  .font(.headline)
                Spacer()
                Text("#\(pr.githubPrNumber)")
                  .font(.caption)
                  .foregroundStyle(.secondary)
              }
              Text("\(pr.headBranch) → \(pr.baseBranch)")
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
              HStack(spacing: 12) {
                Label(pr.checksStatus, systemImage: "checkmark.seal")
                Label(pr.reviewStatus, systemImage: "person.2")
              }
              .font(.caption)
              .foregroundStyle(.secondary)
            }
          }
        }
      }
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
}

private struct PrDetailView: View {
  @EnvironmentObject private var syncService: SyncService
  let pr: PrSummary

  @State private var snapshot: PullRequestSnapshot?
  @State private var reviewerInput = ""
  @State private var errorMessage: String?

  var body: some View {
    List {
      if let errorMessage {
        Text(errorMessage).foregroundStyle(.red)
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
        Button("Merge (squash)") {
          Task {
            try? await syncService.mergePullRequest(prId: pr.id, method: "squash")
            await reload(refreshRemote: true)
          }
        }
        Button("Close PR", role: .destructive) {
          Task {
            try? await syncService.closePullRequest(prId: pr.id)
            await reload(refreshRemote: true)
          }
        }
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
