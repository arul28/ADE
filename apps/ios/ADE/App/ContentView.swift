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
}

struct ContentView: View {
  @EnvironmentObject private var syncService: SyncService
  @State private var selectedTab: RootTab = .work
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
      if syncService.shouldShowProjectHome {
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
      .sheet(isPresented: $syncService.settingsPresented) {
        ConnectionSettingsView(syncService: syncService)
      }
      .sheet(isPresented: $syncService.attentionDrawerPresented) {
        AttentionDrawerSheet()
          .environmentObject(syncService)
          .environmentObject(syncService.attentionDrawer)
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
        guard requestId != nil else { return }
        syncService.closeProjectHome()
        if selectedTab != .work {
          selectedTab = .work
        }
      }
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
