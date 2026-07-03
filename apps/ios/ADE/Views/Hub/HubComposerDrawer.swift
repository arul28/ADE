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

/// Reports the destination control's global top edge so the picker popover can
/// size to the room above it.
private struct HubDestinationTopKey: PreferenceKey {
  static var defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

// MARK: - Inline composer

/// The one animation every hub-composer expand/collapse rides on — shared with
/// HubScreen so a tap-outside collapse moves identically to a focus expand.
let hubComposerSpring = Animation.spring(response: 0.34, dampingFraction: 0.86)

struct HubInlineComposer: View {
  @EnvironmentObject private var syncService: SyncService

  /// Owned by the hub so taps on the list behind the composer can collapse it.
  @Binding var expanded: Bool
  let onCreated: (HubCreatedChat) -> Void

  // Composer selection (seeded from the app-wide "last used" record in init so
  // the provider/model onChange handlers don't reset runtimeMode on first
  // layout — same gotcha the in-project new-chat screen guards against).
  @State private var provider: String = "claude"
  @State private var modelId: String = "claude-sonnet-4-6"
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

  // UI / flow.
  @State private var draft: String = ""
  @State private var busy: Bool = false
  @State private var errorMessage: String?
  @State private var modelPickerPresented = false
  @State private var destinationPickerPresented = false
  @State private var isDictating = false
  @State private var controlsWidth: CGFloat = 0
  // Global top edge of the destination control, so the picker popover can size
  // itself to the room above it (and never overflow the top of the screen).
  @State private var destinationControlTopY: CGFloat = 0
  @FocusState private var composerFocused: Bool
  @StateObject private var dictationCoordinator = DictationInsertionCoordinator()

  private let dictationTargetId = "hub-new-chat-drawer"

  init(expanded: Binding<Bool>, onCreated: @escaping (HubCreatedChat) -> Void) {
    self._expanded = expanded
    self.onCreated = onCreated
    if let saved = WorkComposerPreferences.load() {
      _provider = State(initialValue: saved.provider)
      _modelId = State(initialValue: saved.modelId)
      _runtimeMode = State(initialValue: saved.runtimeMode)
      _reasoningEffort = State(initialValue: saved.reasoningEffort)
      _codexFastMode = State(initialValue: saved.codexFastMode)
    }
    if let dest = HubInlineComposer.loadLastDestination() {
      _pickedProjectId = State(initialValue: dest.projectId)
      _selectedLaneId = State(initialValue: dest.laneId)
    }
  }

  // MARK: Derived state

  /// Expanded while the user is composing, dictating, or inside one of the
  /// pickers (presenting a sheet/popover can resign the text field's focus —
  /// the panel must not collapse underneath it). `expanded` is explicit state
  /// (not derived from focus) so every change happens inside a spring
  /// transaction instead of snapping with the focus flip.
  private var isExpanded: Bool {
    expanded || isDictating || modelPickerPresented || destinationPickerPresented
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
    syncService.projects.first { $0.id == pickedProjectId }
  }

  private var lanesForPickedProject: [RemoteRosterLane] {
    lanes(forProjectId: pickedProjectId)
  }

  private var isAutoCreateLane: Bool {
    selectedLaneId == workAutoCreateLaneSentinelId
  }

  private var selectedLaneName: String {
    if isAutoCreateLane { return "Auto-create lane" }
    if let lane = lanesForPickedProject.first(where: { $0.id == selectedLaneId }) {
      return lane.name
    }
    return selectedLaneId.isEmpty ? "Select lane" : selectedLaneId
  }

  private var selectedLaneTint: Color {
    guard let lane = lanesForPickedProject.first(where: { $0.id == selectedLaneId }) else {
      return ADEColor.textMuted
    }
    return LaneColorPalette.displayColor(forHex: lane.color)
  }

  /// Fast mode only applies to in-app chat sessions on fast-tier models — the
  /// CLI launcher has no fast-mode parameter — so the lightning toggle (and the
  /// value we send) is gated on both. The live picker option can only *add*
  /// support; the catalog/allow-list fallback still shows the toggle for a
  /// known-fast model whose option ships empty `serviceTiers`.
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

