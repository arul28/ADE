import XCTest
@testable import ADE

/// Passwords on the phone open items the brains seal. Both halves must agree
/// byte for byte on the envelope and the additional data, or the phone shows
/// nothing (or, worse, opens an item under the wrong account). The vector
/// below comes from the real `sealPasswordItem`
/// (`apps/ios/Scripts/passwords-vector-fixture.ts`); its key and plaintext
/// are fixed test data.
final class PasswordsVaultTests: XCTestCase {
  private let key = Data(base64Encoded: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=")!
  private let accountId = "user_2pQxFixtureAccount"
  private let itemId = "pw_fixture_01ABCD"
  private let epoch = 3
  private let envelopeJSON = #"{"v":1,"epoch":3,"nonce":"FLtLKwhqmCSGFDJr","ct":"AJ6rJeUcMWMM/wF8i0jVbYLLELRhkNZOM94APnCexZfB41oiBsU4X5nc1lYuWnps6vC1wv5oZ0+W0EB730iwbw4lRHDyBD+DfkV9rLEF9iJA9lZTp34idrXUweX2ZwIePVaArHWu8fA88H3gW+68a91c9Kw2o/Zm/E6W3CGCE66UoUX7Jp0pgZBNjM3HQEmEPQAdFwJAy2mcF5laJkuoB7mYhq12u/c4TsBZiTNQLQuwgVUswNVZoo7i8VD8IOMFScT2tZPfUDKEUraPbtMmcvnj9WEqchd2MSQiGUJK6ejlr6El/repQ0THVN1ZQ908aMZDmwkDavf9BKvKXQMW7zXM1WRz88BuDOPE7jg/p7f9mx3SNU/TgAuVJkCgtXaLJV6TPKDmRfieW650GSq+HGCAzEa5O+i8vt3EvwObT6bUoB3jUAq61AMwvlJlci4x1aXuZgmkmd0a"}"#
  private let plaintext = #"{"kind":"login","title":"Fixture Site","origins":["https://fixture.example"],"username":"fixture@example.com","password":"correct-horse-battery-staple","notes":"Fixture notes","totpUri":"otpauth://totp/Fixture?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ","createdAt":"2026-11-01T00:00:00.000Z","updatedAt":"2026-11-02T00:00:00.000Z"}"#

  func testOpensAnItemSealedByTheBrains() throws {
    let envelope = try XCTUnwrap(PasswordCrypto.parseEnvelope(envelopeJSON))
    let plain = try PasswordCrypto.openData(key: key, accountId: accountId, itemId: itemId, epoch: epoch, envelope: envelope)
    XCTAssertEqual(String(data: plain, encoding: .utf8), plaintext)

    let opened = try PasswordCrypto.open(key: key, accountId: accountId, itemId: itemId, epoch: epoch, envelope: envelope)
    XCTAssertEqual(opened, .login(.init(
      title: "Fixture Site",
      origins: ["https://fixture.example"],
      username: "fixture@example.com",
      password: "correct-horse-battery-staple",
      notes: "Fixture notes",
      totpUri: "otpauth://totp/Fixture?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
    )))
  }

  /// A row copied to another account or item, replayed under another epoch,
  /// opened with another key, or changed by one bit never opens.
  func testRefusesAnyOtherBindingKeyOrTamperedEnvelope() throws {
    let envelope = try XCTUnwrap(PasswordCrypto.parseEnvelope(envelopeJSON))
    var flippedBody = try XCTUnwrap(Data(base64Encoded: envelope.ct))
    flippedBody[5] ^= 0x01
    var flippedTag = try XCTUnwrap(Data(base64Encoded: envelope.ct))
    flippedTag[flippedTag.count - 1] ^= 0x80
    var otherKey = key
    otherKey[0] ^= 0x01
    let resealedAtEpoch4 = PasswordEnvelope(v: 1, epoch: 4, nonce: envelope.nonce, ct: envelope.ct)

    let cases: [(String, Data, String, String, Int, PasswordEnvelope)] = [
      ("wrong account", key, "user_2pQxOtherAccount", itemId, epoch, envelope),
      ("wrong item", key, accountId, "pw_fixture_01ABCE", epoch, envelope),
      ("wrong epoch in binding and envelope", key, accountId, itemId, 4, resealedAtEpoch4),
      ("envelope epoch differs from key epoch", key, accountId, itemId, 2, envelope),
      ("wrong key", otherKey, accountId, itemId, epoch, envelope),
      ("flipped ciphertext byte", key, accountId, itemId, epoch,
       PasswordEnvelope(v: 1, epoch: 3, nonce: envelope.nonce, ct: flippedBody.base64EncodedString())),
      ("flipped tag byte", key, accountId, itemId, epoch,
       PasswordEnvelope(v: 1, epoch: 3, nonce: envelope.nonce, ct: flippedTag.base64EncodedString())),
      ("account id with a newline", key, "\(accountId)\n", itemId, epoch, envelope),
    ]
    for (name, key, account, item, epoch, envelope) in cases {
      XCTAssertThrowsError(
        try PasswordCrypto.openData(key: key, accountId: account, itemId: item, epoch: epoch, envelope: envelope),
        name
      )
    }
  }

  /// RFC 6238 appendix B, through an `otpauth://` URI as logins store them.
  func testAuthenticatorCodesMatchRFC6238() throws {
    let sha1 = "otpauth://totp/ADE:me?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8"
    let sha256 = "otpauth://totp/ADE%20Test:me?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA&digits=8&algorithm=SHA256"
    let vectors: [(String, TimeInterval, String, Int)] = [
      (sha1, 59, "94287082", 1),
      (sha1, 1_111_111_109, "07081804", 1),
      (sha256, 59, "46119246", 1),
      // A bare base32 key: 6 digits, 30 s, SHA-1 (the same answer as the brains').
      ("GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ", 1_234_567_890, "005924", 30),
    ]
    for (input, time, code, secondsLeft) in vectors {
      let params = try XCTUnwrap(PasswordTotp.parse(input), input)
      let result = PasswordTotp.code(params, at: Date(timeIntervalSince1970: time))
      XCTAssertEqual(result.code, code, input)
      XCTAssertEqual(result.secondsLeft, secondsLeft, input)
    }
  }
}
