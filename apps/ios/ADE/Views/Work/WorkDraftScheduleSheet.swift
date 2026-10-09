import SwiftUI

/// A lane a scheduled send may start a new chat in, reduced to the id the
/// target machine understands (a remote machine's lane id comes back namespaced
/// and is stripped here).
struct WorkDraftLaneOption: Identifiable, Equatable {
  let id: String
  let name: String
}

/// The lanes the chosen machine would start a new chat in. The focused machine
/// reads its replicated lanes; another machine is asked directly, so the lane
/// ids that come back are remapped to the raw ids its own scheduler understands.
@MainActor
func workDraftLaneOptions(syncService: SyncService, machineKey: String?) async throws -> [WorkDraftLaneOption] {
  guard let machineKey else {
    return try await syncService.fetchLanes().map { WorkDraftLaneOption(id: $0.id, name: $0.name) }
  }
  let repo = try syncService.requireRemoteLaneRepo(machineKey: machineKey)
  let snapshots = try await syncService.fetchRemoteLaneSnapshots(repo: repo, timeoutNanoseconds: 8_000_000_000)
  return snapshots.map { snapshot in
    let rawId = workParseRemoteLaneId(snapshot.lane.id)?.laneId ?? snapshot.lane.id
    return WorkDraftLaneOption(id: rawId, name: snapshot.lane.name)
  }
}

/// The key a scheduled send names for the machine that will deliver it. The
/// delivering desktop compares this with its own relay machine key, which the
/// account directory publishes; a signed-out pairing with no directory row
/// falls back to the fleet key it already routes commands with.
@MainActor
func workDraftTargetMachineKey(fleetKey: String?, syncService: SyncService) -> String? {
  let resolved = fleetKey ?? syncService.focusedMachineKey
  guard let resolved else { return nil }
  return AccountService.shared.machine(forFleetKey: resolved)?.machineKey ?? resolved
}

/// ISO-8601 with an explicit offset, which is what the desktop's schedule
/// parser requires. The offset is the phone's, so the fire time is the instant
/// the user picked, not a wall-clock string a machine has to guess a zone for.
func workDraftFireTime(_ date: Date) -> String {
  workDraftFireTimeFormatter.string(from: date)
}

private let workDraftFireTimeFormatter: DateFormatter = {
  let formatter = DateFormatter()
  formatter.locale = Locale(identifier: "en_US_POSIX")
  formatter.timeZone = TimeZone.current
  formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ssZZZZZ"
  return formatter
}()

/// "9:00 AM" for the summary caption under the picker.
private let workDraftScheduleClockFormatter: DateFormatter = {
  let formatter = DateFormatter()
  formatter.dateFormat = "h:mm a"
  formatter.amSymbol = "AM"
  formatter.pmSymbol = "PM"
  return formatter
}()

/// The half-sheet behind "Schedule send…": where it goes, when it fires, what
/// happens if the machine is late, and the config it will run under. Every
/// choice is explicit — the sheet never guesses a chat or a lane.
struct WorkDraftScheduleSheet: View {
  @EnvironmentObject private var syncService: SyncService
  @EnvironmentObject private var machineFleet: MachineFleet
  @Environment(\.dismiss) private var dismiss

  let scope: WorkDraftScope
  let text: String
  let attachments: [WorkChatInputAttachment]
  let provider: String?
  let modelId: String?
  let runtimeMode: String
  let onScheduled: (DraftEntry) -> Void

  /// The fleet key of the machine the send targets; nil is the machine being
  /// viewed (the primary), which is the default.
  @State private var selectedMachineKey: String?
  /// True while "This chat" is the target. Only available when the composer
  /// names a chat and the target is the machine being viewed.
  @State private var targetsExistingChat: Bool
  @State private var selectedLaneId: String = ""
  @State private var fireDate: Date
  @State private var policy: DraftDeliveryPolicy = .wait
  @State private var graceMinutes: Int = 15
  @State private var laneOptions: [WorkDraftLaneOption] = []
  @State private var lanesLoading = false
  @State private var lanesError: String?
  @State private var busy = false
  @State private var errorMessage: String?

  init(
    scope: WorkDraftScope,
    text: String,
    attachments: [WorkChatInputAttachment],
    provider: String?,
    modelId: String?,
    runtimeMode: String,
    onScheduled: @escaping (DraftEntry) -> Void
  ) {
    self.scope = scope
    self.text = text
    self.attachments = attachments
    self.provider = provider
    self.modelId = modelId
    self.runtimeMode = runtimeMode
    self.onScheduled = onScheduled
    _targetsExistingChat = State(initialValue: !(scope.chatSessionId ?? "").isEmpty)
    // A round hour out, seconds zeroed: a sensible, obviously-editable default.
    let base = Date().addingTimeInterval(60 * 60)
    _fireDate = State(initialValue: Date(timeIntervalSince1970: (base.timeIntervalSince1970 / 60).rounded(.up) * 60))
  }

