import SwiftUI

/// The chat a "Hand off ▸" sheet acts on, built from a Work row.
struct WorkSessionHandoffSubject: Identifiable, Equatable {
  var id: String { sessionId }
  let sessionId: String
  let laneId: String
  let title: String
  let provider: String
  let modelId: String
  let reasoningEffort: String
  var fastMode: Bool = false
}

/// Providers whose chat can fork in place. Mirrors `HANDOFF_FORK_PROVIDERS`
/// in `shared/types/chat.ts`.
func workProviderSupportsHandoffFork(_ provider: String?) -> Bool {
  guard let provider = provider?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() else { return false }
  return ["claude", "codex", "opencode", "droid", "cursor"].contains(provider)
}

// MARK: - Session menu: Hand off ▸

/// What a `Hand off ▸` item asks for.
enum WorkSessionHandoffIntent: Equatable {
  case local
  case remote
  case auto
  case removeAuto
  /// Cancel a pending move ("Keep it here").
  case keepHere
  /// Retry a move whose confirmation was lost — the same move
  /// (`chat.retryCrossMachineHandoff`), never a new one.
  case retryMove
  /// Drop a lost move the person already checked (cancels it on the brain).
  case dismissMove
  /// Open the chat the move landed on (where the chat continues).
  case openDestination
}

/// The Work row's `Hand off ▸` submenu: a new chat here, another machine, or
/// a rule — plus the move this chat already has (Keep it here / Retry / Dismiss /
/// Open on <machine>). Mirrors desktop `SessionContextMenu` +
/// `CrossMachineMoveSubmenu`. Every flag is the chat's own brain's answer.
struct WorkSessionHandoffMenu: View {
  let session: TerminalSessionSummary
  let record: AgentChatCrossMachineHandoffRecord?
  let isChat: Bool
  let localHandoffAvailable: Bool
  let crossMachineHandoffAvailable: Bool
  let crossMachineCancelAvailable: Bool
  let crossMachineRetryAvailable: Bool
  let autoHandoffAvailable: Bool
  let autoHandoffRuleCount: Int?
  let onHandoff: (TerminalSessionSummary, WorkSessionHandoffIntent) -> Void

  private var move: AgentChatCrossMachineHandoffRecord? {
    guard let record, !record.handoffId.isEmpty else { return nil }
    return record
  }

  /// A move that is asking, waiting or sending, or one whose outcome is
  /// unknown, rules out starting another: the brain would refuse it, and an
  /// unknown one is settled by Retry (same handoff id), not a second move.
  private var offersNewMove: Bool {
    guard crossMachineHandoffAvailable else { return false }
    guard let move else { return true }
    return !move.isActive && move.state != .unknown
  }

  var body: some View {
    if isChat && (localHandoffAvailable || crossMachineHandoffAvailable || autoHandoffAvailable || move != nil) {
      Section {
        Menu {
          moveItems
          if localHandoffAvailable {
            Button {
              onHandoff(session, .local)
            } label: {
              Label("Local handoff…", systemImage: "arrow.triangle.branch")
            }
          }
          if offersNewMove {
            Button {
              onHandoff(session, .remote)
            } label: {
              Label("Another machine…", systemImage: "desktopcomputer")
            }
          }
          if autoHandoffAvailable {
            Divider()
            Button {
              onHandoff(session, .auto)
            } label: {
              Label((autoHandoffRuleCount ?? 0) > 0 ? "Edit auto handoff…" : "Auto handoff…",
                    systemImage: "arrow.left.arrow.right")
            }
            if (autoHandoffRuleCount ?? 0) > 0 {
              Button(role: .destructive) {
                onHandoff(session, .removeAuto)
              } label: {
                Label("Remove auto handoff", systemImage: "nosign")
              }
            }
          }
        } label: {
          Label("Hand off", systemImage: "arrowshape.turn.up.right")
        }
      }
    }
  }

