import SwiftUI
import UIKit

/// Top-level CTO tab. The tab body IS the CTO chat: one always-on agent thread
/// embedded inline. A gear in the top bar opens settings as a sheet. When the
/// CTO hasn't been set up yet, a first-run setup card takes over the tab until
/// onboarding completes.
struct CtoRootScreen: View {
  @EnvironmentObject private var syncService: SyncService
  var isTabActive = true

  @State private var snapshot: CtoSnapshot?
  @State private var isLoadingSnapshot = false
  @State private var snapshotLoadError: String?
  @State private var lastLiveSnapshotReloadAt: Date?
  @State private var showingSettings = false
  @State private var showingModelPicker = false
  @State private var modelPickInFlight = false
  @State private var modelPickError: String?

  var body: some View {
    NavigationStack {
      content
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .tint(ADEColor.ctoAccent)
        .adeScreenBackground()
        .adeNavigationGlass()
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) {
          topBar
        }
        .task(id: isTabActive) {
          guard isTabActive, snapshot == nil else { return }
          await loadSnapshot()
        }
        .task(id: ctoLiveReloadKey) {
          guard ctoLiveReloadKey != nil else { return }
          let now = Date()
          guard shouldRunCtoLiveReload(lastReloadAt: lastLiveSnapshotReloadAt, now: now) else { return }
          lastLiveSnapshotReloadAt = now
          await loadSnapshot()
        }
        .sheet(isPresented: $showingSettings) {
          CtoSettingsScreen(snapshot: snapshot) { updated in
            self.snapshot = updated
          }
          .environmentObject(syncService)
        }
    }
  }

  // MARK: - Top bar

  private var topBar: some View {
    ADERootTopBar(title: topBarTitle) {
      if isOnboarded {
        Button {
          showingSettings = true
        } label: {
          Image(systemName: "gearshape")
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(ADEColor.textSecondary)
            .frame(width: 32, height: 32)
            .background(ADEColor.surfaceBackground.opacity(0.6), in: Circle())
            .overlay(Circle().stroke(ADEColor.glassBorder, lineWidth: 0.5))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("CTO settings")
      }
    }
  }

  private var topBarTitle: String {
    guard isOnboarded, let name = snapshot?.identity.name, !name.isEmpty else { return "CTO" }
    return name
  }

  // MARK: - Content

  @ViewBuilder
  private var content: some View {
    switch ctoRootContent(
      identity: snapshot?.identity,
      loadError: snapshotLoadError,
      hostUnreachable: syncService.connectionState.isHostUnreachable
    ) {
    case .onboarding:
      if let snapshot {
        CtoOnboardingScreen(snapshot: snapshot) { updated in
          self.snapshot = updated
        }
        .environmentObject(syncService)
      }
    case .modelPick:
      // No model the CTO can steer live has been picked yet. The picker takes
      // the thread's place — and `CtoSessionDestinationView` is deliberately
      // not built, so nothing ensures (and so nothing creates) a session on a
      // provider the user has not chosen. Desktop parity: `CtoPage`'s
      // `ModelPickCard`.
      modelPickCard
    case .thread:
      CtoSessionDestinationView(navigationChrome: .embedded)
        .environmentObject(syncService)
    case .loadError(let message):
      loadErrorView(message)
    case .loading:
      loadingView
    }
  }

  // MARK: - Model pick

  private var modelPickCard: some View {
    VStack(spacing: 14) {
      ZStack {
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .fill(ADEColor.ctoAccent.opacity(0.16))
        Image(systemName: "cpu")
          .font(.system(size: 22, weight: .semibold))
          .foregroundStyle(ADEColor.ctoAccent)
      }
      .frame(width: 52, height: 52)

      VStack(spacing: 6) {
        Text("Pick a model that can steer live turns")
          .font(.system(size: 17, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .multilineTextAlignment(.center)
        Text("The CTO is interrupted constantly — by the chats it starts, by its own wake-ups. It can only run on a model that accepts a message into a turn already underway.")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
      }

      Button {
        showingModelPicker = true
      } label: {
        HStack(spacing: 8) {
          if modelPickInFlight { ProgressView().controlSize(.small).tint(.white) }
          Text(modelPickInFlight ? "Moving the thread…" : "Choose a model")
            .fontWeight(.semibold)
        }
        .frame(maxWidth: .infinity, minHeight: 30)
      }
      .buttonStyle(.glassProminent)
      .tint(ADEColor.ctoAccent)
      .disabled(modelPickInFlight)
      .accessibilityLabel("Choose a CTO model")

      if let modelPickError {
        ADENoticeCard(
          title: "Couldn't switch the model",
          message: modelPickError,
          icon: "exclamationmark.triangle.fill",
          tint: ADEColor.danger,
          actionTitle: nil,
          action: nil
        )
      }
    }
    .frame(maxWidth: 420)
    .padding(.horizontal, 20)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .sheet(isPresented: $showingModelPicker) {
      WorkModelPickerSheet(
        currentModelId: "",
        currentProvider: ctoLiveRedirectProviders.first ?? "claude",
        currentReasoningEffort: "",
        currentCodexFastMode: false,
        lanes: [],
        commandScope: .project,
        isBusy: modelPickInFlight,
        // Same gate the CTO settings sheet uses: only providers that can
        // redirect a turn already in flight.
        modelFilter: { providerSupportsLiveRedirect($0.provider) },
        onSelect: { option, pickedReasoning, _, pickedFastMode in
          Task { @MainActor in
            await applyModelPick(
              option,
              reasoningEffort: pickedReasoning,
              fastMode: pickedFastMode
            )
          }
        }
      )
      .environmentObject(syncService)
    }
  }

  /// Desktop stores the bare model name in `modelPreferences.model` while the
  /// catalog id is `family/model` (`resolveModelSelection` in
  /// `useCtoModelOptions.ts`).
  private func ctoPreferenceModelName(_ modelId: String) -> String {
    modelId.split(separator: "/").last.map(String.init) ?? modelId
  }

  /// Applies the first model pick without starting a second thread.
  ///
  /// The preference is written first so that, if the host has to bring the
  /// existing session back up, it comes up on the provider the user just chose
  /// rather than on the identity default. Only then is the live session moved
  /// onto the exact model — the phone's `CtoModelPreferences` carries no
  /// `modelId`, so the session update is what pins the precise model (and what
  /// writes it back into the identity host-side).
  ///
  /// The snapshot is published only at the end: swapping it in earlier would
  /// drop the picker for the thread mid-flight and let
  /// `CtoSessionDestinationView` run a second, concurrent ensure.
  @MainActor
  private func applyModelPick(
    _ option: WorkModelOption,
    reasoningEffort: String?,
    fastMode: Bool
  ) async {
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
      snapshot = try await syncService.fetchCtoState()
      ADEHaptics.light()
    } catch {
      ADEHaptics.error()
      modelPickError = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
    }
  }

  private var loadingView: some View {
    VStack(spacing: 16) {
      ProgressView()
        .controlSize(.large)
        .tint(ADEColor.ctoAccent)
      Text("Opening the CTO")
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private func loadErrorView(_ message: String) -> some View {
    VStack {
      ADENoticeCard(
        title: "Couldn't load CTO state",
        message: message,
        icon: "exclamationmark.triangle.fill",
        tint: ADEColor.warning,
        actionTitle: "Retry",
        action: { Task { await loadSnapshot() } }
      )
      .padding(.horizontal, 20)
      .padding(.top, 12)
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var isOnboarded: Bool {
    // Dismissed-but-not-completed setup still unlocks the tab (desktop parity).
    guard let identity = snapshot?.identity else { return false }
    return !identity.isOnboardingBlocking
  }

  // MARK: - Loading

  @MainActor
  private func loadSnapshot() async {
    if isLoadingSnapshot { return }
    isLoadingSnapshot = true
    defer { isLoadingSnapshot = false }
    do {
      snapshot = try await syncService.fetchCtoState()
      snapshotLoadError = nil
    } catch {
      // Connection failures are owned by the top-right gear dot. Surface
      // anything else (command/parse errors, timeouts while connected) so the
      // user has a retry path instead of a blank tab.
      if syncService.connectionState.isHostUnreachable {
        snapshotLoadError = nil
      } else {
        snapshotLoadError = (error as NSError).localizedDescription
      }
    }
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

/// What the CTO tab renders in place of its thread. Split out of
/// `CtoRootScreen.content` so the branch order — in particular "picker before
/// thread", which is what keeps the tab off the ensure path while no model has
/// been chosen — can be asserted without standing up a UI host.
enum CtoRootContent: Equatable {
  case loading
  case loadError(String)
  case onboarding
  case modelPick
  case thread
}

/// Mirrors desktop `CtoPage`: setup first, then the model picker, then the
/// thread. A load failure is only surfaced while the host is reachable — the
/// offline case is owned by the top bar's connection dot.
func ctoRootContent(
  identity: CtoIdentity?,
  loadError: String?,
  hostUnreachable: Bool
) -> CtoRootContent {
  guard let identity else {
    if let loadError, !hostUnreachable { return .loadError(loadError) }
    return .loading
  }
  if identity.isOnboardingBlocking { return .onboarding }
  if identity.needsModelPick { return .modelPick }
  return .thread
}
