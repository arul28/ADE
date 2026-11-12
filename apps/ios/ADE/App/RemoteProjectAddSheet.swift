import SwiftUI

// Add a project (decision 3): from a folder on a computer, a new project, or
// a repository on GitHub. Each step runs on the computer the user chose, over
// that computer's own link (`onMachine`), so the primary never changes. A
// GitHub project is then added to the ADE account at once, and the user can
// put copies on other online computers.

private enum RemoteProjectAddScreen: Equatable {
  case chooser
  case chooseComputer(ProjectAddFlow)
  case open
  case create
  case clone
  case gitHub
  case parentPicker(ProjectParentPickerTarget)
  case putCopies
  case success
}

private enum ProjectAddFlow: Equatable {
  case open
  case create
  case gitHub

  var screen: RemoteProjectAddScreen {
    switch self {
    case .open: return .open
    case .create: return .create
    case .gitHub: return .gitHub
    }
  }
}

private enum ProjectParentPickerTarget: Equatable {
  case create
  case clone
}

/// What the flow added, for the copies step and the success screen.
private struct ProjectAddOutcome: Equatable {
  enum Kind: Equatable {
    /// A new project on the account (or one that came back from a removal).
    case added
    /// The repository was already on the account: the folder is a copy.
    case copy
    /// No GitHub remote (or signed out): the folder is on that computer only.
    case computerOnly
  }

  var kind: Kind
  var name: String
  /// The folder the flow opened, created or cloned. Nil for a GitHub pick
  /// with no copy yet.
  var folder: MobileProjectSummary?
  /// The phone key of the folder's computer.
  var folderPhoneKey: String?
  var computerName: String?
  var accountProject: AccountProject?
  /// The account could not add the project; the brain publishes it later.
  var accountNotice: String?
}

private enum ProjectCopyJobState: Equatable {
  case waiting
  case copying
  case done(MobileProjectSummary, phoneKey: String)
  case failed(String)
}

private enum RemoteProjectChoiceIcon {
  case system(String)
  case asset(String)
}

struct RemoteProjectAddSheet: View {
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @ObservedObject private var account = AccountService.shared
  @ObservedObject private var accountProjects = AccountProjectStore.shared
  private var syncService: SyncService { syncPublishes.service }
  @Environment(\.dismiss) private var dismiss

  @State private var screen: RemoteProjectAddScreen = .chooser
  /// The computer the flow works on (a phone key; nil = the primary).
  @State private var targetPhoneKey: String?
  @State private var targetName: String?
  @State private var connectingTargetId: String?
  @State private var createName = ""
  @State private var createParentDir = ""
  @State private var cloneUrl = ""
  @State private var cloneName = ""
  @State private var cloneParentDir = ""
  @State private var cloneTab: ProjectCloneTab = .url
  @State private var browsePath = ""
  @State private var actionError: String?
  @State private var isSubmitting = false
  @State private var outcome: ProjectAddOutcome?
  @State private var copyChoices = Set<String>()
  @State private var copyJobs: [String: ProjectCopyJobState] = [:]

  private var governsAccount: Bool { accountProjects.governsHub }
  private var targets: [ProjectAddTarget] { syncService.projectAddTargets() }
  private var callKey: String? { syncService.machineCallKey(targetPhoneKey) }

