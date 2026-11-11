import OSLog
import SwiftUI

private let settingsLanesLog = Logger(subsystem: "com.ade.ios", category: "SettingsLanes")

/// Settings › Lanes: how new lanes start in the active project, as the
/// desktop's Lanes › New lanes view has it (`NewLaneSettingsSection.tsx`,
/// `LaneTemplatesSection.tsx`): where a new lane's branch starts and what it
/// is called, then the template that sets it up. Read with
/// `lanes.getNewLaneDefaults` / `lanes.listTemplates` /
/// `lanes.getDefaultTemplate`, written with `lanes.setNewLaneDefaults` and
/// `lanes.setDefaultTemplate`, so the New lane sheet, Auto-create lane and the
/// desktop all start from the same choice. The lanes themselves stay in the
/// Lanes tab; templates are written on the computer.
struct SettingsLanesPage: View {
  let syncService: SyncService
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared

  @State private var defaults: NewLaneDefaultsSnapshot?
  @State private var defaultsError: String?
  @State private var savingStart = false
  @State private var branchPickerPresented = false

  @State private var customPattern = false
  @State private var patternDraft = ""
  @State private var patternError: String?
  @State private var savingPattern = false

  @State private var templates: [LaneTemplate]?
  @State private var templatesError: String?
  @State private var defaultTemplateId: String?
  @State private var savingTemplate = false

  /// The primary lane's checkout lists the branches a lane can start from.
  @State private var branchListLaneId: String?
  @State private var toast: ADEToastMessage?
  /// The project the page's values were read from.
  @State private var loadedProjectId: String?
  /// Bumped on a project change, so a save started for the old project
  /// neither changes the new project's rows nor holds them.
  @State private var projectGeneration = 0

  private var connected: Bool { syncService.connectionState == .connected }
  private var machine: String { syncService.machineDisplayName }

  var body: some View {
    ADESettingsPage(route: .lanes) {
      if !connected {
        ADESettingsNotice(message: SettingsPageCopy.connectMachine)
      } else if syncService.activeProjectId == nil {
        ADESettingsNotice(message: SettingsPageCopy.openProject, tone: .neutral)
      } else {
        newLanesSection
        templateSection
      }
    }
    .navigationDestination(isPresented: $branchPickerPresented) {
      SettingsLaneBranchPicker(
        syncService: syncService,
        laneId: branchListLaneId,
        selected: defaults?.defaults.start.from == .branch ? plainLaneStartBranch(defaults?.defaults.start.branch) : nil
      ) { branch in
        guard let start = defaults?.defaults.start else { return }
        saveStart(LaneStart(from: .branch, branch: branch, on: start.on))
      }
    }
    .adeToast($toast)
    .task(id: "\(connected):\(syncService.activeProjectId ?? "-")") {
      guard connected, let projectId = syncService.activeProjectId else { return }
      if loadedProjectId != projectId {
        // Another project's defaults must never show, or save, under this one.
        defaults = nil
        defaultsError = nil
        templates = nil
        templatesError = nil
        defaultTemplateId = nil
        branchListLaneId = nil
        customPattern = false
        patternDraft = ""
        patternError = nil
        savingStart = false
        savingPattern = false
        savingTemplate = false
        projectGeneration += 1
        loadedProjectId = projectId
      }
      await load(projectId)
    }
  }

  // MARK: - New lanes

  private var canWriteDefaults: Bool { syncService.supportsRemoteAction("lanes.setNewLaneDefaults") }

  /// Who the setting follows: the account for this repository, or one computer.
  private func scopeHint(_ snapshot: NewLaneDefaultsSnapshot) -> String {
    let uses = "Auto-create lane and ade lanes create use these. You can change both when you make a lane."
    guard let scope = snapshot.scope else { return uses }
    if scope.kind == "account-repo" {
      let repo = scope.repo.map { $0.replacingOccurrences(of: "github.com/", with: "") }
      return uses + " Saved to your account" + (repo.map { " for \($0)" } ?? "") + "."
    }
    return uses + " This project has no remote, so they're saved on \(machine) only."
  }

