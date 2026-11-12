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

/// Which device id this install presents to its computers, and what to save.
///
/// Every computer binds its pairing to the id, so a new id makes every
/// computer refuse the phone as an unknown device. Rules:
/// - The keychain id wins (it survives a reinstall). It is copied to the
///   saved copy, so a later failed keychain read still finds it.
/// - A failed keychain read uses the saved copy and writes nothing to the
///   keychain: the keychain may still hold the real id.
/// - A new id is made only when nothing is stored. After a failed read with
///   no saved copy, the new id is provisional: it goes to neither store, and
///   the phone neither pairs nor drops a pairing with it. The phone reads the
///   keychain again when protected data becomes available (the first unlock
///   after a launch before it, when the saved copy is unreadable too).
func syncResolveDeviceId(
  keychain: KeychainService.StoredRead,
  saved: String?,
  makeFresh: () -> String
) -> (id: String, writeKeychain: Bool, writeSaved: Bool, provisional: Bool) {
  let savedId = saved?.trimmingCharacters(in: .whitespacesAndNewlines)
  let usableSaved = (savedId?.isEmpty == false) ? savedId : nil
  switch keychain {
  case .value(let id) where !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty:
    return (id, false, usableSaved != id, false)
  case .value, .absent:
    if let usableSaved { return (usableSaved, true, false, false) }
    return (makeFresh(), true, true, false)
  case .failed:
    if let usableSaved { return (usableSaved, false, false, false) }
    return (makeFresh(), false, false, true)
  }
}

/// What the phone says when it cannot pair because its device id is still
/// provisional (see `syncResolveDeviceId`).
let syncProvisionalDeviceIdMessage = "This iPhone could not read its ADE identity yet. Unlock it, then try again."
