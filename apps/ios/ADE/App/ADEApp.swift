import SwiftUI

@main
struct ADEApp: App {
  @StateObject private var syncService = SyncService()

  var body: some Scene {
    WindowGroup {
      ContentView()
        .environmentObject(syncService)
        .task {
          await syncService.reconnectIfPossible()
        }
    }
  }
}
