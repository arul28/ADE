import SwiftUI
import UIKit

/// Top-level CTO tab. The tab body IS the CTO chat: one always-on agent
/// thread, headed by a floating pill (the CTO's live avatar, its name and one
/// status word) that opens its profile. Until a model that can steer a live
/// turn has been picked, the CTO sleeps on a welcome page in the thread's
/// place.
struct CtoRootScreen: View {
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }
  @Environment(\.duoLayout) private var duo
  var isTabActive = true

  @StateObject private var store = CtoStore()
  @StateObject private var live = CtoLiveModel()
  @State private var isLoadingSnapshot = false
  @State private var snapshotLoadError: String?
  @State private var lastLiveSnapshotReloadAt: Date?
  @State private var sheet: CtoRootSheet?
  @State private var showingModelPicker = false
  @State private var modelPickInFlight = false
  @State private var modelPickError: String?
  @State private var waking = false
  /// Changing the home from the asleep card ("Pick another home").
  @State private var showingHomeChooser = false
  /// "Moved from …" after a move that took the CTO's account copy.
  @State private var moveNote: ADEToastMessage?

  /// The pane beside the CTO thread on a wide display (Chat Info, CTO
  /// Settings), the same model Work's chat column owns.
  @StateObject private var duoPane = DuoWorkPaneModel()
  /// The Duo's closed display, held upright: its rail beside the thread, so
  /// the composer lines up with the rail's bottom, as in a Work chat.
  @State private var compactEdgeRail = false

  var body: some View {
    wideBody
      .task(id: "\(isTabActive)|\(syncService.activeProjectId ?? "")") {
        guard isTabActive else { return }
        wireLive()
        // The CTO follows the project's home machine; a change there reloads.
        let previousHome = syncService.ctoHomeMachineKey
        let hadHome = !syncService.ctoHomeNeedsChoice
        await syncService.refreshCtoHomeMachine()
        let changed = store.snapshot == nil
          || syncService.ctoHomeMachineKey != previousHome
          || (!hadHome && !syncService.ctoHomeNeedsChoice)
        // No home yet: the chooser asks, and nothing is called meanwhile.
        guard changed, !syncService.ctoHomeNeedsChoice else { return }
        await loadSnapshot()
      }
      .onChange(of: syncService.ctoHomeNeedsChoice) { _, needsChoice in
        // A home picked from Settings: load that machine's CTO.
        guard !needsChoice else { return }
        Task { await loadSnapshot() }
      }
      .task(id: ctoLiveReloadKey) {
        guard ctoLiveReloadKey != nil else { return }
        let now = Date()
        guard shouldRunCtoLiveReload(lastReloadAt: lastLiveSnapshotReloadAt, now: now) else { return }
        lastLiveSnapshotReloadAt = now
        await loadSnapshot()
      }
      .onChange(of: store.snapshot) { _, snapshot in applySnapshot(snapshot) }
      .onChange(of: syncService.connectionState.isHostUnreachable) { _, unreachable in
        live.offline = unreachable
      }
      .adeToast($moveNote)
      .sheet(item: $sheet) { which in
        switch which {
        case .profile:
          CtoProfileSheet(live: live, store: store)
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
            .presentationBackground(ADEColor.pageBackground)
            .environmentObject(syncService)
        case .settings(let route):
          CtoSettingsScreen(store: store, live: live, initialRoute: route)
            .environmentObject(syncService)
        }
      }
  }

  /// Moves the CTO to `option`, then says what came along.
  @MainActor
  private func moveHome(to option: WorkNewChatMachineOption) async throws -> String? {
    let note = try await ctoChooseHome(option, sync: syncService)
    if let note { moveNote = ADEToastMessage(text: note) }
    await loadSnapshot()
    return note
  }

  private func wireLive() {
    live.onOpenProfile = { sheet = .profile }
    live.onOpenSettings = { sheet = .settings(nil) }
    live.offline = syncService.connectionState.isHostUnreachable
  }

  private func applySnapshot(_ snapshot: CtoSnapshot?) {
    guard let identity = snapshot?.identity else { return }
    if live.look != identity.avatar { live.look = identity.avatar }
    let name = store.name
    if live.name != name { live.name = name }
    live.noModel = identity.needsModelPick
  }

  @ViewBuilder
  private var wideBody: some View {
    if case .thread = currentContent, !waking, !syncService.ctoHomeNeedsChoice {
      CtoSessionDestinationView(
        navigationChrome: .embedded,
        duoPane: duoPane,
        duoPaneOpen: duoPane.isOpen,
        title: store.name,
        live: live,
        store: store,
        duoSettings: { [store, live] in
          AnyView(CtoSettingsScreen(store: store, live: live, embedded: true))
        }
      )
      .environmentObject(syncService)
      .tint(live.look.ctoAccent)
      .environment(\.workCompactEdgeRail, compactEdgeRail)
      .onGeometryChange(for: Bool.self) { proxy in
        workDisplayHasEdgeRail(proxy)
      } action: { hasRail in
        if compactEdgeRail != hasRail { compactEdgeRail = hasRail }
      }
      .environment(\.duoWorkFamily, ctoWorkFamily)
    } else {
      NavigationStack {
        content
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .tint(live.look.ctoAccent)
          .adeScreenBackground()
          .navigationTitle("")
          .navigationBarTitleDisplayMode(.inline)
          .toolbar {
            DuoHubBackToolbarItem()
            if store.snapshot != nil {
              ToolbarItem(placement: .topBarTrailing) {
                Button { sheet = .settings(nil) } label: {
                  Label("\(store.name) settings", systemImage: "gearshape")
                }
              }
            }
            DuoAppTabsToolbar()
          }
      }
    }
  }

  /// Where the thread's panes open: beside it on a wide window held flat,
  /// stacked over it when the window is narrow or the fold is bent.
  private var ctoWorkFamily: DuoFamily {
    if !duo.isWide { return .tall }
    return duo.fold.isStacked && duo.bend > 0 ? .tall : .wide
  }

  // MARK: - Content

  private var currentContent: CtoRootContent {
    ctoRootContent(
      identity: store.snapshot?.identity,
      loadError: snapshotLoadError,
      hostUnreachable: syncService.connectionState.isHostUnreachable,
      homeOffline: syncService.ctoHomeIsOffline
    )
  }

  @ViewBuilder
  private var content: some View {
    if syncService.ctoHomeNeedsChoice {
      // No home on the account yet: there is no default, so the person picks.
      CtoHomeChooser(
        look: live.look,
        name: store.name,
        onChoose: { option in try await moveHome(to: option) }
      )
    } else {
      switch currentContent {
      case .modelPick:
        welcome
      case .thread:
        // Only while the wake hop plays.
        welcome
      case .loadError(let message):
        CtoStateCard(
          look: live.look,
          name: store.name,
          state: .error,
          line: "Couldn't wake up",
          detail: message,
          actionTitle: "Try again",
          action: { Task { await loadSnapshot() } }
        )
      case .offline:
        offlineCard
      case .loading:
        CtoStateCard(look: live.look, name: store.name, state: .thinking, line: "Waking up…")
      }
    }
  }

  /// The home cannot be reached now: asleep on ADE Cloud, or offline. Either
  /// way the way on is another home, which brings the notes and chat along.
  private var offlineCard: some View {
    let copy = ctoHomeOfflineCopy(sync: syncService)
    return CtoStateCard(
      look: live.look,
      name: store.name,
      state: .asleep,
      line: copy.line,
      message: copy.message,
      actionTitle: "Reconnect",
      action: {
        Task {
          await syncService.reconnectCtoHome()
          await loadSnapshot()
        }
      },
      secondaryActionTitle: "Pick another home",
      secondaryAction: { showingHomeChooser = true }
    )
    .sheet(isPresented: $showingHomeChooser) {
      CtoHomeChooserSheet(
        look: live.look,
        name: store.name,
        currentName: ctoHomeRowName(syncService),
        onChoose: { option in try await moveHome(to: option) }
      )
      .environmentObject(syncService)
    }
  }

  // MARK: - Welcome

  private var welcome: some View {
    CtoWelcomeView(
      look: live.look,
      name: store.name,
      waking: waking,
      switching: modelPickInFlight,
      error: modelPickError,
      onPick: { showingModelPicker = true }
    )
    .sheet(isPresented: $showingModelPicker) {
      WorkModelPickerSheet(
        currentModelId: "",
        currentProvider: ctoLiveRedirectProviders.first ?? "claude",
        currentReasoningEffort: "",
        currentCodexFastMode: false,
        lanes: [],
        commandScope: .project,
        isBusy: modelPickInFlight,
        // Only providers that can redirect a turn already in flight.
        modelFilter: { providerSupportsLiveRedirect($0.provider) },
        onSelect: { option, pickedReasoning, _, pickedFastMode in
          Task { @MainActor in
            await applyModelPick(option, reasoningEffort: pickedReasoning, fastMode: pickedFastMode)
          }
        }
      )
      .environmentObject(syncService)
    }
  }

  /// Desktop stores the bare model name in `modelPreferences.model` while the
  /// catalog id is `family/model`.
  private func ctoPreferenceModelName(_ modelId: String) -> String {
    modelId.split(separator: "/").last.map(String.init) ?? modelId
  }

  /// Applies the first model pick without starting a second thread: the
  /// preference first (so a restarted session comes up on it), then the live
  /// session onto the exact model, then the wake hop, then the thread.
  @MainActor
  private func applyModelPick(_ option: WorkModelOption, reasoningEffort: String?, fastMode: Bool) async {
    if modelPickInFlight { return }
    modelPickInFlight = true
    modelPickError = nil
    defer { modelPickInFlight = false }

    let pickedReasoning = (reasoningEffort?.isEmpty == false) ? reasoningEffort : nil
    var patch = CtoIdentityPatch()
    patch.modelPreferences = CtoModelPreferences(
      provider: option.provider,
      model: ctoPreferenceModelName(option.id),
      reasoningEffort: pickedReasoning
    )

    do {
      _ = try await syncService.updateCtoIdentity(patch: patch)
      let session = try await syncService.ensureCtoSession()
      _ = try await syncService.updateChatSession(
        sessionId: session.sessionId,
        modelId: option.id,
        reasoningEffort: pickedReasoning,
        codexFastMode: fastMode
      )
      let next = try await syncService.fetchCtoState()
      ADEHaptics.success()
      waking = true
      live.noModel = false
      store.snapshot = next
      try? await Task.sleep(nanoseconds: 1_300_000_000)
      waking = false
    } catch {
      ADEHaptics.error()
      modelPickError = ctoShortError(error, fallback: "Couldn't wake up")
    }
  }

  // MARK: - Loading

  /// The CTO keeps the person's clock: its routines and "now" use this zone
  /// even when it lives on a computer in another one (ADE Cloud runs on UTC).
  /// Written only when it differs.
  @MainActor
  private func syncTimeZoneIfNeeded() async {
    let zone = TimeZone.current.identifier
    guard let identity = store.snapshot?.identity, !zone.isEmpty, identity.timeZone != zone else { return }
    if let next = try? await syncService.updateCtoIdentity(patch: CtoIdentityPatch(timeZone: zone)) {
      store.snapshot = next
    }
  }

  @MainActor
  private func loadSnapshot() async {
    // No home yet: the chooser asks; nothing may be sent to the primary machine.
    guard !syncService.ctoHomeNeedsChoice else { return }
    if isLoadingSnapshot { return }
    isLoadingSnapshot = true
    defer { isLoadingSnapshot = false }
    do {
      store.snapshot = try await syncService.fetchCtoState()
      snapshotLoadError = nil
      await syncTimeZoneIfNeeded()
    } catch {
      if syncService.connectionState.isHostUnreachable {
        snapshotLoadError = nil
      } else {
        snapshotLoadError = ctoShortError(error, fallback: "Couldn't load")
      }
    }
    applySnapshot(store.snapshot)
    // Chats the CTO started, for "Working on 2 things".
    await store.loadChildren()
    let running = store.children.filter { $0.status == .working }.count
    if live.runningChildren != running { live.runningChildren = running }
  }

  private var ctoLiveReloadKey: String? {
    guard isTabActive else { return nil }
    switch syncService.connectionState {
    case .connected:
      return "live-\(syncService.localStateRevision)"
    case .connecting, .disconnected, .error:
      return nil
    }
  }
}

