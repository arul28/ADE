import SwiftUI

// Pull requests read straight from GitHub with the ADE account's GitHub
// sign-in, for a project with no computer online (spec 3.10). The machine
// path (lane links, chat cards, actions) stays the PRs tab's own; this path
// reads and links out to GitHub.
//
// Request budget (the desktop's `accountGithubPullsStore.ts`):
// - One list read when the screen appears, then one every 60 s, only while
//   the screen is on screen and the app is in front. No timer otherwise.
// - Every read is ETag'd, so an unchanged list is a free `304`.
// - The timed read is a background read: it stops while the rate limit is
//   below 10 %.
// - A state only a person can fix (not connected, App not installed, ...)
//   waits 5 minutes between timed reads; a rate limit or an outage waits
//   until the time GitHub gives.
// - Detail, checks, reviews and comments are read once when a PR opens, and
//   again only on pull to refresh.

// MARK: - State copy

enum GitHubDirectStateAction: Equatable {
  case connect(String)
  case link(String, URL)
}

struct GitHubDirectStateCopy: Equatable {
  let title: String
  let body: String
  var primary: GitHubDirectStateAction?
  var secondary: GitHubDirectStateAction?
}

let adeGitHubAppInstallURL = URL(string: "https://github.com/apps/ade-for-github/installations/new")!
private let githubInstallationsURL = URL(string: "https://github.com/settings/installations")!

/// The words for each state a direct read can end in (spec section 5, the
/// phone's lines from spec 3.9). Nil for kinds that need no notice. Pure.
func githubDirectStateCopy(
  _ error: GitHubDirectError,
  owner: String? = nil,
  name: String? = nil,
  githubLogin: String? = nil,
  formatTime: (Date) -> String = { $0.formatted(date: .omitted, time: .shortened) }
) -> GitHubDirectStateCopy? {
  let owner = error.owner ?? owner
  let name = error.name ?? name
  let repo = owner.flatMap { owner in name.map { "\(owner)/\($0)" } } ?? "this repository"
  let ownerLabel = owner ?? "the repository's owner"
  func installation(_ url: String?) -> URL {
    guard let url, let parsed = URL(string: url), parsed.scheme == "https", parsed.host == "github.com" else {
      return githubInstallationsURL
    }
    return parsed
  }
  switch error.kind {
  case .notConnected:
    if error.reason == "signed_out" {
      return GitHubDirectStateCopy(title: "Sign in to ADE", body: "Sign in to your ADE account to see pull requests here.")
    }
    if error.reason == "unsupported" {
      return GitHubDirectStateCopy(title: "GitHub", body: "Your ADE account can't connect GitHub yet. Pull requests show when a computer with this project is online.")
    }
    return GitHubDirectStateCopy(
      title: "Connect GitHub",
      body: "Connect GitHub to see pull requests from this phone.",
      primary: .connect("Connect GitHub")
    )
  case .signInExpired:
    return GitHubDirectStateCopy(
      title: "GitHub connection ended",
      body: "Your GitHub connection ended. Connect GitHub again to keep working with pull requests.",
      primary: .connect("Connect GitHub")
    )
  case .appNotInstalled:
    if error.reason == "read_only" {
      return GitHubDirectStateCopy(
        title: "Read only",
        body: "You can read \(repo), but ADE can't change it until the ADE GitHub App is installed on \(ownerLabel).",
        primary: .link("Install on GitHub", adeGitHubAppInstallURL)
      )
    }
    return GitHubDirectStateCopy(
      title: "Install the ADE GitHub App",
      body: "ADE can't read \(repo) yet. Install the ADE GitHub App on \(ownerLabel).",
      primary: .link("Install on GitHub", adeGitHubAppInstallURL)
    )
  case .rightsNotAccepted:
    let orgLine = error.accountType == "Organization"
      ? " If you don't own \(ownerLabel), ask an owner of \(ownerLabel) to approve the update."
      : ""
    return GitHubDirectStateCopy(
      title: "Approve the ADE GitHub App's update",
      body: "The ADE GitHub App on \(ownerLabel) still has its old permissions. Approve the update so ADE can push and open pull requests. Until then, you can read pull requests here but not change them.\(orgLine)",
      primary: .link("Review on GitHub", installation(error.manageUrl))
    )
  case .repoNotReachable:
    if error.sso {
      var copy = GitHubDirectStateCopy(
        title: "Single sign-on needed",
        body: "Start a single sign-on session for \(ownerLabel) on GitHub, then connect GitHub again.",
        secondary: .connect("Connect again")
      )
      if let owner, let url = URL(string: "https://github.com/orgs/\(owner)/sso") {
        copy.primary = .link("Start single sign-on", url)
      }
      return copy
    }
    let who = githubLogin.map { ", or check that @\($0) has access to it" } ?? ", or check that your GitHub account has access to it"
    return GitHubDirectStateCopy(
      title: "Repository not reachable",
      body: "ADE can't reach \(repo). Add it to the ADE GitHub App's repositories\(who).",
      primary: .link("Choose repositories", installation(error.manageUrl))
    )
  case .rateLimited:
    return GitHubDirectStateCopy(
      title: "GitHub rate limit reached",
      body: error.retryAt.map { "GitHub rate limit reached. Pull requests update again at \(formatTime($0))." }
        ?? "GitHub rate limit reached. Pull requests update again in a few minutes."
    )
  case .githubUnavailable:
    return GitHubDirectStateCopy(
      title: "GitHub isn't answering",
      body: error.retryAt.map { "GitHub isn't answering right now. ADE tries again at \(formatTime($0))." }
        ?? "GitHub isn't answering right now. ADE tries again soon."
    )
  case .forbidden:
    return GitHubDirectStateCopy(title: "GitHub refused", body: "GitHub didn't let ADE read \(repo).")
  case .notFound, .invalidRequest:
    return nil
  }
}

