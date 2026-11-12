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
                onPick: { repo in Task { await addGitHubRepo(repo) } },
                onCloneURL: {
                  cloneTab = .url
                  screen = .clone
                }
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
    // A running step or connect finishes on the computer it started on.
    guard !isSubmitting, connectingTargetId == nil else { return false }
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
    // The computer the step runs on, read before the wait.
    let phoneKey = targetPhoneKey ?? syncService.focusedMachineKey
    let computerName = targetName ?? syncService.focusedMachineDisplayName
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
      folderPhoneKey: phoneKey,
      computerName: computerName
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
      // A computer this step copied to stays, with its result, until the
      // user leaves the step (its roster soon lists the new folder).
      if copyJobs[copyKey(target)] != nil { return true }
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
            if copyChoices.contains(copyKey(target)) { copyChoices.remove(copyKey(target)) } else { copyChoices.insert(copyKey(target)) }
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
            startCopies(result, candidates: candidates.filter { copyChoices.contains(copyKey($0)) })
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
    switch copyJobs[copyKey(target)] {
    case .copying: return .copying
    case .waiting: return target.isLive ? .live : .online
    default: return target.isLive ? .live : .online
    }
  }

  private func copyDetail(_ target: ProjectAddTarget) -> String? {
    switch copyJobs[copyKey(target)] {
    case .waiting: return "Waiting"
    case .done(let folder, _): return folder.rootPath ?? "Copied"
    case .failed(let message): return message
    default: return nil
    }
  }

  private func copyDetailIsPath(_ target: ProjectAddTarget) -> Bool {
    if case .done(let folder, _) = copyJobs[copyKey(target)] { return folder.rootPath != nil }
    return false
  }

  @ViewBuilder
  private func copyTrailing(_ target: ProjectAddTarget) -> some View {
    switch copyJobs[copyKey(target)] {
    case .copying:
      ProgressView().controlSize(.small)
    case .done:
      Image(systemName: "checkmark.circle.fill").foregroundStyle(ADEColor.success)
    case .failed:
      Image(systemName: "exclamationmark.circle.fill").foregroundStyle(ADEColor.danger)
    case .waiting:
      Image(systemName: "clock").foregroundStyle(ADEColor.textMuted)
    case nil:
      Image(systemName: copyChoices.contains(copyKey(target)) ? "checkmark.square.fill" : "square")
        .font(.system(size: 18))
        .foregroundStyle(copyChoices.contains(copyKey(target)) ? ADEColor.accent : ADEColor.textMuted)
    }
  }

  /// The key of a computer in the copy step: its account machine key, which
  /// stays the same when `putAccountProjectCopy` pairs it (its row id then
  /// becomes the phone key).
  private func copyKey(_ target: ProjectAddTarget) -> String {
    target.accountMachineKey ?? target.id
  }

  /// One computer at a time, so two clones never race for the same link.
  private func startCopies(_ result: ProjectAddOutcome, candidates: [ProjectAddTarget]) {
    guard let project = result.accountProject, !candidates.isEmpty else { return }
    for target in candidates { copyJobs[copyKey(target)] = .waiting }
    Task { @MainActor in
      for target in candidates {
        copyJobs[copyKey(target)] = .copying
        guard let accountMachineKey = target.accountMachineKey else {
          copyJobs[copyKey(target)] = .failed("ADE does not know this computer on your account.")
          continue
        }
        switch await syncService.putAccountProjectCopy(project, onAccountMachine: accountMachineKey) {
        case .failure(let failure):
          copyJobs[copyKey(target)] = .failed(failure.message)
        case .success(let copy):
          copyJobs[copyKey(target)] = .done(copy.folder, phoneKey: copy.phoneKey)
        }
      }
    }
  }

  // MARK: Success

  private func successTitle(_ result: ProjectAddOutcome) -> String {
    switch result.kind {
    case .added: return "Added \(result.name)"
    case .copy where result.folder == nil: return "\(result.name) is already on your ADE account"
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
