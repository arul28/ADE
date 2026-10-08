import SwiftUI

enum GitHubIssuesRoute: Hashable {
  case issue(GitHubIssueRow)
}

/// The GitHub Issues pane: a full-screen sheet with this project's issues
/// (list → detail), opened from the Work tab's ⋯ menu like the Linear pane.
struct GitHubIssuesPaneSheet: View {
  @Environment(\.dismiss) private var dismiss
  @StateObject private var store: GitHubIssuesPaneStore
  @State private var path: [GitHubIssuesRoute] = []
  @State private var started = false

  init(syncService: SyncService) {
    _store = StateObject(wrappedValue: GitHubIssuesPaneStore(sync: syncService))
  }

  var body: some View {
    NavigationStack(path: $path) {
      GitHubIssueListScreen(store: store, onClose: { dismiss() })
        .navigationDestination(for: GitHubIssuesRoute.self) { route in
          switch route {
          case let .issue(issue):
            if let repo = store.repo {
              GitHubIssueDetailScreen(repo: repo, initial: issue, store: store)
            }
          }
        }
    }
    .task {
      guard !started else { return }
      started = true
      await store.start()
    }
  }
}

// MARK: - List

struct GitHubIssueListScreen: View {
  @ObservedObject var store: GitHubIssuesPaneStore
  var onClose: () -> Void

  var body: some View {
    List {
      content
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .safeAreaInset(edge: .top, spacing: 0) { stateBar }
    .searchable(text: $store.query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Filter issues")
    .refreshable { await store.reload() }
    .navigationTitle(store.repo?.label ?? "GitHub issues")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar { toolbar }
  }

  @ToolbarContentBuilder
  private var toolbar: some ToolbarContent {
    ToolbarItem(placement: .topBarLeading) {
      Button(action: onClose) {
        Image(systemName: "xmark").font(.system(size: 13, weight: .semibold))
      }
      .accessibilityLabel("Close GitHub issues")
    }
    ToolbarItem(placement: .topBarTrailing) {
      if let repo = store.repo, let url = URL(string: "https://github.com/\(repo.owner)/\(repo.name)/issues/new") {
        Link(destination: url) {
          Image(systemName: "plus")
        }
        .accessibilityLabel("New issue on GitHub")
      }
    }
  }

  private var stateBar: some View {
    HStack(spacing: 10) {
      Picker("State", selection: $store.stateFilter) {
        ForEach(GitHubIssueStateFilter.allCases) { filter in
          Text(filter.title).tag(filter)
        }
      }
      .pickerStyle(.segmented)
      if let open = store.openCount {
        Text("\(open) open")
          .font(.caption.weight(.medium))
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize()
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 8)
    .background(ADEColor.pageBackground)
  }

  @ViewBuilder
  private var content: some View {
    switch store.phase {
    case .idle, .loading where store.issues.isEmpty:
      ForEach(0..<6, id: \.self) { _ in
        VStack(alignment: .leading, spacing: 6) {
          ADESkeletonView(height: 12)
          ADESkeletonView(width: 140, height: 10)
        }
        .padding(.vertical, 6)
        .listRowBackground(Color.clear)
      }
    case .noRepo:
      message(
        title: "No GitHub repository",
        detail: "This project's origin is not on GitHub, so it has no GitHub issues."
      )
    case let .failed(error):
      message(title: "Couldn\u{2019}t load issues", detail: error)
    default:
      let rows = store.visibleIssues
      if rows.isEmpty {
        message(
          title: store.query.isEmpty ? "No \(store.stateFilter == .all ? "" : store.stateFilter.rawValue + " ")issues" : "No matches",
          detail: store.query.isEmpty ? "Nothing to show here." : "No issue title, number or label matches \u{201C}\(store.query)\u{201D}."
        )
      } else {
        ForEach(rows) { issue in
          NavigationLink(value: GitHubIssuesRoute.issue(issue)) {
            GitHubIssueListRow(issue: issue)
          }
          .listRowBackground(Color.clear)
        }
      }
    }
  }

  private func message(title: String, detail: String) -> some View {
    VStack(spacing: 6) {
      Text(title)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      Text(detail)
        .font(.caption)
        .foregroundStyle(ADEColor.textMuted)
        .multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 40)
    .listRowBackground(Color.clear)
    .listRowSeparator(.hidden)
  }
}

struct GitHubIssueListRow: View {
  let issue: GitHubIssueRow

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: GitHubIssueBrand.symbol(state: issue.state, reason: issue.stateReason))
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(GitHubIssueBrand.color(state: issue.state, reason: issue.stateReason))
        .padding(.top, 1)
      VStack(alignment: .leading, spacing: 4) {
        Text(issue.title)
          .font(.subheadline.weight(.medium))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)
        HStack(spacing: 6) {
          Text("#\(issue.number)")
            .font(.caption.monospacedDigit())
            .foregroundStyle(ADEColor.textMuted)
          if let age = githubIssueRelativeAge(issue.updatedAt ?? issue.createdAt) {
            Text("· \(age)").font(.caption).foregroundStyle(ADEColor.textMuted)
          }
          ForEach(issue.labels.prefix(2), id: \.name) { label in
            GitHubIssueLabelPill(label: label)
          }
          if let count = issue.comments, count > 0 {
            Label("\(count)", systemImage: "bubble.left")
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted)
          }
        }
      }
      Spacer(minLength: 0)
    }
    .padding(.vertical, 4)
    .accessibilityElement(children: .combine)
  }
}

