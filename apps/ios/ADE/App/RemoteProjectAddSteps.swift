import SwiftUI

// The steps of Add project (`RemoteProjectAddSheet`): the choice cards, the
// folder browser, the create and clone forms, the GitHub list, the success
// card, and their shared styles. Each step runs on the computer the sheet
// passes as `machineKey`.

enum RemoteProjectChoiceIcon {
  case system(String)
  case asset(String)
}

/// The repositories one computer can list through its GitHub sign-in. A pick
/// adds the repository to the ADE account; copies come after.
struct ProjectGitHubRepoPicker: View {
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @ObservedObject private var accountGitHub = GitHubAccountConnection.shared
  private var syncService: SyncService { syncPublishes.service }

  let machineKey: String?
  let computerName: String
  let isSubmitting: Bool
  let onPick: (MobileGitHubRepoSummary) -> Void
  /// Opens the clone form, for a repository the list does not hold (a
  /// public one, or a computer with no GitHub sign-in).
  let onCloneURL: () -> Void

  @State private var repos: [MobileGitHubRepoSummary] = []
  @State private var search = ""
  @State private var loading = false
  @State private var errorMessage: String?
  @State private var pickedId: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      ProjectField(label: "SEARCH REPOSITORIES") {
        TextField("owner/repo", text: $search)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
      }
      Text("The list comes from the GitHub sign-in on \(computerName).")
        .font(.system(size: 12))
        .foregroundStyle(ADEColor.textMuted)
      if accountGitHub.state == .notConnected {
        // The account's own sign-in lists repositories with no computer.
        ADESettingsNotice(
          message: "Connect GitHub to your ADE account to list your repositories from this phone.",
          tone: .neutral,
          actionTitle: accountGitHub.connecting ? "Connecting…" : "Connect GitHub",
          action: { Task { await accountGitHub.connect() } }
        )
      }
      if loading && repos.isEmpty {
        ProgressView("Loading repositories…")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }
      if let errorMessage {
        InlineProjectNotice(message: errorMessage, tone: .danger)
      }
      if !loading && errorMessage == nil && repos.isEmpty {
        InlineProjectNotice(message: search.isEmpty ? "No repositories on that GitHub sign-in." : "No repository matches \"\(search)\".", tone: .muted)
      }
      ADESettingsRows {
        ForEach(repos) { repo in
          Button {
            guard !isSubmitting else { return }
            pickedId = repo.id
            onPick(repo)
          } label: {
            ADESettingsRow(
              title: repo.fullName,
              hint: repo.defaultBranch,
              symbol: repo.isPrivate ? "lock" : "globe"
            ) {
              if isSubmitting && pickedId == repo.id {
                ProgressView().controlSize(.small)
              } else {
                Image(systemName: "plus.circle")
                  .foregroundStyle(ADEColor.accent)
              }
            }
          }
          .buttonStyle(.plain)
          .disabled(isSubmitting)
        }
      }
      Button("Clone from a URL", action: onCloneURL)
        .buttonStyle(ProjectSecondaryButtonStyle())
        .disabled(isSubmitting)
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
    .task(id: search) {
      // A pause while typing, so one search sends one request.
      if !search.isEmpty {
        try? await Task.sleep(nanoseconds: 300_000_000)
        guard !Task.isCancelled else { return }
      }
      await load()
    }
  }

  private func load() async {
    let query = search
    loading = true
    errorMessage = nil
    // Only the current search ends the spinner or shows an error.
    defer { if query == search { loading = false } }
    do {
      let next = try await syncService.listMachineGitHubRepos(search: query, onMachine: machineKey)
      guard query == search else { return }
      repos = next
    } catch {
      guard query == search, !Task.isCancelled, !(error is CancellationError) else { return }
      errorMessage = SyncUserFacingError.message(for: error)
    }
  }
}

/// The repositories of the ADE account's GitHub sign-in, read straight from
/// GitHub on this phone (spec 3.10): no computer is needed to add one. The
/// list is read once (ETag'd) and searched here.
struct ProjectAccountGitHubRepoPicker: View {
  let isSubmitting: Bool
  let onPick: (MobileGitHubRepoSummary) -> Void
  let onCloneURL: (() -> Void)?

  @ObservedObject private var connection = GitHubAccountConnection.shared
  @State private var repos: [GitHubDirectRepository] = []
  @State private var search = ""
  @State private var loaded = false
  @State private var error: GitHubDirectError?
  @State private var pickedId: String?