  private var title: String {
    switch screen {
    case .chooser: return "Add a project"
    case .chooseComputer: return "Choose a computer"
    case .open: return "From a computer"
    case .create: return "Create a new project"
    case .clone: return "Clone from GitHub"
    case .gitHub: return "From GitHub"
    case .parentPicker: return "Choose parent directory"
    case .putCopies: return copyHolderNames.isEmpty ? "Put a copy on a computer?" : "Put a copy on more?"
    // The card says what was added.
    case .success: return ""
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
            case .chooseComputer(let flow):
              computerChooser(for: flow)
            case .open:
              targetLine
              RemoteProjectDirectoryBrowser(
                mode: .open,
                machineKey: callKey,
                path: $browsePath,
                isSubmitting: isSubmitting,
                onCancel: { screen = .chooser },
                onChoose: { rootPath in
                  guard !isSubmitting else { return }
                  Task { await openProject(rootPath: rootPath) }
                }
              )
            case .create:
              targetLine
              RemoteProjectCreateForm(
                name: $createName,
                parentDir: $createParentDir,
                publishNote: governsAccount
                  ? "ADE creates it on \(targetName ?? syncService.focusedMachineDisplayName) only. To use it from other devices, publish it to GitHub with ADE on that computer."
                  : nil,
                isSubmitting: isSubmitting,
                onChooseParent: { screen = .parentPicker(.create) },
                onCancel: { screen = .chooser },
                onCreate: { Task { await createProject() } }
              )
            case .clone:
              targetLine
              RemoteProjectCloneForm(
                machineKey: callKey,
                tab: $cloneTab,
                url: $cloneUrl,
                name: $cloneName,
                parentDir: $cloneParentDir,
                isSubmitting: isSubmitting,
                onChooseParent: { screen = .parentPicker(.clone) },
                onCancel: { screen = .chooser },
                onClone: { Task { await cloneProject() } }
              )
            case .gitHub:
              targetLine
              ProjectGitHubRepoPicker(
                machineKey: callKey,
                computerName: targetName ?? syncService.focusedMachineDisplayName,
                isSubmitting: isSubmitting,
                onPick: { repo in Task { await addGitHubRepo(repo) } }
              )
            case .parentPicker(let target):
              RemoteProjectDirectoryBrowser(
                mode: .parent,
                machineKey: callKey,
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
            case .putCopies:
              if let outcome { putCopiesStep(outcome) }
            case .success:
              if let outcome {
                RemoteProjectSuccessView(
                  title: successTitle(outcome),
                  detail: successDetail(outcome),
                  notice: outcome.accountNotice,
                  canOpen: openTarget(outcome) != nil,
                  onStay: { dismiss() },
                  onOpen: { open(outcome) }
                )
              }
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
          if canGoBack {
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
    .task(id: targetPhoneKey ?? "primary") {
      await loadDefaultParent()
    }
    .task { await account.loadMachines() }
  }

  // MARK: Chooser

  private var projectChooser: some View {
    let hasComputer = !targets.isEmpty
    return VStack(spacing: 12) {
      RemoteProjectChoiceCard(
        icon: .system("desktopcomputer"),
        title: "From a computer",
        subtitle: hasComputer ? "a folder that is already on a computer" : "Connect a computer to choose a folder.",
        enabled: hasComputer
      ) {
        begin(.open)
      }

      RemoteProjectChoiceCard(
        icon: .system("sparkles"),
        title: "Create",
        subtitle: hasComputer ? "a new repository" : "Create needs a computer or ADE Cloud.",
        enabled: hasComputer
      ) {
        begin(.create)
      }

      RemoteProjectChoiceCard(
        icon: .asset("ProviderGitHub"),
        title: "From GitHub",
        subtitle: hasComputer ? "a repository you have on GitHub" : "Connect a computer with GitHub to list your repositories.",
        enabled: hasComputer
      ) {
        begin(.gitHub)
      }
    }
  }

  /// One computer goes straight on; several ask first.
  private func begin(_ flow: ProjectAddFlow) {
    actionError = nil
    let rows = targets
    if rows.count == 1, let only = rows.first, only.isLive {
      choose(only, phoneKey: only.phoneKey, then: flow)
    } else {
      screen = .chooseComputer(flow)
    }
  }

  private func computerChooser(for flow: ProjectAddFlow) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      ADESettingsRows {
        ForEach(targets) { target in
          Button {
            pick(target, then: flow)
          } label: {
            HubCopyRow(
              name: target.name,
              reach: connectingTargetId == target.id ? .connecting : (target.isLive ? .live : .online),
              symbol: target.symbol
            ) {
              if connectingTargetId == target.id {
                ProgressView().controlSize(.small)
              } else {
                ADESettingsChevron()
              }
            }
          }
          .buttonStyle(.plain)
          .disabled(connectingTargetId != nil)
        }
      }
      if targets.contains(where: { !$0.isLive }) {
        Text("ADE connects a computer that is not connected when you pick it.")
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textMuted)
          .padding(.horizontal, 4)
      }
    }
  }

