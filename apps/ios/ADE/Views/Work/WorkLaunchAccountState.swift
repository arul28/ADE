import SwiftUI

/// The chosen machine's provider accounts for a new launch: the host read, the
/// error/retry state, and the rows that are a real choice. The screen keeps
/// only the selected id and the controls that draw it.
@MainActor
@Observable
final class WorkLaunchAccountState {
  enum LoadFailure: Equatable {
    /// The host may answer on Retry (offline, timed out, still connecting).
    case retryable
    /// The host is live but does not advertise the account commands.
    case unsupported
  }

  private(set) var accounts: [ProviderAccount] = []
  private(set) var failure: LoadFailure?
  /// The provider/machine/preset scope the current rows belong to.
  private(set) var loadedScope: String?

  var error: Bool { failure != nil }

  nonisolated static func scope(
    provider: ProviderAccountProvider?,
    machineKey: String?
  ) -> String {
    // A preset makes the provider nil, so it adds no scope of its own.
    "\(machineKey ?? "local")|\(provider?.rawValue ?? "none")"
  }

  /// One working login is a choice only when it is not the machine default:
  /// a signed-out default would otherwise be unavoidable.
  var choices: [ProviderAccount] {
    let usable = accounts.filter(\.canTakeChats)
    return usable.count > 1 || (usable.count == 1 && !usable[0].isDefault) ? usable : []
  }

  func clear() {
    accounts = []
    failure = nil
    loadedScope = nil
  }

  /// Read the account commands from the machine that owns the launch. A
  /// machine with no live roster must never fall back to the focused host's
  /// accounts: that id would name a different machine's login.
  func load(
    provider: ProviderAccountProvider?,
    machineKey: String?,
    machineFleet: MachineFleet,
    syncService: SyncService
  ) async {
    let scope = Self.scope(provider: provider, machineKey: machineKey)
    if loadedScope != scope {
      // A provider or machine change must never show the previous scope's
      // accounts while its own read is in flight.
      loadedScope = scope
      accounts = []
      failure = nil
    }
    guard let provider else {
      accounts = []
      failure = nil
      return
    }
    let host: ProviderAccountsHost?
    if let machineKey {
      host = machineFleet.connection(for: machineKey)
    } else {
      host = syncService
    }
    guard let host else {
      failure = .retryable
      return
    }
    guard host.providerAccountsConnected else {
      failure = .retryable
      return
    }
    guard host.supportsProviderAccounts else {
      // An older host, or a machine still connecting, cannot answer. Keep the
      // current pick and say so instead of pretending there are no accounts.
      failure = .unsupported
      return
    }
    do {
      let accounts = try await ProviderAccountsClient(host: host).list(provider)
      guard loadedScope == scope, !Task.isCancelled else { return }
      self.accounts = accounts
      failure = nil
    } catch {
      // A cancelled read belongs to a provider or machine the screen moved off.
      guard loadedScope == scope, !Task.isCancelled else { return }
      failure = .retryable
    }
  }
}
