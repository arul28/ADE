import SwiftUI

// The hub's bottom "type to vibecode" composer. The box pinned to the bottom of
// the hub IS the real composer — focusing it raises the keyboard and expands
// the full new-chat controls in place (Project ▸ Lane destination, Chat/CLI
// switch, model/mode/dictation row) directly above the keyboard, mirroring the
// in-project new-chat composer (`WorkNewChatScreen`). Collapsing the keyboard
// hides the controls but keeps the draft text and every setting; send works
// from the minimized box too. On send it creates the chat IN THE CHOSEN
// PROJECT IN PLACE (no active-project switch), reports the created chat back
// through `onCreated`, and collapses. The hub surfaces a toast; it does NOT
// navigate into the chat.
//
// The picker also lists the projects of the other live machines. Sending to
// one of those makes its machine primary first (the old primary stays
// connected), then creates the chat there the same way. The draft stays in the
// box until the switch succeeds, and the hub keeps the composer on screen
// while it runs (`onMachineSwitch`), so a failed switch shows its error here.

// MARK: - Public surface (the hub depends on these names)

/// A chat created from the hub composer, handed back to the hub via `onCreated`
/// after a successful create (the composer has already collapsed by then).
struct HubCreatedChat: Equatable {
  let projectId: String
  let projectRootPath: String?
  let projectName: String
  let laneName: String
  let sessionId: String
  let isCli: Bool
  /// Provider the session was created with (e.g. "claude", "cursor").
  let provider: String?

  /// Tool type for the toast's Open-shortcut stub. A CLI session must never
  /// read as a chat (the cross-project chat quick-look renders blank for it);
  /// a chat keeps its provider-derived chat tool type so quick-look applies.
  var stubToolType: String {
    if isCli { return "cli" }
    let normalized = provider?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    if normalized.isEmpty { return "claude-chat" }
    return normalized == "cursor" ? "cursor" : "\(normalized)-chat"
  }
}

// MARK: - Inline composer

/// The one animation every hub-composer expand/collapse rides on — shared with
/// HubScreen so a tap-outside collapse moves identically to a focus expand.
let hubComposerSpring = Animation.spring(response: 0.34, dampingFraction: 0.86)

struct HubInlineComposer: View {
  /// The space the composer leaves under its box, for a layout that lines
  /// the box up with something else (`duoEdgeBarAlignedBottom`).
  static let bottomPadding: CGFloat = 8

  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  /// The account list: a project removed from ADE leaves the destination.
  @ObservedObject private var accountProjects = AccountProjectStore.shared
  /// ADE Cloud's launches and model catalog: a chat on ADE Cloud starts
  /// through the account server, with no computer of its own linked yet.
  @ObservedObject private var cloudLaunches = AccountCloudLaunchStore.shared
  @ObservedObject private var cloudStore = AccountCloudStore.shared
  private var syncService: SyncService { syncPublishes.service }
  @EnvironmentObject private var machineFleet: MachineFleet

  /// Owned by the hub so taps on the list behind the composer can collapse it.
  @Binding var expanded: Bool
  let onCreated: (HubCreatedChat) -> Void
  /// True while a send is switching the primary machine. The hub keeps the
  /// composer mounted meanwhile, though the primary is not connected.
  var onMachineSwitch: (Bool) -> Void = { _ in }

  // Composer selection (seeded from the app-wide "last used" record in init so
  // the provider/model onChange handlers don't reset runtimeMode on first
  // layout — same gotcha the in-project new-chat screen guards against).
  @State private var provider: String = "claude"
  @State private var modelId: String = "claude-sonnet-5"
  @State private var runtimeMode: String = "default"
  @State private var reasoningEffort: String = ""
  @State private var codexFastMode: Bool = false
  @State private var sessionMode: WorkNewSessionMode = .chat
  /// The catalog option the picker handed us, kept so fast-tier support is read
  /// from the live host-advertised model rather than re-derived from the
  /// curated iOS catalog (which can miss a freshly advertised fast model).
  @State private var selectedModelOption: WorkModelOption?

  // Destination (Project ▸ Lane). `selectedLaneId` is a real lane id or the
  // auto-create sentinel; both are resolved against the TARGET project on send.
  @State private var pickedProjectId: String = ""
  @State private var selectedLaneId: String = ""
  /// The machine of the picked project when it is not the primary one.
  @State private var pickedMachineKey: String?
  /// A send to another machine is switching the primary and then sending:
  /// the roster refreshes this causes must not reset the chosen destination.
  @State private var holdsDestination = false

  // UI / flow.
  @State private var draft: String = ""
  @State private var attachments: [WorkChatInputAttachment] = []
  @State private var composerTextHeight: CGFloat = 28
  @State private var busy: Bool = false
  @State private var errorMessage: String?
  @State private var modelPickerPresented = false
  @State private var destinationPickerPresented = false
  /// The picker opens as a sheet when the popover has no room above.
  @State private var destinationPickerAsSheet = false
  @State private var presentedPicker: WorkComposerPicker?
  @State private var isDictating = false
  // Global top edge of the destination control, so the picker popover can size
  // itself to the room above it (and never overflow the top of the screen).
  @State private var destinationControlTopY: CGFloat = 0
  @State private var composerFocused: Bool = false
  @StateObject private var dictationCoordinator = DictationInsertionCoordinator()

  private let dictationTargetId = "hub-new-chat-drawer"

  init(
    expanded: Binding<Bool>,
    onCreated: @escaping (HubCreatedChat) -> Void,
    onMachineSwitch: @escaping (Bool) -> Void = { _ in }
  ) {
    self._expanded = expanded
    self.onCreated = onCreated
    self.onMachineSwitch = onMachineSwitch
    var restoredProvider = "claude"
    var restoredModelId = "claude-sonnet-5"
    if let saved = WorkComposerPreferences.load() {
      restoredProvider = saved.provider
      restoredModelId = saved.modelId
      _provider = State(initialValue: saved.provider)
      _modelId = State(initialValue: saved.modelId)
      _runtimeMode = State(initialValue: saved.runtimeMode)
      _reasoningEffort = State(initialValue: saved.reasoningEffort)
      _codexFastMode = State(initialValue: saved.codexFastMode)
    }
    var restoredProjectId = ""
    let live = HubComposerLiveSelection.shared
    if let projectId = live.projectId {
      // Built again for another pose: the pick made a moment ago stays.
      restoredProjectId = projectId
      _pickedProjectId = State(initialValue: projectId)
      _selectedLaneId = State(initialValue: live.laneId)
      _pickedMachineKey = State(initialValue: live.machineKey)
      _destinationPickerPresented = State(initialValue: live.pickerOpen)
    } else if let dest = HubInlineComposer.loadLastDestination() {
      restoredProjectId = dest.projectId
      _pickedProjectId = State(initialValue: dest.projectId)
      _selectedLaneId = State(initialValue: dest.laneId)
    }
    // Restore the last explicitly chosen Chat/CLI interface for the restored
    // destination project (shared per-project store with the in-project New Chat
    // screen), honoring a stored CLI choice only when the restored model can run
    // in CLI — otherwise open on chat without discarding the preference. Seeding
    // the initial @State here keeps the sessionMode onChange from resetting
    // runtimeMode to the provider default. Switching the destination project
    // only updates the destination lane; the independent composer settings stay
    // untouched until the user changes them.
    _sessionMode = State(initialValue: WorkNewSessionModePreferences.resolvedMode(
      stored: WorkNewSessionModePreferences.load(projectId: restoredProjectId),
      modelId: restoredModelId,
      provider: restoredProvider
    ))
  }

  // MARK: Derived state

  /// Expanded while the user is composing, dictating, or inside one of the
  /// pickers (presenting a sheet/popover can resign the text field's focus —
  /// the panel must not collapse underneath it). `expanded` is explicit state
  /// (not derived from focus) so every change happens inside a spring
  /// transaction instead of snapping with the focus flip.
  private var isExpanded: Bool {
    expanded || isDictating || modelPickerPresented || destinationPickerPresented || presentedPicker != nil
  }

  /// Collapses the panel, keeping the draft text and all settings.
  private func collapse() {
    composerFocused = false
    withAnimation(hubComposerSpring) { expanded = false }
  }

  private var composerSelection: WorkComposerPreferences.Selection {
    WorkComposerPreferences.Selection(
      provider: provider,
      modelId: modelId,
      runtimeMode: runtimeMode,
      reasoningEffort: reasoningEffort,
      codexFastMode: codexFastMode
    )
  }

  private var pickedProject: MobileProjectSummary? {
    if pickedAccountCloud { return accountCloudProject.map(hubAccountCloudSummary) }
    if pickedMachineKey != nil { return pickedRemoteProject?.asRemoteMachineProjectSummary }
    return syncService.projects.first { $0.id == pickedProjectId }
  }

