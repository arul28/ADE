import SwiftUI

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

  @State private var defaults: SettingsNewLaneDefaults?
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

  private var connected: Bool { syncService.connectionState == .connected }
  private var machine: String { syncService.machineDisplayName }

  var body: some View {
    ADESettingsPage(title: "Lanes", subtitle: SettingsRoute.lanes.subtitle) {
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
    .task(id: connected) {
      guard connected, syncService.activeProjectId != nil else { return }
      await load()
    }
  }

  // MARK: - New lanes

  private var canWriteDefaults: Bool { syncService.supportsRemoteAction("lanes.setNewLaneDefaults") }

  /// Who the setting follows: the account for this repository, or one computer.
  private func scopeHint(_ snapshot: SettingsNewLaneDefaults) -> String {
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
          action: { Task { await loadDefaults() } }
        )
      }
    } else {
      ADESettingsSection("New lanes", symbol: "plus.square.on.square", tint: .green) {
        ADESettingsRows {
          ADESettingsRow(title: "Loading…") { ProgressView() }
        }
      }
    }
  }

  /// The branch the saved start points at: the default branch, the primary
  /// lane's branch, or the one picked.
  private func sourceBranch(_ snapshot: SettingsNewLaneDefaults) -> String {
    let start = snapshot.defaults.start
    switch start.from {
    case .default: return plainLaneStartBranch(snapshot.defaultBranch)
    case .primary: return plainLaneStartBranch(snapshot.primaryBranch)
    case .branch: return plainLaneStartBranch(start.branch)
    }
  }

  private func startFromRow(_ snapshot: SettingsNewLaneDefaults) -> some View {
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
        SettingsMenuLabel(text: current)
      }
      .disabled(!canWriteDefaults || savingStart)
    }
  }

  private func onRow(_ snapshot: SettingsNewLaneDefaults) -> some View {
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
  private func branchNamesRows(_ snapshot: SettingsNewLaneDefaults) -> some View {
    let user = snapshot.branchUser
    let saved = snapshot.defaults.branchPattern ?? Self.defaultPattern
    let presets = patternPresets(user: user)
    // An older brain answers without `branchPrefix` and ignores a saved pattern.
    let supported = snapshot.branchPrefix != nil && canWriteDefaults
    let savedPreset = presets.first(where: { $0.value == saved })
    let showsCustom = customPattern || savedPreset == nil
    let shown = showsCustom ? patternDraft.trimmingCharacters(in: .whitespaces) : saved
    let problem = Self.patternProblem(shown)
    ADESettingsRow(
      title: "Branch names",
      hint: snapshot.branchPrefix == nil
        ? "The machine that owns this project needs a newer ADE to change branch names."
        : patternError ?? problem ?? "“Fix login bug” becomes \(Self.example(pattern: shown, user: user))"
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
        SettingsMenuLabel(text: showsCustom ? "Custom" : savedPreset?.label ?? saved)
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

  /// Why a pattern can't be saved, or nil (`laneBranchPatternProblem` on the
  /// desktop). The machine also refuses a prefix that clashes with a branch.
  private static func patternProblem(_ pattern: String) -> String? {
    let trimmed = pattern.trimmingCharacters(in: .whitespaces)
    guard trimmed.hasSuffix("{slug}") else { return "End the pattern with {slug}, the lane name." }
    guard trimmed.count <= 60 else { return "Keep the pattern under 60 characters." }
    let literal = String(trimmed.dropLast("{slug}".count)).replacingOccurrences(of: "{user}", with: "user")
    if literal.contains("{") || literal.contains("}") { return "Use only {user} and {slug} in the pattern." }
    return nil
  }

  /// "ade/fix-login-bug": the pattern's prefix with `{user}` filled in, then the lane name.
  private static func example(pattern: String, user: String?) -> String {
    let prefix = String(pattern.dropLast("{slug}".count))
    let userSlug = laneBranchSlug(user ?? "")
    var rendered = prefix.replacingOccurrences(of: "{user}", with: userSlug.isEmpty ? "user" : userSlug)
    while rendered.hasPrefix("/") { rendered.removeFirst() }
    return rendered + laneBranchSlug("Fix login bug")
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
          action: { Task { await loadTemplates() } }
        )
      } else {
        ADESettingsRows {
          ADESettingsRow(title: "Loading templates…") { ProgressView() }
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
          SettingsMenuLabel(text: current)
        }
        .disabled(savingTemplate)
      }
    } else {
      ADESettingsValueRow(title: "New lanes use", value: current)
    }
  }

  // MARK: - Loading

  private func load() async {
    await loadDefaults()
    await loadTemplates()
    let lanes = (try? await syncService.fetchLanes()) ?? []
    branchListLaneId = lanes.first(where: { $0.laneType == "primary" && $0.archivedAt == nil })?.id
      ?? lanes.first(where: { $0.archivedAt == nil })?.id
  }

  private func loadDefaults() async {
    guard syncService.supportsRemoteAction("lanes.getNewLaneDefaults") else { return }
    defaultsError = nil
    do {
      let snapshot = try await syncService.fetchSettingsNewLaneDefaults()
      // A save in flight keeps what the person just picked.
      if !savingStart && !savingPattern {
        defaults = snapshot
        if !customPattern { patternDraft = snapshot.defaults.branchPattern ?? Self.defaultPattern }
      }
    } catch {
      if defaults == nil { defaultsError = SyncUserFacingError.message(for: error) }
    }
  }

  private func loadTemplates() async {
    guard syncService.supportsRemoteAction("lanes.listTemplates") else { return }
    templatesError = nil
    do {
      let loaded = try await syncService.fetchLaneTemplates()
      let defaultId = try? await syncService.fetchDefaultLaneTemplateId()
      templates = loaded
      if !savingTemplate { defaultTemplateId = defaultId }
    } catch {
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
    Task {
      defer { savingStart = false }
      do {
        if try await syncService.saveNewLaneDefaults(start: next) == .queued {
          toast = ADEToastMessage(text: SettingsPageCopy.queued(on: machine), kind: .info)
        }
      } catch {
        defaults?.defaults.start = previous
        toast = ADEToastMessage(text: "Couldn't save where new lanes start. \(SyncUserFacingError.message(for: error))", kind: .failure)
      }
    }
  }

  private func savePattern(_ pattern: String) {
    guard let snapshot = defaults, !savingPattern else { return }
    let previous = snapshot.defaults.branchPattern
    guard pattern != (previous ?? Self.defaultPattern) else {
      customPattern = false
      return
    }
    if let problem = Self.patternProblem(pattern) {
      patternError = problem
      return
    }
    defaults?.defaults.branchPattern = pattern
    savingPattern = true
    Task {
      defer { savingPattern = false }
      do {
        if try await syncService.saveNewLaneDefaults(branchPattern: pattern) == .queued {
          toast = ADEToastMessage(text: SettingsPageCopy.queued(on: machine), kind: .info)
        }
        patternError = nil
        customPattern = false
        // The machine fills `{user}` into the prefix it reports; read it back
        // once this save no longer holds the row.
        savingPattern = false
        await loadDefaults()
      } catch {
        defaults?.defaults.branchPattern = previous
        let message = SyncUserFacingError.message(for: error)
        patternError = message
        toast = ADEToastMessage(text: "Couldn't save branch names. \(message)", kind: .failure)
      }
    }
  }

  private func saveDefaultTemplate(_ templateId: String?) {
    guard templateId != defaultTemplateId, !savingTemplate else { return }
    let previous = defaultTemplateId
    defaultTemplateId = templateId
    savingTemplate = true
    Task {
      defer { savingTemplate = false }
      do {
        if try await syncService.setDefaultLaneTemplate(templateId) == .queued {
          toast = ADEToastMessage(text: SettingsPageCopy.queued(on: machine), kind: .info)
        }
        defaults?.defaults.templateId = templateId
      } catch {
        defaultTemplateId = previous
        toast = ADEToastMessage(text: "Couldn't change the template. \(SyncUserFacingError.message(for: error))", kind: .failure)
      }
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
    var seen = Set<String>()
    var result: [Item] = []
    let all = branches ?? []
    for branch in all where !branch.isRemote {
      let plain = plainLaneStartBranch(branch.name)
      if !plain.isEmpty, seen.insert(plain).inserted { result.append(Item(id: plain, isRemote: false)) }
    }
    for branch in all where branch.isRemote {
      let plain = plainLaneStartBranch(branch.name)
      if !plain.isEmpty, plain != "HEAD", seen.insert(plain).inserted { result.append(Item(id: plain, isRemote: true)) }
    }
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? result : result.filter { $0.id.localizedCaseInsensitiveContains(trimmed) }
  }

  var body: some View {
    ADESettingsPage(title: "Start from") {
      if laneId == nil {
        ADESettingsNotice(message: "No lane on this machine can list branches yet. Open the Lanes tab and try again.")
      } else if let loadError {
        ADESettingsNotice(message: loadError, actionTitle: "Try again", action: { Task { await load() } })
      } else if branches == nil {
        ADESettingsRows {
          ADESettingsRow(title: "Loading branches…") { ProgressView() }
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

/// A menu control's face in a settings row: the current choice and the
/// up-down chevron, as `SettingsProviderAccounts` draws its machine menu.
struct SettingsMenuLabel: View {
  let text: String

  var body: some View {
    HStack(spacing: 5) {
      Text(text)
        .font(.system(size: 14))
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)
      Image(systemName: "chevron.up.chevron.down")
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(ADEColor.textMuted)
    }
    .contentShape(Rectangle())
  }
}