/// The kinds a person fixes on GitHub or in ADE.
func githubDirectIsPersonState(_ kind: GitHubDirectErrorKind) -> Bool {
  switch kind {
  case .notConnected, .signInExpired, .appNotInstalled, .rightsNotAccepted, .repoNotReachable: return true
  default: return false
  }
}

// MARK: - State card

/// One state from `githubDirectStateCopy`, with its buttons. "Connect GitHub"
/// starts the sign-in here; a link opens GitHub.
struct GitHubStateCard: View {
  let copy: GitHubDirectStateCopy
  @ObservedObject private var connection = GitHubAccountConnection.shared
  @Environment(\.openURL) private var openURL

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 10) {
        ADEBrandTile(brand: .github, size: 30)
        Text(copy.title)
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
      }
      Text(copy.body)
        .font(.system(size: 13.5))
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
      if let problem = connection.problem {
        Text(problem)
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.danger)
          .fixedSize(horizontal: false, vertical: true)
      }
      if copy.primary != nil || copy.secondary != nil {
        HStack(spacing: 12) {
          if let primary = copy.primary { button(primary, prominent: true) }
          if let secondary = copy.secondary { button(secondary, prominent: false) }
          Spacer(minLength: 0)
        }
        .padding(.top, 2)
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .adeKitCard(padding: nil)
    .accessibilityElement(children: .contain)
  }

  @ViewBuilder
  private func button(_ action: GitHubDirectStateAction, prominent: Bool) -> some View {
    switch action {
    case .connect(let label):
      Button {
        Task { await connection.connect() }
      } label: {
        HStack(spacing: 6) {
          if connection.connecting { ProgressView().controlSize(.mini).tint(prominent ? .white : nil) }
          Text(connection.connecting ? "Connecting…" : label)
        }
      }
      .buttonStyle(ADEKitButtonStyle(prominent: prominent))
      .disabled(connection.connecting)
    case .link(let label, let url):
      Button(label) { openURL(url) }
        .buttonStyle(ADEKitButtonStyle(prominent: prominent))
    }
  }
}

