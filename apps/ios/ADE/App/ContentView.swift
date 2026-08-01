import SwiftUI
import UIKit

private let adeAccent = ADEColor.accent

private enum RootTab: String, Hashable, CaseIterable, Identifiable {
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
  @State private var selectedTab: RootTab = {
    let saved = UserDefaults.standard.string(forKey: "ade.navigation.lastRootTab")
    return saved.flatMap(RootTab.init(rawValue:)) ?? .work
  }()
  @State private var analyticsConsentPresented = false
  @State private var mobileLaunchAccess = MobileLaunchAccessPolicy()
  @AppStorage("ade.colorScheme") private var colorSchemeRaw: String = ADEColorSchemeChoice.system.rawValue

  private var colorSchemeChoice: ADEColorSchemeChoice {
    ADEColorSchemeChoice(rawValue: colorSchemeRaw) ?? .system
  }

  // Split the root into explicit `some View` stages. As one expression this
  // chain exceeds the Swift type-checker's budget; each stage stays bounded.
  var body: some View {
    rootWithChrome
      .onChange(of: syncService.requestedLinearIssueNavigation?.id) { _, requestId in
        guard requestId != nil else { return }
        // A linear-issue deep link opens the global pane (it consumes the
        // request once presented). Only reached when a project is active — the
        // router bounces the link to the Mac otherwise.
        syncService.closeProjectHub()
        syncService.linearPanePresented = true
      }
      .onChange(of: syncService.requestedFilesNavigation?.id) { _, requestId in
        guard requestId != nil else { return }
        syncService.closeProjectHub()
        if selectedTab != .files {
          selectedTab = .files
        }
      }
      .onChange(of: syncService.requestedLaneNavigation?.id) { _, requestId in
        guard requestId != nil else { return }
        syncService.closeProjectHub()
        if selectedTab != .lanes {
          selectedTab = .lanes
        }
      }
      .onChange(of: syncService.requestedWorkLaneNavigation?.id) { _, requestId in
        guard requestId != nil else { return }
        syncService.closeProjectHub()
        if selectedTab != .work {
          selectedTab = .work
        }
      }
      .task(id: syncService.requestedPrNavigation?.id) {
        guard let request = syncService.requestedPrNavigation,
              await syncService.ensureAccountMachineForNavigation(
                request.accountMachineKey
              ),
              syncService.requestedPrNavigation?.id == request.id else { return }
        syncService.closeProjectHub()
        if selectedTab != .prs {
          selectedTab = .prs
        }
      }
      .modifier(WorkSessionNavigationModifier(syncService: syncService, selectedTab: $selectedTab))
  }

  private var rootWithChrome: some View {
    observedRootContent
      .sheet(isPresented: $syncService.settingsPresented) {
        ConnectionSettingsView(syncService: syncService)
      }
      .sheet(isPresented: $syncService.attentionDrawerPresented) {
        ActivityDrawerSheet()
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
  }

  @ViewBuilder
  private var rootContent: some View {
    // The hub is the home screen: all projects open and ready. Opening a
    // project swaps to the detailed tab view. Keep these roots mutually
    // mounted: if the hub stays alive under the project tabs it continues
    // rebuilding roster cards while the user scrolls Work chat detail.
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
    } else if syncService.shouldShowProjectHub {
      HubScreen()
    } else {
      rootTabs
    }
  }

  private var presentedRootContent: some View {
    rootContent
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
      .overlay(alignment: .top) {
        if let label = syncService.accountConnectSuccessLabel {
          AccountConnectStatusToast(label: label)
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .transition(.move(edge: .top).combined(with: .opacity))
        }
      }
      .animation(.spring(response: 0.35, dampingFraction: 0.86), value: syncService.accountConnectSuccessLabel)
      .preferredColorScheme(colorSchemeChoice.preferredColorScheme)
      .sensoryFeedback(.selection, trigger: selectedTab)
      .environmentObject(syncService.attentionDrawer)
  }

  private var observedRootContent: some View {
    presentedRootContent
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
        UserDefaults.standard.set(selectedTab.rawValue, forKey: "ade.navigation.lastRootTab")
        captureCurrentRootScreen()
      }
      .onChange(of: syncService.shouldShowProjectHub) { _, _ in
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
  }

  private var hasMobileAccess: Bool {
    mobileLaunchAccess.hasAccess
  }

  private func captureCurrentRootScreen() {
    guard hasMobileAccess else { return }
    ProductAnalytics.shared.captureScreen(
      syncService.shouldShowProjectHub ? .hub : selectedTab.analyticsScreen
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
        // The accessibility label belongs on the Label inside .tabItem: SwiftUI
        // lifts .tabItem/.badge out of the content view, but an
        // .accessibilityLabel applied outside would stay on the content and
        // never reach the tab-bar button VoiceOver actually focuses.
        Label("CTO", systemImage: "brain")
          .accessibilityLabel(
            syncService.ctoAttention.isAwaitingInput ? "CTO, waiting on you" : "CTO"
          )
      }
      // The CTO chat is excluded from every session roster, so it cannot borrow
      // the Work badge above — a question from the CTO would otherwise surface
      // nowhere on the phone. A string badge renders as a dot-sized marker and
      // hides itself when nil.
      .badge(syncService.ctoAttention.isAwaitingInput ? "!" : nil)
  }
}

struct AccountConnectStatusToast: View {
  let label: String

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: "checkmark.circle.fill")
        .foregroundStyle(ADEColor.success)
      Text(label)
        .font(.system(.footnote, design: .rounded).weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .background(ADEColor.cardBackground.opacity(0.92), in: Capsule())
    .glassEffect()
    .overlay(Capsule().stroke(ADEColor.success.opacity(0.3), lineWidth: 0.75))
    .shadow(color: .black.opacity(0.18), radius: 14, y: 6)
    .accessibilityElement(children: .combine)
  }
}

/// Kept out of ContentView's already-long modifier chain so SwiftUI does not
/// have to infer the entire app root and the cold-start task in one expression.
private struct WorkSessionNavigationModifier: ViewModifier {
  @ObservedObject var syncService: SyncService
  @Binding var selectedTab: RootTab

  func body(content: Content) -> some View {
    // A task runs for an already-present cold-launch request as well as later
    // changes; onChange alone misses the initial value before this root mounts.
    content.task(id: syncService.requestedWorkSessionNavigation?.id) {
      guard let request = syncService.requestedWorkSessionNavigation else { return }
      guard await syncService.ensureAccountMachineForNavigation(
        request.accountMachineKey
      ),
      syncService.requestedWorkSessionNavigation?.id == request.id else { return }
      // A scoped or roster-resolved session may belong to any project. Keep
      // the machine-wide Hub mounted so it can activate and hydrate the target.
      if syncService.navigationDestination(request) == .hub {
        syncService.showProjectHub()
        return
      }
      syncService.closeProjectHub()
      if selectedTab != .work {
        selectedTab = .work
      }
    }
  }
}