struct GitHubIssueLabelPill: View {
  let label: GitHubIssueLabelDTO

  private var dot: Color {
    guard let hex = label.color, hex.count == 6, let value = Int(hex, radix: 16) else { return ADEColor.textMuted }
    return Color(
      red: Double((value >> 16) & 0xFF) / 255.0,
      green: Double((value >> 8) & 0xFF) / 255.0,
      blue: Double(value & 0xFF) / 255.0
    )
  }

  var body: some View {
    HStack(spacing: 4) {
      Circle().fill(dot).frame(width: 6, height: 6)
      Text(label.name).font(.caption2.weight(.medium)).foregroundStyle(ADEColor.textSecondary).lineLimit(1)
    }
    .padding(.horizontal, 7)
    .padding(.vertical, 2)
    .background(ADEKit.track, in: Capsule())
    .overlay(Capsule().stroke(ADEKit.edge, lineWidth: 0.5))
  }
}

// MARK: - Detail

struct GitHubIssueDetailScreen: View {
  @EnvironmentObject private var syncService: SyncService

  let repo: GitHubRepoRefDTO
  /// Read live: the write-access check can finish after this screen opens.
  @ObservedObject var store: GitHubIssuesPaneStore

  @State private var issue: GitHubIssueRow
  @State private var comments: [GitHubIssueCommentDTO] = []
  @State private var commentsLoaded = false
  @State private var commentsFailed = false
  @State private var draft = ""
  @State private var busy = false
  @State private var errorMessage: String?

  init(repo: GitHubRepoRefDTO, initial: GitHubIssueRow, store: GitHubIssuesPaneStore) {
    self.repo = repo
    self.store = store
    _issue = State(initialValue: initial)
  }