  private var shown: [GitHubDirectRepository] {
    let query = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !query.isEmpty else { return repos }
    return repos.filter { $0.fullName.lowercased().contains(query) }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      if let error, let copy = githubDirectStateCopy(error, githubLogin: connection.state.login) {
        GitHubStateCard(copy: copy)
      } else {
        ProjectField(label: "SEARCH REPOSITORIES") {
          TextField("owner/repo", text: $search)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        }
        Text(connection.state.login.map { "The list comes from @\($0) on GitHub." } ?? "The list comes from your GitHub sign-in.")
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textMuted)
        if !loaded {
          ProgressView("Loading repositories…")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        } else if shown.isEmpty {
          InlineProjectNotice(message: search.isEmpty ? "No repositories on that GitHub sign-in." : "No repository matches \"\(search)\".", tone: .muted)
        }
        ADESettingsRows {
          ForEach(shown) { repo in
            Button {
              guard !isSubmitting else { return }
              pickedId = repo.id
              onPick(Self.summary(repo))
            } label: {
              ADESettingsRow(title: repo.fullName, hint: repo.defaultBranch, symbol: repo.isPrivate ? "lock" : "globe") {
                if isSubmitting && pickedId == repo.id {
                  ProgressView().controlSize(.small)
                } else {
                  Image(systemName: "plus.circle")
                    .foregroundStyle(ADEColor.accent)
                }
              }
            }
            .buttonStyle(.plain)
            .disabled(isSubmitting)
          }
        }
      }
      if let onCloneURL {
        Button("Clone from a URL", action: onCloneURL)
          .buttonStyle(ProjectSecondaryButtonStyle())
          .disabled(isSubmitting)
          .frame(maxWidth: .infinity, alignment: .trailing)
      }
    }
    // A new sign-in or an App install reads the list again.
    .task(id: "\(connection.state.login ?? "")#\(connection.installationsRevision)") { await load() }
  }

  private func load() async {
    switch await GitHubDirectClient.shared.listRepositories() {
    case .success(let next):
      repos = next
      error = nil
    case .failure(let failure):
      error = failure
    }
    loaded = true
  }

  static func summary(_ repo: GitHubDirectRepository) -> MobileGitHubRepoSummary {
    MobileGitHubRepoSummary(
      owner: repo.owner,
      name: repo.name,
      fullName: repo.fullName,
      isPrivate: repo.isPrivate,
      pushedAt: repo.pushedAt,
      defaultBranch: repo.defaultBranch ?? "",
      htmlUrl: "https://github.com/\(repo.owner)/\(repo.name)",
      cloneUrl: "https://github.com/\(repo.owner)/\(repo.name).git",
      sshUrl: "git@github.com:\(repo.owner)/\(repo.name).git"
    )
  }
}

struct RemoteProjectChoiceCard: View {
  let icon: RemoteProjectChoiceIcon
  let title: String
  let subtitle: String
  var enabled = true
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 14) {
        iconView
          .frame(width: 40, height: 40)
          .background(ADEKit.track, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(subtitle)
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer(minLength: 8)
        if enabled { ADESettingsChevron() }
      }
      .opacity(enabled ? 1 : 0.55)
      .adeKitCard()
    }
    .buttonStyle(.plain)
    .disabled(!enabled)
    .accessibilityLabel("\(title), \(subtitle)")
  }

  @ViewBuilder
  private var iconView: some View {
    switch icon {
    case .system(let symbol):
      Image(systemName: symbol)
        .font(.system(size: 17, weight: .regular))
        .foregroundStyle(ADEColor.textSecondary)
    case .asset(let name):
      Image(name)
        .renderingMode(.template)
        .resizable()
        .scaledToFit()
        .frame(width: 20, height: 20)
        .foregroundStyle(ADEColor.textPrimary)
    }
  }
}

enum RemoteProjectDirectoryBrowserMode {
  case open
  case parent
}

