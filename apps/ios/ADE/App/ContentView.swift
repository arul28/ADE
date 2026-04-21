import SwiftUI
import UIKit

private let adeAccent = ADEColor.accent

private enum RootTab: Hashable {
  case work
  case lanes
  case prs
  case files
  case cto
}

struct ContentView: View {
  @EnvironmentObject private var syncService: SyncService
  @State private var selectedTab: RootTab = .work
  @AppStorage("ade.colorScheme") private var colorSchemeRaw: String = ADEColorSchemeChoice.system.rawValue

  private var colorSchemeChoice: ADEColorSchemeChoice {
    ADEColorSchemeChoice(rawValue: colorSchemeRaw) ?? .system
  }

  var body: some View {
    rootTabs
      .tint(adeAccent)
      .tabBarMinimizeBehavior(.onScrollDown)
      .adeScreenBackground()
      .adeNavigationGlass()
      .preferredColorScheme(colorSchemeChoice.preferredColorScheme)
      .sensoryFeedback(.selection, trigger: selectedTab)
      .sheet(isPresented: $syncService.settingsPresented) {
        ConnectionSettingsView()
          .environmentObject(syncService)
      }
      .onChange(of: syncService.requestedFilesNavigation?.id) { _, requestId in
        guard requestId != nil else { return }
        selectedTab = .files
      }
      .onChange(of: syncService.requestedLaneNavigation?.id) { _, requestId in
        guard requestId != nil else { return }
        selectedTab = .lanes
      }
      .onChange(of: syncService.requestedPrNavigation?.id) { _, requestId in
        guard requestId != nil else { return }
        selectedTab = .prs
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
    CtoRootScreen()
      .tag(RootTab.cto)
      .tabItem {
        Label("CTO", systemImage: "brain.head.profile")
      }
  }
}
