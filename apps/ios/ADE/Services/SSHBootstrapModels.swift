import Foundation

struct SSHBootstrapDevice: Codable, Equatable {
  let id: String
  let name: String
  let platform: String
  let type: String
  let siteId: String?
  let dpopPublicKey: String
  let capabilities: [String]
  let appVersion: String?
  let appBuild: String?
  let bundleIdentifier: String?
}

struct SSHBootstrapRequest: Codable, Equatable {
  let version: Int
  let device: SSHBootstrapDevice
}

struct SSHBootstrapMachine: Decodable, Equatable {
  let deviceId: String
  let siteId: String?
  let name: String
  let platform: String?
  let deviceType: String?
}

struct SSHBootstrapPairing: Decodable, Equatable {
  let secret: String
  let pairedDeviceId: String
}

struct SSHBootstrapAddress: Decodable, Equatable {
  let host: String
  let kind: String
}

struct SSHBootstrapSync: Decodable, Equatable {
  let port: Int
  let addressCandidates: [SSHBootstrapAddress]
}

struct SSHBootstrapRuntime: Decodable, Equatable {
  let name: String?
  let version: String?
  let channel: String?
}

struct SSHBootstrapErrorPayload: Decodable, Equatable {
  let code: String
  let message: String
}

struct SSHBootstrapResponse: Decodable, Equatable {
  let version: Int
  let ok: Bool
  let machine: SSHBootstrapMachine?
  let pairing: SSHBootstrapPairing?
  let sync: SSHBootstrapSync?
  let runtime: SSHBootstrapRuntime?
  let error: SSHBootstrapErrorPayload?

  func validated() throws -> SSHValidatedBootstrapResponse {
    guard version == 1 else { throw SSHBootstrapError.invalidResponse }
    guard ok else {
      throw SSHBootstrapError.remote(
        code: error?.code ?? "pairing_failed",
        message: error?.message ?? "The Mac could not complete setup."
      )
    }
    guard let machine, let pairing, let sync,
          !machine.deviceId.isEmpty,
          !pairing.secret.isEmpty,
          !pairing.pairedDeviceId.isEmpty,
          (1...65_535).contains(sync.port) else {
      throw SSHBootstrapError.invalidResponse
    }
    return SSHValidatedBootstrapResponse(
      machine: machine,
      pairing: pairing,
      sync: sync,
      runtime: runtime
    )
  }
}

struct SSHValidatedBootstrapResponse: Equatable {
  let machine: SSHBootstrapMachine
  let pairing: SSHBootstrapPairing
  let sync: SSHBootstrapSync
  let runtime: SSHBootstrapRuntime?
  var credentialWarning: String? = nil
}

struct SSHConnectionInput: Equatable {
  var host: String
  var port: Int
  var username: String
  var privateKey: String
  var passphrase: String

  var normalizedHost: String {
    host.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  var normalizedUsername: String {
    username.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  func validated() throws -> SSHConnectionInput {
    guard !normalizedHost.isEmpty else { throw SSHBootstrapError.invalidHost }
    guard (1...65_535).contains(port) else { throw SSHBootstrapError.invalidPort }
    guard !normalizedUsername.isEmpty else { throw SSHBootstrapError.invalidUsername }
    guard privateKey.contains("PRIVATE KEY") else { throw SSHBootstrapError.invalidPrivateKey }
    var copy = self
    copy.host = normalizedHost
    copy.username = normalizedUsername
    return copy
  }
}

enum SSHBootstrapError: LocalizedError, Equatable {
  case invalidHost
  case invalidPort
  case invalidUsername
  case invalidPrivateKey
  case unsupportedKey(String)
  case passphraseRequired
  case incorrectPassphrase
  case hostKeyNotConfirmed(String)
  case hostKeyChanged(expected: String, received: String)
  case cliUnavailable
  case invalidResponse
  case responseTooLarge
  case timedOut
  case remote(code: String, message: String)

  var errorDescription: String? {
    switch self {
    case .invalidHost: "Enter a Mac address."
    case .invalidPort: "Enter an SSH port from 1 to 65535."
    case .invalidUsername: "Enter the macOS username used for SSH."
    case .invalidPrivateKey: "Paste or import a supported private key."
    case .unsupportedKey(let detail): detail
    case .passphraseRequired: "This private key needs its passphrase."
    case .incorrectPassphrase: "The private-key passphrase is incorrect."
    case .hostKeyNotConfirmed: "Compare the Mac's SSH fingerprint, then confirm that it matches."
    case .hostKeyChanged(let expected, let received):
      "This Mac's SSH fingerprint changed. Expected \(expected), but received \(received). Check the fingerprint on the Mac before trying again."
    case .cliUnavailable: "ADE is not installed for this user on the Mac. Install ADE, then try again."
    case .invalidResponse: "The Mac returned an unexpected response. Update ADE on the Mac, then try again."
    case .responseTooLarge: "The Mac returned an unexpectedly large response. Update ADE on the Mac, then try again."
    case .timedOut: "The Mac took too long to finish setup. Make sure ADE is open on the Mac, then try again."
    case .remote(_, let message): message
    }
  }
}