// MARK: - List model

@MainActor
final class PrDirectPullsModel: ObservableObject {
  static let refreshInterval: Duration = .seconds(60)
  static let personStateWait: TimeInterval = 5 * 60

  @Published private(set) var pulls: [GitHubDirectPull] = []
  @Published private(set) var error: GitHubDirectError?
  @Published private(set) var loaded = false
  @Published private(set) var refreshing = false
  /// More open PRs exist than the five pages read.
  @Published private(set) var truncated = false

  private var repoKey: String?
  private var nextBackgroundAt: Date = .distantPast
  /// The repository of the read in flight, and which read is the newest.
  private var inFlightKey: String?
  private var generation = 0

  /// One read. A timed read (`background`) is skipped while a person state
  /// or a rate limit says to wait.
  func load(_ repo: GitHubDirectRepoRef, background: Bool) async {
    if repoKey != repo.key {
      repoKey = repo.key
      pulls = []
      error = nil
      loaded = false
      truncated = false
      nextBackgroundAt = .distantPast
    }
    if background && Date() < nextBackgroundAt { return }
    // One read per repository; a read of the old repository does not hold
    // up the new one (its answer is dropped below).
    guard inFlightKey != repo.key else { return }
    generation += 1
    let current = generation
    inFlightKey = repo.key
    refreshing = true
    defer {
      if generation == current {
        inFlightKey = nil
        refreshing = false
      }
    }
    let result = await GitHubDirectClient.shared.listPulls(repo, background: background)
    guard repoKey == repo.key, generation == current else { return }
    loaded = true
    switch result {
    case .success(let answer):
      if pulls != answer.pulls { pulls = answer.pulls }
      truncated = answer.truncated
      error = nil
      nextBackgroundAt = .distantPast
    case .failure(let failure):
      // A paused background read keeps the list and says nothing new.
      if failure.reason == "background_paused" {
        nextBackgroundAt = failure.retryAt ?? Date().addingTimeInterval(60)
        if pulls.isEmpty { error = failure }
        return
      }
      error = failure
      if githubDirectIsPersonState(failure.kind) {
        pulls = []
        nextBackgroundAt = Date().addingTimeInterval(Self.personStateWait)
      } else if let retryAt = failure.retryAt {
        nextBackgroundAt = max(retryAt, Date().addingTimeInterval(60))
      }
    }
  }
}

/// Runs the list's reads while the view is on screen and the app is in
/// front: one at once, then one every 60 s. A new sign-in or an App install
/// starts over.
private struct PrDirectPollModifier: ViewModifier {
  let repo: GitHubDirectRepoRef
  @ObservedObject var model: PrDirectPullsModel
  @ObservedObject private var connection = GitHubAccountConnection.shared
  @Environment(\.scenePhase) private var scenePhase

  private struct Key: Equatable {
    let repo: String
    let active: Bool
    let login: String?
    let installations: Int
  }

  func body(content: Content) -> some View {
    content.task(id: Key(repo: repo.key, active: scenePhase == .active, login: connection.state.login, installations: connection.installationsRevision)) {
      guard scenePhase == .active else { return }
      await model.load(repo, background: false)
      while !Task.isCancelled {
        try? await Task.sleep(for: PrDirectPullsModel.refreshInterval)
        guard !Task.isCancelled else { return }
        await model.load(repo, background: true)
      }
    }
  }
}

extension View {
  func prDirectPolling(_ repo: GitHubDirectRepoRef, model: PrDirectPullsModel) -> some View {
    modifier(PrDirectPollModifier(repo: repo, model: model))
  }
}