  private var machineOptions: [WorkNewChatMachineOption] {
    workNewChatMachineOptions(syncService: syncService, fleet: machineFleet)
  }

  private var selectedMachineOption: WorkNewChatMachineOption {
    let options = machineOptions
    return options.first { $0.machineKey == selectedMachineKey } ?? options[0]
  }

  /// "This chat" is only a target while the send is aimed at the machine being
  /// viewed — the chat lives there, and a send cannot cross machines.
  private var canTargetExistingChat: Bool {
    selectedMachineKey == nil && !(scope.chatSessionId ?? "").isEmpty
  }

  private var normalizedProvider: String? {
    let value = provider?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return value.isEmpty ? nil : value
  }

  private var normalizedModelId: String? {
    let value = modelId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return value.isEmpty ? nil : value
  }

  private var permissionMode: String? {
    guard let provider = normalizedProvider else { return nil }
    let value = workCliPermissionMode(provider: provider, runtimeMode: runtimeMode)
    return (value?.isEmpty == false) ? value : nil
  }

  private var summaryModelLabel: String {
    guard let modelId = normalizedModelId else { return "Default model" }
    return WorkModelMentionDirectory.shared.entry(for: modelId)?.title ?? modelId
  }

  private var summaryPermissionLabel: String {
    guard let provider = normalizedProvider, !runtimeMode.isEmpty else { return "Default access" }
    return workRuntimeModeLabel(provider: provider, mode: runtimeMode)
  }

  private var permissionElevated: Bool {
    workDraftPermissionIsElevated(provider: normalizedProvider ?? "", runtimeMode: runtimeMode)
  }

  private var attachmentsReady: Bool {
    !workChatInputHasLoadingAttachments(attachments)
      && workComposerHasDraftableContent(text: text, attachments: attachments)
  }