  @ViewBuilder
  private var newLanesSection: some View {
    if !syncService.supportsRemoteAction("lanes.getNewLaneDefaults") {
      ADESettingsSection("New lanes", symbol: "plus.square.on.square", tint: .green) {
        ADESettingsNotice(message: SettingsPageCopy.updateADE(on: machine))
      }
    } else if let defaults {
      ADESettingsSection("New lanes", hint: scopeHint(defaults), symbol: "plus.square.on.square", tint: .green) {
        if !canWriteDefaults {
          ADESettingsNotice(message: SettingsPageCopy.updateADE(on: machine))
        }
        ADESettingsRows {
          startFromRow(defaults)
          if defaults.defaults.start.from == .branch {
            ADESettingsActionRow(
              title: "Branch: \(plainLaneStartBranch(defaults.defaults.start.branch))",
              symbol: "arrow.triangle.branch",
              disabled: !canWriteDefaults || savingStart
            ) {
              branchPickerPresented = true
            }
          }
          onRow(defaults)
          branchNamesRows(defaults)
        }
      }
    } else if let defaultsError {
      ADESettingsSection("New lanes", symbol: "plus.square.on.square", tint: .green) {
        ADESettingsNotice(
          message: "ADE couldn't read this project's new-lane settings on \(machine). \(defaultsError)",
          actionTitle: "Try again",
          action: { Task { if let id = syncService.activeProjectId { await loadDefaults(id) } } }
        )
      }
    } else {
      ADESettingsSection("New lanes", symbol: "plus.square.on.square", tint: .green) {
        ADESettingsRows {
          ADESettingsLoadingRow()
        }
      }
    }
  }

  /// The branch the saved start points at: the default branch, the primary
  /// lane's branch, or the one picked.
  private func sourceBranch(_ snapshot: NewLaneDefaultsSnapshot) -> String {
    let start = snapshot.defaults.start
    switch start.from {
    case .default: return plainLaneStartBranch(snapshot.defaultBranch)
    case .primary: return plainLaneStartBranch(snapshot.primaryBranch)
    case .branch: return plainLaneStartBranch(start.branch)
    }
  }

  private func startFromRow(_ snapshot: NewLaneDefaultsSnapshot) -> some View {
    let start = snapshot.defaults.start
    let source = sourceBranch(snapshot)
    let defaultBranch = plainLaneStartBranch(snapshot.defaultBranch)
    let primaryBranch = plainLaneStartBranch(snapshot.primaryBranch)
    let current: String = {
      switch start.from {
      case .default: return "Default branch"
      case .primary: return "Primary lane's branch"
      case .branch: return "A specific branch"
      }
    }()
    return ADESettingsRow(
      title: "Start from",
      hint: source.isEmpty
        ? "The primary lane has no branch checked out. New lanes can't start from it until it's on a branch."
        : laneStartSentence(start.on, sourceBranch: source, subject: "New lanes")
    ) {
      Menu {
        Picker("Start from", selection: Binding(
          get: { start.from },
          set: { from in
            switch from {
            case .branch:
              branchPickerPresented = true
            case .default, .primary:
              saveStart(LaneStart(from: from, on: start.on))
            }
          }
        )) {
          Text(defaultBranch.isEmpty ? "Default branch" : "Default branch (\(defaultBranch))")
            .tag(LaneStart.From.default)
          Text(primaryBranch.isEmpty ? "Primary lane's branch" : "Primary lane's branch (\(primaryBranch))")
            .tag(LaneStart.From.primary)
          Text("A specific branch…")
            .tag(LaneStart.From.branch)
        }
      } label: {
        ADESettingsMenuLabel(text: current)
      }
      .disabled(!canWriteDefaults || savingStart)
    }
  }