  private func pick(_ target: ProjectAddTarget, then flow: ProjectAddFlow) {
    actionError = nil
    if target.isLive {
      choose(target, phoneKey: target.phoneKey, then: flow)
      return
    }
    guard let accountMachineKey = target.accountMachineKey else { return }
    connectingTargetId = target.id
    Task { @MainActor in
      let result = await syncService.connectForStartOn(accountMachineKey: accountMachineKey)
      connectingTargetId = nil
      switch result {
      case .success(let key): choose(target, phoneKey: key, then: flow)
      case .failure(let failure): actionError = failure.message
      }
    }
  }

  private func choose(_ target: ProjectAddTarget, phoneKey: String?, then flow: ProjectAddFlow) {
    if targetPhoneKey != phoneKey {
      // Folders of the last computer do not apply to this one.
      createParentDir = ""
      cloneParentDir = ""
      browsePath = ""
    }
    targetPhoneKey = phoneKey
    targetName = target.name
    // Signed out, From GitHub keeps today's clone form (URL or the list).
    screen = flow == .gitHub && !governsAccount ? .clone : flow.screen
  }

  /// The computer the step runs on, when the phone has more than one.
  @ViewBuilder
  private var targetLine: some View {
    if targets.count > 1, let targetName {
      HStack(spacing: 6) {
        Image(systemName: "desktopcomputer")
          .font(.system(size: 11, weight: .semibold))
        Text("On \(targetName)")
          .font(.system(size: 12.5, weight: .medium))
        Spacer()
      }
      .foregroundStyle(ADEColor.textSecondary)
    }
  }

  private var canGoBack: Bool {
    switch screen {
    case .chooser, .putCopies, .success: return false
    default: return true
    }
  }

  private func goBack() {
    actionError = nil
    switch screen {
    case .chooser, .putCopies, .success:
      break
    case .chooseComputer, .open, .create, .clone, .gitHub:
      screen = .chooser
    case .parentPicker(let target):
      screen = target == .create ? .create : .clone
    }
  }

  private func loadDefaultParent() async {
    guard createParentDir.isEmpty || cloneParentDir.isEmpty || browsePath.isEmpty else { return }
    guard !targets.isEmpty else { return }
    let key = callKey
    guard let parent = try? await syncService.machineProjectDefaultParentDir(onMachine: key), key == callKey else { return }
    if createParentDir.isEmpty { createParentDir = parent }
    if cloneParentDir.isEmpty { cloneParentDir = parent }
    if browsePath.isEmpty { browsePath = parent }
  }

  // MARK: Steps

  private func openProject(rootPath: String) async {
    await runFolderStep(retry: .open) {
      try await syncService.openMachineProject(rootPath: rootPath, onMachine: callKey)
    }
  }

  private func createProject() async {
    await runFolderStep(retry: .create) {
      try await syncService.createMachineProject(name: createName, parentDir: createParentDir, onMachine: callKey)
    }
  }

  private func cloneProject() async {
    await runFolderStep(retry: .clone) {
      try await syncService.cloneMachineProject(url: cloneUrl, name: cloneName, parentDir: cloneParentDir, onMachine: callKey)
    }
  }