struct RemoteProjectDirectoryBrowser: View {
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }

  let mode: RemoteProjectDirectoryBrowserMode
  /// The computer to browse (`onMachine`); nil = the primary.
  var machineKey: String? = nil
  @Binding var path: String
  var isSubmitting: Bool = false
  let onCancel: () -> Void
  let onChoose: (String) -> Void

  @State private var result: MobileProjectBrowseResult?
  @State private var selectedPath: String?
  @State private var loading = false
  @State private var errorMessage: String?

  private var targetPath: String? {
    switch mode {
    case .open:
      return selectedPath ?? result?.openableProjectRoot
    case .parent:
      return result?.exactDirectoryPath ?? result?.directoryPath
    }
  }

  var body: some View {
    VStack(spacing: 12) {
      HStack(spacing: 8) {
        Image(systemName: "magnifyingglass")
          .foregroundStyle(ADEColor.textMuted)
        TextField("~/Projects", text: $path)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .font(.system(.callout, design: .monospaced))
          .foregroundStyle(ADEColor.textPrimary)
          .submitLabel(.go)
          .onChange(of: path) { _, _ in
            clearBrowseState()
          }
          .onSubmit {
            Task { await load() }
          }
        if loading {
          ProgressView()
            .controlSize(.small)
        }
      }
      .padding(12)
      .background(ADEColor.cardBackground.opacity(0.72), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .stroke(ADEColor.border.opacity(0.75), lineWidth: 1)
      )

      if let parentPath = result?.parentPath {
        DirectoryBrowserRow(
          name: "Go up",
          path: parentPath,
          isGitRepo: false,
          selected: false,
          symbol: "arrow.up"
        ) {
          path = parentPath
        }
      }

      LazyVStack(spacing: 8) {
        ForEach(result?.entries ?? []) { entry in
          DirectoryBrowserRow(
            name: entry.name,
            path: entry.fullPath,
            isGitRepo: entry.isGitRepo,
            selected: selectedPath == entry.fullPath,
            symbol: entry.isGitRepo ? "arrow.triangle.branch" : "folder"
          ) {
            if mode == .open && entry.isGitRepo {
              selectedPath = entry.fullPath
            } else {
              path = entry.fullPath
            }
          }
        }
      }

      if let errorMessage {
        InlineProjectNotice(message: errorMessage, tone: .danger)
      }

      HStack(spacing: 10) {
        Button("Cancel", action: onCancel)
          .buttonStyle(ProjectSecondaryButtonStyle())
          // A running step finishes on the screen it started from.
          .disabled(isSubmitting)
        Button(mode == .open ? "Open project" : "Use directory") {
          if let targetPath {
            onChoose(targetPath)
          }
        }
        .buttonStyle(ProjectPrimaryButtonStyle())
        .disabled(targetPath == nil || loading || isSubmitting)
      }
    }
    .task(id: path) {
      try? await Task.sleep(nanoseconds: 250_000_000)
      guard !Task.isCancelled else { return }
      await load()
    }
  }

  private func load() async {
    let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    loading = true
    errorMessage = nil
    defer { loading = false }
    do {
      let nextResult = try await syncService.browseMachineProjectDirectories(partialPath: trimmed, onMachine: machineKey)
      guard path.trimmingCharacters(in: .whitespacesAndNewlines) == trimmed else { return }
      result = nextResult
      if mode == .open {
        selectedPath = result?.openableProjectRoot
      }
    } catch {
      guard path.trimmingCharacters(in: .whitespacesAndNewlines) == trimmed else { return }
      errorMessage = SyncUserFacingError.message(for: error)
    }
  }

  private func clearBrowseState() {
    result = nil
    selectedPath = nil
    errorMessage = nil
  }
}