  private func onRow(_ snapshot: NewLaneDefaultsSnapshot) -> some View {
    let start = snapshot.defaults.start
    return VStack(alignment: .leading, spacing: 8) {
      Text("On")
        .font(.system(size: 15))
        .foregroundStyle(ADEColor.textPrimary)
      // A saved default never copies uncommitted work (desktop
      // `LaneStartOnSwitch`): only Remote or Local, and an older saved
      // `uncommitted` reads as Local.
      ADEKitSegmented(
        selection: Binding(
          get: { start.on == .uncommitted ? .local : start.on },
          set: { on in
            var next = start
            next.on = on
            saveStart(next)
          }
        ),
        options: [LaneStart.On.remote, .local].map { (value: $0, title: $0.title) }
      )
      .disabled(!canWriteDefaults || savingStart)
    }
    .padding(.horizontal, ADEKit.inset)
    .padding(.vertical, 11)
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  // MARK: - Branch names

  private static let defaultPattern = "ade/{slug}"
  private static let customTag = "__custom__"

  /// The patterns most projects want; anything else is "Custom".
  private func patternPresets(user: String?) -> [(value: String, label: String)] {
    var presets: [(value: String, label: String)] = [(Self.defaultPattern, "ade/ prefix")]
    if let user, !user.isEmpty { presets.append(("{user}/{slug}", "Your name (\(user)/)")) }
    presets.append(("{slug}", "No prefix"))
    return presets
  }

  @ViewBuilder
  private func branchNamesRows(_ snapshot: NewLaneDefaultsSnapshot) -> some View {
    let user = snapshot.branchUser
    let saved = snapshot.defaults.branchPattern ?? Self.defaultPattern
    let presets = patternPresets(user: user)
    // An older brain answers without `branchPrefix` and ignores a saved pattern.
    let supported = snapshot.branchPrefix != nil && canWriteDefaults
    let savedPreset = presets.first(where: { $0.value == saved })
    let showsCustom = customPattern || savedPreset == nil
    let shown = showsCustom ? patternDraft.trimmingCharacters(in: .whitespaces) : saved
    let problem = laneBranchPatternProblem(shown)
    ADESettingsRow(
      title: "Branch names",
      hint: snapshot.branchPrefix == nil
        ? "The machine that owns this project needs a newer ADE to change branch names."
        : patternError ?? problem ?? "“Fix login bug” becomes \(laneBranchPatternExample(shown, user: user))"
    ) {
      Menu {
        Picker("Branch names", selection: Binding(
          get: { showsCustom ? Self.customTag : saved },
          set: { value in
            patternError = nil
            if value == Self.customTag {
              patternDraft = saved
              customPattern = true
            } else {
              customPattern = false
              savePattern(value)
            }
          }
        )) {
          ForEach(presets, id: \.value) { preset in
            Text(preset.label).tag(preset.value)
          }
          Text("Custom…").tag(Self.customTag)
        }
      } label: {
        ADESettingsMenuLabel(text: showsCustom ? "Custom" : savedPreset?.label ?? saved)
      }
      .disabled(!supported || savingPattern)
    }
    if supported && showsCustom {
      VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 8) {
          TextField(Self.defaultPattern, text: $patternDraft)
            .font(.adeMono(13))
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.done)
            .onSubmit { savePattern(patternDraft.trimmingCharacters(in: .whitespaces)) }
            .disabled(savingPattern)
          Button("Save") { savePattern(patternDraft.trimmingCharacters(in: .whitespaces)) }
            .buttonStyle(ADEKitButtonStyle())
            .disabled(savingPattern || problem != nil || shown == saved)
        }
        Text("{slug} is the lane name and goes last. {user} is your git name.")
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      .padding(.horizontal, ADEKit.inset)
      .padding(.vertical, 11)
    }
  }

  // MARK: - Template

  private var templateSection: some View {
    ADESettingsSection("Template", hint: "Set up new lanes the same way: copy files in, install packages, run a script.", symbol: "doc.on.doc", tint: .blue) {
      if !syncService.supportsRemoteAction("lanes.listTemplates") {
        ADESettingsNotice(message: SettingsPageCopy.updateADE(on: machine))
      } else if let templates {
        if templates.isEmpty {
          ADESettingsRows {
            ADESettingsRow(
              "No templates yet",
              hint: "A template says which files get copied in, what gets installed, and what script runs. Make one on your computer in Settings › Lanes."
            )
          }
        } else {
          ADESettingsRows {
            defaultTemplateRow(templates)
          }
          ADESettingsRows {
            ForEach(templates) { template in
              ADESettingsRow(title: template.name, hint: template.description) {
                if template.id == defaultTemplateId {
                  ADEKitTag(text: "Default")
                }
              }
            }
          }
        }
      } else if let templatesError {
        ADESettingsNotice(
          message: "Couldn't read the templates on \(machine). \(templatesError)",
          actionTitle: "Try again",
          action: { Task { if let id = syncService.activeProjectId { await loadTemplates(id) } } }
        )
      } else {
        ADESettingsRows {
          ADESettingsLoadingRow(title: "Loading templates…")
        }
      }
    }
  }

  @ViewBuilder
  private func defaultTemplateRow(_ templates: [LaneTemplate]) -> some View {
    let current = templates.first(where: { $0.id == defaultTemplateId })?.name ?? "None"
    let hint = "Auto-create lane too. You can pick another when you make a lane."
    if syncService.supportsRemoteAction("lanes.setDefaultTemplate") {
      ADESettingsRow(title: "New lanes use", hint: hint) {
        Menu {
          Picker("New lanes use", selection: Binding(
            get: { defaultTemplateId ?? "" },
            set: { saveDefaultTemplate($0.isEmpty ? nil : $0) }
          )) {
            Text("None").tag("")
            ForEach(templates) { template in
              Text(template.name).tag(template.id)
            }
          }
        } label: {
          ADESettingsMenuLabel(text: current)
        }
        .disabled(savingTemplate)
      }
    } else {
      ADESettingsValueRow(title: "New lanes use", value: current)
    }
  }

  // MARK: - Loading

  /// Each read is dropped when the project changed while it was out; the new
  /// project's load owns the page.
  private func load(_ projectId: String) async {
    await loadDefaults(projectId)
    await loadTemplates(projectId)
    let lanes = (try? await syncService.fetchLanes()) ?? []
    guard syncService.activeProjectId == projectId else { return }
    branchListLaneId = lanes.first(where: { $0.laneType == "primary" && $0.archivedAt == nil })?.id
      ?? lanes.first(where: { $0.archivedAt == nil })?.id
  }

  private func loadDefaults(_ projectId: String) async {
    guard syncService.supportsRemoteAction("lanes.getNewLaneDefaults") else { return }
    defaultsError = nil
    do {
      let snapshot = try await syncService.loadNewLaneDefaults(disconnectOnTimeout: false)
      guard syncService.activeProjectId == projectId else { return }
      // A save in flight keeps what the person just picked.
      if !savingStart && !savingPattern {
        defaults = snapshot
        if !customPattern { patternDraft = snapshot.defaults.branchPattern ?? Self.defaultPattern }
      }
    } catch {
      guard syncService.activeProjectId == projectId else { return }
      settingsLanesLog.warning("New lane defaults read failed: \(error.localizedDescription, privacy: .public)")
      if defaults == nil { defaultsError = SyncUserFacingError.message(for: error) }
    }
  }

  private func loadTemplates(_ projectId: String) async {
    guard syncService.supportsRemoteAction("lanes.listTemplates") else { return }
    templatesError = nil
    do {
      let loaded = try await syncService.fetchLaneTemplates(disconnectOnTimeout: false)
      guard syncService.activeProjectId == projectId else { return }
      templates = loaded
      do {
        // A successful nil is "None" and clears the pick.
        let defaultId = try await syncService.fetchDefaultLaneTemplateId(disconnectOnTimeout: false)
        guard syncService.activeProjectId == projectId else { return }
        if !savingTemplate { defaultTemplateId = defaultId }
      } catch {
        // A failed read keeps the default shown so far rather than "None".
        settingsLanesLog.warning("Default lane template read failed: \(error.localizedDescription, privacy: .public)")
      }
    } catch {
      guard syncService.activeProjectId == projectId else { return }
      settingsLanesLog.warning("Lane templates read failed: \(error.localizedDescription, privacy: .public)")
      if templates == nil { templatesError = SyncUserFacingError.message(for: error) }
    }
  }

  // MARK: - Saving

  /// Optimistic: the row shows the new start at once and goes back if the
  /// machine refuses it. Only the start is sent; the brain keeps the rest.
  private func saveStart(_ requested: LaneStart) {
    var next = requested
    if next.on == .uncommitted { next.on = .local }
    guard let previous = defaults?.defaults.start, previous != next, !savingStart else { return }
    defaults?.defaults.start = next
    savingStart = true
    let generation = projectGeneration
    Task {
      let message = await SettingsPageCopy.commit(
        failure: "Couldn't save where new lanes start.",
        on: machine,
        revert: { _ in if generation == projectGeneration { defaults?.defaults.start = previous } }
      ) {
        try await syncService.saveNewLaneDefaults(start: next)
      }
      guard generation == projectGeneration else { return }
      savingStart = false
      toast = message ?? toast
    }
  }

  private func savePattern(_ pattern: String) {
    guard let snapshot = defaults, !savingPattern else { return }
    let previous = snapshot.defaults.branchPattern
    guard pattern != (previous ?? Self.defaultPattern) else {
      customPattern = false
      return
    }
    if let problem = laneBranchPatternProblem(pattern) {
      patternError = problem
      return
    }
    defaults?.defaults.branchPattern = pattern
    savingPattern = true
    let generation = projectGeneration
    let projectId = loadedProjectId
    Task {
      var failed = false
      let message = await SettingsPageCopy.commit(
        failure: "Couldn't save branch names.",
        on: machine,
        revert: { reason in
          failed = true
          guard generation == projectGeneration else { return }
          defaults?.defaults.branchPattern = previous
          patternError = reason
        }
      ) {
        try await syncService.saveNewLaneDefaults(branchPattern: pattern)
      }
      guard generation == projectGeneration else { return }
      savingPattern = false
      toast = message ?? toast
      guard !failed else { return }
      patternError = nil
      customPattern = false
      // The machine fills `{user}` into the prefix it reports; read it back
      // once this save no longer holds the row.
      if let projectId { await loadDefaults(projectId) }
    }
  }

  private func saveDefaultTemplate(_ templateId: String?) {
    guard templateId != defaultTemplateId, !savingTemplate else { return }
    let previous = defaultTemplateId
    defaultTemplateId = templateId
    savingTemplate = true
    let generation = projectGeneration
    Task {
      var failed = false
      let message = await SettingsPageCopy.commit(
        failure: "Couldn't change the template.",
        on: machine,
        revert: { _ in
          failed = true
          if generation == projectGeneration { defaultTemplateId = previous }
        }
      ) {
        try await syncService.setDefaultLaneTemplate(templateId)
      }
      guard generation == projectGeneration else { return }
      savingTemplate = false
      toast = message ?? toast
      if !failed { defaults?.defaults.templateId = templateId }
    }
  }
}

