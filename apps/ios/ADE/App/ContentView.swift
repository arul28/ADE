import SwiftUI
import UIKit

private let adeAccent = ADEColor.accent

private enum RootTab: Hashable, CaseIterable, Identifiable {
  case work
  case lanes
  case prs
  case files
  case cto

  var id: Self { self }

  var title: String {
    switch self {
    case .work: return "Work"
    case .lanes: return "Lanes"
    case .prs: return "PRs"
    case .files: return "Files"
    case .cto: return "CTO"
    }
  }

  var symbol: String {
    switch self {
    case .work: return "terminal"
    case .lanes: return "square.stack.3d.up"
    case .prs: return "arrow.triangle.pull"
    case .files: return "doc.text"
    case .cto: return "brain"
    }
  }

  var analyticsScreen: ADEAnalyticsScreen {
    switch self {
    case .work: return .work
    case .lanes: return .lanes
    case .prs: return .pullRequests
    case .files: return .files
    case .cto: return .cto
    }
  }
}

struct ContentView: View {
  @EnvironmentObject private var syncService: SyncService
  @EnvironmentObject private var accountService: AccountService
  @State private var selectedTab: RootTab = .work
  @State private var analyticsConsentPresented = false
  @State private var mobileLaunchAccess = MobileLaunchAccessPolicy()
  @AppStorage("ade.colorScheme") private var colorSchemeRaw: String = ADEColorSchemeChoice.system.rawValue

  private var colorSchemeChoice: ADEColorSchemeChoice {
    ADEColorSchemeChoice(rawValue: colorSchemeRaw) ?? .system
  }

  var body: some View {
    // The hub is the home screen: all projects open and ready. Opening a
    // project swaps to the detailed tab view. Keep these roots mutually
    // mounted: if the hub stays alive under the project tabs it continues
    // rebuilding roster cards while the user scrolls Work chat detail.
    Group {
      if !hasMobileAccess {
        MobileAccessGateView(
          accountConfigured: accountService.isConfigured,
          accountLoading: accountService.phase == .loading,
          accountSignedIn: accountService.isSignedIn,
          hasPairedHost: syncService.hasPairedHost,
          onContinue: {
            mobileLaunchAccess.grantAccess()
            if syncService.hasPairedHost, syncService.connectionState.isHostUnreachable {
              Task { await syncService.reconnectIfPossible(userInitiated: true) }
            }
          }
        )
      } else if syncService.shouldShowProjectHome {
        HubScreen()
      } else {
        rootTabs
      }
    }
    // Global capture popup. Sits just below the notch on every tab, stays in
    // sync with the composer's pill (both observe the same global
    // DictationController), and lets you Done/Cancel from anywhere.
      .safeAreaInset(edge: .top, spacing: 0) {
        GlobalDictationPill()
      }
      .tint(adeAccent)
      .adeScreenBackground()
      .adeNavigationGlass()
      .adeInspectorHost()
      .preferredColorScheme(colorSchemeChoice.preferredColorScheme)
      .sensoryFeedback(.selection, trigger: selectedTab)
      .environmentObject(syncService.attentionDrawer)
      .onAppear {
        mobileLaunchAccess.observeInitialAccountPhase(accountService.phase)
        captureCurrentRootScreen()
        analyticsConsentPresented = hasMobileAccess && ProductAnalytics.shared.shouldRequestConsent
      }
      .onChange(of: hasMobileAccess) { _, hasAccess in
        guard hasAccess else { return }
        captureCurrentRootScreen()
        analyticsConsentPresented = ProductAnalytics.shared.shouldRequestConsent
      }
      .onChange(of: accountService.phase) { _, phase in
        mobileLaunchAccess.observeInitialAccountPhase(phase)
      }
      .onChange(of: selectedTab) { _, _ in
        captureCurrentRootScreen()
      }
      .onChange(of: syncService.shouldShowProjectHome) { _, _ in
        captureCurrentRootScreen()
      }
      .onChange(of: syncService.settingsPresented) { _, isPresented in
        guard isPresented else { return }
        ProductAnalytics.shared.captureScreen(.settings)
      }
      .onChange(of: syncService.attentionDrawerPresented) { _, isPresented in
        guard isPresented else { return }
        ProductAnalytics.shared.captureScreen(.attentionDrawer)
      }
      .onChange(of: syncService.linearPanePresented) { _, isPresented in
        guard isPresented else { return }
        ProductAnalytics.shared.captureScreen(.linear)
      }
      .sheet(isPresented: $syncService.settingsPresented) {
        ConnectionSettingsView(syncService: syncService)
      }
      .sheet(isPresented: $syncService.attentionDrawerPresented) {
        AttentionDrawerSheet()
          .environmentObject(syncService)
          .environmentObject(syncService.attentionDrawer)
      }
      .sheet(isPresented: $syncService.linearPanePresented) {
        LinearPaneSheet(syncService: syncService)
          .environmentObject(syncService)
      }
      .alert("Share anonymous product usage?", isPresented: $analyticsConsentPresented) {
        Button("Don't share", role: .cancel) {
          ProductAnalytics.shared.setEnabled(false)
        }
        Button("Share usage") {
          ProductAnalytics.shared.setEnabled(true)
          ProductAnalytics.shared.captureAppOpened(.coldStart)
          captureCurrentRootScreen()
        }
      } message: {
        Text("ADE can send a small, daily-capped set of screen and feature categories to help improve the app. It never sends prompts, code, project or file names, terminal content, raw errors, or screen recordings. You can change this later in Settings.")
      }
      .onChange(of: syncService.requestedLinearIssueNavigation?.id) { _, requestId in
        guard requestId != nil else { return }
        // A linear-issue deep link opens the global pane (it consumes the
        // request once presented). Only reached when a project is active — the
        // router bounces the link to the Mac otherwise.
        syncService.closeProjectHome()
        syncService.linearPanePresented = true
      }
      .onChange(of: syncService.requestedFilesNavigation?.id) { _, requestId in
        guard requestId != nil else { return }
        syncService.closeProjectHome()
        if selectedTab != .files {
          selectedTab = .files
        }
      }
      .onChange(of: syncService.requestedLaneNavigation?.id) { _, requestId in
        guard requestId != nil else { return }
        syncService.closeProjectHome()
        if selectedTab != .lanes {
          selectedTab = .lanes
        }
      }
      .onChange(of: syncService.requestedWorkLaneNavigation?.id) { _, requestId in
        guard requestId != nil else { return }
        syncService.closeProjectHome()
        if selectedTab != .work {
          selectedTab = .work
        }
      }
      .onChange(of: syncService.requestedPrNavigation?.id) { _, requestId in
        guard requestId != nil else { return }
        syncService.closeProjectHome()
        if selectedTab != .prs {
          selectedTab = .prs
        }
      }
      .onChange(of: syncService.requestedWorkSessionNavigation?.id) { _, requestId in
        guard requestId != nil,
              let request = syncService.requestedWorkSessionNavigation else { return }
        // A scoped or roster-resolved session may belong to any project. Keep
        // the machine-wide Hub mounted so it can open the correct chat directly
        // instead of sending the id into whichever project's Work tab happens
        // to be active (which produces a misleading blank-cache state).
        if request.hasProjectScope || syncService.rosterNavigationTarget(for: request) != nil {
          syncService.showProjectHome()
          return
        }
        syncService.closeProjectHome()
        if selectedTab != .work {
          selectedTab = .work
        }
      }
  }