  @ViewBuilder
  private var moveItems: some View {
    if let move {
      if move.isActive {
        if move.state == .sending {
          // Status, not an action: nothing to do while it is in flight.
          Button {} label: {
            Label("Sending to \(move.machineLabel)…", systemImage: "arrow.up.right.circle")
          }
          .disabled(true)
        } else if crossMachineCancelAvailable {
          Button {
            onHandoff(session, .keepHere)
          } label: {
            Label("Keep it here", systemImage: "hand.raised")
          }
        }
      } else {
        // Failed moves retry too, like the card above the composer and desktop.
        if move.state == .unknown || move.state == .failed, crossMachineRetryAvailable {
          Button {
            onHandoff(session, .retryMove)
          } label: {
            Label("Retry move to \(move.machineLabel)", systemImage: "arrow.clockwise")
          }
        }
        // Where the chat continues outlives later attempts (`continuedOn`);
        // an unknown move points at its own target, the chat to check.
        if move.continuation != nil || move.state == .unknown,
           let target = workCrossMachineHandoffOpenTarget(move) {
          Button {
            onHandoff(session, .openDestination)
          } label: {
            Label("Open on \(target.machineName)", systemImage: "arrow.up.forward.app")
          }
        }
        if move.state == .unknown || move.state == .failed, crossMachineCancelAvailable {
          Button {
            onHandoff(session, .dismissMove)
          } label: {
            Label("Dismiss", systemImage: "xmark")
          }
        }
      }
      Divider()
    }
  }
}

// MARK: - Local handoff

/// "Hand off ▸ Local handoff…": a new chat on this machine that continues the
/// work, via `chat.handoff` — the action desktop's Handoff tab calls.
struct WorkLocalHandoffSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let subject: WorkSessionHandoffSubject

  @State private var modelId: String
  @State private var provider: String
  @State private var mode: String
  @State private var reasoningEffort: String
  @State private var fastMode: Bool
  /// Effort and fast mode are sent only once the person picks them; until
  /// then the new chat inherits the source chat's settings.
  @State private var settingsPicked = false
  @State private var note = ""
  @State private var modelPickerPresented = false
  @State private var busy = false
  @State private var errorMessage: String?

  init(subject: WorkSessionHandoffSubject) {
    self.subject = subject
    _modelId = State(initialValue: subject.modelId)
    _provider = State(initialValue: subject.provider)
    _mode = State(initialValue: workProviderSupportsHandoffFork(subject.provider) ? "fork" : "brief")
    _reasoningEffort = State(initialValue: subject.reasoningEffort)
    _fastMode = State(initialValue: subject.fastMode)
  }

  private var forkSupported: Bool { workProviderSupportsHandoffFork(subject.provider) }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 14) {
          ADEKitCard(title: "Conversation") {
            VStack(alignment: .leading, spacing: 8) {
              Picker("Conversation", selection: $mode) {
                if forkSupported { Text("Fork").tag("fork") }
                Text("Brief").tag("brief")
              }
              .pickerStyle(.segmented)
              Text(mode == "fork"
                ? "A copy of this chat, same provider, same lane."
                : "A fresh chat that starts from a written brief of this one.")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
          }
          ADEKitCard(title: "Model") {
            workHandoffModelRow(modelId: modelId, provider: provider) { modelPickerPresented = true }
          }
          ADEKitCard(title: "Note for the next agent") {
            TextField("Where to pick up (optional)", text: $note, axis: .vertical)
              .lineLimit(2...5)
              .adeInsetField(cornerRadius: 12, padding: 10)
          }
          if let errorMessage {
            Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
              .font(.caption)
              .foregroundStyle(ADEColor.warning)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
        .padding(16)
      }
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Local handoff")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }.disabled(busy)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(busy ? "Handing off…" : "Hand off") { Task { await submit() } }
            .disabled(busy || modelId.isEmpty)
        }
      }
      .onChange(of: mode) { _, newMode in
        if newMode == "fork", workNormalizedChatProvider(provider) != workNormalizedChatProvider(subject.provider) {
          modelId = subject.modelId
          provider = subject.provider
        }
      }
      .sheet(isPresented: $modelPickerPresented) {
        WorkModelPickerSheet(
          currentModelId: modelId,
          currentProvider: provider,
          currentReasoningEffort: reasoningEffort,
          currentCodexFastMode: fastMode,
          isBusy: false,
          modelFilter: mode == "fork"
            ? { [sourceProvider = subject.provider] option in
                workNormalizedChatProvider(option.provider) == workNormalizedChatProvider(sourceProvider)
              }
            : nil,
          onSelect: { option, pickedReasoning, runtimeProvider, pickedFastMode in
            modelId = option.id
            provider = workNormalizedChatProvider(runtimeProvider)
            reasoningEffort = pickedReasoning ?? ""
            fastMode = pickedFastMode
            settingsPicked = true
          }
        )
        .environmentObject(syncService)
      }
    }
  }

  private func submit() async {
    busy = true
    errorMessage = nil
    do {
      let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
      try await syncService.handoffChatSession(
        sourceSessionId: subject.sessionId,
        targetModelId: modelId,
        mode: mode,
        handoffNote: trimmed.isEmpty ? nil : trimmed,
        reasoningEffort: settingsPicked && !reasoningEffort.isEmpty ? reasoningEffort : nil,
        fastMode: settingsPicked ? fastMode : nil
      )
      ADEHaptics.success()
      busy = false
      dismiss()
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
      busy = false
    }
  }
}

