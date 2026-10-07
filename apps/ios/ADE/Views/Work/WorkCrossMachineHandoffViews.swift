import SwiftUI

// MARK: - Presentation (pure)

/// What the in-chat card says and offers for one handoff record. Pure so the
/// card, the send gate's confirmation and a future test all read one table.
struct WorkCrossMachineHandoffCardModel: Equatable {
  enum Action: Equatable {
    case keepHere
    case approve
    case deny
    case open
    case retry
    case workHere
    /// Drops a lost move the person already checked (the brain cancels it).
    case dismiss
  }

  /// No red: a move that didn't happen leaves the chat fine where it is, so
  /// failure reads amber (`warning`), never danger.
  enum Tone: Equatable {
    case neutral
    case accent
    case success
    case warning
  }

  var title: String
  var detail: String?
  var symbol: String
  var tone: Tone
  var actions: [Action]
  /// Ordered checkpoint ticks for a move in flight; empty otherwise.
  var checkpoints: [(label: String, done: Bool)]

  static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.title == rhs.title
      && lhs.detail == rhs.detail
      && lhs.symbol == rhs.symbol
      && lhs.tone == rhs.tone
      && lhs.actions == rhs.actions
      && lhs.checkpoints.map(\.label) == rhs.checkpoints.map(\.label)
      && lhs.checkpoints.map(\.done) == rhs.checkpoints.map(\.done)
  }
}

/// The durable steps of a move in order, with the words every surface shows.
/// Mirrors `CROSS_MACHINE_HANDOFF_STEPS` in shared/crossMachineHandoff.ts — the
/// one list, so the phone and desktop cannot drift.
let workCrossMachineHandoffSteps: [(id: String, label: String)] = [
  ("prepared", "Packed"),
  ("destination_ready", "Ready there"),
  ("accepted", "Accepted"),
  ("marked", "Done"),
]

/// Nil hides the card: no record, a record the UI cannot read, a cancelled
/// move, a continued chat the user chose to keep working in here, or a state
/// this build does not know.
func workCrossMachineHandoffCardModel(
  _ record: AgentChatCrossMachineHandoffRecord?
) -> WorkCrossMachineHandoffCardModel? {
  guard let record, !record.handoffId.isEmpty else { return nil }
  let machine = record.machineLabel.isEmpty ? "another machine" : record.machineLabel
  // Where the chat already continues outlives later attempts (`continuedOn`).
  let continuation = record.continuation
  let alreadyContinues = continuation.flatMap { $0.handoffId == record.handoffId ? nil : $0 }
    .map { "This chat already continues on \($0.targetMachineName)." }
  let modeWord = record.mode == "fork" ? "fork" : "brief"
  switch record.state {
  case .pending:
    return WorkCrossMachineHandoffCardModel(
      title: "Moving to \(machine) when this turn ends · \(modeWord)",
      detail: alreadyContinues,
      symbol: "arrow.right.circle",
      tone: .accent,
      actions: [.keepHere],
      checkpoints: []
    )
  case .awaitingApproval:
    return WorkCrossMachineHandoffCardModel(
      title: "Agent wants to continue on \(machine)",
      // Say what the chat would run with there before the person approves.
      detail: {
        let parts = [record.targetPermissionLabel.map { "Runs there as \($0)." }, alreadyContinues].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
      }(),
      symbol: "questionmark.circle",
      tone: .warning,
      actions: [.approve, .deny],
      checkpoints: []
    )
  case .sending:
    let reached = workCrossMachineHandoffSteps.firstIndex { $0.id == record.checkpoint } ?? -1
    return WorkCrossMachineHandoffCardModel(
      title: "Sending to \(machine)",
      detail: nil,
      symbol: "arrow.up.right.circle",
      tone: .accent,
      actions: [],
      checkpoints: workCrossMachineHandoffSteps.enumerated().map { index, step in
        (label: step.label, done: index <= reached)
      }
    )
  case .continued, .cancelled:
    guard let continuation, !record.resumedHere else { return nil }
    return WorkCrossMachineHandoffCardModel(
      title: "Continues on \(continuation.targetMachineName)",
      // The phone asks on send (continue there, or work here), so it does
      // not say messages go there on their own.
      detail: "Sending here asks where it goes.",
      symbol: "arrow.up.forward.app",
      tone: .accent,
      actions: [.open, .workHere],
      checkpoints: []
    )
  case .failed:
    // A chat that already continues elsewhere still sends there, so the card
    // offers that chat and the way back here alongside the retry.
    var actions: [WorkCrossMachineHandoffCardModel.Action] = [.retry]
    if alreadyContinues != nil { actions.append(.open) }
    if continuation != nil, !record.resumedHere { actions.append(.workHere) }
    return WorkCrossMachineHandoffCardModel(
      title: "Couldn't move to \(machine)",
      detail: [record.reason, alreadyContinues].compactMap { $0 }.joined(separator: " "),
      symbol: "exclamationmark.triangle",
      // Amber, not red: the chat is fine here; only the move didn't happen.
      tone: .warning,
      actions: actions,
      checkpoints: []
    )
  case .unknown:
    // Open first: the chat may already be there. Retry reconciles the same
    // move (same handoff id) and never starts a second chat.
    var actions: [WorkCrossMachineHandoffCardModel.Action] = []
    if workCrossMachineHandoffOpenTarget(record) != nil { actions.append(.open) }
    actions.append(.retry)
    if continuation != nil, !record.resumedHere { actions.append(.workHere) }
    actions.append(.dismiss)
    return WorkCrossMachineHandoffCardModel(
      title: "Lost confirmation — check \(machine) before retrying",
      detail: record.reason ?? "The chat may already be there. Retrying won't start a second one.",
      symbol: "questionmark.diamond",
      tone: .warning,
      actions: actions,
      checkpoints: []
    )
  case .other:
    return nil
  }
}

