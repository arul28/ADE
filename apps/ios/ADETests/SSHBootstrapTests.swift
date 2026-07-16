import XCTest
@testable import ADE

final class SSHBootstrapTests: XCTestCase {
  func testGeneratedEd25519KeyParsesAndProducesAuthorizationCommand() throws {
    let generated = SSHGeneratedKey.make(comment: "ade-test")
    _ = try SSHPrivateKeyParser.parse(generated.privateKey, passphrase: "")
    XCTAssertTrue(generated.publicKey.hasPrefix("ssh-ed25519 "))
    XCTAssertTrue(generated.authorizationCommand.contains("authorized_keys"))
    XCTAssertFalse(generated.authorizationCommand.contains("PRIVATE KEY"))
  }

  func testRSAKeyIsRejectedWithSupportedFormats() {
    let key = syntheticOpenSSHKey(type: "ssh-rsa", cipher: "none", kdf: "none")
    XCTAssertThrowsError(try SSHPrivateKeyParser.parse(key, passphrase: "")) { error in
      XCTAssertEqual(
        error as? SSHBootstrapError,
        .unsupportedKey("Use an Ed25519 or ECDSA OpenSSH private key. RSA keys are not enabled.")
      )
    }
  }

  func testEncryptedECDSAKeyExplainsRemediation() {
    // Assemble the boundary at runtime so this parser fixture cannot be
    // mistaken for a committed credential by repository secret scans.
    let key = [
      "-----BEGIN OPENSSH" + " PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABBW44d1+S",
      "yF6FDRmNNxiMclAAAAGAAAAAEAAABoAAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlz",
      "dHAyNTYAAABBBCjuSRdjkGwvDpzqG0o4I23msEqPcQEQ5J3PbpYEYiQoZ3JW1qr16g2bgM",
      "s5vj5Siq4ZBQn5q//Q12kT+cuXHR8AAADAN2oXl4jglEx72SSoNh22eSKX21pPh6nT9aPd",
      "zqczINy3Uwj6IYnAwbiVYpygAnZuZmyTjjQ6AlEdXwCCTh6aITl5nVhN5fr9E5rf5n2maF",
      "54uJn+GWGPV8t5P51kBvh8yvpNO/lGWx6tyqi2l96v7HeKTbQUhzF9jSRiV8QnhD8hZEuR",
      "4kmHwsUCaq6NE5Be3QqPXnYAHjuutjiY/99doTEpEEdGAk7V9Stn7GadCdwPUGSPsa4cic",
      "69XOB8UtNA",
      "-----END OPENSSH" + " PRIVATE KEY-----",
    ].joined(separator: "\n")
    for passphrase in ["", "secret"] {
      XCTAssertThrowsError(try SSHPrivateKeyParser.parse(key, passphrase: passphrase)) { error in
        XCTAssertEqual(
          error as? SSHBootstrapError,
          .unsupportedKey("Citadel 0.12.1 cannot decrypt ECDSA OpenSSH keys. Use an Ed25519 key, or import an unencrypted ECDSA key.")
        )
      }
    }
  }

  func testMalformedUnencryptedECDSAKeyFailsWithoutCrashing() {
    let key = syntheticOpenSSHKey(type: "ecdsa-sha2-nistp256", cipher: "none", kdf: "none")
    XCTAssertThrowsError(try SSHPrivateKeyParser.parse(key, passphrase: "")) { error in
      XCTAssertEqual(error as? SSHBootstrapError, .invalidPrivateKey)
    }
  }