  private var pickedRemoteMachine: MachineFleet.Machine? {
    pickedMachineKey.flatMap { machineFleet.machine(for: $0) }
  }

  private var pickedRemoteProject: RemoteRosterProject? {
    pickedRemoteMachine?.projects.first { $0.projectId == pickedProjectId }
  }

  private var lanesForPickedProject: [RemoteRosterLane] {
    lanes(forProjectId: pickedProjectId)
  }

  private var isAutoCreateLane: Bool {
    selectedLaneId == workAutoCreateLaneSentinelId
  }

  private var selectedLaneName: String {
    if isAutoCreateLane { return pickedAccountCloud ? "New lane on ADE Cloud" : "Auto-create lane" }
    if let lane = lanesForPickedProject.first(where: { $0.id == selectedLaneId }) {
      return lane.displayName
    }
    return selectedLaneId.isEmpty ? "Select lane" : selectedLaneId
  }

  private var selectedLaneTint: Color {
    guard let lane = lanesForPickedProject.first(where: { $0.id == selectedLaneId }) else {
      return ADEColor.textMuted
    }
    return LaneColorPalette.displayColor(forHex: lane.color)
  }

  private var selectedLaneEmoji: String? {
    lanesForPickedProject.first(where: { $0.id == selectedLaneId })?.emoji
  }

  /// Fast mode only applies to in-app chat sessions on fast-tier models. The
  /// picker owns the control, but launch still gates the submitted value on the
  /// resolved session interface and model support.
  private var fastModeSupported: Bool {
    guard sessionMode == .chat else { return false }
    if let option = selectedModelOption,
       workModelIdsEquivalent(option.id, modelId),
       option.supportsServiceTier("fast") {
      return true
    }
    return workComposerSupportsFastMode(modelId: modelId, provider: provider)
  }

  private var canStart: Bool {
    !busy
      && !pickedProjectId.isEmpty
      && (isAutoCreateLane || !selectedLaneId.isEmpty)
      && !modelId.isEmpty
  }

  private var attachmentsAvailable: Bool {
    syncService.supportsViewerRemoteAction("chat.saveTempAttachment")
  }

  private var canUploadAttachments: Bool {
    // Another machine's project: that machine is checked once it is primary.
    if pickedMachineKey != nil { return true }
    return attachmentsAvailable
      && syncService.connectionState == .connected
  }

  private var canSend: Bool {
    workChatInputCanSend(
      text: draft,
      attachments: attachments,
      baseEnabled: canStart,
      canUploadAttachments: canUploadAttachments
    )
  }

  // MARK: Body