  /// Runs one machine step, adds a GitHub folder to the account, then moves
  /// to the copies step (or straight to success).
  private func runFolderStep(retry: RemoteProjectAddScreen, _ step: () async throws -> MobileProjectSummary) async {
    guard !isSubmitting else { return }
    isSubmitting = true
    defer { isSubmitting = false }
    let folder: MobileProjectSummary
    do {
      folder = try await step()
    } catch {
      actionError = SyncUserFacingError.message(for: error)
      screen = retry
      return
    }
    actionError = nil
    var result = ProjectAddOutcome(
      kind: .computerOnly,
      name: folder.displayName,
      folder: folder,
      folderPhoneKey: targetPhoneKey ?? syncService.focusedMachineKey,
      computerName: targetName ?? syncService.focusedMachineDisplayName
    )
    if governsAccount, let identity = AccountProjectIdentity(folder: folder) {
      do {
        let answer = try await accountProjects.add(identity)
        result.accountProject = answer.project
        result.name = answer.project.name
        result.kind = answer.created || answer.revived ? .added : .copy
      } catch {
        // The folder is on the computer; its brain publishes it on its own.
        result.kind = .added
        result.name = identity.name
        result.accountNotice = "Your ADE account did not list it yet: \(changeMessage(error)) It appears when \(result.computerName ?? "the computer") checks in."
      }
    }
    finish(result)
  }

  private func addGitHubRepo(_ repo: MobileGitHubRepoSummary) async {
    guard !isSubmitting else { return }
    isSubmitting = true
    defer { isSubmitting = false }
    do {
      let answer = try await accountProjects.add(AccountProjectIdentity(
        owner: repo.owner,
        name: repo.name,
        defaultBranch: repo.defaultBranch.isEmpty ? nil : repo.defaultBranch
      ))
      actionError = nil
      finish(ProjectAddOutcome(
        kind: answer.created || answer.revived ? .added : .copy,
        name: answer.project.name,
        accountProject: answer.project
      ))
    } catch {
      actionError = changeMessage(error)
    }
  }

  private func finish(_ result: ProjectAddOutcome) {
    outcome = result
    copyJobs = [:]
    copyChoices = []
    screen = result.accountProject != nil && !copyCandidates(for: result).isEmpty ? .putCopies : .success
  }

  private func changeMessage(_ error: Error) -> String {
    (error as? AccountProjectsClient.ChangeError)?.message ?? SyncUserFacingError.message(for: error)
  }

  // MARK: Put copies

  /// Online computers with no copy of the project (and not the one the flow
  /// just used).
  private func copyCandidates(for result: ProjectAddOutcome) -> [ProjectAddTarget] {
    guard let project = result.accountProject else { return [] }
    let account = AccountService.shared
    let held = Set(project.copies.map(\.machineKey))
    let usedAccountKey = result.folderPhoneKey.flatMap { account.machine(forFleetKey: $0)?.machineKey }
    return targets.filter { target in
      guard let key = target.accountMachineKey, !held.contains(key), key != usedAccountKey else { return false }
      if let phoneKey = target.phoneKey, syncService.liveRosterHasFolder(of: project, phoneKey: phoneKey) { return false }
      return true
    }
  }

  private func putCopiesStep(_ result: ProjectAddOutcome) -> some View {
    let candidates = copyCandidates(for: result)
    let running = copyJobs.values.contains { $0 == .copying || $0 == .waiting }
    let started = !copyJobs.isEmpty
    return VStack(alignment: .leading, spacing: 16) {
      Text(copiesLead(result))
        .font(.system(size: 14))
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
      ADESettingsRows {
        ForEach(candidates) { target in
          Button {
            guard !started else { return }
            if copyChoices.contains(target.id) { copyChoices.remove(target.id) } else { copyChoices.insert(target.id) }
          } label: {
            HubCopyRow(
              name: target.name,
              reach: copyReach(target),
              detail: copyDetail(target),
              detailIsPath: copyDetailIsPath(target),
              symbol: target.symbol
            ) {
              copyTrailing(target)
            }
          }
          .buttonStyle(.plain)
          // Not `.disabled`: a row that is copying or done keeps full contrast.
          .allowsHitTesting(!started)
        }
      }
      HStack(spacing: 10) {
        Button(started ? "Done" : "Not now") {
          screen = .success
        }
        .buttonStyle(ProjectSecondaryButtonStyle())
        .disabled(running)
        if !started {
          Button("Put copies") {
            startCopies(result, candidates: candidates.filter { copyChoices.contains($0.id) })
          }
          .buttonStyle(ProjectPrimaryButtonStyle())
          .disabled(copyChoices.isEmpty)
        }
      }
      .frame(maxWidth: .infinity, alignment: .trailing)
    }
  }

