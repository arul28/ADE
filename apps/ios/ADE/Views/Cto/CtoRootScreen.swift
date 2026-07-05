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
        Text(ctoPersonalityLabel(for: snapshot?.identity.personality))
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.ctoAccent)
          .padding(.horizontal, 10)
          .padding(.vertical, 5)
          .background(ADEColor.ctoAccent.opacity(0.14), in: Capsule())
          .overlay(Capsule().stroke(ADEColor.ctoAccent.opacity(0.28), lineWidth: 0.5))
          .accessibilityLabel("Personality: \(ctoPersonalityLabel(for: snapshot?.identity.personality))")

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
    if let snapshot, snapshot.identity.isOnboardingBlocking {
      CtoOnboardingScreen(snapshot: snapshot) { updated in
        self.snapshot = updated
      }
      .environmentObject(syncService)
    } else if snapshot != nil {
      CtoSessionDestinationView(navigationChrome: .embedded)
        .environmentObject(syncService)
    } else if let snapshotLoadError, !syncService.connectionState.isHostUnreachable {
      loadErrorView(snapshotLoadError)
    } else {
      loadingView
    }
  }

  private var loadingView: some View {
    VStack(spacing: 16) {
      ProgressView()
        .controlSize(.large)
        .tint(ADEColor.ctoAccent)
      Text("Waking the CTO…")
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
    case .connected, .syncing:
      return "live-\(syncService.localStateRevision)"
    case .connecting, .disconnected, .error:
      return nil
    }
  }
}