private struct DirectoryBrowserRow: View {
  let name: String
  let path: String
  let isGitRepo: Bool
  let selected: Bool
  let symbol: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 12) {
        Image(systemName: symbol)
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(isGitRepo ? ADEColor.accent : ADEColor.textSecondary)
          .frame(width: 32, height: 32)
          .background(ADEColor.recessedBackground, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        VStack(alignment: .leading, spacing: 3) {
          Text(name)
            .font(.system(.subheadline, design: .rounded).weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          Text(path)
            .font(.system(.caption2, design: .monospaced))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
        Spacer(minLength: 8)
        if isGitRepo {
          Text("repo")
            .font(.system(.caption2, design: .rounded).weight(.bold))
            .foregroundStyle(ADEColor.accent)
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .background(ADEColor.accent.opacity(0.16), in: Capsule())
        }
      }
      .padding(12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(ADEColor.cardBackground.opacity(selected ? 0.95 : 0.62), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .stroke(selected ? ADEColor.accent.opacity(0.70) : ADEColor.border.opacity(0.70), lineWidth: 1)
      )
    }
    .buttonStyle(.plain)
  }
}

struct RemoteProjectCreateForm: View {
  @Binding var name: String
  @Binding var parentDir: String
  /// "Publish to GitHub": nil hides the switch (the phone is not signed in
  /// to an ADE account, so the project stays on the computer anyway).
  var publish: Binding<Bool>? = nil
  /// Why the switch is off and cannot be turned on (an older ADE there).
  var publishUnavailable: String? = nil
  var computerName = "the computer"
  let isSubmitting: Bool
  let onChooseParent: () -> Void
  let onCancel: () -> Void
  let onCreate: () -> Void

  private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
  private var canCreate: Bool {
    !trimmedName.isEmpty
      && !trimmedName.hasPrefix(".")
      && !trimmedName.contains("/")
      && !trimmedName.contains("\\")
      && !parentDir.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      ProjectField(label: "PROJECT NAME") {
        TextField("my-new-project", text: $name)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
      }
      ProjectField(label: "PARENT DIRECTORY") {
        HStack(spacing: 8) {
          TextField("/Users/admin/Projects", text: $parentDir)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .font(.system(.callout, design: .monospaced))
          Button(action: onChooseParent) {
            Image(systemName: "folder")
          }
          .buttonStyle(ProjectIconButtonStyle())
        }
      }
      if !parentDir.isEmpty && !trimmedName.isEmpty {
        InlineProjectNotice(message: projectJoinPath(parentDir, trimmedName), tone: .muted)
      }
      if let publish {
        publishRow(publish)
      }
      HStack(spacing: 10) {
        Button("Cancel", action: onCancel)
          .buttonStyle(ProjectSecondaryButtonStyle())
          // A running step finishes on the screen it started from.
          .disabled(isSubmitting)
        Button("Create", action: onCreate)
          .buttonStyle(ProjectPrimaryButtonStyle())
          .disabled(!canCreate || isSubmitting)
      }
      .frame(maxWidth: .infinity, alignment: .trailing)
    }
  }

  private func publishRow(_ publish: Binding<Bool>) -> some View {
    let on = publish.wrappedValue && publishUnavailable == nil
    let hint = publishUnavailable
      ?? (on
        ? "ADE makes a private repository with \(computerName)'s GitHub sign-in, so your other devices can use it."
        : "It stays on \(computerName) only. You can publish it later with ADE on that computer.")
    return ADESettingsRows {
      ADESettingsRow(title: "Publish to GitHub", hint: hint) {
        // A computer that cannot publish shows the switch off, as it acts.
        Toggle("Publish to GitHub", isOn: publishUnavailable == nil ? publish : .constant(false))
          .labelsHidden()
          .tint(ADEColor.accent)
          .disabled(publishUnavailable != nil || isSubmitting)
      }
    }
    .opacity(publishUnavailable == nil ? 1 : 0.7)
  }
}

enum ProjectCloneTab: String, CaseIterable, Identifiable {
  case url
  case repos

  var id: String { rawValue }
  var label: String { self == .url ? "URL" : "My repos" }
}