  /// The computers that hold the outcome's project, the flow's own first.
  private var copyHolderNames: [String] {
    guard let result = outcome else { return [] }
    var names = result.accountProject.map { accountProjectCopyMachines($0, machines: AccountService.shared.machines).compactMap { $0.machine?.displayName } } ?? []
    if let computer = result.computerName, result.folder != nil, !names.contains(computer) { names.insert(computer, at: 0) }
    return names
  }

  private func copiesLead(_ result: ProjectAddOutcome) -> String {
    let names = copyHolderNames
    if names.isEmpty {
      return "\(result.name) is on your ADE account. Put a copy on a computer to start work there. ADE copies it from GitHub into the computer's projects folder."
    }
    let place: String
    switch names.count {
    case 1: place = names[0]
    case 2: place = "\(names[0]) and \(names[1])"
    default: place = "\(names[0]) and \(names.count - 1) more computers"
    }
    return "\(result.name) is on \(place). Put a copy on more computers? ADE copies it from GitHub into each computer's projects folder."
  }

  private func copyReach(_ target: ProjectAddTarget) -> HubCopyReach {
    switch copyJobs[target.id] {
    case .copying: return .copying
    case .waiting: return target.isLive ? .live : .online
    default: return target.isLive ? .live : .online
    }
  }

  private func copyDetail(_ target: ProjectAddTarget) -> String? {
    switch copyJobs[target.id] {
    case .waiting: return "Waiting"
    case .done(let folder, _): return folder.rootPath ?? "Copied"
    case .failed(let message): return message
    default: return nil
    }
  }

  private func copyDetailIsPath(_ target: ProjectAddTarget) -> Bool {
    if case .done(let folder, _) = copyJobs[target.id] { return folder.rootPath != nil }
    return false
  }

  @ViewBuilder
  private func copyTrailing(_ target: ProjectAddTarget) -> some View {
    switch copyJobs[target.id] {
    case .copying:
      ProgressView().controlSize(.small)
    case .done:
      Image(systemName: "checkmark.circle.fill").foregroundStyle(ADEColor.success)
    case .failed:
      Image(systemName: "exclamationmark.circle.fill").foregroundStyle(ADEColor.danger)
    case .waiting:
      Image(systemName: "clock").foregroundStyle(ADEColor.textMuted)
    case nil:
      Image(systemName: copyChoices.contains(target.id) ? "checkmark.square.fill" : "square")
        .font(.system(size: 18))
        .foregroundStyle(copyChoices.contains(target.id) ? ADEColor.accent : ADEColor.textMuted)
    }
  }

  /// One computer at a time, so two clones never race for the same link.
  private func startCopies(_ result: ProjectAddOutcome, candidates: [ProjectAddTarget]) {
    guard let project = result.accountProject, !candidates.isEmpty else { return }
    for target in candidates { copyJobs[target.id] = .waiting }
    Task { @MainActor in
      for target in candidates {
        copyJobs[target.id] = .copying
        guard let accountMachineKey = target.accountMachineKey else {
          copyJobs[target.id] = .failed("ADE does not know this computer on your account.")
          continue
        }
        switch await syncService.connectForStartOn(accountMachineKey: accountMachineKey) {
        case .failure(let failure):
          copyJobs[target.id] = .failed(failure.message)
        case .success(let key):
          do {
            let folder = try await syncService.copyAccountProject(project, ontoMachine: key)
            copyJobs[target.id] = .done(folder, phoneKey: key)
          } catch {
            copyJobs[target.id] = .failed(SyncUserFacingError.message(for: error))
          }
        }
      }
    }
  }