@ViewBuilder
func workHandoffModelRow(modelId: String, provider: String, onTap: @escaping () -> Void) -> some View {
  Button(action: onTap) {
    HStack(spacing: 10) {
      Image(systemName: providerIcon(provider))
        .foregroundStyle(providerTint(provider))
      Text(modelId.isEmpty ? "Choose a model" : (workKnownModelDisplayName(modelId) ?? prettyWorkChatModelName(modelId)))
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(modelId.isEmpty ? ADEColor.textSecondary : ADEColor.textPrimary)
      Spacer(minLength: 0)
      Image(systemName: "chevron.right")
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
    }
    .padding(10)
    .background(ADEColor.surfaceBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
  }
  .buttonStyle(.plain)
}

// MARK: - Auto handoff

/// One condition the rule can fire on. Mirrors `AUTO_HANDOFF_CONDITIONS` in
/// `AutoHandoffModal.tsx`; the trigger types and rule-id suffixes are the wire.
enum WorkAutoHandoffCondition: String, CaseIterable, Identifiable {
  case limit
  case failure
  case ended

  var id: String { rawValue }

  var triggerType: String {
    switch self {
    case .limit: return "session.limit_reached"
    case .failure: return "session.failed"
    case .ended: return "session.ended_without_pr"
    }
  }

  var label: String {
    switch self {
    case .limit: return "Usage limit"
    case .failure: return "API failure"
    case .ended: return "Chat ends"
    }
  }

  var ruleLabel: String {
    switch self {
    case .limit: return "usage limit"
    case .failure: return "API failure"
    case .ended: return "chat ends"
    }
  }

  var hint: String {
    switch self {
    case .limit: return "The provider's usage window closed mid-chat."
    case .failure: return "The provider or the runtime failed the turn."
    case .ended: return "The chat ended without opening a PR."
    }
  }

  var symbol: String {
    switch self {
    case .limit: return "timer"
    case .failure: return "exclamationmark.circle"
    case .ended: return "flag"
    }
  }

  static func from(triggerType: String) -> WorkAutoHandoffCondition? {
    allCases.first { $0.triggerType == triggerType }
  }
}

struct WorkAutoHandoffForm: Equatable {
  var conditions: Set<WorkAutoHandoffCondition> = [.limit]
  var targetModelId = ""
  var targetProvider = ""
  var reasoningEffort = ""
  var prompt = ""
  var mode = "fork"
  /// "same", "new" or "explicit".
  var laneTarget = "same"
  var targetLaneId = ""
  /// Written as `maxRuns`; matches the runtime's one-shot default of 3.
  var retries = 3

  var isValid: Bool {
    !targetModelId.isEmpty
      && !conditions.isEmpty
      && !(laneTarget == "explicit" && targetLaneId.trimmingCharacters(in: .whitespaces).isEmpty)
      && (mode != "fork" || laneTarget == "same")
  }
}

/// Desktop `autoHandoffRuleId`: deterministic so a second save upserts.
func workAutoHandoffRuleId(sessionId: String?, condition: WorkAutoHandoffCondition) -> String {
  guard let sessionId else { return "auto-handoff-all-\(condition.rawValue)" }
  let slug = sessionId.lowercased()
    .replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
    .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
  return "auto-handoff-\(slug.isEmpty ? "chat" : slug)-\(condition.rawValue)"
}

/// Desktop `selectAutoHandoffRulesForSession`: scope is the identity, and a
/// rule without a handoff action is someone else's.
func workAutoHandoffRules(_ rules: [WorkAutomationRuleSummary], sessionId: String) -> [WorkAutomationRuleSummary] {
  rules.filter { $0.scope?.sessionId == sessionId && $0.handoffAction != nil }
}

/// Desktop `formFromRules`.
func workAutoHandoffForm(from rules: [WorkAutomationRuleSummary], fallback: WorkAutoHandoffForm) -> WorkAutoHandoffForm {
  guard !rules.isEmpty else { return fallback }
  var form = fallback
  form.conditions = Set(rules.flatMap { $0.triggers ?? [] }.compactMap { WorkAutoHandoffCondition.from(triggerType: $0.type) })
  if let action = rules.compactMap(\.handoffAction).first {
    form.targetModelId = action.targetModelId ?? fallback.targetModelId
    form.reasoningEffort = action.reasoningEffort ?? fallback.reasoningEffort
    form.prompt = action.promptTemplate ?? ""
    form.mode = action.handoffMode == "brief" ? "brief" : "fork"
    let laneMode = action.targetLaneMode
    form.laneTarget = form.mode == "brief" && (laneMode == "new" || laneMode == "explicit") ? laneMode! : "same"
    form.targetLaneId = action.targetLaneId ?? ""
  }
  if let maxRuns = rules.compactMap(\.maxRuns).first { form.retries = maxRuns }
  return form
}

/// Desktop `buildAutoHandoffDrafts`: one draft per condition, because a rule
/// keeps a single trigger.
func workAutoHandoffDrafts(form: WorkAutoHandoffForm, sessionId: String, sessionTitle: String, scoped: Bool) -> [[String: Any]] {
  let prompt = form.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
  let maxRuns = max(1, min(5, form.retries))
  return WorkAutoHandoffCondition.allCases.filter { form.conditions.contains($0) }.map { condition in
    let id = workAutoHandoffRuleId(sessionId: scoped ? sessionId : nil, condition: condition)
    var trigger: [String: Any] = ["type": condition.triggerType]
    if scoped { trigger["sessionId"] = sessionId }
    var action: [String: Any] = [
      "type": "handoff",
      "handoffMode": form.mode,
      "targetModelId": form.targetModelId,
      "targetLaneMode": form.laneTarget,
    ]
    if form.laneTarget == "explicit" { action["targetLaneId"] = form.targetLaneId.trimmingCharacters(in: .whitespaces) }
    if !prompt.isEmpty { action["promptTemplate"] = prompt }
    if !form.reasoningEffort.isEmpty { action["reasoningEffort"] = form.reasoningEffort }
    var draft: [String: Any] = [
      "id": id,
      "name": scoped
        ? "Auto handoff · \(condition.ruleLabel) · \(sessionTitle)"
        : "Auto handoff · \(condition.ruleLabel) · every chat",
      "description": scoped
        ? "Created from the chat menu for \"\(sessionTitle)\"."
        : "Created from a chat menu and applied to every chat.",
      "enabled": true,
      "origin": "chat-menu",
      "maxRuns": maxRuns,
      "mode": "review",
      "triggers": [trigger],
      "trigger": trigger,
      "executor": ["mode": "automation-bot"],
      "reviewProfile": "quick",
      "toolPalette": ["repo"],
      "contextSources": [] as [Any],
      "guardrails": [:] as [String: Any],
      "outputs": ["disposition": "comment-only", "createArtifact": true],
      "verification": ["verifyBeforePublish": false],
      "billingCode": "auto:\(id)",
      "actions": [action],
    ]
    if scoped {
      draft["scope"] = ["sessionId": sessionId, "sessionTitle": sessionTitle]
      draft["oneShot"] = true
    }
    return draft
  }
}

/// Desktop `staleAutoHandoffRuleIds`: ids this chat owns that the new drafts
/// no longer cover.
func workAutoHandoffStaleRuleIds(drafts: [[String: Any]], existing: [WorkAutomationRuleSummary], sessionId: String?) -> [String] {
  let keep = Set(drafts.compactMap { $0["id"] as? String })
  var candidates = Set(existing.map(\.id))
  for condition in WorkAutoHandoffCondition.allCases {
    candidates.insert(workAutoHandoffRuleId(sessionId: sessionId, condition: condition))
  }
  return candidates.subtracting(keep).sorted()
}

/// "Hand off ▸ Auto handoff…": the rule editor desktop's `AutoHandoffModal`
/// is, writing through the same automations surface.
struct WorkAutoHandoffSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let subject: WorkSessionHandoffSubject
  let lanes: [LaneSummary]
  /// Called after a save or removal so the caller can refresh its menu cache.
  var onChanged: @MainActor ([WorkAutomationRuleSummary]) -> Void = { _ in }

  /// Nil until the read lands. A failed read keeps the editor closed: saving
  /// over defaults would delete rules this read never saw.
  @State private var existing: [WorkAutomationRuleSummary]?
  @State private var loadError: String?
  @State private var form = WorkAutoHandoffForm()
  @State private var modelPickerPresented = false
  @State private var busy = false
  @State private var errorMessage: String?

  /// Lanes a rule may hand off into. `lanes` is the focused project's list,
  /// so for a chat on another machine none of them exist where the rule runs:
  /// that chat offers no "Another lane" choice (the other targets need no id).
  private var laneOptions: [LaneSummary] {
    if syncService.isRemoteMachineChat(sessionId: subject.sessionId) { return [] }
    return lanes.filter { $0.id != subject.laneId }
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 14) {
          if existing == nil {
            ADEKitCard(title: "Auto handoff") {
              if let loadError {
                VStack(alignment: .leading, spacing: 8) {
                  Text(loadError).font(.caption).foregroundStyle(ADEColor.warning)
                  Button("Try again") { Task { await load() } }.font(.caption.weight(.semibold))
                }
              } else {
                HStack(spacing: 10) {
                  ProgressView().tint(ADEColor.accent)
                  Text("Reading this chat's rules…").font(.subheadline).foregroundStyle(ADEColor.textSecondary)
                }
              }
            }
          } else {
            editor
          }
        }
        .padding(16)
      }
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Auto handoff")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }.disabled(busy)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(busy ? "Saving…" : "Save") { Task { await save(scoped: true) } }
            .disabled(busy || existing == nil || !form.isValid)
        }
      }
      .task { await load() }
      .sheet(isPresented: $modelPickerPresented) {
        WorkModelPickerSheet(
          currentModelId: form.targetModelId,
          currentProvider: form.targetProvider.isEmpty ? subject.provider : form.targetProvider,
          currentReasoningEffort: form.reasoningEffort,
          isBusy: false,
          onSelect: { option, pickedReasoning, runtimeProvider, _ in
            form.targetModelId = option.id
            form.targetProvider = workNormalizedChatProvider(runtimeProvider)
            form.reasoningEffort = pickedReasoning ?? ""
          }
        )
        .environmentObject(syncService)
      }
    }
  }

  @ViewBuilder
  private var editor: some View {
    ADEKitCard(title: "When") {
      VStack(alignment: .leading, spacing: 6) {
        ForEach(WorkAutoHandoffCondition.allCases) { condition in
          Toggle(isOn: Binding(
            get: { form.conditions.contains(condition) },
            set: { on in
              if on { form.conditions.insert(condition) } else { form.conditions.remove(condition) }
            }
          )) {
            Label {
              VStack(alignment: .leading, spacing: 1) {
                Text(condition.label).font(.subheadline.weight(.semibold)).foregroundStyle(ADEColor.textPrimary)
                Text(condition.hint).font(.caption2).foregroundStyle(ADEColor.textSecondary)
              }
            } icon: {
              Image(systemName: condition.symbol).foregroundStyle(ADEColor.accent)
            }
          }
          .tint(ADEColor.accent)
        }
      }
    }
    ADEKitCard(title: "Hand off to") {
      VStack(alignment: .leading, spacing: 10) {
        workHandoffModelRow(
          modelId: form.targetModelId,
          provider: form.targetProvider.isEmpty ? subject.provider : form.targetProvider
        ) { modelPickerPresented = true }
        Picker("Conversation", selection: $form.mode) {
          Text("Fork").tag("fork")
          Text("Brief").tag("brief")
        }
        .pickerStyle(.segmented)
        .onChange(of: form.mode) { _, mode in
          // A fork keeps its source lane; only a brief can move to another lane.
          if mode == "fork" { form.laneTarget = "same" }
        }
        if form.mode == "brief" {
          Picker("Lane", selection: $form.laneTarget) {
            Text("This lane").tag("same")
            Text("A new lane").tag("new")
            if !laneOptions.isEmpty { Text("Another lane").tag("explicit") }
          }
          .pickerStyle(.segmented)
        }
        if form.mode == "brief" && form.laneTarget == "explicit" {
          Picker("Lane", selection: $form.targetLaneId) {
            Text("Choose a lane").tag("")
            ForEach(laneOptions) { lane in
              Text(lane.name).tag(lane.id)
            }
          }
          .pickerStyle(.menu)
          .tint(ADEColor.textPrimary)
        }
      }
    }
    ADEKitCard(title: "Prompt for the next agent") {
      TextField("Optional", text: $form.prompt, axis: .vertical)
        .lineLimit(2...5)
        .adeInsetField(cornerRadius: 12, padding: 10)
    }
    ADEKitCard(title: "Attempts") {
      Stepper(value: $form.retries, in: 1...5) {
        Text("Up to \(form.retries) attempt\(form.retries == 1 ? "" : "s")")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textPrimary)
      }
    }
    if let errorMessage {
      Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
        .font(.caption)
        .foregroundStyle(ADEColor.warning)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    VStack(spacing: 6) {
      Text("Applies to this chat only.")
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
      Button("Make it a rule for every chat") { Task { await save(scoped: false) } }
        .font(.caption.weight(.semibold))
        .disabled(busy || !form.isValid)
      if !(existing ?? []).isEmpty {
        Button("Remove auto handoff", role: .destructive) { Task { await remove() } }
          .font(.caption.weight(.semibold))
          .disabled(busy)
      }
    }
    .frame(maxWidth: .infinity)
  }

  private func load() async {
    loadError = nil
    do {
      let rules = workAutoHandoffRules(
        try await syncService.listAutomationRules(forSessionId: subject.sessionId),
        sessionId: subject.sessionId
      )
      form = workAutoHandoffForm(from: rules, fallback: WorkAutoHandoffForm())
      existing = rules
    } catch {
      loadError = error.localizedDescription
    }
  }

  /// Writes first, then deletes what the user turned off — desktop
  /// `saveAutoHandoffRules`, for the same reason: a failed delete must not
  /// leave the user with fewer rules than they asked for.
  private func save(scoped: Bool) async {
    guard let existing, form.isValid, !busy else { return }
    busy = true
    errorMessage = nil
    defer { busy = false }
    let drafts = workAutoHandoffDrafts(form: form, sessionId: subject.sessionId, sessionTitle: subject.title, scoped: scoped)
    let stale = workAutoHandoffStaleRuleIds(
      drafts: drafts,
      existing: scoped ? existing : [],
      sessionId: scoped ? subject.sessionId : nil
    )
    do {
      for draft in drafts {
        try await syncService.saveAutomationDraft(draft, forSessionId: subject.sessionId)
      }
      for id in stale {
        try await syncService.deleteAutomationRule(id: id, forSessionId: subject.sessionId)
      }
      ADEHaptics.success()
      let refreshed = try? await syncService.listAutomationRules(forSessionId: subject.sessionId)
      onChanged(refreshed.map { workAutoHandoffRules($0, sessionId: subject.sessionId) } ?? existing)
      dismiss()
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  private func remove() async {
    guard let existing, !busy else { return }
    busy = true
    defer { busy = false }
    var remaining = existing
    do {
      for rule in existing {
        try await syncService.deleteAutomationRule(id: rule.id, forSessionId: subject.sessionId)
        remaining.removeAll { $0.id == rule.id }
      }
      ADEHaptics.success()
      onChanged([])
      dismiss()
    } catch {
      // Report what is actually left, so the menu doesn't keep offering
      // rules that are already gone.
      onChanged(remaining)
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }
}
