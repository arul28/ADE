import SwiftUI
import UIKit

private let adeAccent = ADEColor.accent

private enum RootTab: Hashable {
  case lanes
  case files
  case work
  case prs
  case settings
}

struct ContentView: View {
  @EnvironmentObject private var syncService: SyncService
  @State private var selectedTab: RootTab = .lanes
  @AppStorage("ade.colorScheme") private var colorSchemeRaw: String = ADEColorSchemeChoice.system.rawValue

  private var colorSchemeChoice: ADEColorSchemeChoice {
    ADEColorSchemeChoice(rawValue: colorSchemeRaw) ?? .system
  }

  var body: some View {
    TabView(selection: $selectedTab) {
      LanesTabView()
        .tag(RootTab.lanes)
        .tabItem {
          Label("Lanes", systemImage: "square.stack.3d.up")
        }
      FilesTabView()
        .tag(RootTab.files)
        .tabItem {
          Label("Files", systemImage: "doc.text")
        }
      WorkTabView()
        .tag(RootTab.work)
        .tabItem {
          Label("Work", systemImage: "terminal")
        }
        .badge(syncService.runningChatSessionCount)
      PRsTabView()
        .tag(RootTab.prs)
        .tabItem {
          Label("PRs", systemImage: "arrow.triangle.pull")
        }
      ConnectionSettingsView()
        .tag(RootTab.settings)
        .tabItem {
          Label("Settings", systemImage: "gearshape")
        }
    }
    .tint(adeAccent)
    .tabBarMinimizeBehavior(.onScrollDown)
    .adeScreenBackground()
    .adeNavigationGlass()
    .preferredColorScheme(colorSchemeChoice.preferredColorScheme)
    .sensoryFeedback(.selection, trigger: selectedTab)
    .onChange(of: syncService.settingsPresented) { _, presented in
      guard presented else { return }
      selectedTab = .settings
      syncService.settingsPresented = false
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
}