  var body: some View {
    VStack(spacing: 12) {
      if isExpanded {
        destinationControl
          .transition(.move(edge: .bottom).combined(with: .opacity))
        if !isDictating {
          WorkSessionTypeSwitcher(selection: $sessionMode, onUserSelect: { mode in
            WorkNewSessionModePreferences.save(mode, projectId: pickedProjectId)
          })
            .frame(maxWidth: .infinity, alignment: .center)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
      }
      if let errorMessage {
        HStack(spacing: 8) {
          Image(systemName: "exclamationmark.triangle.fill")
            .font(.caption)
            .foregroundStyle(ADEColor.danger)
          Text(errorMessage)
            .font(.caption)
            .foregroundStyle(ADEColor.danger)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(10)
        .background(ADEColor.danger.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      }
      composerCard
    }
    .padding(.horizontal, 16)
    .padding(.top, isExpanded ? 12 : 0)
    .padding(.bottom, Self.bottomPadding)
    .workChatAttachmentPicker(
      isPresented: $presentedPicker.isPresenting(.photos),
      attachments: $attachments,
      onDismiss: { composerFocused = true }
    )
    .animation(hubComposerSpring, value: isExpanded)
    .animation(.easeOut(duration: 0.16), value: errorMessage != nil)
    // Dragging down anywhere on the panel collapses it (the keyboard follows
    // via the focus reset in collapse()).
    .gesture(
      DragGesture(minimumDistance: 16)
        .onEnded { value in
          if isExpanded && value.translation.height > 24 { collapse() }
        }
    )
    .onAppear { onAppearSetup() }
    .workPersistedDraft($draft, key: WorkComposerDraftStore.hubNewChatKey)
    .workPersistedDraftAttachments($attachments, key: WorkComposerDraftStore.hubNewChatKey)
    .workChatFileAttachmentPickers(
      presentedPicker: $presentedPicker,
      attachments: $attachments,
      onDismiss: { composerFocused = true }
    )
    .onChange(of: composerFocused) { _, focused in
      if focused { withAnimation(hubComposerSpring) { expanded = true } }
    }
    .onChange(of: expanded) { _, nowExpanded in
      // The hub collapses us from the outside (tap on the list) by flipping the
      // binding — drop focus so the keyboard goes down with the panel.
      if !nowExpanded { composerFocused = false }
    }
    // The keyboard can disappear while the panel is open (interactive scroll
    // dismissal). Never leave the panel expanded once the field lost focus —
    // unless a picker or dictation legitimately owns the screen. A field that
    // keeps focus means a hardware keyboard took over (iPad, a paired keyboard,
    // the simulator): its software keyboard "hides" the moment it shows, and
    // collapsing then made the composer impossible to open. The hub's tap
    // outside still collapses it.
    .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
      guard expanded,
            !modelPickerPresented,
            !destinationPickerPresented,
            presentedPicker == nil,
            !isDictating else { return }
      // The text view reports a resign in `textViewDidEndEditing`, which can
      // land just after this notification; read focus on the next turn.
      DispatchQueue.main.async {
        guard expanded, !composerFocused else { return }
        collapse()
      }
    }
    .onChange(of: composerSelection) { _, newValue in
      WorkComposerPreferences.save(newValue)
    }
    // A pose change builds this composer again in another layout; these keep
    // the destination and an open picker across it.
    .onChange(of: pickedProjectId) { _, _ in rememberLiveSelection() }
    .onChange(of: selectedLaneId) { _, _ in rememberLiveSelection() }
    .onChange(of: pickedMachineKey) { _, _ in
      rememberLiveSelection()
      // ADE Cloud runs its own models: switch to one it runs when picked.
      if pickedAccountCloud {
        Task {
          await cloudLaunches.loadCatalogIfNeeded(using: syncService)
          pickCloudModelIfNeeded()
        }
      }
    }
    .onChange(of: destinationPickerPresented) { _, _ in rememberLiveSelection() }
    // Projects/lanes can appear or vanish while the hub sits open (reconnects,
    // roster refreshes) — keep the persisted destination honest against them.
    .onChange(of: syncService.rosterRevision) { _, _ in reconcileDestination() }
    .onChange(of: syncService.projects.map(\.id)) { _, _ in reconcileDestination() }
    .onChange(of: machineFleet.machines) { _, _ in reconcileDestination() }
    .onChange(of: accountProjects.removedProjects.map(\.id)) { _, _ in reconcileDestination() }
    .sheet(isPresented: $modelPickerPresented, onDismiss: { composerFocused = true }) {
      WorkModelPickerSheet(
        currentModelId: modelId,
        currentProvider: provider,
        currentReasoningEffort: reasoningEffort,
        currentCodexFastMode: codexFastMode,
        cursorAvailabilityMode: sessionMode == .cli ? .cli : .chat,
        lanes: lanesForPickedProject.map { $0.asLaneSummary() },
        isBusy: false,
        // ADE Cloud lists its own models, never the connected machine's.
        cloudCatalog: pickedAccountCloud ? (cloudLaunches.catalog ?? .pending) : nil,
        onSelect: { option, pickedReasoning, runtimeProvider, pickedFastMode in
          selectedModelOption = option
          modelId = option.id
          provider = sessionMode == .chat
            ? hubNormalizedChatProvider(runtimeProvider)
            : workResolveCliProvider(for: option.id, provider: runtimeProvider)
          let nextReasoning = pickedReasoning ?? ""
          if nextReasoning != reasoningEffort { reasoningEffort = nextReasoning }
          if pickedFastMode != codexFastMode { codexFastMode = pickedFastMode }
        }
      )
      .environmentObject(syncService)
    }
  }

  // MARK: Combined destination control (Project ▸ Lane)

  private var destinationControl: some View {
    Button {
      // With the keyboard up on a short screen (a Duo held open, landscape)
      // the room above the control is less than the picker's smallest height,
      // and a popover there opened its Project section above the top edge.
      // A sheet holds the same picker then.
      destinationPickerAsSheet = destinationControlTopY > 0
        && destinationControlTopY - 64 < Self.destinationPickerMinHeight
      destinationPickerPresented = true
    } label: {
      HStack(spacing: 7) {
        HubProjectIcon(iconDataUrl: pickedProject?.iconDataUrl, isActive: false, size: 18)

        Text(hubComposerDestinationTitle(
          projectName: pickedAccountProject?.name ?? pickedProject?.displayName,
          machineName: pickedAccountCloud ? ADECloudMachine.name : pickedRemoteMachine?.name
        ))
          .font(.system(size: 13.5, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)

        Image(systemName: "chevron.right")
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)

        laneTag

        Spacer(minLength: 4)

        Image(systemName: "chevron.up.chevron.down")
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(.horizontal, 12)
      .frame(minHeight: 36)
      // Floats over the list behind the scrim, so it sits on the solid kit
      // surface rather than a translucent track.
      .adeKitPill()
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    // Measured directly: the preference this used did not reach this view in
    // every layout (it read 0 in the Duo's open pose), so the picker fell
    // back to a fixed height taller than the room above it.
    .onGeometryChange(for: CGFloat.self, of: { $0.frame(in: .global).minY }) { top in
      destinationControlTopY = top
    }
    // Fixed while a send runs: it switches machines to reach this destination.
    .disabled(busy)
    .accessibilityLabel("Destination")
    .accessibilityValue("\(pickedProject?.displayName ?? "No project"), \(selectedLaneName)")
    .accessibilityHint("Choose the project and lane for this chat.")
    .popover(
      isPresented: Binding(
        get: { destinationPickerPresented && !destinationPickerAsSheet },
        set: { destinationPickerPresented = $0 }
      ),
      attachmentAnchor: .rect(.bounds),
      arrowEdge: .bottom
    ) {
      destinationPicker
        .frame(width: 320, height: destinationPickerHeight)
        .presentationCompactAdaptation(.popover)
    }
    .sheet(
      isPresented: Binding(
        get: { destinationPickerPresented && destinationPickerAsSheet },
        set: { destinationPickerPresented = $0 }
      )
    ) {
      destinationPicker
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
    .onChange(of: destinationPickerPresented) { _, presented in
      // Presenting the popover can resign the text field; bring the keyboard
      // back when it closes so the flow stays continuous.
      if !presented { composerFocused = true }
    }
  }

  @ViewBuilder
  private var laneTag: some View {
    if isAutoCreateLane {
      HStack(spacing: 4) {
        Image(systemName: "sparkles")
          .font(.system(size: 10, weight: .semibold))
        Text(pickedAccountCloud ? "New lane" : "Auto-create lane")
          .font(.system(size: 12.5, weight: .medium))
          .lineLimit(1)
      }
      .foregroundStyle(ADEColor.textSecondary)
    } else {
      HStack(spacing: 5) {
        if let selectedLaneEmoji, !selectedLaneEmoji.isEmpty {
          Text(selectedLaneEmoji)
            .font(.system(size: 11))
        } else {
          Circle().fill(selectedLaneTint).frame(width: 7, height: 7)
        }
        Text(selectedLaneName)
          .font(.system(size: 12.5, weight: .medium))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
      }
    }
  }

  private static let destinationPickerMinHeight: CGFloat = 240

  /// The picker fills the room between the destination control and the top of
  /// the screen (minus a small margin) so it never overflows and clips a
  /// project — the two sections then split that height evenly. Falls back to a
  /// device fraction until the control's position has been measured.
  private var destinationPickerHeight: CGFloat {
    let deviceCap = min(UIScreen.main.bounds.height * 0.62, 560)
    guard destinationControlTopY > 0 else { return min(deviceCap, 320) }
    let available = destinationControlTopY - 64
    return max(Self.destinationPickerMinHeight, min(deviceCap, available))
  }

  private var destinationPicker: some View {
    VStack(spacing: 0) {
      sectionLabel("Project")
      ScrollView {
        LazyVStack(spacing: 2) {
          if let entries = composerEntries {
            // Signed in: each account project once, then its computers.
            if entries.isEmpty {
              emptyPickerRow("No projects on a connected computer")
            }
            ForEach(entries) { entry in
              entryRow(entry)
            }
          } else {
          if !machineFleet.composerDestinationMachines.isEmpty {
            HubComposerMachineHeader(name: syncService.focusedMachineDisplayName)
          }
          if syncService.projects.isEmpty {
            emptyPickerRow("No projects on this computer")
          } else {
            ForEach(syncService.projects) { project in
              projectRow(project)
            }
          }
          ForEach(machineFleet.composerDestinationMachines) { machine in
            HubComposerMachineHeader(name: machine.name)
            ForEach(machine.projects, id: \.projectId) { project in
              projectRow(project.asRemoteMachineProjectSummary, machineKey: machine.machineKey)
            }
          }
          }
        }
        .padding(4)
      }
      .frame(maxHeight: .infinity)

      Rectangle().fill(ADEKit.rule).frame(height: 0.75)

      sectionLabel("Lane")
      ScrollView {
        LazyVStack(spacing: 2) {
          if pickedMachineIsCloud {
            // A new lane on ADE Cloud gets its own computer, through the account.
            if let accountCopy = accountCloudCopy {
              newCloudLaneRow(accountCopy)
            }
            // ADE Cloud is one machine: the lanes of each of its computers.
            ForEach(cloudLaneChoices) { choice in
              laneRow(choice.lane, copy: choice.copy)
            }
          } else {
            autoCreateLaneRow
            ForEach(lanesForPickedProject) { lane in
              laneRow(lane)
            }
          }
        }
        .padding(4)
      }
      .frame(maxHeight: .infinity)
    }
    .background(ADEKit.surface)
  }

  private func sectionLabel(_ text: String) -> some View {
    HStack {
      ADEEyebrow(text)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 12)
    .padding(.top, 10)
    .padding(.bottom, 4)
  }

  private func emptyPickerRow(_ text: String) -> some View {
    Text(text)
      .font(.system(size: 12.5))
      .foregroundStyle(ADEColor.textMuted)
      .frame(maxWidth: .infinity)
      .padding(.vertical, 12)
  }

  /// The composer's projects when the account lists them: each account
  /// project once with its live copies (the primary's and every live
  /// computer's), then the folders that are not on the account. Nil when the
  /// account does not decide the projects (signed out, an older server).
  private var composerEntries: [HubComposerProjectEntry]? {
    guard let resolver = syncService.accountProjectResolver() else { return nil }
    let account = AccountService.shared
    let liveById = Dictionary(
      accountProjects.liveProjects.map { ($0.id, $0) },
      uniquingKeysWith: { first, _ in first }
    )
    var copies: [(copy: HubComposerCopy, accountProject: AccountProject?)] = []
    func add(_ copy: HubComposerCopy) {
      let id = syncService.accountProjectId(forCheckout: copy.project, onMachine: copy.machineKey, resolver: resolver)
      // A folder of a project removed from ADE: the Hub hides its card, so
      // the picker does not offer it either (`removedFromAccount`).
      if let id, resolver.removedIds.contains(id) { return }
      copies.append((copy, id.flatMap { liveById[$0] }))
    }
    let primaryName = syncService.focusedMachineDisplayName
    let primaryAccountKey = account.machine(forFleetKey: syncService.focusedMachineKey)?.machineKey
    let primaryIsCloud = syncService.isCloudFleetKey(syncService.focusedMachineKey)
    for project in syncService.projects {
      add(HubComposerCopy(
        machineKey: nil, machineName: primaryName, accountMachineKey: primaryAccountKey,
        project: project, isCloud: primaryIsCloud
      ))
    }
    for machine in machineFleet.composerDestinationMachines {
      let accountKey = account.machine(forFleetKey: machine.machineKey)?.machineKey
      let isCloud = syncService.isCloudFleetKey(machine.machineKey)
      for rosterProject in machine.projects {
        add(HubComposerCopy(
          machineKey: machine.machineKey,
          machineName: isCloud ? ADECloudMachine.name : machine.name,
          accountMachineKey: accountKey,
          project: rosterProject.asRemoteMachineProjectSummary,
          isCloud: isCloud
        ))
      }
    }
    // ADE Cloud is in every "Run on" list: each project on the account can
    // start there, through the account server, linked computer or not.
    if account.isSignedIn {
      for project in accountProjects.liveProjects {
        copies.append((HubComposerCopy(
          machineKey: ADECloudMachine.id,
          machineName: ADECloudMachine.name,
          accountMachineKey: nil,
          project: hubAccountCloudSummary(project),
          isCloud: true
        ), project))
      }
    }
    return hubComposerProjectEntries(copies)
  }

  private func isPicked(_ copy: HubComposerCopy) -> Bool {
    copy.project.id == pickedProjectId && copy.machineKey == pickedMachineKey
  }

  /// The account project of the current pick (one lookup, not the list).
  private var pickedAccountProject: AccountProject? {
    if pickedAccountCloud { return accountCloudProject }
    return pickedProject.flatMap { syncService.accountProject(forCheckout: $0, onMachine: pickedMachineKey) }
  }

  private func pick(_ copy: HubComposerCopy) {
    guard !isPicked(copy) else { return }
    pickedMachineKey = copy.machineKey
    pickedProjectId = copy.project.id
    // Switching projects resets only that project's lane selection.
    selectedLaneId = defaultLaneId(forProjectId: copy.project.id)
  }

  /// One project, named by the account; when chosen and on more than one
  /// computer, its computers follow as chips (project first, then Start on).
  @ViewBuilder
  private func entryRow(_ entry: HubComposerProjectEntry) -> some View {
    let isSelected = entry.copies.contains(where: isPicked)
    let destinations = hubComposerDestinationCopies(entry.copies, isPicked: isPicked)
    Button {
      guard !isSelected else { return }
      let last = entry.accountProjectId.flatMap { StartOnMemory.lastMachine(for: $0) }
      let mains = entry.accountProjectId.flatMap { id in
        accountProjects.liveProjects.first { $0.id == id }?.copies.filter(\.isMain)
      } ?? []
      if let copy = hubComposerDefaultCopy(entry, lastAccountMachineKey: last, mainCopies: mains) { pick(copy) }
    } label: {
      HStack(spacing: 9) {
        HubProjectIcon(iconDataUrl: entry.iconDataUrl, isActive: isSelected)
        VStack(alignment: .leading, spacing: 1) {
          Text(entry.name)
            .font(.system(size: 14, weight: isSelected ? .semibold : .regular))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          if destinations.count == 1, let only = destinations.first, only.machineKey != nil {
            Text(only.machineName)
              .font(.system(size: 11.5))
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        if isSelected {
          Image(systemName: "checkmark")
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(ADEColor.accent)
        }
      }
      .padding(.horizontal, 8)
      .padding(.vertical, 6)
      .background(
        isSelected ? ADEKit.pressed : Color.clear,
        in: RoundedRectangle(cornerRadius: 8, style: .continuous)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    if isSelected, destinations.count > 1 {
      HubComposerStartOnChips(copies: destinations, isSelected: isPicked, onPick: pick)
    }
  }

  /// `machineKey`: the project's machine when it is not the primary one.
  private func projectRow(_ project: MobileProjectSummary, machineKey: String? = nil) -> some View {
    let isSelected = project.id == pickedProjectId && machineKey == pickedMachineKey
    return Button {
      guard !isSelected else { return }
      pickedMachineKey = machineKey
      pickedProjectId = project.id
      // Switching projects resets only that project's lane selection.
      selectedLaneId = defaultLaneId(forProjectId: project.id)
    } label: {
      HStack(spacing: 9) {
        HubProjectIcon(iconDataUrl: project.iconDataUrl, isActive: isSelected)
        Text(project.displayName)
          .font(.system(size: 14, weight: isSelected ? .semibold : .regular))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .frame(maxWidth: .infinity, alignment: .leading)
        if isSelected {
          Image(systemName: "checkmark")
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(ADEColor.accent)
        }
      }
      .padding(.horizontal, 8)
      .padding(.vertical, 6)
      .background(
        isSelected ? ADEKit.pressed : Color.clear,
        in: RoundedRectangle(cornerRadius: 8, style: .continuous)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  private func newCloudLaneRow(_ copy: HubComposerCopy) -> some View {
    let selected = pickedAccountCloud && isAutoCreateLane
    return Button {
      if !isPicked(copy) {
        pickedMachineKey = copy.machineKey
        pickedProjectId = copy.project.id
      }
      selectedLaneId = workAutoCreateLaneSentinelId
      destinationPickerPresented = false
    } label: {
      HStack(spacing: 8) {
        Image(systemName: "sparkles")
          .font(.system(size: 12, weight: .regular))
          .foregroundStyle(ADEColor.textSecondary)
          .frame(width: 22)
        Text("New lane on ADE Cloud")
          .font(.system(size: 14, weight: selected ? .semibold : .regular))
          .foregroundStyle(ADEColor.textPrimary)
          .frame(maxWidth: .infinity, alignment: .leading)
        if selected {
          Image(systemName: "checkmark")
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(ADEColor.accent)
        }
      }
      .padding(.horizontal, 8)
      .padding(.vertical, 7)
      .background(
        selected ? ADEKit.pressed : Color.clear,
        in: RoundedRectangle(cornerRadius: 8, style: .continuous)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  private var autoCreateLaneRow: some View {
    Button {
      selectedLaneId = workAutoCreateLaneSentinelId
      destinationPickerPresented = false
    } label: {
      HStack(spacing: 8) {
        Image(systemName: "sparkles")
          .font(.system(size: 12, weight: .regular))
          .foregroundStyle(ADEColor.textSecondary)
          .frame(width: 22)
        Text("Auto-create lane")
          .font(.system(size: 14, weight: isAutoCreateLane ? .semibold : .regular))
          .foregroundStyle(ADEColor.textPrimary)
          .frame(maxWidth: .infinity, alignment: .leading)
        if isAutoCreateLane {
          Image(systemName: "checkmark")
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(ADEColor.accent)
        }
      }
      .padding(.horizontal, 8)
      .padding(.vertical, 7)
      .background(
        isAutoCreateLane ? ADEKit.pressed : Color.clear,
        in: RoundedRectangle(cornerRadius: 8, style: .continuous)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  /// `copy`: the ADE Cloud computer the lane is on, picked with the lane.
  private func laneRow(_ lane: RemoteRosterLane, copy: HubComposerCopy? = nil) -> some View {
    let isSelected = lane.id == selectedLaneId && (copy.map(isPicked) ?? true)
    let tint = LaneColorPalette.displayColor(forHex: lane.color)
    let branch = normalizedPrBranchName(lane.branchRef)
    return Button {
      if let copy, !isPicked(copy) {
        pickedMachineKey = copy.machineKey
        pickedProjectId = copy.project.id
      }
      selectedLaneId = lane.id
      destinationPickerPresented = false
    } label: {
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 8) {
          if let emoji = lane.emoji, !emoji.isEmpty {
            Text(emoji)
              .font(.system(size: 14))
              .frame(width: 22)
          } else {
            Circle().fill(tint).frame(width: 8, height: 8)
              .frame(width: 22)
          }
          Text(lane.displayName)
            .font(.system(size: 14, weight: isSelected ? .semibold : .regular))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
          if isSelected {
            Image(systemName: "checkmark")
              .font(.system(size: 12, weight: .bold))
              .foregroundStyle(ADEColor.accent)
          }
        }
        if !branch.isEmpty {
          HStack(spacing: 4) {
            Image(systemName: "arrow.branch")
              .font(.system(size: 9, weight: .regular))
              .foregroundStyle(ADEColor.textMuted.opacity(0.6))
            Text(branch)
              .font(.adeMono(10.5))
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
          }
          .padding(.leading, 30)
        }
      }
      .padding(.horizontal, 8)
      .padding(.vertical, branch.isEmpty ? 6 : 5)
      .background(
        isSelected ? ADEKit.pressed : Color.clear,
        in: RoundedRectangle(cornerRadius: 8, style: .continuous)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  // MARK: Composer card

  /// The app's shared glass prompt box (`ADEGlassComposerCard`): folded to
  /// [⋯][field][send] while the drawer is closed, the full composer with the
  /// model/mode controls once it opens. The drawer owns the fold (`isExpanded`
  /// also covers pickers and dictation), so the card never folds under a sheet.
  private var composerCard: some View {
    let collapsed = !isExpanded
    return ADEGlassComposerCard(
      collapsed: collapsed,
      isDictating: isDictating,
      onFold: { intent in
        switch intent {
        case .collapse: collapse()
        case .expand, .focusChanged:
          composerFocused = true
          withAnimation(hubComposerSpring) { expanded = true }
        }
      },
      accessory: {
        if !attachments.isEmpty {
          WorkChatInputAttachmentTray(
            attachments: $attachments,
            compact: collapsed,
            onExpand: {
              composerFocused = true
              withAnimation(hubComposerSpring) { expanded = true }
            }
          )
          .fixedSize(horizontal: false, vertical: true)
        }
      },
      field: {
        WorkPlainComposerTextView(
          text: $draft,
          isFocused: Binding(
            get: { composerFocused },
            set: { composerFocused = $0 }
          ),
          measuredHeight: $composerTextHeight,
          placeholder: "Type to vibecode…",
          acceptsPastedImages: attachmentsAvailable,
          onPasteImages: { images in
            workChatInputPasteImages(images, into: $attachments)
          }
        )
        .frame(height: composerTextHeight)
        .frame(
          height: collapsed
            ? min(composerTextHeight, workComposerFoldedFieldHeight(lineHeight: UIFont.preferredFont(forTextStyle: .body).lineHeight))
            : composerTextHeight,
          alignment: .top
        )
        .clipped()
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(minHeight: 44)
      },
      menu: {
        WorkComposerOverflowButton(
          presentedPicker: $presentedPicker,
          draft: $draft,
          attachments: $attachments,
          canCompose: !busy,
          attachmentsAvailable: attachmentsAvailable,
          onDictate: { dictationCoordinator.requestStart() },
          draftsAvailable: syncService.canInvokeRemoteAction("chat.listDrafts"),
          scheduleAvailable: syncService.canInvokeRemoteAction("chat.createDraft"),
          scope: WorkDraftScope(
            projectId: pickedProjectId.isEmpty ? nil : pickedProjectId
          ),
          provider: provider,
          modelId: modelId,
          runtimeMode: runtimeMode,
          extraMenuContent: AnyView(
            Section {
              Button {
                modelPickerPresented = true
              } label: {
                Label("Model · \(hubPrettyModelName(modelId))", systemImage: "cpu")
              }
            }
          )
        )
      },
      controls: {
        ScrollView(.horizontal, showsIndicators: false) {
          WorkComposerControlsRow(
            provider: provider,
            modelDisplayName: hubPrettyModelName(modelId),
            modelBrandKey: WorkModelMentionDirectory.shared.entry(for: modelId)?.brandKey,
            reasoningEffort: reasoningEffort,
            currentMode: runtimeMode,
            modeOptions: workRuntimeModeOptions(provider: provider),
            modeLabel: workRuntimeModeLabel(provider: provider, mode: runtimeMode),
            fastModeEnabled: codexFastMode,
            onOpenModelPicker: { modelPickerPresented = true },
            onSelectMode: { runtimeMode = $0 }
          )
          .padding(.trailing, 4)
        }

        DictationRawUndoChip(coordinator: dictationCoordinator, draft: $draft)
      },
      trailing: {
        DictationMicButton(
          draft: $draft,
          coordinator: dictationCoordinator,
          targetId: dictationTargetId,
          showsIdleButton: false,
          onRecordingChange: { isDictating = $0 }
        )
        .frame(maxWidth: isDictating ? .infinity : nil)

        if !isDictating {
          ADEComposerSendButton(
            enabled: canSend && !busy,
            sending: busy,
            accessibilityLabelText: "Start chat",
            disabledAccessibilityLabel: "Enter a message to start"
          ) {
            dispatch()
          }
        }
      }
    )
  }

  // MARK: Actions

  @MainActor
  private func onAppearSetup() {
    if runtimeMode.isEmpty {
      runtimeMode = workDefaultRuntimeMode(provider: provider)
    }
    reconcileDestination()
  }

  @MainActor
  private func dispatch() {
    let outgoingAttachments = workChatInputReadyAttachments(attachments)
    guard canSend else {
      // A tap during a switch is refused (`busy`) and must not release the
      // hold; the re-entry after a switch that cannot send does release it.
      if !busy { holdsDestination = false }
      return
    }
    // A folder of a project removed from ADE while the composer was open.
    if let picked = pickedProject, removedFromAccount()(picked, pickedMachineKey) {
      holdsDestination = false
      reconcileDestination()
      return
    }
    // Another machine's project: make that machine primary first, before the
    // draft is cleared, then send as usual.
    if let key = pickedMachineKey, key != syncService.focusedMachineKey, !pickedAccountCloud {
      holdsDestination = true
      // Set before the task runs, so a second tap cannot start a second switch.
      busy = true
      Task {
        guard await focusPickedMachine(key) else {
          holdsDestination = false
          return
        }
        dispatch()
      }
      return
    }
    // The computer this send starts on, saved as the project's next default
    // only when the chat starts.
    let remembered: (machine: String, project: String)? = pickedAccountProject.flatMap { project in
      AccountService.shared.machine(forFleetKey: pickedMachineKey ?? syncService.focusedMachineKey)
        .map { (machine: $0.machineKey, project: project.id) }
    }
    let restoredDraft = draft
    let restoredAttachments = attachments
    collapse()
    draft = ""
    attachments.removeAll()
    // Drop the persisted draft synchronously — the collapse must not race the
    // 400ms autosave debounce and leave the just-sent text behind.
    WorkComposerDraftStore.clear(WorkComposerDraftStore.hubNewChatKey)
    Task {
      let started = await submit(opener: restoredDraft, attachments: outgoingAttachments)
      holdsDestination = false
      if started, let remembered { StartOnMemory.remember(remembered.machine, for: remembered.project) }
      if !started {
        draft = restoredDraft
        attachments = restoredAttachments
      }
    }
  }

  @MainActor
  private func submit(opener rawOpener: String, attachments inputAttachments: [WorkChatInputAttachment]) async -> Bool {
    let readyAttachments = workChatInputReadyAttachments(inputAttachments)
    let rawText = rawOpener.trimmingCharacters(in: .whitespacesAndNewlines)
    let opener = workChatOutgoingText(rawOpener, attachmentCount: readyAttachments.count)
    guard canStart, !opener.isEmpty, !modelId.isEmpty else { return false }
    let availabilityMode: WorkCursorAvailabilityMode = sessionMode == .cli ? .cli : .chat
    guard workModelAllowedForAvailabilityMode(modelId: modelId, provider: provider, mode: availabilityMode) else {
      errorMessage = sessionMode == .cli
        ? "This model is available for chat only. Choose a CLI-capable model."
        : "This model is available for CLI only. Choose a chat-capable model."
      return false
    }
    if pickedAccountCloud {
      return await submitOnCloud(opener: opener, rawText: rawText, attachments: readyAttachments)
    }
    guard readyAttachments.isEmpty || canUploadAttachments else {
      errorMessage = "Reconnect to attach images."
      return false
    }
    guard let project = pickedProject else {
      errorMessage = "Pick a project first."
      return false
    }

    // Anchor the "last time you sent a message" composer choice.
    WorkComposerPreferences.save(composerSelection)
    busy = true
    errorMessage = nil

    let targetProjectId = project.id
    let targetProjectRootPath = project.rootPath
    let wire = workRuntimeWireFields(provider: provider, mode: runtimeMode)
    let piMetadata = workResolvedPiModelMetadata(
      modelId: modelId,
      profileId: selectedModelOption?.piProfileId,
      providerId: selectedModelOption?.piProviderId,
      piModelId: selectedModelOption?.piModelId
    )
    let normalizedReasoning = reasoningEffort.trimmingCharacters(in: .whitespacesAndNewlines)

    // Auto-create lane + plain chat: the host owns the launch (reserve ids,
    // fetch, checkout, template, create the chat, send the opener) in the
    // TARGET project, and the hub reports the chat at once. Older hosts that
    // do not advertise `chat.startLaunch`, and offline sends, keep the chained
    // flow below unchanged. Same gate as the Work new-chat screen; the drawer
    // has no Cursor Cloud mode.
    if let request = ChatLaunchRequest(
      composerOpener: opener,
      laneName: workDeterministicAutoLaneName(from: opener, genericSuffix: workAutoLaneGenericSuffix()),
      provider: provider,
      modelId: modelId,
      reasoningEffort: reasoningEffort,
      codexFastMode: codexFastMode,
      piMetadata: piMetadata,
      wire: wire,
      projectId: targetProjectId,
      projectRootPath: targetProjectRootPath,
      originClientId: syncService.pairingDeviceId,
      isAutoCreateLane: isAutoCreateLane,
      isChatSession: sessionMode == .chat,
      cursorCloudMode: false,
      hostCanStartLaunch: syncService.canStartChatLaunch
    ) {
      let laneName = request.laneName
      let syncService = syncService
      let attachmentsToStage = readyAttachments
      let snapshot = syncService.beginChatLaunch(request) {
        try await workChatSaveInputAttachments(
          attachmentsToStage,
          syncService: syncService,
          targetProjectId: targetProjectId,
          targetProjectRootPath: targetProjectRootPath
        )
      }
      WorkComposerPreferences.save(composerSelection)
      saveLastDestination(projectId: targetProjectId, laneId: workAutoCreateLaneSentinelId)
      ADEHaptics.success()
      busy = false
      collapse()
      onCreated(HubCreatedChat(
        projectId: targetProjectId,
        projectRootPath: targetProjectRootPath,
        projectName: project.displayName,
        laneName: laneName,
        sessionId: snapshot.chatSessionId,
        isCli: false,
        provider: provider
      ))
      return true
    }

    // Resolve the target lane. Auto-create mints a fresh lane in the TARGET
    // project first; on failure we surface the error and never create the chat.
    // Track the minted lane so we can tear it back down if the chat launch
    // fails immediately afterwards (desktop parity — no orphaned empty lane).
    let targetLaneId: String
    let targetLaneName: String
    var createdLaneId: String?
    var autoCreatedFallbackName: String?
    var autoCreatedTemporaryBranch: String?
    if isAutoCreateLane {
      let name = workDeterministicAutoLaneName(from: opener, genericSuffix: workAutoLaneGenericSuffix())
      do {
        let lane = try await syncService.createLane(
          name: name,
          description: opener.isEmpty ? "" : String(opener.prefix(280)),
          autoNamedBranch: true,
          targetProjectId: targetProjectId,
          targetProjectRootPath: targetProjectRootPath,
          setUpLane: true
        )
        targetLaneId = lane.id
        targetLaneName = lane.name
        createdLaneId = lane.id
        autoCreatedFallbackName = name
        // The host chose the placeholder in the project's branch pattern.
        autoCreatedTemporaryBranch = lane.branchRef
      } catch {
        ADEHaptics.error()
        errorMessage = error.localizedDescription
        busy = false
        return false
      }
    } else {
      targetLaneId = selectedLaneId
      targetLaneName = lanesForPickedProject.first(where: { $0.id == selectedLaneId })?.name ?? selectedLaneId
    }
    var createdChatAfterSessionCreation: HubCreatedChat?
    var namingAttachmentRefs: [AgentChatFileRef] = []

    do {
      let isCli = sessionMode == .cli
      let attachmentRefs = try await workChatSaveInputAttachments(
        readyAttachments,
        syncService: syncService,
        targetProjectId: targetProjectId,
        targetProjectRootPath: targetProjectRootPath
      )
      namingAttachmentRefs = attachmentRefs
      let sessionId: String
      if isCli {
        let cliProvider = workResolveCliProvider(for: modelId, provider: provider)
        let cliReasoning = hubCliSupportsReasoning(provider: cliProvider) && !normalizedReasoning.isEmpty
          ? normalizedReasoning
          : nil
        let result = try await syncService.startCliSession(
          laneId: targetLaneId,
          provider: cliProvider,
          permissionMode: workCliPermissionMode(provider: cliProvider, runtimeMode: runtimeMode),
          title: hubCliInitialTitle(opener: opener, provider: cliProvider),
          initialInput: workCliInitialInput(text: rawText, attachments: attachmentRefs),
          modelId: modelId,
          reasoningEffort: cliReasoning,
          fastMode: fastModeSupported ? codexFastMode : nil,
          cols: 48,
          rows: 24,
          targetProjectId: targetProjectId,
          targetProjectRootPath: targetProjectRootPath
        )
        sessionId = result.sessionId
      } else {
        let summary = try await syncService.createChatSession(
          laneId: targetLaneId,
          provider: provider,
          model: modelId,
          reasoningEffort: normalizedReasoning.isEmpty ? nil : normalizedReasoning,
          // Preserve the independent preference. Runtime capability checks
          // belong at request construction, not in the composer state.
          codexFastMode: codexFastMode,
          piProfileId: piMetadata?.profileId,
          piProviderId: piMetadata?.providerId,
          piModelId: piMetadata?.modelId,
          permissionMode: wire.permissionMode,
          interactionMode: wire.interactionMode,
          claudePermissionMode: wire.claudePermissionMode,
          codexApprovalPolicy: wire.codexApprovalPolicy,
          codexSandbox: wire.codexSandbox,
          codexConfigSource: wire.codexConfigSource,
          opencodePermissionMode: wire.opencodePermissionMode,
          droidPermissionMode: wire.droidPermissionMode,
          musePermissionMode: wire.musePermissionMode,
          copilotPermissionMode: wire.copilotPermissionMode,
          copilotContextTier: wire.copilotContextTier,
          copilotAutoTier: wire.copilotAutoTier,
          cursorModeId: wire.cursorModeId,
          targetProjectId: targetProjectId,
          targetProjectRootPath: targetProjectRootPath
        )
        sessionId = summary.sessionId
        createdChatAfterSessionCreation = HubCreatedChat(
          projectId: targetProjectId,
          projectRootPath: targetProjectRootPath,
          projectName: project.displayName,
          laneName: targetLaneName,
          sessionId: summary.sessionId,
          isCli: false,
          provider: provider
        )
        try await syncService.sendChatMessage(
          sessionId: summary.sessionId,
          text: opener,
          attachments: attachmentRefs.isEmpty ? nil : attachmentRefs,
          targetProjectId: targetProjectId,
          targetProjectRootPath: targetProjectRootPath
        )
      }

      // Persist the composer + destination so the next New Chat restores both.
      WorkComposerPreferences.save(composerSelection)
      saveLastDestination(
        projectId: targetProjectId,
        laneId: isAutoCreateLane ? workAutoCreateLaneSentinelId : selectedLaneId
      )
      ADEHaptics.success()
      busy = false

      let created = createdChatAfterSessionCreation ?? HubCreatedChat(
        projectId: targetProjectId,
        projectRootPath: targetProjectRootPath,
        projectName: project.displayName,
        laneName: targetLaneName,
        sessionId: sessionId,
        isCli: isCli,
        provider: provider
      )
      // Collapse back to the minimized box; the hub's toast takes over from here.
      collapse()
      onCreated(created)
      if let createdLaneId, let autoCreatedFallbackName {
        startBackgroundLaneNaming(
          laneId: createdLaneId,
          opener: opener,
          fallbackName: autoCreatedFallbackName,
          temporaryBranch: autoCreatedTemporaryBranch,
          attachments: namingAttachmentRefs,
          targetProjectId: targetProjectId,
          targetProjectRootPath: targetProjectRootPath
        )
      }
      return true
    } catch let error as QueuedRemoteCommandError {
      if workQueuedNewSessionConsumesOpeningDraft(sessionMode) {
        // The queued CLI start already contains the opener as `initialInput`.
        // Keep the cleared composer so a retry cannot duplicate that input.
        ADEHaptics.medium()
        errorMessage = nil
        if let createdLaneId, let autoCreatedFallbackName {
          startBackgroundLaneNaming(
            laneId: createdLaneId,
            opener: opener,
            fallbackName: autoCreatedFallbackName,
            temporaryBranch: autoCreatedTemporaryBranch,
            attachments: namingAttachmentRefs,
            targetProjectId: targetProjectId,
            targetProjectRootPath: targetProjectRootPath
          )
        }
        busy = false
        return true
      }
      // The chat create itself is safely queued, but the opener was not sent.
      // Keep the lane and return false so the hub preserves the exact draft and
      // attachments until the pending session materializes after reconnect.
      ADEHaptics.medium()
      errorMessage = error.localizedDescription
      busy = false
      return false
    } catch let error as AmbiguousChatCreationError {
      // A live create may already have reached the host. Never delete its lane
      // or retry blindly; preserve the draft while the Work list reconciles.
      ADEHaptics.error()
      errorMessage = error.localizedDescription
      busy = false
      return false
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
      if let createdChatAfterSessionCreation {
        // The session exists and the host may already have started the opener.
        // Keep the lane/session, expose the chat through the hub toast, and
        // return false so the inline composer restores the user's exact draft
        // and attachments without auto-resending them.
        onCreated(createdChatAfterSessionCreation)
        if let createdLaneId, let autoCreatedFallbackName {
          startBackgroundLaneNaming(
            laneId: createdLaneId,
            opener: opener,
            fallbackName: autoCreatedFallbackName,
            temporaryBranch: autoCreatedTemporaryBranch,
            attachments: namingAttachmentRefs,
            targetProjectId: targetProjectId,
            targetProjectRootPath: targetProjectRootPath
          )
        }
        busy = false
        return false
      }
      // The chat never launched into the lane we just minted — clean it up so
      // an auto-create failure doesn't leave an orphaned empty lane behind.
      if let createdLaneId {
        try? await syncService.deleteLane(
          createdLaneId,
          targetProjectId: targetProjectId,
          targetProjectRootPath: targetProjectRootPath
        )
      }
      busy = false
      return false
    }
  }

  /// Desktop-parity background lane naming. The lane is created immediately
  /// with the deterministic fallback; then the host AI gets two chances to
  /// replace it, and every failure is logged with the lane id. Both calls carry
  /// the picked project's scope since the hub can launch into a project other
  /// than the active one (same envelope routing as createLane above).
  /// A chat on ADE Cloud through the account server (as the Work screen
  /// starts one): a new cloud lane, or an existing one. Its launch card then
  /// shows in the project's Work tab, which opens.
  @MainActor
  private func submitOnCloud(opener: String, rawText: String, attachments: [WorkChatInputAttachment]) async -> Bool {
    if let refusal = cloudStore.doingRefusal {
      errorMessage = refusal
      return false
    }
    guard sessionMode == .chat else {
      errorMessage = "ADE Cloud starts chats from the phone. Switch to Chat."
      return false
    }
    guard let project = accountCloudProject else {
      errorMessage = "Pick a project first."
      return false
    }
    guard let entry = cloudLaunches.catalog?.providers.first(where: { $0.provider == provider }),
          entry.models.contains(where: { $0.id == modelId }) else {
      errorMessage = "Pick a model ADE Cloud runs."
      return false
    }
    var files: [(name: String, contentType: String, data: Data)] = []
    for attachment in attachments {
      guard let data = attachment.uploadData ?? attachment.image?.jpegData(compressionQuality: 0.85) else {
        errorMessage = "\(attachment.filename) is on the machine that saved this draft. Remove it and attach it again to send it to ADE Cloud."
        return false
      }
      files.append((name: attachment.filename, contentType: attachment.uploadData == nil ? "image/jpeg" : attachment.mimeType, data: data))
    }
    let existingLane: (id: String, name: String)? = isAutoCreateLane ? nil : lanesForPickedProject
      .first { $0.id == selectedLaneId }
      .map { (id: $0.id, name: $0.name) }
    if !isAutoCreateLane, existingLane == nil {
      errorMessage = "Pick a lane."
      return false
    }
    WorkComposerPreferences.save(composerSelection)
    busy = true
    errorMessage = nil
    let launchId = await cloudLaunches.start(
      accountProjectId: project.id,
      origin: "\(project.host)/\(project.owner)/\(project.name)",
      prompt: opener,
      provider: entry.provider,
      modelId: modelId,
      effort: reasoningEffort,
      fast: codexFastMode && entry.models.contains { $0.id == modelId && $0.fast },
      files: files,
      existingLane: existingLane,
      newLaneName: existingLane == nil
        ? workDeterministicAutoLaneName(from: rawText, genericSuffix: workAutoLaneGenericSuffix())
        : nil,
      using: syncService
    )
    busy = false
    if let failure = cloudLaunches.entries.first(where: { $0.launchId == launchId })?.startError {
      errorMessage = failure
      return false
    }
    ADEHaptics.success()
    // The launch card (setup steps, then the chat) lives in the project's Work tab.
    syncService.openAccountProjectScope(project.id)
    return true
  }

  private func startBackgroundLaneNaming(
    laneId: String,
    opener: String,
    fallbackName: String,
    temporaryBranch: String?,
    attachments: [AgentChatFileRef],
    targetProjectId: String?,
    targetProjectRootPath: String?
  ) {
    let syncService = syncService
    let modelId = modelId
    Task {
      await workRunAutoLaneAiRename(
        laneId: laneId,
        opener: opener,
        fallbackName: fallbackName,
        modelId: modelId,
        temporaryBranch: temporaryBranch,
        attachments: attachments,
        syncService: syncService,
        surface: .hubComposer,
        targetProjectId: targetProjectId,
        targetProjectRootPath: targetProjectRootPath,
        refreshLanes: {
          syncService.requestRosterSnapshot()
        }
      )
    }
  }

  /// Makes the picked project's machine primary so the chat can be created
  /// there; the previous primary stays connected. False (with the error set)
  /// when that machine cannot be reached or does not list the project.
  @MainActor
  private func focusPickedMachine(_ key: String) async -> Bool {
    let machineName = pickedRemoteMachine?.name ?? "that computer"
    let projectId = pickedProjectId
    let rootPath = syncNormalizedProjectRootScope(pickedRemoteProject?.rootPath)
    // The switch reconciles the destination against a roster that may not have
    // its lanes yet; the lane the user chose belongs to that machine and stays.
    let laneId = selectedLaneId
    busy = true
    errorMessage = nil
    onMachineSwitch(true)
    defer { onMachineSwitch(false) }
    let switched = await syncService.switchFocusKeepingPrevious(toMachineKey: key)
    busy = false
    guard switched else {
      // The switch can retarget the destination mid-way; a retry must still go
      // to the machine the user picked.
      pickedMachineKey = key
      pickedProjectId = projectId
      selectedLaneId = laneId
      errorMessage = "Can’t reach \(machineName) right now."
      return false
    }
    // The catalog can name the project by a cached id: match its folder too.
    guard let project = syncService.projects.first(where: { candidate in
      candidate.id == projectId
        || (rootPath != nil && syncNormalizedProjectRootScope(candidate.rootPath) == rootPath)
    }) else {
      errorMessage = "\(machineName) no longer has that project."
      return false
    }
    pickedMachineKey = nil
    pickedProjectId = project.id
    selectedLaneId = laneId
    return true
  }

  // MARK: Destination resolution

  /// An ADE Cloud lane computer exists for its one lane: its main checkout is
  /// left out and no new lane is made there.
  private var pickedMachineIsCloud: Bool {
    pickedAccountCloud || syncService.isCloudFleetKey(pickedMachineKey ?? syncService.focusedMachineKey)
  }

  /// Keeps the model on one ADE Cloud runs: the last cloud pick, else the
  /// catalog's default (as the Work screen does).
  private func pickCloudModelIfNeeded() {
    guard pickedAccountCloud,
          cloudLaunches.catalog?.providers.first(where: { $0.provider == provider })?.models.contains(where: { $0.id == modelId }) != true,
          let pick = cloudLaunches.defaultModel() else { return }
    provider = pick.provider
    modelId = pick.modelId
    selectedModelOption = nil
    reasoningEffort = ""
    codexFastMode = false
  }

  /// ADE Cloud through the account server: `pickedProjectId` is then the
  /// account project's id.
  private var pickedAccountCloud: Bool { pickedMachineKey == ADECloudMachine.id }

  private var accountCloudProject: AccountProject? {
    guard pickedAccountCloud else { return nil }
    return accountProjects.liveProjects.first { $0.id == pickedProjectId }
  }

  private struct CloudLaneChoice: Identifiable {
    let lane: RemoteRosterLane
    /// Nil: the picked computer.
    let copy: HubComposerCopy?
    var id: String { "\(copy?.id ?? "")|\(lane.id)" }
  }

  /// The picked project's lanes on every ADE Cloud computer (each holds one),
  /// so ADE Cloud lists as one machine; a pick routes to the lane's computer.
  /// Signed out (no account entries): the picked computer's lanes.
  private var cloudLaneChoices: [CloudLaneChoice] {
    let cloudCopies = composerEntries?
      .first { $0.copies.contains(where: isPicked) }?
      .copies.filter(\.isCloud) ?? []
    guard !cloudCopies.isEmpty else {
      return lanesForPickedProject.map { CloudLaneChoice(lane: $0, copy: nil) }
    }
    var choices = cloudCopies.filter { $0.machineKey != ADECloudMachine.id }.flatMap { copy in
      cloudLanes(on: copy).map { CloudLaneChoice(lane: $0, copy: copy) }
    }
    // The project's other cloud lanes, read from the account (their computers
    // are not linked here, or asleep): a chat there wakes its computer.
    if let accountCopy = cloudCopies.first(where: { $0.machineKey == ADECloudMachine.id }) {
      let shown = Set(choices.map(\.lane.id))
      choices += accountCloudLanes(accountProjectId: accountCopy.project.id)
        .filter { !shown.contains($0.id) }
        .map { CloudLaneChoice(lane: $0, copy: accountCopy) }
    }
    return choices
  }

  /// The cloud lanes of one account project, from the account's ADE Cloud
  /// computers (each holds one lane), newest name order.
  private func accountCloudLanes(accountProjectId: String) -> [RemoteRosterLane] {
    guard let project = accountProjects.liveProjects.first(where: { $0.id == accountProjectId }) else { return [] }
    let origin = "\(project.host)/\(project.owner)/\(project.name)".lowercased()
    var seen = Set<String>()
    return syncService.cloudServerInstances.compactMap { instance -> RemoteRosterLane? in
      guard instance.projectOrigin == origin, let id = instance.laneId, seen.insert(id).inserted else { return nil }
      return RemoteRosterLane(id: id, name: instance.laneName ?? "Lane", laneType: "worktree", branchRef: instance.laneBranch)
    }
    .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
  }

  /// The account-server ADE Cloud destination of the picked project.
  private var accountCloudCopy: HubComposerCopy? {
    composerEntries?
      .first { $0.copies.contains(where: isPicked) }?
      .copies.first { $0.machineKey == ADECloudMachine.id }
  }

  private func cloudLanes(on copy: HubComposerCopy) -> [RemoteRosterLane] {
    let lanes: [RemoteRosterLane]
    if let key = copy.machineKey {
      lanes = machineFleet.machine(for: key)?.projects.first { $0.projectId == copy.project.id }?.lanes ?? []
    } else {
      lanes = syncService.projects.first { $0.id == copy.project.id }
        .flatMap { syncService.rosterProject(for: $0)?.lanes } ?? []
    }
    return lanes.filter { ($0.laneType ?? "") != "primary" }
  }

  private func lanes(forProjectId id: String) -> [RemoteRosterLane] {
    if pickedAccountCloud { return accountCloudLanes(accountProjectId: id) }
    let lanes: [RemoteRosterLane]
    if pickedMachineKey != nil {
      lanes = pickedRemoteMachine?.projects.first { $0.projectId == id }?.lanes ?? []
    } else {
      guard !id.isEmpty, let project = syncService.projects.first(where: { $0.id == id }) else { return [] }
      lanes = syncService.rosterProject(for: project)?.lanes ?? []
    }
    return pickedMachineIsCloud ? lanes.filter { ($0.laneType ?? "") != "primary" } : lanes
  }

  /// Primary lane for a project (or its first lane); falls back to the
  /// auto-create sentinel when the project has no synced lanes yet.
  private func defaultLaneId(forProjectId id: String) -> String {
    let lanes = lanes(forProjectId: id)
    if let primary = lanes.first(where: { ($0.laneType ?? "") == "primary" }) {
      return primary.id
    }
    if let first = lanes.first {
      return first.id
    }
    if pickedAccountCloud { return workAutoCreateLaneSentinelId }
    return pickedMachineIsCloud ? "" : workAutoCreateLaneSentinelId
  }

  /// Reconciles the (possibly persisted) destination against the live project +
  /// lane lists: keep a still-valid choice, else fall back to the active project
  /// (then first) and that project's primary/first lane.
  /// A test for folders of projects removed from ADE, built once for a pass.
  /// The picker hides them, so the composer neither keeps nor sends to one.
  private func removedFromAccount() -> (MobileProjectSummary, String?) -> Bool {
    guard let resolver = syncService.accountProjectResolver(), !resolver.removedIds.isEmpty else { return { _, _ in false } }
    return { project, machineKey in
      syncService.accountProjectId(forCheckout: project, onMachine: machineKey, resolver: resolver)
        .map { resolver.removedIds.contains($0) } ?? false
    }
  }

  private func reconcileDestination() {
    guard !holdsDestination else { return }
    let isRemoved = removedFromAccount()
    if let picked = pickedProject, isRemoved(picked, pickedMachineKey) {
      pickedMachineKey = nil
      pickedProjectId = ""
    }
    if pickedAccountCloud {
      // ADE Cloud through the account: kept while the project is on it.
      if accountCloudProject != nil {
        if !isAutoCreateLane, !lanesForPickedProject.contains(where: { $0.id == selectedLaneId }) {
          selectedLaneId = workAutoCreateLaneSentinelId
        }
        return
      }
      pickedMachineKey = nil
      pickedProjectId = ""
    }
    if let key = pickedMachineKey {
      if key == syncService.focusedMachineKey {
        // That machine became primary: the same project id names it there.
        pickedMachineKey = nil
      } else if pickedRemoteProject != nil {
        if !isAutoCreateLane, !lanesForPickedProject.contains(where: { $0.id == selectedLaneId }) {
          selectedLaneId = defaultLaneId(forProjectId: pickedProjectId)
        }
        return
      } else {
        // The machine went away or no longer has the project.
        pickedMachineKey = nil
        pickedProjectId = ""
      }
    }
    let projects = syncService.projects.filter { !isRemoved($0, nil) }
    guard !projects.isEmpty else {
      pickedProjectId = ""
      selectedLaneId = ""
      return
    }
    if pickedProjectId.isEmpty || !projects.contains(where: { $0.id == pickedProjectId }) {
      let active = syncService.activeProject.flatMap { active in projects.first { $0.id == active.id } }
      let resolvedProjectId = active?.id ?? projects[0].id
      pickedProjectId = resolvedProjectId
      selectedLaneId = defaultLaneId(forProjectId: resolvedProjectId)
      return
    }
    if !isAutoCreateLane || pickedMachineIsCloud {
      let lanes = lanesForPickedProject
      if selectedLaneId.isEmpty || !lanes.contains(where: { $0.id == selectedLaneId }) {
        selectedLaneId = defaultLaneId(forProjectId: pickedProjectId)
      }
    }
  }

  private func rememberLiveSelection() {
    let live = HubComposerLiveSelection.shared
    live.projectId = pickedProjectId
    live.laneId = selectedLaneId
    live.machineKey = pickedMachineKey
    live.pickerOpen = destinationPickerPresented
  }

  // MARK: Last-destination persistence (App Group)

  private struct HubLastDestination: Codable, Equatable {
    var projectId: String
    var laneId: String
  }

  /// Removed on sign-out with the account's other stores (`AccountService.publishSignedOut`).
  static let lastDestinationKey = "ade.hub.lastDestination.v1"

  private static func loadLastDestination() -> HubLastDestination? {
    guard let data = ADESharedContainer.defaults.data(forKey: lastDestinationKey) else { return nil }
    return try? JSONDecoder().decode(HubLastDestination.self, from: data)
  }

  private func saveLastDestination(projectId: String, laneId: String) {
    let trimmed = projectId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    let dest = HubLastDestination(projectId: trimmed, laneId: laneId)
    guard let data = try? JSONEncoder().encode(dest) else { return }
    ADESharedContainer.defaults.set(data, forKey: HubInlineComposer.lastDestinationKey)
  }

}

// MARK: - File-private helpers (mirror the private new-chat-screen helpers)

/// Collapse a free-form provider key to a chat-capable runtime family, matching
/// the new-chat screen so routed Pi and Droid models stay on their native
/// runtimes instead of silently routing to Claude.
private func hubNormalizedChatProvider(_ provider: String) -> String {
  workNormalizedChatProvider(provider)
}

/// CLI runtimes that accept a reasoning-effort selection (mirrors the new-chat
/// screen's `workCliSupportsReasoningSelection`).
private func hubCliSupportsReasoning(provider: String) -> Bool {
  let family = providerFamilyKey(provider)
  return family == "claude" || family == "codex" || family == "muse" || family == "droid" || family == "pi"
}

/// Derive a short CLI session title from the opener (mirrors the new-chat
/// screen's `workCliInitialSessionTitle`).
private func hubCliInitialTitle(opener: String, provider: String) -> String {
  let fallback = providerLabel(provider)
  let seed = opener
    .replacingOccurrences(of: "\n", with: " ")
    .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
    .trimmingCharacters(in: .whitespacesAndNewlines)
  guard !seed.isEmpty else { return fallback }
  let clipped: String
  if seed.count > 72 {
    let prefix = String(seed.prefix(72))
    clipped = prefix.replacingOccurrences(of: #"\s+\S*$"#, with: "", options: .regularExpression)
  } else {
    clipped = seed
  }
  return clipped.trimmingCharacters(in: CharacterSet(charactersIn: ".?!,:; ").union(.whitespacesAndNewlines))
}

/// Beautify a raw model id for the composer pill (mirrors the new-chat screen's
/// `prettyNewChatModelName`), preferring the host-known display name.
private func hubPrettyModelName(_ model: String) -> String {
  let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return "Model" }
  if let entry = WorkModelMentionDirectory.shared.entry(for: trimmed) {
    let title = entry.title.trimmingCharacters(in: .whitespacesAndNewlines)
    if !title.isEmpty { return title }
  }
  if let known = workKnownModelDisplayName(trimmed) {
    return known
  }
  if let pretty = workPrettyModelNameFromId(trimmed) {
    return pretty
  }
  return trimmed
}

/// The Hub composer's destination while the app runs. Each pose lays the Hub
/// out in its own container, so the composer is built again on a fold or an
/// unfold; it reads this, and the project, lane, computer and an open picker
/// stay as the person left them. A send saves the lasting default
/// (`HubLastDestination`) as before.
@MainActor
final class HubComposerLiveSelection {
  static let shared = HubComposerLiveSelection()
  /// Nil until the person (or a restore) picks a project in this run.
  var projectId: String?
  var laneId = ""
  var machineKey: String?
  var pickerOpen = false
}

/// The account project as the composer's project row for its ADE Cloud copy.
private func hubAccountCloudSummary(_ project: AccountProject) -> MobileProjectSummary {
  var summary = MobileProjectSummary(
    id: project.id,
    displayName: project.name,
    repoOwner: project.owner,
    repoName: project.name,
    defaultBaseRef: project.defaultBranch,
    laneCount: 0,
    isAvailable: true,
    isCached: false
  )
  summary.accountProjectId = project.id
  return summary
}
