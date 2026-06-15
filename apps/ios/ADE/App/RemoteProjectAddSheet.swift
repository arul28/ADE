import SwiftUI

private enum RemoteProjectAddScreen: Equatable {
  case chooser
  case open
  case create
  case clone
  case parentPicker(ProjectParentPickerTarget)
  case success(RemoteProjectActionOutcome)
}

private enum ProjectParentPickerTarget: Equatable {
  case create
  case clone
}

private struct RemoteProjectActionOutcome: Equatable {
  var verb: String
  var project: MobileProjectSummary
}

private enum RemoteProjectChoiceIcon {
  case system(String)
  case asset(String)
}

struct RemoteProjectAddSheet: View {
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss

  @State private var screen: RemoteProjectAddScreen = .chooser
  @State private var createName = ""
  @State private var createParentDir = ""
  @State private var cloneUrl = ""
  @State private var cloneName = ""
  @State private var cloneParentDir = ""
  @State private var cloneTab: ProjectCloneTab = .url
  @State private var browsePath = ""
  @State private var actionError: String?
  @State private var isSubmitting = false

  private var title: String {
    switch screen {
    case .chooser: return "Add a project"
    case .open: return "Open a project"
    case .create: return "Create a new project"
    case .clone: return "Clone from GitHub"
    case .parentPicker: return "Choose parent directory"
    case .success(let outcome): return "\(outcome.verb)!"
    }
  }

