import SwiftUI
import UIKit

@main
struct ADEApp: App {
  @Environment(\.scenePhase) private var scenePhase
  @StateObject private var syncService = SyncService()

  init() {
    ADETheme.configureUIKitAppearance()
  }

  var body: some Scene {
    WindowGroup {
      ContentView()
        .environmentObject(syncService)
        .task {
          await syncService.reconnectIfPossible()
        }
        .onChange(of: scenePhase) { _, newPhase in
          guard newPhase == .active else { return }
          Task {
            await syncService.reconnectIfPossible()
          }
        }
    }
  }
}

// MARK: - UIKit Appearance

enum ADETheme {
  private static let pageBackground = UIColor(red: 13 / 255, green: 11 / 255, blue: 19 / 255, alpha: 1)
  private static let tabBarBackground = UIColor(red: 18 / 255, green: 15 / 255, blue: 25 / 255, alpha: 1)
  private static let border = UIColor(red: 62 / 255, green: 57 / 255, blue: 77 / 255, alpha: 1)
  private static let textPrimary = UIColor(red: 250 / 255, green: 250 / 255, blue: 250 / 255, alpha: 1)
  private static let textSecondary = UIColor(red: 161 / 255, green: 161 / 255, blue: 170 / 255, alpha: 1)
  private static let accent = UIColor(red: 167 / 255, green: 139 / 255, blue: 250 / 255, alpha: 1)

  static func configureUIKitAppearance() {
    let navAppearance = UINavigationBarAppearance()
    navAppearance.configureWithOpaqueBackground()
    navAppearance.backgroundColor = pageBackground
    navAppearance.shadowColor = border
    navAppearance.titleTextAttributes = [.foregroundColor: textPrimary]
    navAppearance.largeTitleTextAttributes = [.foregroundColor: textPrimary]

    UINavigationBar.appearance().standardAppearance = navAppearance
    UINavigationBar.appearance().scrollEdgeAppearance = navAppearance
    UINavigationBar.appearance().compactAppearance = navAppearance
    UINavigationBar.appearance().tintColor = accent

    let tabAppearance = UITabBarAppearance()
    tabAppearance.configureWithOpaqueBackground()
    tabAppearance.backgroundColor = tabBarBackground
    tabAppearance.shadowColor = border

    let normal = tabAppearance.stackedLayoutAppearance.normal
    normal.iconColor = textSecondary
    normal.titleTextAttributes = [.foregroundColor: textSecondary]

    let selected = tabAppearance.stackedLayoutAppearance.selected
    selected.iconColor = accent
    selected.titleTextAttributes = [.foregroundColor: accent]

    UITabBar.appearance().standardAppearance = tabAppearance
    UITabBar.appearance().scrollEdgeAppearance = tabAppearance
    UITabBar.appearance().tintColor = accent
  }
}