  private var trimmedDraft: String {
    draft.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var canSend: Bool {
    canStart && !trimmedDraft.isEmpty
  }

  private var isControlsCollapsed: Bool {
    controlsWidth > 0 && controlsWidth <= workComposerControlsCollapseThreshold
  }

  // MARK: Body

  var body: some View {
    VStack(spacing: 12) {
      if isExpanded {
        destinationControl
          .transition(.move(edge: .bottom).combined(with: .opacity))
        if !isDictating {
          WorkSessionTypeSwitcher(selection: $sessionMode)
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
    .padding(.bottom, 8)
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
    .onChange(of: composerFocused) { _, focused in
      if focused { withAnimation(hubComposerSpring) { expanded = true } }
    }
    .onChange(of: expanded) { _, nowExpanded in
      // The hub collapses us from the outside (tap on the list) by flipping the
      // binding — drop focus so the keyboard goes down with the panel.
      if !nowExpanded { composerFocused = false }
    }
    // The keyboard can disappear without SwiftUI clearing focus (interactive
    // scroll dismissal, hardware-keyboard toggles). Never leave the panel
    // expanded with no keyboard and no way out — unless a picker or dictation
    // legitimately owns the screen.
    .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
      guard expanded, !modelPickerPresented, !destinationPickerPresented, !isDictating else { return }
      collapse()
    }
    .onChange(of: provider) { _, newProvider in
      runtimeMode = workDefaultRuntimeMode(provider: newProvider)
      if !hubChatModelBelongs(modelId, to: hubNormalizedChatProvider(newProvider)) {
        modelId = hubDefaultChatModelId(provider: newProvider)
      }
      if !modelSupportsReasoning(modelId: modelId, provider: newProvider) {
        reasoningEffort = ""
      }
      if !fastModeSupported {
        codexFastMode = false
      }
    }
    .onChange(of: sessionMode) { _, newMode in
      normalizeSelection(for: newMode)
    }
    .onChange(of: modelId) { _, newModel in
      if !modelSupportsReasoning(modelId: newModel, provider: provider) {
        reasoningEffort = ""
      }
      if !fastModeSupported {
        codexFastMode = false
      }
    }
    .onChange(of: composerSelection) { _, newValue in
      WorkComposerPreferences.save(newValue)
    }
    // Projects/lanes can appear or vanish while the hub sits open (reconnects,
    // roster refreshes) — keep the persisted destination honest against them.
    .onChange(of: syncService.rosterRevision) { _, _ in reconcileDestination() }
    .onChange(of: syncService.projects.map(\.id)) { _, _ in reconcileDestination() }
    .sheet(isPresented: $modelPickerPresented, onDismiss: { composerFocused = true }) {
      WorkModelPickerSheet(
        currentModelId: modelId,
        currentProvider: provider,
        currentReasoningEffort: reasoningEffort,
        cursorAvailabilityMode: sessionMode == .cli ? .cli : .chat,
        isBusy: false,
        onSelect: { option, pickedReasoning, runtimeProvider in
          selectedModelOption = option
          modelId = option.id
          provider = sessionMode == .chat
            ? hubNormalizedChatProvider(runtimeProvider)
            : workResolveCliProvider(for: option.id, provider: runtimeProvider)
          reasoningEffort = pickedReasoning ?? ""
          runtimeMode = workDefaultRuntimeMode(provider: provider)
          modelPickerPresented = false
        }
      )
      .environmentObject(syncService)
    }
  }

  // MARK: Combined destination control (Project ▸ Lane)

  private var destinationControl: some View {
    Button {
      destinationPickerPresented = true
    } label: {
      HStack(spacing: 8) {
        Image(systemName: "folder.fill")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.accent)

        Text(pickedProject?.displayName ?? "Select project")
          .font(.system(.subheadline, design: .rounded).weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)

        Image(systemName: "chevron.compact.right")
          .font(.system(size: 12, weight: .bold))
          .foregroundStyle(ADEColor.textMuted.opacity(0.7))

        laneTag

        Spacer(minLength: 4)

        Image(systemName: "chevron.up.chevron.down")
          .font(.system(size: 11, weight: .bold))
          .foregroundStyle(ADEColor.textMuted.opacity(0.7))
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 9)
      .background(ADEColor.cardBackground.opacity(0.62), in: Capsule(style: .continuous))
      .overlay(Capsule(style: .continuous).stroke(ADEColor.border.opacity(0.8), lineWidth: 1))
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .background(
      GeometryReader { proxy in
        Color.clear.preference(key: HubDestinationTopKey.self, value: proxy.frame(in: .global).minY)
      }
    )
    .onPreferenceChange(HubDestinationTopKey.self) { destinationControlTopY = $0 }
    .accessibilityLabel("Destination")
    .accessibilityValue("\(pickedProject?.displayName ?? "No project"), \(selectedLaneName)")
    .accessibilityHint("Choose the project and lane for this chat.")
    .popover(isPresented: $destinationPickerPresented, attachmentAnchor: .rect(.bounds), arrowEdge: .bottom) {
      destinationPicker
        .presentationCompactAdaptation(.popover)
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
          .font(.system(size: 10, weight: .bold))
        Text("Auto-create lane")
          .font(.system(.caption, design: .rounded).weight(.medium))
          .lineLimit(1)
      }
      .foregroundStyle(
        LinearGradient(
          colors: [ADEColor.accent, ADEColor.purpleAccent],
          startPoint: .leading,
          endPoint: .trailing
        )
      )
    } else {
      HStack(spacing: 5) {
        Circle().fill(selectedLaneTint).frame(width: 7, height: 7)
        Text(selectedLaneName)
          .font(.system(.caption, design: .rounded).weight(.medium))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
      }
    }
  }

  /// The picker fills the room between the destination control and the top of
  /// the screen (minus a small margin) so it never overflows and clips a
  /// project — the two sections then split that height evenly. Falls back to a
  /// device fraction until the control's position has been measured.
  private var destinationPickerHeight: CGFloat {
    let deviceCap = min(UIScreen.main.bounds.height * 0.62, 560)
    guard destinationControlTopY > 0 else { return min(deviceCap, 320) }
    let available = destinationControlTopY - 64
    return max(240, min(deviceCap, available))
  }

  private var destinationPicker: some View {
    VStack(spacing: 0) {
      sectionLabel("PROJECT")
      ScrollView {
        LazyVStack(spacing: 2) {
          if syncService.projects.isEmpty {
            emptyPickerRow("No projects on this machine")
          } else {
            ForEach(syncService.projects) { project in
              projectRow(project)
            }
          }
        }
        .padding(4)
      }
      .frame(maxHeight: .infinity)

      Divider().overlay(ADEColor.glassBorder)

      sectionLabel("LANE")
      ScrollView {
        LazyVStack(spacing: 2) {
          autoCreateLaneRow
          ForEach(lanesForPickedProject) { lane in
            laneRow(lane)
          }
        }
        .padding(4)
      }
      .frame(maxHeight: .infinity)
    }
    .frame(width: 320, height: destinationPickerHeight)
    .background(ADEColor.cardBackground.opacity(0.98))
    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(ADEColor.glassBorder, lineWidth: 0.8))
  }

  private func sectionLabel(_ text: String) -> some View {
    HStack {
      Text(text)
        .font(.system(.caption2, design: .rounded).weight(.bold))
        .tracking(0.6)
        .foregroundStyle(ADEColor.textMuted)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 12)
    .padding(.top, 10)
    .padding(.bottom, 4)
  }

  private func emptyPickerRow(_ text: String) -> some View {
    Text(text)
      .font(.system(.caption, design: .rounded))
      .foregroundStyle(ADEColor.textMuted)
      .frame(maxWidth: .infinity)
      .padding(.vertical, 12)
  }

  private func projectRow(_ project: MobileProjectSummary) -> some View {
    let isSelected = project.id == pickedProjectId
    return Button {
      guard project.id != pickedProjectId else { return }
      pickedProjectId = project.id
      // Switching projects resets the lane to that project's default; the user
      // can still tap a specific lane (or auto-create) below to confirm.
      selectedLaneId = defaultLaneId(forProjectId: project.id)
    } label: {
      HStack(spacing: 9) {
        HubProjectIcon(iconDataUrl: project.iconDataUrl, isActive: isSelected)
        Text(project.displayName)
          .font(.system(.footnote, design: .rounded).weight(isSelected ? .semibold : .regular))
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
        isSelected ? ADEColor.accent.opacity(0.12) : Color.clear,
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
          .font(.system(size: 12, weight: .bold))
          .foregroundStyle(ADEColor.accent)
        Text("Auto-create lane")
          .font(.system(.footnote, design: .rounded).weight(.medium))
          .foregroundStyle(
            LinearGradient(
              colors: [ADEColor.accent, ADEColor.purpleAccent],
              startPoint: .leading,
              endPoint: .trailing
            )
          )
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
        isAutoCreateLane ? ADEColor.accent.opacity(0.12) : Color.clear,
        in: RoundedRectangle(cornerRadius: 8, style: .continuous)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  private func laneRow(_ lane: RemoteRosterLane) -> some View {
    let isSelected = lane.id == selectedLaneId
    let tint = LaneColorPalette.displayColor(forHex: lane.color)
    let branch = normalizedPrBranchName(lane.branchRef)
    return Button {
      selectedLaneId = lane.id
      destinationPickerPresented = false
    } label: {
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 8) {
          Circle().fill(tint).frame(width: 8, height: 8)
          Text(lane.name)
            .font(.system(.footnote, design: .rounded).weight(isSelected ? .semibold : .regular))
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
              .font(.system(size: 10, design: .rounded))
              .foregroundStyle(ADEColor.textMuted.opacity(0.9))
              .lineLimit(1)
          }
          .padding(.leading, 16)
        }
      }
      .padding(.horizontal, 8)
      .padding(.vertical, branch.isEmpty ? 6 : 5)
      .background(
        isSelected ? ADEColor.accent.opacity(0.12) : Color.clear,
        in: RoundedRectangle(cornerRadius: 8, style: .continuous)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  // MARK: Composer card

  /// One card that morphs between two densities: minimized it reads as the old
  /// "type to vibecode" capsule (sparkles + field + send), expanded it grows the
  /// controls row (model/mode/fast/dictation) beneath the field.
  private var composerCard: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .center, spacing: 10) {
        if !isExpanded {
          Image(systemName: "sparkles")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(ADEColor.accent)
            .transition(.opacity)
        }

        TextField("Type to vibecode…", text: $draft, axis: .vertical)
          .textFieldStyle(.plain)
          .lineLimit(1...6)
          .font(.body)
          .foregroundStyle(ADEColor.textPrimary)
          .tint(ADEColor.accent)
          .textInputAutocapitalization(.sentences)
          .focused($composerFocused)
          .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)

        if !isExpanded {
          ADEComposerSendButton(
            enabled: canSend && !busy,
            sending: busy,
            accessibilityLabelText: "Start chat",
            disabledAccessibilityLabel: "Enter a message to start"
          ) {
            dispatch()
          }
          .transition(.opacity)
        }
      }

      if isExpanded {
        HStack(alignment: .center, spacing: 8) {
          if !isDictating {
            ScrollView(.horizontal, showsIndicators: false) {
              WorkComposerControlsRow(
                provider: provider,
                modelDisplayName: hubPrettyModelName(modelId),
                reasoningEffort: reasoningEffort,
                currentMode: runtimeMode,
                modeOptions: workRuntimeModeOptions(provider: provider),
                modeLabel: workRuntimeModeLabel(provider: provider, mode: runtimeMode),
                isCollapsed: isControlsCollapsed,
                fastModeSupported: fastModeSupported,
                fastModeEnabled: codexFastMode,
                settingsMutationInFlight: busy,
                onOpenModelPicker: { modelPickerPresented = true },
                onSelectMode: { runtimeMode = $0 },
                onToggleFastMode: { codexFastMode = $0 }
              )
              .padding(.trailing, 4)
            }
            .background(
              GeometryReader { proxy in
                Color.clear
                  .onAppear { controlsWidth = proxy.size.width }
                  .onChange(of: proxy.size.width) { _, newValue in
                    controlsWidth = newValue
                  }
              }
            )

            DictationRawUndoChip(coordinator: dictationCoordinator, draft: $draft)
          }

          DictationMicButton(
            draft: $draft,
            coordinator: dictationCoordinator,
            targetId: dictationTargetId,
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
        .transition(.move(edge: .top).combined(with: .opacity))
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, isExpanded ? 14 : 10)
    .background {
      RoundedRectangle(cornerRadius: isExpanded ? 22 : 26, style: .continuous)
        .fill(ADEColor.pageBackground)
      RoundedRectangle(cornerRadius: isExpanded ? 22 : 26, style: .continuous)
        .fill(ADEColor.composerBackground)
    }
    .overlay(
      RoundedRectangle(cornerRadius: isExpanded ? 22 : 26, style: .continuous)
        .stroke(isExpanded ? ADEColor.glassBorder : ADEColor.border.opacity(0.8), lineWidth: 1)
    )
    .shadow(color: Color.black.opacity(isExpanded ? 0.16 : 0), radius: 8, y: 3)
  }

  // MARK: Actions

  @MainActor
  private func onAppearSetup() {
    // A restored selection (see init) can carry a model only valid in the mode
    // it was last used in (e.g. a CLI-only Cursor model). The composer starts in
    // .chat, so normalize only when the restored model is actually disallowed —
    // a valid restored selection keeps its runtimeMode.
    let availabilityMode: WorkCursorAvailabilityMode = sessionMode == .cli ? .cli : .chat
    if !workModelAllowedForAvailabilityMode(modelId: modelId, provider: provider, mode: availabilityMode) {
      normalizeSelection(for: sessionMode)
    }
    if runtimeMode.isEmpty {
      runtimeMode = workDefaultRuntimeMode(provider: provider)
    }
    reconcileDestination()
  }

  @MainActor
  private func dispatch() {
    let text = trimmedDraft
    guard !text.isEmpty else { return }
    draft = ""
    Task {
      let started = await submit(opener: text)
      if !started {
        draft = text
      }
    }
  }

  @MainActor
  private func submit(opener rawOpener: String) async -> Bool {
    let opener = rawOpener.trimmingCharacters(in: .whitespacesAndNewlines)
    guard canStart, !opener.isEmpty, !modelId.isEmpty else { return false }
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
    let normalizedReasoning = reasoningEffort.trimmingCharacters(in: .whitespacesAndNewlines)

    // Resolve the target lane. Auto-create mints a fresh lane in the TARGET
    // project first; on failure we surface the error and never create the chat.
    // Track the minted lane so we can tear it back down if the chat launch
    // fails immediately afterwards (desktop parity — no orphaned empty lane).
    let targetLaneId: String
    let targetLaneName: String
    var createdLaneId: String?
    if isAutoCreateLane {
      let name = workDeterministicAutoLaneName(from: opener, genericSuffix: workAutoLaneGenericSuffix())
      do {
        let lane = try await syncService.createLane(
          name: name,
          description: opener.isEmpty ? "" : String(opener.prefix(280)),
          targetProjectId: targetProjectId,
          targetProjectRootPath: targetProjectRootPath
        )
        targetLaneId = lane.id
        targetLaneName = lane.name
        createdLaneId = lane.id
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

    do {
      let isCli = sessionMode == .cli
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
          initialInput: opener,
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
          // Send an explicit true/false when fast mode applies so the user's
          // choice (including an explicit OFF) is honored; nil only when N/A.
          codexFastMode: fastModeSupported ? codexFastMode : nil,
          permissionMode: wire.permissionMode,
          interactionMode: wire.interactionMode,
          claudePermissionMode: wire.claudePermissionMode,
          codexApprovalPolicy: wire.codexApprovalPolicy,
          codexSandbox: wire.codexSandbox,
          codexConfigSource: wire.codexConfigSource,
          opencodePermissionMode: wire.opencodePermissionMode,
          droidPermissionMode: wire.droidPermissionMode,
          cursorModeId: wire.cursorModeId,
          targetProjectId: targetProjectId,
          targetProjectRootPath: targetProjectRootPath
        )
        sessionId = summary.sessionId
        try await syncService.sendChatMessage(
          sessionId: summary.sessionId,
          text: opener,
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

      let created = HubCreatedChat(
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
      return true
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
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

  // MARK: Destination resolution

  private func lanes(forProjectId id: String) -> [RemoteRosterLane] {
    guard !id.isEmpty, let project = syncService.projects.first(where: { $0.id == id }) else { return [] }
    return syncService.rosterProject(for: project)?.lanes ?? []
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
    return workAutoCreateLaneSentinelId
  }

  /// Reconciles the (possibly persisted) destination against the live project +
  /// lane lists: keep a still-valid choice, else fall back to the active project
  /// (then first) and that project's primary/first lane.
  private func reconcileDestination() {
    let projects = syncService.projects
    guard !projects.isEmpty else {
      pickedProjectId = ""
      selectedLaneId = ""
      return
    }
    if pickedProjectId.isEmpty || !projects.contains(where: { $0.id == pickedProjectId }) {
      pickedProjectId = syncService.activeProject?.id ?? projects[0].id
      selectedLaneId = defaultLaneId(forProjectId: pickedProjectId)
      return
    }
    if !isAutoCreateLane {
      let lanes = lanesForPickedProject
      if selectedLaneId.isEmpty || !lanes.contains(where: { $0.id == selectedLaneId }) {
        selectedLaneId = defaultLaneId(forProjectId: pickedProjectId)
      }
    }
  }

  // MARK: Last-destination persistence (App Group)

  private struct HubLastDestination: Codable, Equatable {
    var projectId: String
    var laneId: String
  }

  private static let lastDestinationKey = "ade.hub.lastDestination.v1"

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

  // MARK: Composer normalization (self-contained mirrors of the new-chat screen)

  private func normalizeSelection(for mode: WorkNewSessionMode) {
    let availabilityMode: WorkCursorAvailabilityMode = mode == .cli ? .cli : .chat
    if !workModelAllowedForAvailabilityMode(modelId: modelId, provider: provider, mode: availabilityMode),
       let replacement = workDefaultModelIdForAvailabilityMode(preferredProvider: provider, mode: availabilityMode) {
      modelId = replacement.modelId
      provider = mode == .chat
        ? hubNormalizedChatProvider(replacement.provider)
        : workResolveCliProvider(for: replacement.modelId, provider: replacement.provider)
    } else if mode == .chat {
      provider = hubNormalizedChatProvider(provider)
      if !hubChatModelBelongs(modelId, to: provider) {
        modelId = hubDefaultChatModelId(provider: provider)
      }
    } else {
      provider = workResolveCliProvider(for: modelId, provider: provider)
    }
    runtimeMode = workDefaultRuntimeMode(provider: provider)
    if !modelSupportsReasoning(modelId: modelId, provider: provider) {
      reasoningEffort = ""
    }
    if !fastModeSupported {
      codexFastMode = false
    }
  }
}

// MARK: - File-private helpers (mirror the private new-chat-screen helpers)

/// Collapse a free-form provider key to a chat-capable runtime family, matching
/// the new-chat screen so a picked Droid Core model stays on the droid runtime
/// instead of silently routing to Claude.
private func hubNormalizedChatProvider(_ provider: String) -> String {
  let family = providerFamilyKey(provider)
  return ["claude", "codex", "cursor", "opencode", "droid"].contains(family) ? family : "claude"
}

private func hubChatModelBelongs(_ modelId: String, to provider: String) -> Bool {
  let trimmed = modelId.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return false }
  return workModelCatalogGroupKey(for: trimmed, currentProvider: provider) == provider
}

private func hubDefaultChatModelId(provider: String) -> String {
  let family = providerFamilyKey(provider)
  if let defaultModel = workDefaultCatalogModelId(provider: family) {
    return defaultModel
  }
  switch hubNormalizedChatProvider(provider) {
  case "codex": return workDefaultCatalogModelId(provider: "codex") ?? "gpt-5.5"
  case "cursor": return "auto"
  case "opencode": return "opencode/anthropic/claude-sonnet-4-6"
  default: return "claude-sonnet-4-6"
  }
}

/// CLI runtimes that accept a reasoning-effort selection (mirrors the new-chat
/// screen's `workCliSupportsReasoningSelection`).
private func hubCliSupportsReasoning(provider: String) -> Bool {
  let family = providerFamilyKey(provider)
  return family == "claude" || family == "codex" || family == "droid"
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
  if let known = workKnownModelDisplayName(trimmed) {
    return known
  }
  let lower = trimmed.lowercased()
  switch lower {
  case "opus": return "Claude Opus 4.7"
  case "opus[1m]", "opus-1m": return "Claude Opus 4.7 1M"
  case "sonnet": return "Claude Sonnet 4.6"
  case "haiku": return "Claude Haiku 4.5"
  default: break
  }
  if lower.hasPrefix("claude-") {
    let tail = trimmed.dropFirst("claude-".count)
    let joined = tail.split(separator: "-").map { part -> String in
      let s = String(part)
      if s.range(of: #"^\d+$"#, options: .regularExpression) != nil { return s }
      return s.prefix(1).uppercased() + s.dropFirst()
    }.joined(separator: " ")
    return "Claude " + joined.replacingOccurrences(of: #"(\d+) (\d+)"#, with: "$1.$2", options: .regularExpression)
  }
  return trimmed
}
