import SwiftUI

@main
struct ADEApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @Environment(\.scenePhase) private var scenePhase
  @StateObject private var syncService = SyncService()
  @State private var didBootstrapSync = false
  @State private var lastActivationSyncAt = Date.distantPast

  var body: some Scene {
    WindowGroup {
      ContentView()
        .environmentObject(syncService)
        .task {
          guard !didBootstrapSync else { return }
          didBootstrapSync = true
          lastActivationSyncAt = Date()
          await syncService.handleForegroundTransition()
        }
        .onChange(of: scenePhase) { _, newPhase in
          guard newPhase == .active else { return }
          guard didBootstrapSync else { return }
          let now = Date()
          guard now.timeIntervalSince(lastActivationSyncAt) > 1.0 else { return }
          lastActivationSyncAt = now
          Task {
            await syncService.handleForegroundTransition()
          }
        }
        .onOpenURL { url in
          DeepLinkRouter.shared.handle(url)
        }
    }
  }
}
