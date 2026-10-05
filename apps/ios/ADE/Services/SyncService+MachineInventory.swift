import Foundation

// MARK: - Machine inventory (Custom harness presets)

extension SyncService {
  /// The connected machine's saved Custom harnesses, with their bound state.
  /// Feature-detected: a host that never registered
  /// `account.getMachineInventory` throws, and the caller shows no Custom
  /// section.
  func fetchMachineInventory(machineKey: String) async throws -> SyncMachineInventoryDetail {
    try requireInvokableRemoteAction("account.getMachineInventory")
    return try await sendDecodableCommand(
      action: "account.getMachineInventory",
      args: ["machineKey": machineKey],
      as: SyncMachineInventoryDetail.self
    )
  }

  /// The machine key `account.getMachineInventory` wants for the focused host:
  /// its account-directory key when the directory row is known, else the saved
  /// profile key. The host reads its own local store either way; the key only
  /// names which machine the answer is about.
  var focusedHostInventoryMachineKey: String? {
    AccountService.shared.machine(forFleetKey: focusedMachineKey)?.machineKey
      ?? focusedMachineKey
  }
}
