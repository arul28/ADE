import XCTest
@testable import ADE

final class SyncEnvelopeChunkAssemblerTests: XCTestCase {
  private func base64(_ text: String) -> String {
    Data(text.utf8).base64EncodedString()
  }

  func testRoundTripsPartsInOrder() {
    var assembler = SyncEnvelopeChunkAssembler()
    XCTAssertNil(assembler.add(chunkId: "a", index: 0, total: 3, part: base64("{\"type\":\"file_re")))
    XCTAssertNil(assembler.add(chunkId: "a", index: 1, total: 3, part: base64("sponse\",\"payload\":")))
    let result = assembler.add(chunkId: "a", index: 2, total: 3, part: base64("\"done\"}"))
    XCTAssertEqual(result, "{\"type\":\"file_response\",\"payload\":\"done\"}")
  }

  func testRoundTripsPartsOutOfOrder() {
    var assembler = SyncEnvelopeChunkAssembler()
    XCTAssertNil(assembler.add(chunkId: "b", index: 1, total: 2, part: base64("world")))
    XCTAssertEqual(assembler.add(chunkId: "b", index: 0, total: 2, part: base64("hello ")), "hello world")
  }

  func testPreservesMultiByteUnicodeSplitMidCharacter() {
    // Split the UTF-8 bytes of a multi-byte string at an arbitrary byte
    // boundary — reassembly must restore the exact original text.
    let original = "变更日志 🚀 ünïcödé"
    let bytes = Data(original.utf8)
    let cut = 7
    var assembler = SyncEnvelopeChunkAssembler()
    XCTAssertNil(assembler.add(chunkId: "u", index: 0, total: 2, part: bytes.prefix(cut).base64EncodedString()))
    XCTAssertEqual(assembler.add(chunkId: "u", index: 1, total: 2, part: bytes.dropFirst(cut).base64EncodedString()), original)
  }

  func testDropsChunkSetsWithInconsistentTotals() {
    var assembler = SyncEnvelopeChunkAssembler()
    XCTAssertNil(assembler.add(chunkId: "c", index: 0, total: 2, part: base64("x")))
    XCTAssertNil(assembler.add(chunkId: "c", index: 1, total: 3, part: base64("y")))
    // The mismatch dropped the buffer, so completing the original pair restarts.
    XCTAssertNil(assembler.add(chunkId: "c", index: 1, total: 2, part: base64("y")))
  }

  func testRejectsInvalidIndexesAndOversizedTotals() {
    var assembler = SyncEnvelopeChunkAssembler()
    XCTAssertNil(assembler.add(chunkId: "d", index: 2, total: 2, part: base64("x")))
    XCTAssertNil(assembler.add(chunkId: "d", index: -1, total: 2, part: base64("x")))
    XCTAssertNil(assembler.add(chunkId: "d", index: 0, total: 0, part: base64("x")))
    XCTAssertNil(assembler.add(chunkId: "d", index: 0, total: 100_000, part: base64("x")))
    XCTAssertNil(assembler.add(chunkId: "", index: 0, total: 1, part: base64("x")))
  }

  func testResetClearsPartialChunks() {
    var assembler = SyncEnvelopeChunkAssembler()
    XCTAssertNil(assembler.add(chunkId: "e", index: 0, total: 2, part: base64("1")))
    assembler.reset()
    XCTAssertNil(assembler.add(chunkId: "e", index: 1, total: 2, part: base64("2")))
  }
}