/// After a move the work lives on the other machine, so a send here asks
/// where it should go. False once the person chose to work here instead.
func workCrossMachineHandoffNeedsSendConfirmation(_ record: AgentChatCrossMachineHandoffRecord?) -> Bool {
  guard let record, !record.handoffId.isEmpty else { return false }
  return record.sendsElsewhere != nil
}

/// A chat on another machine that "Open on <machine>" goes to.
struct WorkCrossMachineHandoffOpenTarget: Equatable {
  let sessionId: String
  let laneId: String?
  let machineKey: String
  let machineName: String
}

/// The chat "Open on <machine>" goes to. An `unknown` move points at its own
/// target first (that is the chat to check); everything else at where the
/// chat continues. Nil when there is nothing to open.
func workCrossMachineHandoffOpenTarget(
  _ record: AgentChatCrossMachineHandoffRecord
) -> WorkCrossMachineHandoffOpenTarget? {
  let ownSession = record.targetSessionId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  let own = ownSession.isEmpty ? nil : WorkCrossMachineHandoffOpenTarget(
    sessionId: ownSession,
    laneId: record.targetLaneId,
    machineKey: record.targetMachineKey,
    machineName: record.machineLabel
  )
  if record.state == .unknown, let own { return own }
  if let continuation = record.continuation {
    let session = continuation.targetSessionId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !session.isEmpty else { return own }
    let name = continuation.targetMachineName.trimmingCharacters(in: .whitespacesAndNewlines)
    return WorkCrossMachineHandoffOpenTarget(
      sessionId: session,
      laneId: continuation.targetLaneId,
      machineKey: continuation.targetMachineKey,
      machineName: name.isEmpty ? continuation.targetMachineKey : name
    )
  }
  return own
}

func workCrossMachineHandoffActionLabel(_ action: WorkCrossMachineHandoffCardModel.Action, machine: String) -> String {
  switch action {
  case .keepHere: return "Keep it here"
  case .approve: return "Approve"
  case .deny: return "Deny"
  case .open: return "Open on \(machine)"
  case .retry: return "Retry"
  case .workHere: return "Work here instead"
  case .dismiss: return "Dismiss"
  }
}