/// A direct PR as a row of the PRs list, so it draws with `PrRowCard`.
func prDirectListItem(_ pull: GitHubDirectPull, repo: GitHubDirectRepoRef) -> GitHubPrListItem {
  GitHubPrListItem(
    id: "github-direct:\(repo.key)#\(pull.number)",
    scope: "repo",
    repoOwner: repo.owner,
    repoName: repo.name,
    githubPrNumber: pull.number,
    githubUrl: pull.htmlUrl ?? "",
    title: pull.title,
    state: pull.merged ? "merged" : pull.state,
    isDraft: pull.draft,
    baseBranch: pull.baseRef.isEmpty ? nil : pull.baseRef,
    headBranch: pull.headRef.isEmpty ? nil : pull.headRef,
    author: pull.author,
    createdAt: pull.createdAt ?? "",
    updatedAt: pull.updatedAt ?? pull.createdAt ?? "",
    linkedPrId: nil,
    linkedGroupId: nil,
    linkedLaneId: nil,
    linkedLaneName: nil,
    adeKind: nil,
    workflowDisplayState: nil,
    cleanupState: nil,
    labels: pull.labels.map { PrLabel(name: $0, color: "", description: nil) },
    isBot: false,
    commentCount: 0
  )
}

// MARK: - Rows inside a list

/// The direct list as rows of a `List`: the PRs tab uses it when no
/// computer with the project is online. `computerName` names the computer
/// the lane info waits for.
struct PrDirectPullRows: View {
  let repo: GitHubDirectRepoRef
  let computerName: String?
  @ObservedObject var model: PrDirectPullsModel
  /// The PRs header's search, applied to the open PRs read from GitHub.
  var searchText = ""
  /// The PR shown beside the list on the Duo's inner display, marked like a
  /// selected row of the machine's list.
  var selectedNumber: Int? = nil
  let onOpen: (GitHubDirectPull) -> Void
  @ObservedObject private var connection = GitHubAccountConnection.shared

  private var shown: [GitHubDirectPull] {
    let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !query.isEmpty else { return model.pulls }
    return model.pulls.filter { pull in
      pull.title.lowercased().contains(query)
        || "#\(pull.number)".contains(query)
        || pull.headRef.lowercased().contains(query)
        || (pull.author?.lowercased().contains(query) ?? false)
    }
  }

  var body: some View {
    Section {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Image(systemName: "icloud")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
        Text(laneLine)
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 0)
      }
      .adeFlatRow(separator: .hidden)
      if let error = model.error {
        if let copy = githubDirectStateCopy(error, owner: repo.owner, name: repo.name, githubLogin: connection.state.login) {
          GitHubStateCard(copy: copy)
            .adeFlatRow(separator: .hidden)
        } else {
          // A failure with no state of its own (GitHub refused the request).
          Text("GitHub did not return this list. Pull down to try again.")
            .font(.footnote)
            .foregroundStyle(ADEColor.warning)
            .fixedSize(horizontal: false, vertical: true)
            .adeFlatRow(separator: .hidden)
        }
      }
      if !model.loaded && model.error == nil {
        ForEach(0..<3, id: \.self) { _ in PrRowCardSkeleton().adeFlatRow() }
      } else if model.loaded && model.error == nil && model.pulls.isEmpty {
        PrFlatEmptyRow(title: "No open pull requests", message: "\(repo.fullName) on GitHub")
          .adeFlatRow(separator: .hidden)
      } else if !model.pulls.isEmpty && shown.isEmpty {
        PrFlatEmptyRow(title: "No open pull request matches", message: "\"\(searchText)\" in \(repo.fullName)")
          .adeFlatRow(separator: .hidden)
      }
    }
    if !shown.isEmpty {
      Section {
        ForEach(shown) { pull in
          Button {
            onOpen(pull)
          } label: {
            PrRowCard(item: prDirectListItem(pull, repo: repo))
          }
          .buttonStyle(.plain)
          .accessibilityAddTraits(selectedNumber == pull.number ? .isSelected : [])
          // Before `adeFlatRow`: the innermost row background wins.
          .listRowBackground(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .fill(selectedNumber == pull.number ? ADEColor.accent.opacity(0.14) : Color.clear)
              .padding(.horizontal, 6)
              .padding(.vertical, 2)
          )
          .adeFlatRow()
        }
        if model.truncated {
          Link(destination: URL(string: "https://github.com/\(repo.owner)/\(repo.name)/pulls")!) {
            Text("More pull requests on GitHub")
              .font(.footnote.weight(.semibold))
              .foregroundStyle(ADEColor.accent)
          }
          .adeFlatRow(separator: .hidden)
        }
      } header: {
        // Rows kept from an earlier read while the last one failed.
        ADEFlatSectionHeader("Open on GitHub", detail: model.error == nil ? "\(shown.count)" : "\(shown.count) · may be out of date")
      }
    }
  }

  private var laneLine: String {
    if let computerName, !computerName.isEmpty {
      return "From GitHub. Lane info shows when \(computerName) is online."
    }
    return "From GitHub. Lane info shows when a computer with this project is online."
  }
}

