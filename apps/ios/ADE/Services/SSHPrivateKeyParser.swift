import Citadel
import Crypto
import Foundation

enum SSHPrivateKeyMaterial {
  case ed25519(Curve25519.Signing.PrivateKey)
  case p256(P256.Signing.PrivateKey)
  case p384(P384.Signing.PrivateKey)
  case p521(P521.Signing.PrivateKey)

  func authenticationMethod(username: String) -> SSHAuthenticationMethod {
    switch self {
    case .ed25519(let key): .ed25519(username: username, privateKey: key)
    case .p256(let key): .p256(username: username, privateKey: key)
    case .p384(let key): .p384(username: username, privateKey: key)
    case .p521(let key): .p521(username: username, privateKey: key)
    }
  }
}

enum SSHPrivateKeyParser {
  static func parse(_ key: String, passphrase: String) throws -> SSHPrivateKeyMaterial {
    let type: SSHKeyType
    do {
      type = try SSHKeyDetection.detectPrivateKeyType(from: key)
    } catch {
      throw SSHBootstrapError.invalidPrivateKey
    }

    if type == .ed25519 {
      do {
        let decryptionKey = passphrase.isEmpty ? nil : Data(passphrase.utf8)
        return .ed25519(try Curve25519.Signing.PrivateKey(sshEd25519: key, decryptionKey: decryptionKey))
      } catch {
        if passphrase.isEmpty { throw SSHBootstrapError.passphraseRequired }
        throw SSHBootstrapError.incorrectPassphrase
      }
    }

    guard type == .ecdsaP256 || type == .ecdsaP384 || type == .ecdsaP521 else {
      throw SSHBootstrapError.unsupportedKey("Use an Ed25519 or ECDSA OpenSSH private key. RSA keys are not enabled.")
    }
    guard !isEncryptedOpenSSH(key) else {
      throw SSHBootstrapError.unsupportedKey("Citadel 0.12.1 cannot decrypt ECDSA OpenSSH keys. Use an Ed25519 key, or import an unencrypted ECDSA key.")
    }
    let scalar = try parseUnencryptedECDSAScalar(key, expectedType: type)
    do {
      if type == .ecdsaP256 { return .p256(try P256.Signing.PrivateKey(rawRepresentation: normalizedScalar(scalar, count: 32))) }
      if type == .ecdsaP384 { return .p384(try P384.Signing.PrivateKey(rawRepresentation: normalizedScalar(scalar, count: 48))) }
      return .p521(try P521.Signing.PrivateKey(rawRepresentation: normalizedScalar(scalar, count: 66)))
    } catch {
      throw SSHBootstrapError.invalidPrivateKey
    }
  }

  private static func isEncryptedOpenSSH(_ source: String) -> Bool {
    let payload = source
      .replacing("-----BEGIN OPENSSH PRIVATE KEY-----", with: "")
      .replacing("-----END OPENSSH PRIVATE KEY-----", with: "")
      .filter { !$0.isWhitespace }
    guard let data = Data(base64Encoded: payload) else { return false }
    let bytes = [UInt8](data)
    let magic = [UInt8]("openssh-key-v1\0".utf8)
    guard bytes.count >= magic.count + 4,
          Array(bytes.prefix(magic.count)) == magic else { return false }
    let lengthOffset = magic.count
    let cipherLength = Int(bytes[lengthOffset]) << 24
      | Int(bytes[lengthOffset + 1]) << 16
      | Int(bytes[lengthOffset + 2]) << 8
      | Int(bytes[lengthOffset + 3])
    let cipherStart = lengthOffset + 4
    guard cipherLength >= 0,
          cipherStart + cipherLength <= bytes.count,
          let cipher = String(bytes: bytes[cipherStart..<(cipherStart + cipherLength)], encoding: .utf8) else {
      return false
    }
    return cipher != "none"
  }

  private static func parseUnencryptedECDSAScalar(_ source: String, expectedType: SSHKeyType) throws -> Data {
    let payload = source
      .replacing("-----BEGIN OPENSSH PRIVATE KEY-----", with: "")
      .replacing("-----END OPENSSH PRIVATE KEY-----", with: "")
      .filter { !$0.isWhitespace }
    guard let data = Data(base64Encoded: payload) else { throw SSHBootstrapError.invalidPrivateKey }
    var reader = SSHBinaryReader(data: data)
    guard reader.readBytes(count: 15) == Data("openssh-key-v1\0".utf8),
          reader.readString() == "none",
          reader.readString() == "none",
          reader.readData()?.isEmpty == true,
          reader.readUInt32() == 1,
          reader.readData() != nil,
          let privateBlock = reader.readData() else {
      throw SSHBootstrapError.invalidPrivateKey
    }
    var privateReader = SSHBinaryReader(data: privateBlock)
    guard let check1 = privateReader.readUInt32(),
          check1 == privateReader.readUInt32(),
          privateReader.readString() == expectedType.rawValue,
          privateReader.readString() != nil,
          privateReader.readData() != nil,
          let scalar = privateReader.readData() else {
      throw SSHBootstrapError.invalidPrivateKey
    }
    return scalar
  }

  private static func normalizedScalar(_ scalar: Data, count: Int) throws -> Data {
    let trimmed = scalar.drop(while: { $0 == 0 })
    guard trimmed.count <= count else { throw SSHBootstrapError.invalidPrivateKey }
    var result = Data(repeating: 0, count: count - trimmed.count)
    result.append(contentsOf: trimmed)
    return result
  }
}

private struct SSHBinaryReader {
  let data: Data
  var offset = 0

  mutating func readUInt32() -> UInt32? {
    guard offset + 4 <= data.count else { return nil }
    let value = data[offset..<(offset + 4)].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
    offset += 4
    return value
  }

  mutating func readData() -> Data? {
    guard let length = readUInt32(), let count = Int(exactly: length) else { return nil }
    return readBytes(count: count)
  }

  mutating func readString() -> String? {
    readData().flatMap { String(data: $0, encoding: .utf8) }
  }

  mutating func readBytes(count: Int) -> Data? {
    guard count >= 0, offset + count <= data.count else { return nil }
    defer { offset += count }
    return data.subdata(in: offset..<(offset + count))
  }
}