// MARK: - Branch picker

/// Every branch a new lane can start from, once each: local branches, then
/// remote branches with no local copy (as the New lane sheet lists them).
private struct SettingsLaneBranchPicker: View {
  let syncService: SyncService
  let laneId: String?
  let selected: String?
  let onPick: (String) -> Void

  @Environment(\.dismiss) private var dismiss
  @State private var branches: [GitBranchSummary]?
  @State private var loadError: String?
  @State private var query = ""

  private struct Item: Identifiable {
    let id: String
    let isRemote: Bool
  }

  private var items: [Item] {
    let result = laneStartBranchChoices(branches ?? []).map { Item(id: $0.name, isRemote: $0.branch.isRemote) }
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? result : result.filter { $0.id.localizedCaseInsensitiveContains(trimmed) }
  }

  var body: some View {
    ADESettingsPage(title: "Start from") {
      if laneId == nil {
        ADESettingsNotice(message: "No lane in this project can list branches yet. Open the Lanes tab and try again.")
      } else if let loadError {
        ADESettingsNotice(message: loadError, actionTitle: "Try again", action: { Task { await load() } })
      } else if branches == nil {
        ADESettingsRows {
          ADESettingsLoadingRow(title: "Loading branches…")
        }
      } else {
        ADESettingsSection("Branches", hint: "New lanes branch off the one you pick.", symbol: "arrow.triangle.branch", tint: .accent) {
          if (branches?.count ?? 0) > 6 {
            TextField("Search branches", text: $query)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .padding(.horizontal, ADEKit.inset)
              .frame(minHeight: 44)
              .adeKitCard(padding: nil)
          }
          ADESettingsRows {
            if items.isEmpty {
              ADESettingsRow(branches?.isEmpty == true ? "No branches found." : "No branches match.")
            }
            ForEach(items) { item in
              Button {
                onPick(item.id)
                dismiss()
              } label: {
                ADESettingsRow(
                  title: item.id,
                  hint: item.isRemote ? "Remote only" : nil,
                  symbol: item.isRemote ? "cloud" : "arrow.triangle.branch"
                ) {
                  if item.id == selected {
                    Image(systemName: "checkmark")
                      .font(.system(size: 13, weight: .semibold))
                      .foregroundStyle(ADEColor.accent)
                  }
                }
              }
              .buttonStyle(ADEKitRowButtonStyle())
            }
          }
        }
      }
    }
    .task { await load() }
  }

  private func load() async {
    guard let laneId else { return }
    loadError = nil
    do {
      branches = try await syncService.listBranches(laneId: laneId)
    } catch {
      loadError = "Couldn't list the branches. \(SyncUserFacingError.message(for: error))"
    }
  }
}