// MARK: - A screen of its own (project home)

/// The open PRs of a project with no computer online, pushed from the
/// project home.
struct PrDirectListScreen: View {
  let repo: GitHubDirectRepoRef
  let computerName: String?
  @StateObject private var model = PrDirectPullsModel()
  @State private var opened: GitHubDirectPull?

  var body: some View {
    List {
      PrDirectPullRows(repo: repo, computerName: computerName, model: model) { opened = $0 }
    }
    .adeFlatList()
    .refreshable { await model.load(repo, background: false) }
    .navigationTitle("Pull requests")
    .navigationBarTitleDisplayMode(.inline)
    .navigationDestination(item: $opened) { pull in
      PrDirectDetailScreen(repo: repo, pull: pull, computerName: computerName)
    }
    .prDirectPolling(repo, model: model)
  }
}

// MARK: - Detail

/// One PR read straight from GitHub: its description, checks, reviews and
/// comments. Changes open on GitHub; lane work waits for a computer.
struct PrDirectDetailScreen: View {
  let repo: GitHubDirectRepoRef
  let pull: GitHubDirectPull
  let computerName: String?

  @Environment(\.openURL) private var openURL
  @ObservedObject private var connection = GitHubAccountConnection.shared
  @State private var detail: GitHubDirectPullDetail?
  @State private var checks: GitHubDirectChecks?
  @State private var reviews: [GitHubDirectReview] = []
  @State private var comments: [GitHubDirectComment] = []
  @State private var error: GitHubDirectError?
  @State private var loading = false
  /// A checks, reviews or comments read failed: that section is empty, not current.
  @State private var partial = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        header
        if let error {
          if let copy = githubDirectStateCopy(error, owner: repo.owner, name: repo.name, githubLogin: connection.state.login) {
            GitHubStateCard(copy: copy)
          } else {
            Text(detail == nil
              ? "GitHub did not return this PR. Pull down to try again."
              : "GitHub did not return the latest of this PR, so this may be out of date. Pull down to try again.")
              .font(.system(size: 12))
              .foregroundStyle(ADEColor.warning)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        if let body = detail?.body.trimmingCharacters(in: .whitespacesAndNewlines), !body.isEmpty {
          section("Description") {
            Text(body)
              .font(.system(size: 14))
              .foregroundStyle(ADEColor.textPrimary)
              .textSelection(.enabled)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
        if let checks, !(checks.runs.isEmpty && checks.statuses.isEmpty) {
          section("Checks") { checksList(checks) }
        }
        if !reviews.isEmpty {
          section("Reviews") {
            ForEach(reviews) { review in
              entry(author: review.author, meta: prDirectReviewState(review.state), text: review.body, when: review.submittedAt)
            }
          }
        }
        if !comments.isEmpty {
          section("Comments") {
            ForEach(comments) { comment in
              entry(
                author: comment.author,
                meta: comment.path.map { path in comment.line.map { "\(path):\($0)" } ?? path },
                text: comment.body,
                when: comment.createdAt
              )
            }
          }
        }
        if loading && detail == nil {
          ProgressView().frame(maxWidth: .infinity).padding(.top, 12)
        }
        if partial {
          Text("Some parts of this PR did not load. Pull down to try again.")
            .font(.system(size: 12))
            .foregroundStyle(ADEColor.warning)
            .fixedSize(horizontal: false, vertical: true)
        }
        footer
      }
      .padding(.horizontal, 16)
      .padding(.top, 8)
      .padding(.bottom, 28)
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .navigationTitle(Text(verbatim: "#\(pull.number)"))
    .navigationBarTitleDisplayMode(.inline)
    .refreshable { await load() }
    .task(id: pull.number) { await load() }
  }

  /// The newest read of the PR: a refresh updates the title, state and branches.
  private var current: GitHubDirectPull { detail?.pull ?? pull }

  private var header: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        Image(systemName: prStateSymbol(stateLabel))
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(prStateColor(stateLabel))
        Text(stateTitle)
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(prStateColor(stateLabel))
        Text(verbatim: "#\(current.number)")
          .font(.adeMono(12, weight: .medium))
          .foregroundStyle(ADEColor.textMuted)
      }
      Text(current.title)
        .font(.system(size: 19, weight: .bold))
        .foregroundStyle(ADEColor.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
      HStack(spacing: 6) {
        Text(current.headRef)
          .font(.adeMono(12))
          .lineLimit(1)
          .truncationMode(.middle)
        Image(systemName: "arrow.right")
          .font(.system(size: 9, weight: .semibold))
        Text(current.baseRef)
          .font(.adeMono(12))
          .lineLimit(1)
      }
      .foregroundStyle(ADEColor.textSecondary)
      HStack(spacing: 10) {
        if let author = current.author {
          Text(author).font(.system(size: 12.5)).foregroundStyle(ADEColor.textSecondary)
        }
        if let detail, let additions = detail.additions, let deletions = detail.deletions {
          Text("+\(additions)").font(.adeMono(12)).foregroundStyle(ADEColor.success)
          Text("−\(deletions)").font(.adeMono(12)).foregroundStyle(ADEColor.danger)
        }
        if let files = detail?.changedFiles {
          Text(files == 1 ? "1 file" : "\(files) files").font(.system(size: 12.5)).foregroundStyle(ADEColor.textMuted)
        }
      }
      if let url = current.htmlUrl.flatMap(URL.init(string:)) {
        Button {
          openURL(url)
        } label: {
          Label("Open on GitHub", systemImage: "arrow.up.right.square")
        }
        .buttonStyle(ADEKitButtonStyle(prominent: true))
        .padding(.top, 4)
      }
    }
  }