enum CtoRootSheet: Identifiable, Hashable {
  case profile
  case settings(CtoSettingsRoute?)

  var id: String {
    switch self {
    case .profile: return "profile"
    case .settings(let route): return "settings-\(String(describing: route))"
    }
  }
}

/// What the CTO tab renders in place of its thread. Split out so the branch
/// order — "picker before thread", which keeps the tab off the ensure path
/// while no model has been chosen — can be asserted without a UI host.
enum CtoRootContent: Equatable {
  case loading
  case loadError(String)
  case offline
  case modelPick
  case thread
}

/// Mirrors desktop `CtoPage`: the model picker first, then the thread. With no
/// identity yet, an unreachable machine — or a chosen home that cannot be
/// reached now — is "offline" (the asleep avatar), a reachable one that failed
/// is the error, otherwise it is still loading.
func ctoRootContent(
  identity: CtoIdentity?,
  loadError: String?,
  hostUnreachable: Bool,
  homeOffline: Bool = false
) -> CtoRootContent {
  if homeOffline { return .offline }
  guard let identity else {
    if hostUnreachable { return .offline }
    if let loadError { return .loadError(loadError) }
    return .loading
  }
  if identity.needsModelPick { return .modelPick }
  return .thread
}

// MARK: - Welcome and states

