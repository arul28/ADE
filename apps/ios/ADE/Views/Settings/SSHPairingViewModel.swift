import Combine
import Foundation

@MainActor
final class SSHPairingViewModel: ObservableObject {
  @Published private(set) var state: SSHPairingViewState = .idle
  @Published private(set) var generatedKey: SSHGeneratedKey?

  private let service: SSHBootstrapService
  private let syncService: SyncService
  private var pendingInput: SSHConnectionInput?
  private var pendingRetention = false

  init(syncService: SyncService, service: SSHBootstrapService = SSHBootstrapService()) {
    self.syncService = syncService
    self.service = service
  }

  func generateKey() -> SSHGeneratedKey {
    let key = SSHGeneratedKey.make()
    generatedKey = key
    return key
  }

  func loadRetainedCredential(host: String, port: Int, username: String) async -> SSHStoredCredential? {
    do {
      return try await service.loadRetainedCredential(host: host, port: port, username: username)
    } catch {
      state = .failed(error.localizedDescription)
      return nil
    }
  }

  func begin(input: SSHConnectionInput, retainCredential: Bool) async {
    state = .checkingHost
    do {
      let input = try input.validated()
      pendingInput = input
      pendingRetention = retainCredential
      if let pinned = await service.savedFingerprint(for: input) {
        await pair(input: input, fingerprint: pinned, retainCredential: retainCredential)
        return
      }
      let fingerprint = try await service.probeFingerprint(input: input)
      state = .needsHostConfirmation(fingerprint)
    } catch {
      state = .failed(error.localizedDescription)
    }
  }

  func confirmHostFingerprint(_ fingerprint: String) async {
    guard let pendingInput else { return }
    await pair(input: pendingInput, fingerprint: fingerprint, retainCredential: pendingRetention)
  }

  func cancelConfirmation() {
    pendingInput = nil
    state = .idle
  }

  func clearEphemeralCredential() {
    generatedKey = nil
  }

  private func pair(input: SSHConnectionInput, fingerprint: String, retainCredential: Bool) async {
    state = .pairing
    do {
      guard let dpopPublicKey = DpopKeyService.shared.publicKeyX963Base64() else {
        throw SSHBootstrapError.invalidResponse
      }
      let info = Bundle.main.infoDictionary
      let request = SSHBootstrapRequest(
        version: 1,
        device: SSHBootstrapDevice(
          id: syncService.pairingDeviceId,
          name: ProcessInfo.processInfo.hostName,
          platform: "iOS",
          type: "phone",
          siteId: nil,
          dpopPublicKey: dpopPublicKey,
          capabilities: ["dpop", "chunkedEnvelopes", "projectCatalog"],
          appVersion: info?["CFBundleShortVersionString"] as? String,
          appBuild: info?["CFBundleVersion"] as? String,
          bundleIdentifier: Bundle.main.bundleIdentifier
        )
      )
      let response = try await service.bootstrap(
        input: input,
        expectedFingerprint: fingerprint,
        request: request,
        retainCredential: retainCredential
      )
      guard await syncService.adoptSSHBootstrapPairing(response, sshHost: input.normalizedHost) else {
        throw SSHBootstrapError.invalidResponse
      }
      pendingInput = nil
      state = .paired(response.machine.name, warning: response.credentialWarning)
    } catch {
      state = .failed(error.localizedDescription)
    }
  }
}