  private var hasMobileAccess: Bool {
    mobileLaunchAccess.hasAccess
  }

  private func captureCurrentRootScreen() {
    guard hasMobileAccess else { return }
    ProductAnalytics.shared.captureScreen(
      syncService.shouldShowProjectHome ? .hub : selectedTab.analyticsScreen
    )
  }

  private var rootTabs: some View {
    TabView(selection: $selectedTab) {
      workTab
      lanesTab
      prsTab
      filesTab
      ctoTab
    }
  }

  private var workTab: some View {
    WorkTabView(isActive: selectedTab == .work)
      .tag(RootTab.work)
      .tabItem {
        Label("Work", systemImage: "terminal")
      }
      .badge(syncService.runningChatSessionCount)
  }

  private var lanesTab: some View {
    LanesTabView(isActive: selectedTab == .lanes)
      .tag(RootTab.lanes)
      .tabItem {
        Label("Lanes", systemImage: "square.stack.3d.up")
      }
  }

  private var prsTab: some View {
    PRsTabView(isActive: selectedTab == .prs)
      .tag(RootTab.prs)
      .tabItem {
        Label("PRs", systemImage: "arrow.triangle.pull")
      }
  }

  private var filesTab: some View {
    FilesTabView(isActive: selectedTab == .files)
      .tag(RootTab.files)
      .tabItem {
        Label("Files", systemImage: "doc.text")
      }
  }

  private var ctoTab: some View {
    CtoRootScreen(isTabActive: selectedTab == .cto)
      .tag(RootTab.cto)
      .tabItem {
        Label("CTO", systemImage: "brain")
      }
  }
}
