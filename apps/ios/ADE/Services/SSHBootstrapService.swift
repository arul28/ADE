import Citadel
import Foundation
import NIOCore

actor SSHBootstrapService {
  static let pairingCommand = """
  sh -lc 'IFS= read -r payload || exit 64; attempted=0; for entry in "stable:.ade" "beta:.ade-beta" "alpha:.ade-alpha"; do channel=${entry%%:*}; home=${entry#*:}; socket="$HOME/$home/sock/ade.sock"; binary="$HOME/$home/bin/ade"; if [ -S "$socket" ] && [ -x "$binary" ]; then attempted=1; printf "%s\n" "$payload" | env ADE_HOME="$HOME/$home" ADE_PACKAGE_CHANNEL="$channel" "$binary" --socket "$socket" sync pair-device --json-stdin && exit 0; fi; done; for entry in "stable:.ade" "beta:.ade-beta" "alpha:.ade-alpha"; do channel=${entry%%:*}; home=${entry#*:}; socket="$HOME/$home/sock/ade.sock"; binary="$HOME/$home/bin/ade"; if [ -x "$binary" ]; then attempted=1; printf "%s\n" "$payload" | env ADE_HOME="$HOME/$home" ADE_PACKAGE_CHANNEL="$channel" "$binary" --socket "$socket" sync pair-device --json-stdin && exit 0; fi; done; if [ "$attempted" -eq 0 ]; then echo ADE_CLI_NOT_FOUND >&2; exit 127; fi; exit 1'
  """

  private let credentialStore: SSHCredentialStore
  private let pinStore: SSHHostKeyPinStore
  private let decoder = JSONDecoder()
  private let encoder = JSONEncoder()
  private let maximumResponseBytes = 64 * 1024
  private let commandTimeout: Duration = .seconds(30)

  init(
    credentialStore: SSHCredentialStore = SSHCredentialStore(),
    pinStore: SSHHostKeyPinStore = SSHHostKeyPinStore()
  ) {
    self.credentialStore = credentialStore
    self.pinStore = pinStore
  }

  func savedFingerprint(for input: SSHConnectionInput) -> String? {
    pinStore.fingerprint(host: input.normalizedHost, port: input.port)
  }

  func probeFingerprint(input: SSHConnectionInput) async throws -> String {
    let input = try input.validated()
    let material = try SSHPrivateKeyParser.parse(input.privateKey, passphrase: input.passphrase)
    let validator = SSHHostFingerprintValidator(expectedFingerprint: nil)
    let settings = makeSettings(input: input, material: material, validator: validator)
    do {
      let client = try await SSHClient.connect(to: settings)
      try? await client.close()
    } catch {
      if let fingerprint = validator.fingerprint { return fingerprint }
      throw error
    }
    guard let fingerprint = validator.fingerprint else { throw SSHBootstrapError.invalidResponse }
    return fingerprint
  }

  func loadRetainedCredential(host: String, port: Int, username: String) throws -> SSHStoredCredential? {
    try credentialStore.load(host: host, port: port, username: username)
  }

  func bootstrap(
    input: SSHConnectionInput,
    expectedFingerprint: String,
    request: SSHBootstrapRequest,
    retainCredential: Bool
  ) async throws -> SSHValidatedBootstrapResponse {
    let input = try input.validated()
    let material = try SSHPrivateKeyParser.parse(input.privateKey, passphrase: input.passphrase)
    let validator = SSHHostFingerprintValidator(expectedFingerprint: expectedFingerprint)
    let settings = makeSettings(input: input, material: material, validator: validator)
    let client: SSHClient
    do {
      client = try await SSHClient.connect(to: settings)
    } catch {
      if let received = validator.fingerprint, received != expectedFingerprint {
        throw SSHBootstrapError.hostKeyChanged(expected: expectedFingerprint, received: received)
      }
      throw error
    }

    do {
      let requestData = try encoder.encode(request)
      let responseData = try await executePairingCommand(client: client, requestData: requestData)
      try await client.close()
      let response = try decoder.decode(SSHBootstrapResponse.self, from: responseData)
      var validated = try response.validated()
      guard validated.pairing.pairedDeviceId == request.device.id else {
        throw SSHBootstrapError.invalidResponse
      }
      pinStore.save(expectedFingerprint, host: input.normalizedHost, port: input.port)
      if retainCredential {
        do {
          try credentialStore.save(
            SSHStoredCredential(privateKey: input.privateKey, passphrase: input.passphrase),
            host: input.normalizedHost,
            port: input.port,
            username: input.normalizedUsername
          )
        } catch {
          validated.credentialWarning = "Your Mac is paired, but ADE could not save the SSH key. You can pair again later if you need SSH recovery."
        }
      } else {
        credentialStore.remove(host: input.normalizedHost, port: input.port, username: input.normalizedUsername)
      }
      return validated
    } catch {
      try? await client.close()
      throw error
    }
  }

  private func makeSettings(
    input: SSHConnectionInput,
    material: SSHPrivateKeyMaterial,
    validator: SSHHostFingerprintValidator
  ) -> SSHClientSettings {
    var settings = SSHClientSettings(
      host: input.normalizedHost,
      port: input.port,
      authenticationMethod: {
        material.authenticationMethod(username: input.normalizedUsername)
      },
      hostKeyValidator: .custom(validator)
    )
    // Citadel/NIOSSH defaults include modern curve host keys, curve key
    // exchange, and authenticated encryption. Do not opt into `.all`, which
    // adds the package's legacy RSA/SHA-1 compatibility algorithms.
    settings.algorithms = SSHAlgorithms()
    return settings
  }

  private func executePairingCommand(client: SSHClient, requestData: Data) async throws -> Data {
    try await withTaskCancellationHandler(operation: {
      try await withThrowingTaskGroup(of: (Data, Data).self) { group in
        group.addTask { [maximumResponseBytes] in
          var stdout = Data()
          var stderr = Data()
          do {
            try await client.withExec(Self.pairingCommand) { inbound, outbound in
              var line = ByteBuffer(data: requestData)
              line.writeString("\n")
              try await outbound.write(line)
              for try await output in inbound {
                switch output {
                case .stdout(let buffer):
                  stdout.append(contentsOf: buffer.readableBytesView)
                case .stderr(let buffer):
                  stderr.append(contentsOf: buffer.readableBytesView)
                }
                if stdout.count + stderr.count > maximumResponseBytes {
                  throw SSHBootstrapError.responseTooLarge
                }
              }
            }
          } catch let error as SSHBootstrapError {
            throw error
          } catch {
            // Citadel throws for a non-zero remote exit after yielding output.
            // Keep that bounded output so CLI errors stay actionable.
            if stdout.isEmpty && stderr.isEmpty { throw error }
          }
          return (stdout, stderr)
        }
        group.addTask { [commandTimeout] in
          try await Task.sleep(for: commandTimeout)
          try? await client.close()
          throw SSHBootstrapError.timedOut
        }
        defer { group.cancelAll() }
        guard let (stdout, stderr) = try await group.next() else {
          throw SSHBootstrapError.invalidResponse
        }
        guard stderr.range(of: Data("ADE_CLI_NOT_FOUND".utf8)) == nil else {
          throw SSHBootstrapError.cliUnavailable
        }
        guard !stdout.isEmpty else {
          let message = String(data: stderr, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
          if let message, !message.isEmpty {
            throw SSHBootstrapError.remote(code: "remote_command_failed", message: message)
          }
          throw SSHBootstrapError.invalidResponse
        }
        return stdout
      }
    }, onCancel: {
      Task { try? await client.close() }
    })
  }
}