  // MARK: Success

  private func successTitle(_ result: ProjectAddOutcome) -> String {
    switch result.kind {
    case .added: return "Added \(result.name)"
    case .copy: return "Added a copy of \(result.name) on \(result.computerName ?? "the computer")"
    case .computerOnly: return "Added \(result.name)"
    }
  }

  private func successDetail(_ result: ProjectAddOutcome) -> String? {
    switch result.kind {
    case .computerOnly where governsAccount:
      return "\(result.name) is on \(result.computerName ?? "this computer") only. Publish it to GitHub to use it from other devices."
    case .computerOnly:
      return result.folder?.rootPath
    case .added, .copy:
      if result.folder == nil, openTarget(result) == nil {
        return "It is on your ADE account with no copy yet. Put a copy on a computer to start work."
      }
      return result.folder?.rootPath
    }
  }

  /// The folder Open goes to: the flow's folder, else the first copy made.
  private func openTarget(_ result: ProjectAddOutcome) -> (folder: MobileProjectSummary, phoneKey: String?)? {
    if let folder = result.folder { return (folder, result.folderPhoneKey) }
    for value in copyJobs.values {
      if case .done(let folder, let key) = value { return (folder, key) }
    }
    return nil
  }

  private func open(_ result: ProjectAddOutcome) {
    guard let target = openTarget(result) else { return }
    if let key = syncService.machineCallKey(target.phoneKey) {
      Task { await syncService.openProject(target.folder, onMachine: key) }
    } else {
      syncService.selectProject(target.folder)
    }
    dismiss()
  }
}

/// The repositories one computer can list through its GitHub sign-in. A pick
/// adds the repository to the ADE account; copies come after.
private struct ProjectGitHubRepoPicker: View {
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }

  let machineKey: String?
  let computerName: String
  let isSubmitting: Bool
  let onPick: (MobileGitHubRepoSummary) -> Void

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
    loading = true
    errorMessage = nil
    defer { loading = false }
    do {
      let query = search
      let next = try await syncService.listMachineGitHubRepos(search: query, onMachine: machineKey)
      guard query == search else { return }
      repos = next
    } catch {
      errorMessage = SyncUserFacingError.message(for: error)
    }
  }
}

private struct RemoteProjectChoiceCard: View {
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

private enum RemoteProjectDirectoryBrowserMode {
  case open
  case parent
}

private struct RemoteProjectDirectoryBrowser: View {
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

private struct RemoteProjectCreateForm: View {
  @Binding var name: String
  @Binding var parentDir: String
  /// Where the new project lives until it is on GitHub. The phone cannot
  /// publish yet.
  var publishNote: String? = nil
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
      if let publishNote {
        HStack(alignment: .top, spacing: 8) {
          Image("ProviderGitHub")
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: 13, height: 13)
            .padding(.top, 2)
          Text(publishNote)
            .font(.system(size: 13))
            .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(ADEColor.textSecondary)
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

private struct RemoteProjectSuccessView: View {
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
            .font(detail.hasPrefix("/") || detail.hasPrefix("~") ? .system(.caption, design: .monospaced) : .system(size: 13.5))
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

private enum InlineProjectNoticeTone {
  case muted
  case danger
}

private struct InlineProjectNotice: View {
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

  private var isPath: Bool { message.hasPrefix("/") || message.hasPrefix("~") }
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
      .modifier(ADEKitDisabledDim())
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
