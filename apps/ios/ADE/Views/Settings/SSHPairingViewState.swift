import Foundation

enum SSHPairingViewState: Equatable {
  case idle
  case checkingHost
  case needsHostConfirmation(String)
  case pairing
  case paired(String, warning: String?)
  case failed(String)

  var isBusy: Bool {
    self == .checkingHost || self == .pairing
  }
}