struct RemoteProjectCloneForm: View {
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }

  var machineKey: String? = nil
  @Binding var tab: ProjectCloneTab
  @Binding var url: String
  @Binding var name: String
  @Binding var parentDir: String
  let isSubmitting: Bool
  let onChooseParent: () -> Void
  let onCancel: () -> Void
  let onClone: () -> Void

  @State private var repos: [MobileGitHubRepoSummary] = []
  @State private var repoSearch = ""
  @State private var reposLoading = false
  @State private var reposError: String?

  private var trimmedUrl: String { url.trimmingCharacters(in: .whitespacesAndNewlines) }
  private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
  private var hasGitHubHost: Bool {
    if trimmedUrl.lowercased().hasPrefix("git@github.com:") {
      return true
    }
    guard let host = URL(string: trimmedUrl)?.host?.lowercased() else { return false }
    return host == "github.com" || host.hasSuffix(".github.com")
  }
  private var canClone: Bool {
    hasGitHubHost
      && !trimmedName.isEmpty
      && !parentDir.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Picker("Clone mode", selection: $tab) {
        ForEach(ProjectCloneTab.allCases) { option in
          Text(option.label).tag(option)
        }
      }
      .pickerStyle(.segmented)

      if tab == .url {
        urlFields
      } else {
        repoList
      }

      ProjectField(label: "FOLDER NAME") {
        TextField("repo", text: $name)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
      }
      ProjectField(label: "PARENT DIRECTORY") {
        HStack(spacing: 8) {
          TextField("/Users/admin/Projects", text: $parentDir)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .font(.system(.callout, design: .monospaced))
          Button(action: onChooseParent) {
            Image(systemName: "folder")
          }
          .buttonStyle(ProjectIconButtonStyle())
        }
      }
      if !parentDir.isEmpty && !trimmedName.isEmpty {
        InlineProjectNotice(message: projectJoinPath(parentDir, trimmedName), tone: .muted)
      }
      HStack(spacing: 10) {
        Button("Cancel", action: onCancel)
          .buttonStyle(ProjectSecondaryButtonStyle())
          // A running step finishes on the screen it started from.
          .disabled(isSubmitting)
        Button("Clone", action: onClone)
          .buttonStyle(ProjectPrimaryButtonStyle())
          .disabled(!canClone || isSubmitting)
      }
      .frame(maxWidth: .infinity, alignment: .trailing)
    }
  }

  private var urlFields: some View {
    ProjectField(label: "REPOSITORY URL") {
      TextField("https://github.com/owner/repo", text: $url)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .font(.system(.callout, design: .monospaced))
        .onSubmit {
          fillNameFromUrlIfNeeded()
        }
        .onChange(of: url) { _, _ in
          fillNameFromUrlIfNeeded()
        }
    }
  }

  private var repoList: some View {
    VStack(alignment: .leading, spacing: 10) {
      ProjectField(label: "SEARCH REPOS") {
        TextField("owner/repo", text: $repoSearch)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .onSubmit {
            Task { await loadRepos() }
          }
      }
      if reposLoading {
        ProgressView("Loading repositories...")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }
      if let reposError {
        InlineProjectNotice(message: reposError, tone: .danger)
      }
      LazyVStack(spacing: 8) {
        ForEach(repos) { repo in
          Button {
            url = repo.cloneUrl
            name = repo.name
            tab = .url
          } label: {
            HStack(spacing: 10) {
              Image(systemName: repo.isPrivate ? "lock" : "globe")
                .foregroundStyle(ADEColor.accent)
                .frame(width: 28, height: 28)
                .background(ADEColor.recessedBackground, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
              VStack(alignment: .leading, spacing: 3) {
                Text(repo.fullName)
                  .font(.system(.subheadline, design: .rounded).weight(.semibold))
                  .foregroundStyle(ADEColor.textPrimary)
                  .lineLimit(1)
                Text(repo.defaultBranch)
                  .font(.system(.caption2, design: .monospaced))
                  .foregroundStyle(ADEColor.textMuted)
              }
              Spacer()
              Image(systemName: "chevron.right")
                .foregroundStyle(ADEColor.textMuted)
            }
            .padding(10)
            .background(ADEColor.cardBackground.opacity(0.62), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
              RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(ADEColor.border.opacity(0.65), lineWidth: 1)
            )
          }
          .buttonStyle(.plain)
        }
      }
    }
    .task(id: repoSearch) {
      guard tab == .repos else { return }
      try? await Task.sleep(nanoseconds: 300_000_000)
      guard !Task.isCancelled else { return }
      await loadRepos()
    }
  }

  private func loadRepos() async {
    reposLoading = true
    reposError = nil
    do {
      repos = try await syncService.listMachineGitHubRepos(search: repoSearch, onMachine: machineKey)
    } catch {
      reposError = SyncUserFacingError.message(for: error)
    }
    reposLoading = false
  }

  private func fillNameFromUrlIfNeeded() {
    guard name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          let derived = projectNameFromGitHubUrl(url)
    else { return }
    name = derived
  }
}

struct RemoteProjectSuccessView: View {
  let title: String
  let detail: String?
  let notice: String?
  let canOpen: Bool
  let onStay: () -> Void
  let onOpen: () -> Void