  var body: some View {
    NavigationStack {
      ZStack {
        ADEColor.pageBackground.ignoresSafeArea()
        ScrollView {
          VStack(spacing: 16) {
            switch screen {
            case .chooser:
              projectChooser
            case .open:
              RemoteProjectDirectoryBrowser(
                mode: .open,
                path: $browsePath,
                isSubmitting: isSubmitting,
                onCancel: { screen = .chooser },
                onChoose: { rootPath in
                  guard !isSubmitting else { return }
                  Task { await openProject(rootPath: rootPath) }
                }
              )
            case .create:
              RemoteProjectCreateForm(
                name: $createName,
                parentDir: $createParentDir,
                isSubmitting: isSubmitting,
                onChooseParent: { screen = .parentPicker(.create) },
                onCancel: { screen = .chooser },
                onCreate: { Task { await createProject() } }
              )
            case .clone:
              RemoteProjectCloneForm(
                tab: $cloneTab,
                url: $cloneUrl,
                name: $cloneName,
                parentDir: $cloneParentDir,
                isSubmitting: isSubmitting,
                onChooseParent: { screen = .parentPicker(.clone) },
                onCancel: { screen = .chooser },
                onClone: { Task { await cloneProject() } }
              )
            case .parentPicker(let target):
              RemoteProjectDirectoryBrowser(
                mode: .parent,
                path: target == .create ? $createParentDir : $cloneParentDir,
                onCancel: { screen = target == .create ? .create : .clone },
                onChoose: { directory in
                  switch target {
                  case .create:
                    createParentDir = directory
                    screen = .create
                  case .clone:
                    cloneParentDir = directory
                    screen = .clone
                  }
                }
              )
            case .success(let outcome):
              RemoteProjectSuccessView(
                outcome: outcome,
                onStay: { dismiss() },
                onOpen: {
                  syncService.selectProject(outcome.project)
                  dismiss()
                }
              )
            }

            if let actionError {
              InlineProjectNotice(message: actionError, tone: .danger)
            }
          }
          .padding(20)
          .frame(maxWidth: 560)
          .frame(maxWidth: .infinity)
        }
      }
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          if screen != .chooser {
            Button {
              goBack()
            } label: {
              Label("Back", systemImage: "chevron.left")
            }
          }
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button("Close") {
            dismiss()
          }
        }
      }
    }
    .presentationDetents([.large])
    .presentationDragIndicator(.visible)
    .task {
      await loadDefaultParentIfNeeded()
    }
  }

  private var projectChooser: some View {
    VStack(spacing: 12) {
      RemoteProjectChoiceCard(
        icon: .system("folder"),
        title: "Open",
        subtitle: "a folder you have",
        tint: Color(red: 0.376, green: 0.647, blue: 0.980)
      ) {
        actionError = nil
        browsePath = createParentDir.isEmpty ? browsePath : createParentDir
        screen = .open
      }

      RemoteProjectChoiceCard(
        icon: .system("sparkles"),
        title: "Create",
        subtitle: "a brand-new project",
        tint: Color(red: 0.655, green: 0.545, blue: 0.980)
      ) {
        actionError = nil
        screen = .create
      }

      RemoteProjectChoiceCard(
        icon: .asset("ProviderGitHub"),
        title: "Clone",
        subtitle: "from GitHub",
        tint: Color(red: 0.204, green: 0.827, blue: 0.600)
      ) {
        actionError = nil
        screen = .clone
      }
    }
  }

  private func goBack() {
    switch screen {
    case .chooser:
      break
    case .open, .create, .clone, .success(_):
      screen = .chooser
    case .parentPicker(let target):
      screen = target == .create ? .create : .clone
    }
  }

  private func loadDefaultParentIfNeeded() async {
    guard createParentDir.isEmpty || cloneParentDir.isEmpty || browsePath.isEmpty else { return }
    guard let parent = try? await syncService.machineProjectDefaultParentDir() else { return }
    if createParentDir.isEmpty { createParentDir = parent }
    if cloneParentDir.isEmpty { cloneParentDir = parent }
    if browsePath.isEmpty { browsePath = parent }
  }

  private func openProject(rootPath: String) async {
    guard !isSubmitting else { return }
    isSubmitting = true
    defer { isSubmitting = false }
    do {
      let project = try await syncService.openMachineProject(rootPath: rootPath)
      actionError = nil
      screen = .success(RemoteProjectActionOutcome(verb: "Opened", project: project))
    } catch {
      actionError = SyncUserFacingError.message(for: error)
      screen = .open
    }
  }

  private func createProject() async {
    guard !isSubmitting else { return }
    isSubmitting = true
    defer { isSubmitting = false }
    do {
      let project = try await syncService.createMachineProject(name: createName, parentDir: createParentDir)
      actionError = nil
      screen = .success(RemoteProjectActionOutcome(verb: "Created", project: project))
    } catch {
      actionError = SyncUserFacingError.message(for: error)
    }
  }

  private func cloneProject() async {
    guard !isSubmitting else { return }
    isSubmitting = true
    defer { isSubmitting = false }
    do {
      let project = try await syncService.cloneMachineProject(url: cloneUrl, name: cloneName, parentDir: cloneParentDir)
      actionError = nil
      screen = .success(RemoteProjectActionOutcome(verb: "Cloned", project: project))
    } catch {
      actionError = SyncUserFacingError.message(for: error)
    }
  }
}

private struct RemoteProjectChoiceCard: View {
  let icon: RemoteProjectChoiceIcon
  let title: String
  let subtitle: String
  let tint: Color
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 16) {
        ZStack {
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(
              LinearGradient(
                colors: [tint.opacity(0.30), tint.opacity(0.09)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
              )
            )
            .overlay(
              RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(tint.opacity(0.32), lineWidth: 1)
            )
            .frame(width: 58, height: 58)
          iconView
        }
        VStack(alignment: .leading, spacing: 5) {
          Text(title.uppercased())
            .font(.system(.headline, design: .rounded).weight(.bold))
            .tracking(3)
            .foregroundStyle(ADEColor.textPrimary)
          Text(subtitle)
            .font(.system(.footnote, design: .rounded))
            .foregroundStyle(ADEColor.textMuted)
        }
        Spacer(minLength: 8)
        Image(systemName: "chevron.right")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(tint.opacity(0.75))
      }
      .padding(18)
      .frame(maxWidth: .infinity, minHeight: 112, alignment: .leading)
      .background {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(ADEColor.cardBackground.opacity(0.76))
          .overlay {
            LinearGradient(
              colors: [tint.opacity(0.14), tint.opacity(0.035), .clear],
              startPoint: .topLeading,
              endPoint: .bottomTrailing
            )
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
          }
      }
      .overlay(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .stroke(tint.opacity(0.42), lineWidth: 1)
      )
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(title), \(subtitle)")
  }

  @ViewBuilder
  private var iconView: some View {
    switch icon {
    case .system(let symbol):
      Image(systemName: symbol)
        .font(.system(size: 24, weight: .semibold))
        .foregroundStyle(tint)
    case .asset(let name):
      Image(name)
        .renderingMode(.template)
        .resizable()
        .scaledToFit()
        .frame(width: 28, height: 28)
        .foregroundStyle(tint)
    }
  }
}