/// The calls the in-chat card and the send gate make. Built by the chat's
/// destination view, which owns the session id and the sync service.
struct WorkCrossMachineHandoffActions {
  var keepHere: @MainActor () async -> Void
  /// Cancels a lost (`unknown`) move the person already checked.
  var dismiss: @MainActor () async -> Void
  var resolveApproval: @MainActor (Bool) async -> Void
  /// Records "send here anyway"; false when the write failed (the send stops).
  var acknowledge: @MainActor () async -> Bool
  var retry: @MainActor () async -> Void
  var open: @MainActor () -> Void
}

// MARK: - In-chat card

struct WorkCrossMachineHandoffCard: View {
  let record: AgentChatCrossMachineHandoffRecord
  let model: WorkCrossMachineHandoffCardModel
  var enabled: Bool = true
  let actions: WorkCrossMachineHandoffActions?

  @State private var inFlight = false

  private var tint: Color {
    switch model.tone {
    case .neutral: return ADEColor.textMuted
    case .accent: return ADEColor.accent
    case .success: return ADEColor.success
    case .warning: return ADEColor.warning
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .top, spacing: 9) {
        Image(systemName: model.symbol)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(tint)
          .frame(width: 24, height: 24)
          .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        VStack(alignment: .leading, spacing: 3) {
          Text(model.title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
          if let detail = model.detail, !detail.isEmpty {
            Text(detail)
              .font(.caption2)
              .foregroundStyle(ADEColor.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        Spacer(minLength: 0)
        if inFlight || model.tone == .accent && model.actions.isEmpty {
          ProgressView().controlSize(.small)
        }
      }
      if !model.checkpoints.isEmpty {
        HStack(spacing: 8) {
          ForEach(Array(model.checkpoints.enumerated()), id: \.offset) { _, step in
            HStack(spacing: 3) {
              Image(systemName: step.done ? "checkmark.circle.fill" : "circle")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(step.done ? ADEColor.success : ADEColor.textMuted)
              Text(step.label)
                .font(.caption2)
                .foregroundStyle(step.done ? ADEColor.textSecondary : ADEColor.textMuted)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(step.label), \(step.done ? "done" : "not yet")")
          }
        }
      }
      if !model.actions.isEmpty, actions != nil {
        HStack(spacing: 8) {
          ForEach(model.actions, id: \.self) { action in
            actionButton(action)
          }
          Spacer(minLength: 0)
        }
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(ADEColor.cardBackground.opacity(0.72), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(tint.opacity(0.28), lineWidth: 0.8)
    )
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("work-cross-machine-handoff-card")
  }

  private func actionButton(_ action: WorkCrossMachineHandoffCardModel.Action) -> some View {
    let label = workCrossMachineHandoffActionLabel(
      action,
      machine: workCrossMachineHandoffOpenTarget(record)?.machineName ?? record.machineLabel
    )
    let primary = action == .approve || action == .open || action == .retry
    return Button {
      run(action)
    } label: {
      Text(label)
        .font(.caption.weight(.semibold))
        .foregroundStyle(action == .retry ? ADEColor.warning : primary ? Color.white : ADEColor.textPrimary)
        .padding(.horizontal, 12)
        .frame(minHeight: 30)
        .background(
          Group {
            if primary {
              // Retry is amber like the card: a failed move is not an error state.
              Capsule(style: .continuous).fill(action == .retry ? ADEColor.warning.opacity(0.18) : ADEColor.accent)
            } else {
              Capsule(style: .continuous).stroke(ADEColor.border.opacity(0.6), lineWidth: 0.8)
            }
          }
        )
        .contentShape(Capsule(style: .continuous))
    }
    .buttonStyle(.plain)
    .disabled(!enabled || inFlight)
    .accessibilityLabel(label)
  }

  private func run(_ action: WorkCrossMachineHandoffCardModel.Action) {
    guard let actions, !inFlight else { return }
    if action == .open {
      actions.open()
      return
    }
    inFlight = true
    Task { @MainActor in
      switch action {
      case .keepHere: await actions.keepHere()
      case .approve: await actions.resolveApproval(true)
      case .deny: await actions.resolveApproval(false)
      case .retry: await actions.retry()
      case .workHere: _ = await actions.acknowledge()
      case .dismiss: await actions.dismiss()
      case .open: break
      }
      inFlight = false
    }
  }
}

// MARK: - Setup sheet ("Continue on another machine")

/// The chat the sheet moves. Built from the Work row (or the open chat).
struct WorkCrossMachineHandoffTarget: Identifiable, Equatable {
  var id: String { sessionId }
  let sessionId: String
  let laneId: String
  let title: String
  let provider: String
  let modelId: String
  let reasoningEffort: String
  let runtimeMode: String
  /// The chat is mid-turn: the primary action becomes "Move when this turn ends".
  let busy: Bool
}

struct WorkCrossMachineHandoffSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let target: WorkCrossMachineHandoffTarget
  /// DEBUG fixture seam: renders these options without asking a brain.
  var previewOptions: AgentChatCrossMachineHandoffOptions? = nil

  @State private var options: AgentChatCrossMachineHandoffOptions?
  @State private var loadError: String?
  @State private var selectedMachineKey: String?
  @State private var mode: String = "brief"
  @State private var modelId: String
  @State private var provider: String
  @State private var reasoningEffort: String
  @State private var fastMode = false
  @State private var runtimeMode: String
  @State private var note = ""
  @State private var includeChanges = false
  @State private var cloneConfirmed = false
  @State private var modelPickerPresented = false
  @State private var busyAction: String?
  @State private var errorMessage: String?

  init(target: WorkCrossMachineHandoffTarget, previewOptions: AgentChatCrossMachineHandoffOptions? = nil) {
    self.target = target
    self.previewOptions = previewOptions
    _modelId = State(initialValue: target.modelId)
    _provider = State(initialValue: target.provider)
    _reasoningEffort = State(initialValue: target.reasoningEffort)
    _runtimeMode = State(initialValue: target.runtimeMode.isEmpty
      ? workDefaultRuntimeMode(provider: target.provider)
      : target.runtimeMode)
  }

  private var machines: [AgentChatCrossMachineHandoffMachineOption] { options?.machines ?? [] }

  private var selectedMachine: AgentChatCrossMachineHandoffMachineOption? {
    machines.first { $0.machineKey == selectedMachineKey }
  }

  private var forkSupported: Bool { workProviderSupportsCrossMachineHandoffFork(target.provider) }

  /// The chat is busy now. A busy chat is not a blocker: the move waits for
  /// the turn to end ("Move when this turn ends").
  private var busy: Bool { target.busy }

  /// Blockers still standing once the user's choices are applied: carried
  /// changes clear the dirty/unpushed ones.
  private var openBlockers: [AgentChatCrossMachineHandoffBlocker] {
    (options?.blockers ?? []).filter { blocker in
      !(blocker.clearedByIncludeChanges && includeChanges)
    }
  }

  private var needsClone: Bool { selectedMachine?.hasRepository == false }

  private var canStart: Bool {
    guard let machine = selectedMachine, machine.unavailableReason == nil else { return false }
    guard !modelId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
    guard openBlockers.isEmpty else { return false }
    if needsClone && !cloneConfirmed { return false }
    return busyAction == nil
  }

  private var primaryLabel: String {
    guard let machine = selectedMachine else { return "Choose a machine" }
    return busy ? "Move when this turn ends" : "Continue on \(machine.name)"
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 14) {
          machineCard
          if options != nil {
            carryCard
            destinationCard
            noteCard
            ForEach(options?.blockers ?? []) { blocker in
              blockerCard(blocker)
            }
            if needsClone, let machine = selectedMachine {
              cloneCard(machine)
            }
            travelsCard
          }
          if let errorMessage {
            Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
              .font(.caption)
              .foregroundStyle(ADEColor.warning)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(12)
              .background(ADEColor.warning.opacity(0.10), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          }
        }
        .padding(16)
        .padding(.bottom, 80)
      }
      .safeAreaInset(edge: .bottom) { primaryButton }
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Continue on another machine")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
      }
      .task { await loadOptions() }
      .sheet(isPresented: $modelPickerPresented) {
        WorkModelPickerSheet(
          currentModelId: modelId,
          currentProvider: provider,
          currentReasoningEffort: reasoningEffort,
          currentCodexFastMode: fastMode,
          isBusy: false,
          // A fork resumes the provider's own session, so it stays on that provider.
          modelFilter: mode == "fork"
            ? { [sourceProvider = target.provider] option in
                workNormalizedChatProvider(option.provider) == workNormalizedChatProvider(sourceProvider)
              }
            : nil,
          onSelect: { option, pickedReasoning, runtimeProvider, pickedFastMode in
            modelId = option.id
            let nextProvider = workNormalizedChatProvider(runtimeProvider)
            if nextProvider != provider {
              provider = nextProvider
              runtimeMode = workDefaultRuntimeMode(provider: nextProvider)
            }
            reasoningEffort = pickedReasoning ?? ""
            fastMode = pickedFastMode
          }
        )
        .environmentObject(syncService)
      }
    }
  }

  // MARK: Cards

  private var machineCard: some View {
    ADEKitCard(title: "Machine") {
      VStack(alignment: .leading, spacing: 8) {
        if options == nil && loadError == nil {
          HStack(spacing: 10) {
            ProgressView().tint(ADEColor.accent)
            Text("Checking your machines…")
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)
          }
        } else if let loadError {
          Text(loadError)
            .font(.caption)
            .foregroundStyle(ADEColor.warning)
          Button("Try again") { Task { await loadOptions() } }
            .font(.caption.weight(.semibold))
        } else if machines.isEmpty {
          Text("No other machine on your account can take this chat.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        } else {
          ForEach(machines) { machine in
            machineRow(machine)
          }
        }
      }
    }
  }

  private func machineRow(_ machine: AgentChatCrossMachineHandoffMachineOption) -> some View {
    let available = machine.unavailableReason == nil
    let selected = selectedMachineKey == machine.machineKey
    return Button {
      guard available else { return }
      selectedMachineKey = machine.machineKey
      cloneConfirmed = false
    } label: {
      HStack(spacing: 10) {
        Circle()
          .fill(machine.online ? ADEColor.success : ADEColor.textMuted.opacity(0.5))
          .frame(width: 8, height: 8)
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text(machine.name)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(available ? ADEColor.textPrimary : ADEColor.textMuted)
          if let reason = machine.unavailableReason {
            Text(reason)
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted)
          } else if machine.hasRepository == false {
            Text("Repository not there yet — ADE can clone it")
              .font(.caption2)
              .foregroundStyle(ADEColor.textSecondary)
          } else {
            Text(machine.online ? "Online" : "Offline")
              .font(.caption2)
              .foregroundStyle(ADEColor.textSecondary)
          }
        }
        Spacer(minLength: 0)
        if selected {
          Image(systemName: "checkmark.circle.fill")
            .foregroundStyle(ADEColor.accent)
        }
      }
      .padding(10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(selected ? ADEColor.accent.opacity(0.10) : ADEColor.surfaceBackground.opacity(0.55))
      )
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(selected ? ADEColor.accent.opacity(0.42) : ADEColor.border.opacity(0.18), lineWidth: selected ? 1.2 : 0.8)
      )
      .opacity(available ? 1 : 0.6)
      .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
    .buttonStyle(.plain)
    .disabled(!available)
    .accessibilityLabel("\(machine.name), \(machine.online ? "online" : "offline")\(machine.unavailableReason.map { ", unavailable: \($0)" } ?? "")")
    .accessibilityAddTraits(selected ? .isSelected : [])
  }