  private var canWrite: Bool? { store.canWrite }
  private var writable: Bool { canWrite == true }
  private func onChange(_ updated: GitHubIssueRow) { store.replace(updated) }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        header
        if let body = issue.body?.trimmingCharacters(in: .whitespacesAndNewlines), !body.isEmpty {
          Text(markdownAttributedString(githubIssueDisplayMarkdown(body)))
            .font(.subheadline)
            .foregroundStyle(ADEColor.textPrimary)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
          Text("No description.")
            .font(.subheadline.italic())
            .foregroundStyle(ADEColor.textMuted)
        }
        propertiesCard
        activity
        if writable { composer } else if canWrite == false { readOnlyNote }
      }
      .padding(16)
      .padding(.bottom, 32)
    }
    .scrollContentBackground(.hidden)
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .navigationTitle("#\(issue.number)")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar { toolbar }
    .alert("Couldn\u{2019}t save", isPresented: Binding(
      get: { errorMessage != nil },
      set: { if !$0 { errorMessage = nil } }
    )) {
      Button("OK", role: .cancel) { errorMessage = nil }
    } message: {
      Text(errorMessage ?? "")
    }
    .task(id: issue.number) { await load() }
  }

  @ToolbarContentBuilder
  private var toolbar: some ToolbarContent {
    ToolbarItem(placement: .topBarTrailing) {
      Menu {
        if writable {
          if issue.isOpen {
            Button {
              Task { await setState(closed: true, reason: "completed") }
            } label: { Label("Close as completed", systemImage: "checkmark.circle") }
            Button {
              Task { await setState(closed: true, reason: "not_planned") }
            } label: { Label("Close as not planned", systemImage: "nosign") }
          } else {
            Button {
              Task { await setState(closed: false, reason: "reopened") }
            } label: { Label("Reopen", systemImage: "arrow.uturn.backward.circle") }
          }
          Divider()
        }
        if let url = issue.htmlUrl.flatMap(URL.init(string:)) {
          Link(destination: url) { Label("Open on GitHub", systemImage: "arrow.up.forward.square") }
          ShareLink(item: url) { Label("Share link", systemImage: "square.and.arrow.up") }
        }
        Button {
          UIPasteboard.general.string = "\(repo.label)#\(issue.number)"
        } label: { Label("Copy reference", systemImage: "number") }
      } label: {
        if busy {
          ProgressView().controlSize(.small)
        } else {
          Image(systemName: "ellipsis.circle")
        }
      }
      .disabled(busy)
      .accessibilityLabel("Issue actions")
    }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(issue.title)
        .font(.title3.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
      HStack(spacing: 6) {
        Image(systemName: GitHubIssueBrand.symbol(state: issue.state, reason: issue.stateReason))
        Text(GitHubIssueBrand.label(state: issue.state, reason: issue.stateReason))
      }
      .font(.caption.weight(.semibold))
      .foregroundStyle(GitHubIssueBrand.color(state: issue.state, reason: issue.stateReason))
      .padding(.horizontal, 9)
      .padding(.vertical, 4)
      .background(GitHubIssueBrand.color(state: issue.state, reason: issue.stateReason).opacity(0.14), in: Capsule())
    }
  }

  private var propertiesCard: some View {
    VStack(spacing: 0) {
      LinearPropertyRow(label: "Assignees", value: issue.assignees.isEmpty ? "No one" : issue.assignees.map(\.login).joined(separator: ", "))
      LinearPropertyRow(label: "Labels", value: issue.labels.isEmpty ? "None" : issue.labels.map(\.name).joined(separator: ", "))
      LinearPropertyRow(label: "Milestone", value: issue.milestone?.title ?? "None")
      LinearPropertyRow(label: "Author", value: issue.user?.login ?? "Unknown")
      if let created = linearFormatDate(issue.createdAt) {
        LinearPropertyRow(label: "Created", value: created)
      }
      LinearPropertyRow(label: "Repository", value: repo.label)
    }
    .adeKitCard(padding: 16)
  }

  @ViewBuilder
  private var activity: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Comments")
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textSecondary)
      if !commentsLoaded {
        ADESkeletonView(height: 12)
        ADESkeletonView(width: 200, height: 12)
      } else if commentsFailed {
        Text("Couldn\u{2019}t load comments.").font(.caption).foregroundStyle(ADEColor.textMuted)
      } else if comments.isEmpty {
        Text("No comments yet.").font(.caption).foregroundStyle(ADEColor.textMuted)
      } else {
        ForEach(comments) { comment in
          VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
              Text(comment.user?.login ?? "Someone")
                .font(.caption.weight(.semibold))
                .foregroundStyle(ADEColor.textSecondary)
              if let date = linearFormatDate(comment.createdAt) {
                Text(date).font(.caption2).foregroundStyle(ADEColor.textMuted)
              }
            }
            Text(markdownAttributedString(githubIssueDisplayMarkdown(comment.body)))
              .font(.caption)
              .foregroundStyle(ADEColor.textPrimary)
              .textSelection(.enabled)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          .adeKitCard(padding: 11)
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var composer: some View {
    VStack(alignment: .trailing, spacing: 8) {
      TextField("Leave a comment\u{2026}", text: $draft, axis: .vertical)
        .lineLimit(2...8)
        .font(.subheadline)
        .padding(10)
        .background(ADEColor.surfaceBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(ADEKit.edge, lineWidth: 0.5))
      Button {
        Task { await postComment() }
      } label: {
        Text("Comment").font(.subheadline.weight(.semibold))
      }
      .buttonStyle(.borderedProminent)
      .tint(ADEColor.accent)
      .disabled(busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
  }

  private var readOnlyNote: some View {
    Text("This machine has no GitHub credential that can edit issues. Connect GitHub CLI or add a token in ADE on the desktop.")
      .font(.caption)
      .foregroundStyle(ADEColor.textMuted)
  }

  // MARK: Actions

  private func load() async {
    if let fresh = try? await syncService.fetchGitHubIssue(repo, number: issue.number) {
      issue = fresh
      onChange(fresh)
    }
    do {
      comments = try await syncService.fetchGitHubIssueComments(repo, number: issue.number)
      commentsFailed = false
    } catch {
      commentsFailed = true
    }
    commentsLoaded = true
  }

  private func setState(closed: Bool, reason: String) async {
    busy = true
    defer { busy = false }
    do {
      let updated = try await syncService.updateGitHubIssue(
        repo,
        number: issue.number,
        patch: ["state": closed ? "closed" : "open", "state_reason": reason]
      )
      issue = updated
      onChange(updated)
      ADEHaptics.success()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func postComment() async {
    let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !body.isEmpty else { return }
    busy = true
    defer { busy = false }
    do {
      let comment = try await syncService.commentOnGitHubIssue(repo, number: issue.number, body: body)
      comments.append(comment)
      draft = ""
      ADEHaptics.success()
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}
