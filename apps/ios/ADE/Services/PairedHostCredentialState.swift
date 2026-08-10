import Foundation

/// Why a saved pairing is or is not usable right now.
///
/// `hasPairedHost` used to answer this as one boolean, which made "this phone
/// has never been paired" and "this phone is paired but cannot read its
/// credential" indistinguishable. They need different words: the first is an
/// instruction, the second is a fault, and showing the first when the second is
/// true tells the user to do something they have already done.
enum PairedHostCredentialState: Equatable {
  /// No saved pairing at all. Pairing is the next step.
  case notPaired
  /// Saved pairing with a readable credential — the phone can connect.
  case ready
  /// A pairing was saved, but its credential cannot be read back. The Keychain
  /// entry is missing, was cleared out from under the app, or the read failed
  /// (`errSecMissingEntitlement`, a locked or reset Keychain). The pairing
  /// cannot be used and must be redone.
  case credentialUnreadable

  /// Whether the phone can act on the saved pairing. This is the exact
  /// predicate `hasPairedHost` has always answered.
  var isUsable: Bool { self == .ready }
}

/// Classifies a saved pairing, given a credential lookup.
///
/// Pure and lookup-injected so the unreadable-credential branch can be tested
/// directly. That branch is otherwise only reachable with a real Keychain
/// fault, which is exactly the case that has shipped broken before.
func syncPairedHostCredentialState(
  profile: HostConnectionProfile?,
  authKind: String? = nil,
  credentialLookup: (HostConnectionProfile) -> String?
) -> PairedHostCredentialState {
  guard let profile else { return .notPaired }
  let kind = authKind ?? profile.authKind
  guard kind == "paired" else { return .notPaired }
  return credentialLookup(profile) == nil ? .credentialUnreadable : .ready
}