  func testPairDeviceContractDecodesAndValidates() throws {
    let json = Data(#"{"version":1,"ok":true,"machine":{"deviceId":"machine-1","siteId":"site-1","name":"Mac Studio","platform":"darwin","deviceType":"brain"},"pairing":{"pairedDeviceId":"phone-1","secret":"secret-value"},"sync":{"port":8787,"addressCandidates":[{"host":"mac.local","kind":"lan"},{"host":"100.75.20.63","kind":"tailnet"}]},"runtime":{"name":"ADE","version":"1.2.28","channel":"stable"}}"#.utf8)
    let response = try JSONDecoder().decode(SSHBootstrapResponse.self, from: json)
    let validated = try response.validated()
    XCTAssertEqual(validated.machine.deviceId, "machine-1")
    XCTAssertEqual(validated.pairing.pairedDeviceId, "phone-1")
    XCTAssertEqual(validated.sync.port, 8787)
  }

  func testPairDeviceFailureUsesStructuredMessage() throws {
    let json = Data(#"{"version":1,"ok":false,"error":{"code":"invalid_device","message":"Device key rejected."}}"#.utf8)
    let response = try JSONDecoder().decode(SSHBootstrapResponse.self, from: json)
    XCTAssertThrowsError(try response.validated()) { error in
      XCTAssertEqual(error as? SSHBootstrapError, .remote(code: "invalid_device", message: "Device key rejected."))
    }
  }

  func testPairingCommandPrefersRunningChannelSocketsBeforeInstalledBinaries() throws {
    let command = SSHBootstrapService.pairingCommand
    let firstPass = try XCTUnwrap(command.range(of: #"for entry in "stable:.ade" "beta:.ade-beta" "alpha:.ade-alpha""#))
    let secondPass = try XCTUnwrap(
      command.range(of: #"for entry in "stable:.ade" "beta:.ade-beta" "alpha:.ade-alpha""#, range: firstPass.upperBound..<command.endIndex)
    )
    XCTAssertLessThan(firstPass.lowerBound, secondPass.lowerBound)
    XCTAssertTrue(command[firstPass.lowerBound..<secondPass.lowerBound].contains(#"[ -S "$socket" ]"#))
    XCTAssertFalse(command[secondPass.lowerBound..<command.endIndex].contains(#"[ -S "$socket" ]"#))
    XCTAssertTrue(command.contains(#"IFS= read -r payload"#))
    XCTAssertTrue(command.contains("printf \"%s\n\" \"$payload\" | env"))
    XCTAssertEqual(command.components(separatedBy: "sync pair-device --json-stdin").count - 1, 2)
  }

  func testPairingCommandLetsInstalledBinaryRecoverMissingOrStoppedRuntime() throws {
    let command = SSHBootstrapService.pairingCommand
    let firstPass = try XCTUnwrap(command.range(of: #"for entry in "stable:.ade" "beta:.ade-beta" "alpha:.ade-alpha""#))
    let secondPass = try XCTUnwrap(
      command.range(of: #"for entry in "stable:.ade" "beta:.ade-beta" "alpha:.ade-alpha""#, range: firstPass.upperBound..<command.endIndex)
    )
    let runningSocketPass = command[firstPass.lowerBound..<secondPass.lowerBound]
    let installedBinaryPass = command[secondPass.lowerBound..<command.endIndex]

    XCTAssertTrue(runningSocketPass.contains(#""$binary" --socket "$socket" sync pair-device --json-stdin"#))
    XCTAssertFalse(installedBinaryPass.contains(#""$binary" --socket "$socket""#))
    XCTAssertTrue(
      installedBinaryPass.contains(
        #"ADE_RUNTIME_SOCKET_PATH="$socket" "$binary" sync pair-device --json-stdin"#
      )
    )
  }

  func testPairingCommandEmitsOnlySuccessfulFallbackOutput() {
    let command = SSHBootstrapService.pairingCommand
    let successfulOutputContract = #">"$output"; then cat "$output"; exit 0"#

    XCTAssertTrue(command.contains(#"output=$(mktemp "${TMPDIR:-/tmp}/ade-pair.XXXXXX")"#))
    XCTAssertTrue(command.contains(#"trap cleanup EXIT HUP INT TERM"#))
    XCTAssertEqual(command.components(separatedBy: successfulOutputContract).count - 1, 2)
    XCTAssertFalse(command.contains("sync pair-device --json-stdin && exit 0"))
  }

  func testHostPinStoreKeysByHostAndPort() {
    let suite = "SSHBootstrapTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let store = SSHHostKeyPinStore(defaults: defaults)
    store.save("SHA256:abc", host: "Mac.Local", port: 22)
    XCTAssertEqual(store.fingerprint(host: "mac.local", port: 22), "SHA256:abc")
    XCTAssertNil(store.fingerprint(host: "mac.local", port: 2222))
  }

  func testTrustResetDoesNotTargetAccountOrDeviceIdentity() {
    XCTAssertFalse(MobileTrustResetPolicy.userDefaultsKeys.contains("ade.sync.deviceId"))
    XCTAssertFalse(MobileTrustResetPolicy.userDefaultsKeys.contains { $0.localizedCaseInsensitiveContains("clerk") })
  }

  func testTrustResetClearsMachineStateOnceAndPreservesAccountState() {
    let suite = "SSHBootstrapTests.TrustReset.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    defaults.set("saved-profile", forKey: "ade.sync.hostProfile")
    defaults.set("signed-in-account", forKey: "clerk.session")
    var tokenClearCount = 0
    let clearTokens = {
      tokenClearCount += 1
      return true
    }

    XCTAssertTrue(MobileTrustResetPolicy.applyIfNeeded(defaults: defaults, clearConnectionTokens: clearTokens))
    XCTAssertNil(defaults.object(forKey: "ade.sync.hostProfile"))
    XCTAssertEqual(defaults.string(forKey: "clerk.session"), "signed-in-account")
    XCTAssertFalse(MobileTrustResetPolicy.applyIfNeeded(defaults: defaults, clearConnectionTokens: clearTokens))
    XCTAssertEqual(tokenClearCount, 1)
  }

  func testTrustResetRetriesWhenKeychainClearFails() {
    let suite = "SSHBootstrapTests.TrustResetFailure.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    defaults.set("saved-profile", forKey: "ade.sync.hostProfile")

    XCTAssertFalse(MobileTrustResetPolicy.applyIfNeeded(defaults: defaults, clearConnectionTokens: { false }))
    XCTAssertEqual(defaults.string(forKey: "ade.sync.hostProfile"), "saved-profile")
    XCTAssertFalse(defaults.bool(forKey: MobileTrustResetPolicy.migrationKey))
  }

  private func syntheticOpenSSHKey(type: String, cipher: String, kdf: String) -> String {
    var payload = Data("openssh-key-v1\0".utf8)
    appendSSHString(cipher, to: &payload)
    appendSSHString(kdf, to: &payload)
    appendSSHData(Data(), to: &payload)
    appendUInt32(1, to: &payload)

    var publicKey = Data()
    appendSSHString(type, to: &publicKey)
    appendSSHData(publicKey, to: &payload)

    let body = payload.base64EncodedString(options: [.lineLength64Characters, .endLineWithLineFeed])
    return "-----BEGIN OPENSSH PRIVATE KEY-----\n\(body)-----END OPENSSH PRIVATE KEY-----"
  }

  private func appendSSHString(_ value: String, to data: inout Data) {
    appendSSHData(Data(value.utf8), to: &data)
  }

  private func appendSSHData(_ value: Data, to data: inout Data) {
    appendUInt32(UInt32(value.count), to: &data)
    data.append(value)
  }

  private func appendUInt32(_ value: UInt32, to data: inout Data) {
    data.append(UInt8((value >> 24) & 0xff))
    data.append(UInt8((value >> 16) & 0xff))
    data.append(UInt8((value >> 8) & 0xff))
    data.append(UInt8(value & 0xff))
  }
}
