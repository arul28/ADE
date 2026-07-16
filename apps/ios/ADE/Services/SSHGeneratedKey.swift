import Crypto
import Foundation

struct SSHGeneratedKey: Equatable {
  let privateKey: String
  let publicKey: String

  var authorizationCommand: String {
    "mkdir -p ~/.ssh && chmod 700 ~/.ssh && printf '%s\\n' '\(publicKey)' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
  }

  static func make(comment: String = "ade-mobile") -> SSHGeneratedKey {
    let key = Curve25519.Signing.PrivateKey()
    let publicBlob = sshString("ssh-ed25519") + sshString(key.publicKey.rawRepresentation)
    let publicLine = "ssh-ed25519 \(publicBlob.base64EncodedString()) \(comment)"

    let check = UInt32.random(in: UInt32.min...UInt32.max)
    var privateBlock = uint32(check) + uint32(check)
    privateBlock += sshString("ssh-ed25519")
    privateBlock += sshString(key.publicKey.rawRepresentation)
    privateBlock += sshString(key.rawRepresentation + key.publicKey.rawRepresentation)
    privateBlock += sshString(comment)
    var padding: UInt8 = 1
    while privateBlock.count.isMultiple(of: 8) == false {
      privateBlock.append(padding)
      padding &+= 1
    }

    var container = Data("openssh-key-v1\0".utf8)
    container += sshString("none")
    container += sshString("none")
    container += sshString(Data())
    container += uint32(1)
    container += sshString(publicBlob)
    container += sshString(privateBlock)

    let base64 = container.base64EncodedString()
    let lines = stride(from: 0, to: base64.count, by: 70).map { offset in
      let start = base64.index(base64.startIndex, offsetBy: offset)
      let end = base64.index(start, offsetBy: min(70, base64.distance(from: start, to: base64.endIndex)))
      return String(base64[start..<end])
    }
    let privateKey = (["-----BEGIN OPENSSH PRIVATE KEY-----"] + lines + ["-----END OPENSSH PRIVATE KEY-----"]).joined(separator: "\n")
    return SSHGeneratedKey(privateKey: privateKey, publicKey: publicLine)
  }

  private static func sshString(_ value: String) -> Data {
    sshString(Data(value.utf8))
  }

  private static func sshString(_ value: Data) -> Data {
    uint32(UInt32(value.count)) + value
  }

  private static func uint32(_ value: UInt32) -> Data {
    Data([
      UInt8((value >> 24) & 0xff),
      UInt8((value >> 16) & 0xff),
      UInt8((value >> 8) & 0xff),
      UInt8(value & 0xff),
    ])
  }
}