/// The CTO is asleep until it has a model. One big sleeping avatar, its name,
/// one status word and one button. Picking a model wakes it with a hop.
struct CtoWelcomeView: View {
  let look: CtoAvatarLook?
  let name: String
  var waking = false
  var switching = false
  var error: String? = nil
  let onPick: () -> Void

  private var state: CtoAvatarState { waking ? .happy : switching ? .thinking : .asleep }
  private var status: String { waking ? "Morning! Let's go." : switching ? "Waking up…" : "Asleep" }

  var body: some View {
    let resolved = CtoResolvedLook(look)
    VStack(spacing: 0) {
      Spacer(minLength: 24)
      ZStack {
        CtoAvatarHalo(color: resolved.color, diameter: 300)
        CtoAvatarView(look: look, state: state, size: 148, motion: .live, label: "\(name), \(status.lowercased())", blips: false)
      }
      .frame(height: 200)
      Text(name)
        .font(.system(.largeTitle, design: .rounded).weight(.bold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
        .padding(.top, 6)
      Text(status)
        .font(.system(.title3, design: .rounded).weight(.medium))
        .foregroundStyle(waking ? resolved.color : ADEColor.textSecondary)
        .lineLimit(1)
        .contentTransition(.opacity)
        .padding(.top, 2)
        .accessibilityIdentifier("Cto.Welcome.Status")
      CtoPrimaryButton(title: "Pick a model to wake", look: look, busy: switching, action: onPick)
        .opacity(waking ? 0 : 1)
        .disabled(waking || switching)
        .padding(.top, 28)
        .accessibilityIdentifier("Cto.Welcome.Pick")
      if let error {
        Text(error)
          .font(.footnote)
          .foregroundStyle(ADEColor.warning)
          .lineLimit(1)
          .padding(.top, 12)
          .padding(.horizontal, 32)
      }
      Spacer(minLength: 24)
      Spacer(minLength: 24)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .animation(.easeOut(duration: 0.25), value: waking)
    .animation(.easeOut(duration: 0.25), value: switching)
  }
}

/// The CTO's one big action: its colour, its eye ink for the label.
struct CtoPrimaryButton: View {
  let title: String
  let look: CtoAvatarLook?
  var busy = false
  let action: () -> Void

  var body: some View {
    let resolved = CtoResolvedLook(look)
    Button(action: action) {
      HStack(spacing: 8) {
        if busy { ProgressView().controlSize(.small).tint(ctoColor(hex: resolved.inkHex)) }
        Text(title)
          .font(.system(.body, design: .rounded).weight(.semibold))
          .lineLimit(1)
      }
      .foregroundStyle(ctoColor(hex: resolved.inkHex))
      .padding(.horizontal, 26)
      .frame(minHeight: 52)
      .background(resolved.color, in: Capsule())
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
  }
}

/// A state the avatar carries (asleep offline, x-eyes on an error, dots while
/// loading) with a few words and at most one action.
struct CtoStateCard: View {
  let look: CtoAvatarLook?
  let name: String
  let state: CtoAvatarState
  let line: String
  var detail: String? = nil
  /// A sentence under the line, when a state needs more than a few words
  /// (the home asleep on ADE Cloud, a machine that is offline).
  var message: String? = nil
  var actionTitle: String? = nil
  var action: (() -> Void)? = nil
  var secondaryActionTitle: String? = nil
  var secondaryAction: (() -> Void)? = nil

  var body: some View {
    let resolved = CtoResolvedLook(look)
    VStack(spacing: 0) {
      Spacer(minLength: 24)
      ZStack {
        CtoAvatarHalo(color: resolved.color, diameter: 240)
        CtoAvatarView(look: look, state: state, size: 112, motion: .live, label: "\(name), \(line.lowercased())", blips: false)
      }
      .frame(height: 160)
      Text(name)
        .font(.system(.title2, design: .rounded).weight(.bold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
      Text(line)
        .font(.system(.subheadline, design: .rounded).weight(.medium))
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)
        .padding(.top, 2)
      if let detail {
        Text(detail)
          .font(.footnote)
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
          .truncationMode(.tail)
          .padding(.horizontal, 40)
          .padding(.top, 6)
      }
      if let message {
        Text(message)
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.horizontal, 32)
          .padding(.top, 8)
      }
      if let actionTitle, let action {
        Button(actionTitle, action: action)
          .font(.system(.body, design: .rounded).weight(.semibold))
          .buttonStyle(.bordered)
          .buttonBorderShape(.capsule)
          .controlSize(.large)
          .tint(resolved.color)
          .padding(.top, 20)
      }
      if let secondaryActionTitle, let secondaryAction {
        Button(secondaryActionTitle, action: secondaryAction)
          .font(.system(.subheadline, design: .rounded).weight(.semibold))
          .buttonStyle(.plain)
          .foregroundStyle(ADEColor.textSecondary)
          .padding(.top, 12)
      }
      Spacer(minLength: 24)
      Spacer(minLength: 24)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}
