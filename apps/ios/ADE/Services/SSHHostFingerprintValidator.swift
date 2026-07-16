import CryptoKit
import Foundation
import NIOCore
import NIOSSH

final class SSHHostFingerprintValidator: NIOSSHClientServerAuthenticationDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private let expectedFingerprint: String?
  private var capturedFingerprint: String?

  init(expectedFingerprint: String?) {
    self.expectedFingerprint = expectedFingerprint
  }

  var fingerprint: String? {
    lock.withLock { capturedFingerprint }
  }

  func validateHostKey(
    hostKey: NIOSSHPublicKey,
    validationCompletePromise: EventLoopPromise<Void>
  ) {
    let fingerprint = Self.fingerprint(for: hostKey)
    lock.withLock { capturedFingerprint = fingerprint }
    guard let expectedFingerprint else {
      validationCompletePromise.fail(SSHHostFingerprintNeedsConfirmation())
      return
    }
    guard expectedFingerprint == fingerprint else {
      validationCompletePromise.fail(SSHHostFingerprintMismatch())
      return
    }
    validationCompletePromise.succeed(())
  }

  static func fingerprint(for key: NIOSSHPublicKey) -> String {
    let openSSH = String(openSSHPublicKey: key)
    let encoded = openSSH.split(separator: " ").dropFirst().first.flatMap { Data(base64Encoded: String($0)) }
      ?? Data(openSSH.utf8)
    let digest = SHA256.hash(data: encoded)
    return "SHA256:\(Data(digest).base64EncodedString().replacing("=", with: ""))"
  }
}

private struct SSHHostFingerprintNeedsConfirmation: Error {}
private struct SSHHostFingerprintMismatch: Error {}