  var body: some View {
    VStack(spacing: 18) {
      Image(systemName: "checkmark.circle.fill")
        .font(.system(size: 44, weight: .semibold))
        .foregroundStyle(ADEColor.success)
      VStack(spacing: 6) {
        Text(title)
          .font(.system(.title3, design: .rounded).weight(.bold))
          .foregroundStyle(ADEColor.textPrimary)
          .multilineTextAlignment(.center)
        if let detail, !detail.isEmpty {
          Text(detail)
            .font(projectTextIsPath(detail) ? .system(.caption, design: .monospaced) : .system(size: 13.5))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(3)
            .multilineTextAlignment(.center)
        }
      }
      if let notice {
        InlineProjectNotice(message: notice, tone: .muted)
      }
      HStack(spacing: 10) {
        Button("Done", action: onStay)
          .buttonStyle(ProjectSecondaryButtonStyle())
        if canOpen {
          Button("Open", action: onOpen)
            .buttonStyle(ProjectPrimaryButtonStyle())
        }
      }
    }
    .padding(24)
    .frame(maxWidth: .infinity)
    .background(ADEColor.cardBackground.opacity(0.72), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .stroke(ADEColor.success.opacity(0.38), lineWidth: 1)
    )
  }
}

private struct ProjectField<Content: View>: View {
  let label: String
  let content: Content

  init(label: String, @ViewBuilder content: () -> Content) {
    self.label = label
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      Text(label)
        .font(.system(.caption2, design: .rounded).weight(.bold))
        .foregroundStyle(ADEColor.textMuted)
        .tracking(0.8)
      content
        .padding(12)
        .background(ADEColor.cardBackground.opacity(0.72), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .stroke(ADEColor.border.opacity(0.75), lineWidth: 1)
        )
    }
  }
}

enum InlineProjectNoticeTone {
  case muted
  case danger
}

struct InlineProjectNotice: View {
  let message: String
  let tone: InlineProjectNoticeTone

  var body: some View {
    Text(message)
      // A folder path is monospaced; a sentence is not.
      .font(isPath ? .system(.caption, design: .monospaced) : .system(size: 13))
      .foregroundStyle(tone == .danger ? ADEColor.danger : ADEColor.textMuted)
      .lineLimit(tone == .danger ? nil : 3)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(10)
      .background((tone == .danger ? ADEColor.danger : ADEColor.recessedBackground).opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
  }

  private var isPath: Bool { projectTextIsPath(message) }
}

/// A folder path, on any computer: a POSIX or home path, a Windows drive
/// path (`C:\` or `C:/`), or a UNC share (`\\server\share`).
func projectTextIsPath(_ text: String) -> Bool {
  if text.hasPrefix("/") || text.hasPrefix("~") || text.hasPrefix("\\\\") { return true }
  return text.range(of: #"^[A-Za-z]:[\\/]"#, options: .regularExpression) != nil
}

struct ProjectPrimaryButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(.subheadline, design: .rounded).weight(.bold))
      .foregroundStyle(Color.white)
      .padding(.horizontal, 16)
      .frame(minHeight: 42)
      .background(ADEColor.accent.opacity(configuration.isPressed ? 0.80 : 1), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      .opacity(configuration.isPressed ? 0.88 : 1)
      .modifier(ADEKitDisabledDim())
  }
}

struct ProjectSecondaryButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(.subheadline, design: .rounded).weight(.semibold))
      .foregroundStyle(ADEColor.textSecondary)
      .padding(.horizontal, 16)
      .frame(minHeight: 42)
      .background(ADEColor.cardBackground.opacity(configuration.isPressed ? 0.90 : 0.62), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .stroke(ADEColor.border.opacity(0.75), lineWidth: 1)
      )
      .modifier(ADEKitDisabledDim())
  }
}

private struct ProjectIconButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 14, weight: .semibold))
      .foregroundStyle(ADEColor.textSecondary)
      .frame(width: 38, height: 38)
      .background(ADEColor.recessedBackground.opacity(configuration.isPressed ? 0.75 : 1), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
  }
}

private func projectJoinPath(_ parent: String, _ name: String) -> String {
  let trimmed = parent.hasSuffix("/") ? String(parent.dropLast()) : parent
  guard !name.isEmpty else { return trimmed }
  return "\(trimmed)/\(name)"
}

private func projectNameFromGitHubUrl(_ value: String) -> String? {
  let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return nil }
  let noGit = trimmed.hasSuffix(".git") ? String(trimmed.dropLast(4)) : trimmed
  let separators = CharacterSet(charactersIn: "/:")
  return noGit
    .components(separatedBy: separators)
    .last?
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .nilIfEmpty
}

private extension String {
  var nilIfEmpty: String? {
    isEmpty ? nil : self
  }
}
