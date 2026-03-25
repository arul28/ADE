import SwiftUI

@main
struct ADEApp: App {
  @Environment(\.scenePhase) private var scenePhase
  @StateObject private var syncService = SyncService()

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
            await syncService.handleForegroundTransition()
          }
        }
    }
  }
}