  private var footer: some View {
    Text(computerName.map { "Merge, review and lane work open on GitHub or in ADE. Lane info shows when \($0) is online." }
      ?? "Merge, review and lane work open on GitHub or in ADE. Lane info shows when a computer with this project is online.")
      .font(.system(size: 12))
      .foregroundStyle(ADEColor.textMuted)
      .fixedSize(horizontal: false, vertical: true)
  }

  private var stateLabel: String {
    current.merged ? "merged" : current.draft ? "draft" : current.state
  }

  private var stateTitle: String {
    current.merged ? "Merged" : current.draft ? "Draft" : current.state == "closed" ? "Closed" : "Open"
  }

  private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title)
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)
      VStack(alignment: .leading, spacing: 10) { content() }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .adeKitCard(padding: nil)
    }
  }

  @ViewBuilder
  private func checksList(_ checks: GitHubDirectChecks) -> some View {
    ForEach(checks.runs) { run in
      checkRow(name: run.name, state: run.conclusion ?? run.status, url: run.htmlUrl)
    }
    ForEach(checks.statuses) { status in
      checkRow(name: status.context, state: status.state, url: status.targetUrl)
    }
  }

  private func checkRow(name: String, state: String, url: String?) -> some View {
    let (symbol, color) = prDirectCheckGlyph(state)
    return HStack(spacing: 8) {
      Image(systemName: symbol)
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(color)
        .frame(width: 16)
        // The glyph is the check's only state on screen.
        .accessibilityLabel(state.replacingOccurrences(of: "_", with: " "))
      Text(name)
        .font(.system(size: 13.5))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
      Spacer(minLength: 8)
      if let url = url.flatMap(URL.init(string:)) {
        Button {
          openURL(url)
        } label: {
          Image(systemName: "arrow.up.right")
            .font(.system(size: 11, weight: .semibold))
            // A wider target that keeps the row's height. It is as tall as
            // one row plus the gap, so it never covers the next check's.
            .frame(width: 44, height: 28)
            .contentShape(Rectangle())
        }
        .padding(.vertical, -5)
        .padding(.trailing, -14)
        .buttonStyle(.plain)
        .foregroundStyle(ADEColor.textMuted)
        .accessibilityLabel("Open \(name) on GitHub")
      }
    }
  }

  private func entry(author: String?, meta: String?, text: String, when: String?) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 6) {
        Text(author ?? "Someone")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
        if let meta, !meta.isEmpty {
          Text(meta).font(.system(size: 12)).foregroundStyle(ADEColor.textMuted).lineLimit(1).truncationMode(.middle)
        }
        Spacer(minLength: 0)
        Text(prCompactRelativeTime(when)).font(.system(size: 12)).foregroundStyle(ADEColor.textMuted)
      }
      if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        Text(text)
          .font(.system(size: 13.5))
          .foregroundStyle(ADEColor.textSecondary)
          .textSelection(.enabled)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private func load() async {
    guard !loading else { return }
    loading = true
    defer { loading = false }
    let client = GitHubDirectClient.shared
    switch await client.getPull(repo, number: pull.number) {
    case .success(let value):
      detail = value
      error = nil
    case .failure(let failure):
      error = failure
      return
    }
    let sha = detail?.pull.headSha ?? pull.headSha
    async let checkAnswer = client.listChecks(repo, sha: sha)
    async let reviewAnswer = client.listReviews(repo, number: pull.number)
    async let commentAnswer = client.listComments(repo, number: pull.number)
    var failed = false
    switch await checkAnswer {
    case .success(let value): checks = value
    case .failure: checks = nil; failed = true  // older checks may belong to another commit
    }
    switch await reviewAnswer {
    case .success(let value): reviews = value.filter { !$0.body.isEmpty || $0.state != "COMMENTED" }
    case .failure: reviews = []; failed = true
    }
    switch await commentAnswer {
    case .success(let value): comments = value
    case .failure: comments = []; failed = true
    }
    partial = failed
  }
}

func prDirectReviewState(_ state: String) -> String {
  switch state.uppercased() {
  case "APPROVED": return "approved"
  case "CHANGES_REQUESTED": return "asked for changes"
  case "COMMENTED": return "commented"
  case "DISMISSED": return "dismissed"
  default: return state.lowercased()
  }
}

func prDirectCheckGlyph(_ state: String) -> (String, Color) {
  switch state.lowercased() {
  case "success", "neutral", "skipped": return ("checkmark.circle.fill", ADEColor.success)
  case "failure", "error", "timed_out", "action_required", "startup_failure": return ("xmark.circle.fill", ADEColor.danger)
  case "cancelled", "stale": return ("minus.circle", ADEColor.textMuted)
  default: return ("circle.dotted", ADEColor.warning)
  }
}
