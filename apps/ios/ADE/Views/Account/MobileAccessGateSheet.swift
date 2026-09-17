import Foundation

enum MobileAccessGateSheet: String, Identifiable {
  case signIn
  case pairMachine

  var id: String { rawValue }
}

/// Per-process access choice for the mobile launch gate. A cached active
/// account can enter directly, while a user who starts signed out stays on the
/// gate until sign-in finishes or another explicit access grant, such as
/// continuing with an already-paired machine, is made.
struct MobileLaunchAccessPolicy: Equatable {
  private(set) var checkedInitialAccountState = false
  private(set) var hasAccess = false

  mutating func observeInitialAccountPhase(_ phase: AccountService.Phase) {
    guard !checkedInitialAccountState, phase != .loading else { return }
    checkedInitialAccountState = true
    if phase == .signedIn {
      hasAccess = true
    }
  }

  mutating func grantAccess() {
    hasAccess = true
  }
}