private enum RemoteProjectDirectoryBrowserMode {
  case open
  case parent
}

private struct RemoteProjectDirectoryBrowser: View {
  @EnvironmentObject private var syncService: SyncService

  let mode: RemoteProjectDirectoryBrowserMode
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
      let nextResult = try await syncService.browseMachineProjectDirectories(partialPath: trimmed)
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

private struct RemoteProjectCreateForm: View {
  @Binding var name: String
  @Binding var parentDir: String
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
      HStack(spacing: 10) {
        Button("Cancel", action: onCancel)
          .buttonStyle(ProjectSecondaryButtonStyle())
        Button("Create", action: onCreate)
          .buttonStyle(ProjectPrimaryButtonStyle())
          .disabled(!canCreate || isSubmitting)
      }
      .frame(maxWidth: .infinity, alignment: .trailing)
    }
  }
}

private enum ProjectCloneTab: String, CaseIterable, Identifiable {
  case url
  case repos

  var id: String { rawValue }
  var label: String { self == .url ? "URL" : "My repos" }
}

private struct RemoteProjectCloneForm: View {
  @EnvironmentObject private var syncService: SyncService

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
      repos = try await syncService.listMachineGitHubRepos(search: repoSearch)
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

private struct RemoteProjectSuccessView: View {
  let outcome: RemoteProjectActionOutcome
  let onStay: () -> Void
  let onOpen: () -> Void

  var body: some View {
    VStack(spacing: 18) {
      Image(systemName: "checkmark.circle.fill")
        .font(.system(size: 44, weight: .semibold))
        .foregroundStyle(ADEColor.success)
      VStack(spacing: 6) {
        Text(outcome.project.displayName)
          .font(.system(.title3, design: .rounded).weight(.bold))
          .foregroundStyle(ADEColor.textPrimary)
          .multilineTextAlignment(.center)
        if let rootPath = outcome.project.rootPath {
          Text(rootPath)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(2)
            .multilineTextAlignment(.center)
        }
      }
      HStack(spacing: 10) {
        Button("Stay in projects", action: onStay)
          .buttonStyle(ProjectSecondaryButtonStyle())
        Button("Open now", action: onOpen)
          .buttonStyle(ProjectPrimaryButtonStyle())
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

private enum InlineProjectNoticeTone {
  case muted
  case danger
}

private struct InlineProjectNotice: View {
  let message: String
  let tone: InlineProjectNoticeTone

  var body: some View {
    Text(message)
      .font(.system(.caption, design: .monospaced))
      .foregroundStyle(tone == .danger ? ADEColor.danger : ADEColor.textMuted)
      .lineLimit(3)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(10)
      .background((tone == .danger ? ADEColor.danger : ADEColor.recessedBackground).opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
  }
}

private struct ProjectPrimaryButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(.subheadline, design: .rounded).weight(.bold))
      .foregroundStyle(Color.white)
      .padding(.horizontal, 16)
      .frame(minHeight: 42)
      .background(ADEColor.accent.opacity(configuration.isPressed ? 0.80 : 1), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      .opacity(configuration.isPressed ? 0.88 : 1)
  }
}

private struct ProjectSecondaryButtonStyle: ButtonStyle {
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
