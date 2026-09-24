import SwiftUI

/// One live subscription: the session, registered for records and end notices.
///
/// Both the tools card and the full-screen viewer mount this way. The
/// subscription id is the caller's, so the two can never unsubscribe each other.
@MainActor
func mountMacDesktopLiveSession(
  laneId: String,
  subscriptionId: String,
  using syncService: SyncService
) -> MacDesktopLiveSession {
  let session = MacDesktopLiveSession(
    laneId: laneId,
    subscriptionId: subscriptionId,
    viewerLabel: MacDesktopLiveSession.defaultViewerLabel()
  )
  syncService.registerMacDesktopStream(
    subscriptionId: session.subscriptionId,
    onRecord: { [weak session] record in session?.consume(record) },
    onEnded: { [weak session] ended in session?.noteEnded(ended) }
  )
  return session
}

/// Starts this lane's display. Both Start buttons report the system error string.
@MainActor
func macDesktopStartDisplay(
  using syncService: SyncService,
  laneId: String,
  starting: Binding<Bool>,
  errorText: Binding<String?>,
  refresh: @escaping @MainActor () async -> Void
) {
  guard !starting.wrappedValue else { return }
  starting.wrappedValue = true
  errorText.wrappedValue = nil
  Task { @MainActor in
    do {
      try await syncService.macDesktopStart(laneId: laneId)
      await refresh()
    } catch {
      errorText.wrappedValue = macDesktopVisibleMessage(for: error)
    }
    starting.wrappedValue = false
  }
}