  var body: some View {
    NavigationStack {
      List {
        sendToSection
        whenSection
        lateSection
        summarySection
      }
      .listStyle(.insetGrouped)
      .navigationTitle("Schedule send")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
      }
      .safeAreaInset(edge: .bottom) {
        VStack(spacing: 8) {
          if let errorMessage {
            Text(errorMessage)
              .font(.caption)
              .foregroundStyle(ADEColor.danger)
              .multilineTextAlignment(.center)
          }
          Button {
            Task { await submit() }
          } label: {
            HStack(spacing: 8) {
              if busy { ProgressView().controlSize(.small) }
              Text(busy ? "Scheduling…" : "Schedule")
                .font(.system(size: 16, weight: .semibold))
            }
            .frame(maxWidth: .infinity)
            .frame(height: 48)
          }
          .buttonStyle(.borderedProminent)
          .disabled(busy || !attachmentsReady)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial)
      }
      .task { await loadLanes() }
      .onChange(of: selectedMachineKey) { _, _ in
        if selectedMachineKey != nil { targetsExistingChat = false }
        selectedLaneId = ""
        laneOptions = []
        Task { await loadLanes() }
      }
      .onChange(of: targetsExistingChat) { _, _ in
        Task { await loadLanes() }
      }
    }
    .presentationDetents([.medium, .large])
  }

  // MARK: - Sections

  @ViewBuilder
  private var sendToSection: some View {
    Section("Send to") {
      if canTargetExistingChat {
        Picker("Target", selection: $targetsExistingChat) {
          Text("This chat").tag(true)
          Text("New chat…").tag(false)
        }
        .pickerStyle(.menu)
      }
      if !canTargetExistingChat || !targetsExistingChat {
        lanePicker
      }

      // Which paired machine the send belongs to. Its local clock is the one
      // the fire time is stated in, and only it will deliver the send.
      WorkNewChatMachineDropdown(
        options: machineOptions,
        selected: selectedMachineOption,
        onSelect: { selectedMachineKey = $0.machineKey }
      )
      .frame(maxWidth: .infinity, alignment: .leading)
      .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
    }
  }

  @ViewBuilder
  private var lanePicker: some View {
    if lanesLoading {
      HStack(spacing: 8) {
        ProgressView().controlSize(.small)
        Text("Loading lanes…").font(.caption).foregroundStyle(ADEColor.textMuted)
      }
    } else if let lanesError {
      Text(lanesError)
        .font(.caption)
        .foregroundStyle(ADEColor.danger)
    } else if laneOptions.isEmpty {
      Text("This machine lists no lanes for this project.")
        .font(.caption)
        .foregroundStyle(ADEColor.textMuted)
    } else {
      Picker("Lane", selection: $selectedLaneId) {
        Text("Pick a lane").tag("")
        ForEach(laneOptions) { option in
          Text(option.name).tag(option.id)
        }
      }
      .pickerStyle(.menu)
    }
  }

  private var whenSection: some View {
    Section {
      DatePicker(
        "Fire time",
        selection: $fireDate,
        displayedComponents: [.date, .hourAndMinute]
      )
    } header: {
      Text("When")
    } footer: {
      // The fire time is stated in the target machine's local clock, so the
      // user can see which machine they are anchoring it to.
      Text("\(workDraftScheduleClockFormatter.string(from: fireDate)) on \(selectedMachineOption.name)")
    }
  }

  private var lateSection: some View {
    Section {
      Picker("If late", selection: $policy) {
        ForEach(DraftDeliveryPolicy.allCases) { option in
          Text(option.title).tag(option)
        }
      }
      .pickerStyle(.segmented)
      if policy == .grace {
        Picker("Grace window", selection: $graceMinutes) {
          ForEach([5, 15, 30, 60, 120], id: \.self) { minutes in
            Text(minutes >= 60 ? "\(minutes / 60) hour\(minutes >= 120 ? "s" : "")" : "\(minutes) minutes")
              .tag(minutes)
          }
        }
        .pickerStyle(.menu)
      }
    } header: {
      Text("If late")
    } footer: {
      Text(policy.detail)
    }
  }

  private var summarySection: some View {
    Section("Runs as") {
      HStack(spacing: 8) {
        Text((normalizedProvider?.capitalized ?? "Default") + " · " + summaryModelLabel + " · " + summaryPermissionLabel)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(2)
        Spacer(minLength: 0)
        if permissionElevated {
          Label("Elevated", systemImage: "exclamationmark.triangle.fill")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(ADEColor.warning)
            .labelStyle(.titleAndIcon)
        }
      }
    }
  }

  // MARK: - Data

  @MainActor
  private func loadLanes() async {
    if canTargetExistingChat && targetsExistingChat {
      laneOptions = []
      lanesError = nil
      lanesLoading = false
      return
    }
    lanesLoading = true
    lanesError = nil
    defer { lanesLoading = false }
    do {
      let loaded = try await workDraftLaneOptions(syncService: syncService, machineKey: selectedMachineKey)
      guard !Task.isCancelled else { return }
      laneOptions = loaded
      if !loaded.contains(where: { $0.id == selectedLaneId }) {
        selectedLaneId = loaded.first?.id ?? ""
      }
    } catch {
      guard !Task.isCancelled else { return }
      laneOptions = []
      lanesError = error.localizedDescription
    }
  }

  // MARK: - Submit

  @MainActor
  private func submit() async {
    guard !busy else { return }
    errorMessage = nil

    let targetKind: DraftTargetKind = (canTargetExistingChat && targetsExistingChat) ? .existing : .new
    var targetSessionId: String?
    var targetLaneId: String?
    if targetKind == .existing {
      let sessionId = scope.chatSessionId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      guard !sessionId.isEmpty else {
        errorMessage = "Choose the chat this send should go to."
        return
      }
      targetSessionId = sessionId
    } else {
      let laneId = selectedLaneId.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !laneId.isEmpty else {
        errorMessage = "Choose the lane a new chat should start in."
        return
      }
      targetLaneId = laneId
    }

    guard fireDate.timeIntervalSinceNow > 0 else {
      errorMessage = "Pick a time in the future."
      return
    }

    busy = true
    defer { busy = false }
    do {
      let refs = try await workChatSaveInputAttachments(
        workChatInputReadyAttachments(attachments),
        syncService: syncService,
        chatSessionId: scope.chatSessionId,
        targetProjectId: scope.projectId,
        targetProjectRootPath: scope.projectRootPath
      )
      let schedule = DraftScheduleInput(
        scheduledAt: workDraftFireTime(fireDate),
        targetKind: targetKind,
        targetSessionId: targetSessionId,
        targetLaneId: targetLaneId,
        targetMachineKey: workDraftTargetMachineKey(fleetKey: selectedMachineKey, syncService: syncService),
        deliveryPolicy: policy,
        graceSeconds: policy == .grace ? graceMinutes * 60 : nil,
        provider: normalizedProvider,
        modelId: normalizedModelId,
        permissionMode: permissionMode,
        scheduledBy: .user
      )
      let created: DraftEntry
      if let chatSessionId = scope.chatSessionId?.trimmingCharacters(in: .whitespacesAndNewlines),
         !chatSessionId.isEmpty {
        created = try await syncService.createDraftForChat(
          sessionId: chatSessionId,
          text: text,
          attachments: refs,
          provider: normalizedProvider,
          modelId: normalizedModelId,
          schedule: schedule
        )
      } else {
        created = try await syncService.createDraft(
          text: text,
          attachments: refs,
          provider: normalizedProvider,
          modelId: normalizedModelId,
          originSessionId: scope.chatSessionId,
          schedule: schedule,
          targetProjectId: scope.projectId,
          targetProjectRootPath: scope.projectRootPath
        )
      }
      onScheduled(created)
      dismiss()
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}