  private var carryCard: some View {
    ADEKitCard(title: "Conversation") {
      VStack(alignment: .leading, spacing: 8) {
        Picker("Conversation", selection: $mode) {
          Text("Brief").tag("brief")
          if forkSupported {
            Text("Fork").tag("fork")
          }
        }
        .pickerStyle(.segmented)
        Text(mode == "fork"
          ? "The full provider session travels; the next agent resumes it."
          : "A written brief travels; a fresh agent picks up from it.")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
        if !forkSupported {
          Text("\(providerLabel(target.provider)) chats move as a brief.")
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
        }
      }
    }
    .onChange(of: mode) { _, newMode in
      // Fork keeps the provider; snap a cross-provider pick back to the source.
      if newMode == "fork", workNormalizedChatProvider(provider) != workNormalizedChatProvider(target.provider) {
        modelId = target.modelId
        provider = target.provider
        reasoningEffort = target.reasoningEffort
        runtimeMode = target.runtimeMode.isEmpty ? workDefaultRuntimeMode(provider: target.provider) : target.runtimeMode
      }
    }
  }

  private var destinationCard: some View {
    ADEKitCard(title: "Next agent") {
      VStack(alignment: .leading, spacing: 10) {
        Button {
          modelPickerPresented = true
        } label: {
          HStack(spacing: 10) {
            Image(systemName: providerIcon(provider))
              .foregroundStyle(providerTint(provider))
            VStack(alignment: .leading, spacing: 2) {
              Text(workKnownModelDisplayName(modelId) ?? prettyWorkChatModelName(modelId))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(ADEColor.textPrimary)
              let detail = [
                reasoningEffort.isEmpty ? nil : workReasoningEffortDisplayName(reasoningEffort),
                fastMode ? "Fast" : nil,
              ].compactMap { $0 }.joined(separator: " · ")
              if !detail.isEmpty {
                Text(detail)
                  .font(.caption2)
                  .foregroundStyle(ADEColor.textSecondary)
              }
            }
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
        .accessibilityLabel("Model, \(workKnownModelDisplayName(modelId) ?? modelId)")

        let runtimeOptions = workRuntimeModeOptions(provider: provider)
        if !runtimeOptions.isEmpty {
          Picker(selection: $runtimeMode) {
            ForEach(runtimeOptions) { option in
              Text(option.title).tag(option.id)
            }
          } label: {
            Label("Access · \(workRuntimeModeLabel(provider: provider, mode: runtimeMode))", systemImage: "lock.shield")
          }
          .pickerStyle(.menu)
          .tint(ADEColor.textPrimary)
        }
      }
    }
  }

  private var noteCard: some View {
    ADEKitCard(title: "Note for the next agent") {
      TextField("Where to pick up (optional)", text: $note, axis: .vertical)
        .lineLimit(2...5)
        .adeInsetField(cornerRadius: 12, padding: 10)
    }
  }

  private func blockerCard(_ blocker: AgentChatCrossMachineHandoffBlocker) -> some View {
    let cleared = blocker.clearedByIncludeChanges && includeChanges
    return VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .top, spacing: 9) {
        Image(systemName: cleared ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
          .foregroundStyle(cleared ? ADEColor.success : ADEColor.warning)
        VStack(alignment: .leading, spacing: 3) {
          Text(blocker.title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(blocker.detail)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 0)
      }
      blockerActions(blocker)
    }
    .adeKitCard(padding: 12)
    .accessibilityElement(children: .contain)
  }

  @ViewBuilder
  private func blockerActions(_ blocker: AgentChatCrossMachineHandoffBlocker) -> some View {
    HStack(spacing: 8) {
      switch blocker.id {
      case "unpushed", "no_upstream":
        blockerButton("Publish branch", key: "push") {
          try await syncService.pushGitForChat(sessionId: target.sessionId, laneId: target.laneId)
        }
      case "behind":
        blockerButton("Update branch", key: "pull") {
          try await syncService.pullGitForChat(sessionId: target.sessionId, laneId: target.laneId)
        }
      default:
        EmptyView()
      }
      if blocker.clearedByIncludeChanges {
        Button {
          includeChanges.toggle()
        } label: {
          Label(includeChanges ? "Bringing them along" : "Bring them along",
                systemImage: includeChanges ? "checkmark" : "shippingbox")
            .font(.caption.weight(.semibold))
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 12)
            .frame(minHeight: 30)
            .background(Capsule(style: .continuous).stroke(ADEColor.accent.opacity(0.5), lineWidth: 0.8))
        }
        .buttonStyle(.plain)
        .foregroundStyle(ADEColor.accent)
        if includeChanges, let changes = options?.changes {
          Text(workCrossMachineHandoffChangesLabel(changes))
            .font(.caption2.weight(.medium))
            .foregroundStyle(ADEColor.textSecondary)
        }
      }
      Spacer(minLength: 0)
    }
    if let hint = blocker.fixHint, !hint.isEmpty, !["unpushed", "no_upstream", "behind"].contains(blocker.id),
       !blocker.clearedByIncludeChanges {
      Text(hint)
        .font(.caption2.monospaced())
        .foregroundStyle(ADEColor.textMuted)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private func blockerButton(_ title: String, key: String, run: @escaping () async throws -> Void) -> some View {
    Button {
      Task { @MainActor in
        busyAction = key
        errorMessage = nil
        do {
          try await run()
          await loadOptions()
        } catch {
          errorMessage = error.localizedDescription
        }
        busyAction = nil
      }
    } label: {
      HStack(spacing: 6) {
        if busyAction == key { ProgressView().controlSize(.mini) }
        Text(title).font(.caption.weight(.semibold)).lineLimit(1).fixedSize()
      }
      .foregroundStyle(Color.white)
      .padding(.horizontal, 12)
      .frame(minHeight: 30)
      .background(Capsule(style: .continuous).fill(ADEColor.accent))
    }
    .buttonStyle(.plain)
    .disabled(busyAction != nil)
  }

  private func cloneCard(_ machine: AgentChatCrossMachineHandoffMachineOption) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Toggle(isOn: $cloneConfirmed) {
        VStack(alignment: .leading, spacing: 2) {
          Text("Clone the repository on \(machine.name)")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text("It isn't there yet. ADE clones it from GitHub before the chat starts.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
      }
      .tint(ADEColor.accent)
    }
    .adeKitCard(padding: 12)
  }

  private var travelsCard: some View {
    ADEKitCard(title: "What travels") {
      VStack(alignment: .leading, spacing: 6) {
        travelLine(ok: true, mode == "fork" ? "The conversation, as a fork" : "The conversation, as a brief")
        if includeChanges, let changes = options?.changes {
          travelLine(ok: true, "Your work: \(workCrossMachineHandoffChangesLabel(changes))")
        } else {
          travelLine(ok: true, "The pushed branch")
        }
        travelLine(ok: false, ".env and ignored files stay here")
      }
    }
  }

  private func travelLine(ok: Bool, _ text: String) -> some View {
    HStack(spacing: 7) {
      Image(systemName: ok ? "checkmark" : "xmark")
        .font(.system(size: 10, weight: .bold))
        .foregroundStyle(ok ? ADEColor.success : ADEColor.textMuted)
        .frame(width: 14)
      Text(text)
        .font(.caption)
        .foregroundStyle(ok ? ADEColor.textPrimary : ADEColor.textSecondary)
    }
  }

  private var primaryButton: some View {
    Button {
      Task { await start() }
    } label: {
      HStack(spacing: 8) {
        if busyAction == "start" { ProgressView().controlSize(.small).tint(.white) }
        Text(primaryLabel)
          .font(.subheadline.weight(.semibold))
      }
      .foregroundStyle(Color.white)
      .frame(maxWidth: .infinity, minHeight: 48)
      .background(
        RoundedRectangle(cornerRadius: 13, style: .continuous)
          .fill(canStart ? ADEColor.accent : ADEColor.textMuted.opacity(0.4))
      )
      .contentShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
    }
    .buttonStyle(.plain)
    .disabled(!canStart)
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
    .background(.ultraThinMaterial)
    .accessibilityIdentifier("work-cross-machine-handoff-start")
  }

  // MARK: Calls

  private func loadOptions() async {
    if let previewOptions {
      options = previewOptions
      if selectedMachineKey == nil {
        selectedMachineKey = previewOptions.machines.first { $0.unavailableReason == nil }?.machineKey
      }
      return
    }
    loadError = nil
    do {
      let next = try await syncService.crossMachineHandoffOptions(sourceSessionId: target.sessionId)
      options = next
      if selectedMachineKey == nil || !next.machines.contains(where: { $0.machineKey == selectedMachineKey && $0.unavailableReason == nil }) {
        selectedMachineKey = next.machines.first { $0.unavailableReason == nil }?.machineKey
      }
      if let changes = next.changes, changes.unpushedCommits + changes.changedFiles == 0 {
        includeChanges = false
      }
    } catch {
      loadError = error.localizedDescription
    }
  }

  private func start() async {
    guard canStart, let machine = selectedMachine else { return }
    busyAction = "start"
    errorMessage = nil
    var args: [String: Any] = [
      "machine": machine.machineKey,
      "mode": mode,
      "targetModelId": modelId,
    ]
    if !reasoningEffort.isEmpty { args["reasoningEffort"] = reasoningEffort }
    if fastMode { args["fastMode"] = true }
    let wire = workRuntimeWireFields(provider: provider, mode: runtimeMode)
    if let v = wire.permissionMode { args["permissionMode"] = v }
    if let v = wire.claudePermissionMode { args["claudePermissionMode"] = v }
    if let v = wire.codexApprovalPolicy { args["codexApprovalPolicy"] = v }
    if let v = wire.codexSandbox { args["codexSandbox"] = v }
    if let v = wire.codexConfigSource { args["codexConfigSource"] = v }
    if let v = wire.opencodePermissionMode { args["opencodePermissionMode"] = v }
    if let v = wire.droidPermissionMode { args["droidPermissionMode"] = v }
    if let v = wire.cursorModeId { args["cursorModeId"] = v }
    let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmedNote.isEmpty { args["continuationPrompt"] = trimmedNote }
    if includeChanges { args["includeChanges"] = true }
    if needsClone && cloneConfirmed { args["clone"] = true }
    if busy { args["whenTurnEnds"] = true }
    do {
      try await syncService.startCrossMachineHandoff(sourceSessionId: target.sessionId, args: args)
      ADEHaptics.success()
      busyAction = nil
      dismiss()
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
      busyAction = nil
    }
  }
}

func workCrossMachineHandoffChangesLabel(_ changes: AgentChatCrossMachineHandoffChanges) -> String {
  let commits = "+\(changes.unpushedCommits) commit\(changes.unpushedCommits == 1 ? "" : "s")"
  let files = "\(changes.changedFiles) file\(changes.changedFiles == 1 ? "" : "s")"
  return "\(commits), \(files)"
}

// MARK: - Send gate (where new messages go)

enum WorkHandoffSendDecision: Equatable {
  /// Keep working here: records `resumedHere`, then sends here.
  case workHere
  /// Take the message to the chat on the other machine.
  case continueThere
  case cancel
}

/// Suspends one send until the user answers the "continues on <machine>"
/// question. One question at a time; a second send while it is open is
/// refused rather than queued behind it.
@MainActor
final class WorkHandoffSendGate: ObservableObject {
  struct Prompt: Equatable {
    let machine: String
    let branch: String?
  }

  @Published private(set) var prompt: Prompt?
  private var continuation: CheckedContinuation<WorkHandoffSendDecision, Never>?

  func ask(machine: String, branch: String?) async -> WorkHandoffSendDecision {
    guard continuation == nil else { return .cancel }
    return await withCheckedContinuation { continuation in
      self.continuation = continuation
      self.prompt = Prompt(machine: machine, branch: branch?.isEmpty == false ? branch : nil)
    }
  }

  func answer(_ decision: WorkHandoffSendDecision) {
    guard let continuation else { return }
    self.continuation = nil
    prompt = nil
    continuation.resume(returning: decision)
  }
}
