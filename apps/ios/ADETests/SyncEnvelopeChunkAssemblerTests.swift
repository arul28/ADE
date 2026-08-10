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
    XCTAssertNil(assembler.add(
      chunkId: String(repeating: "x", count: 129),
      index: 0,
      total: 1,
      part: base64("x")
    ))
  }

  func testDropsOversizedSinglePartAndAllowsChunkIdReuse() {
    var assembler = SyncEnvelopeChunkAssembler(maxEnvelopeBytes: 4)
    XCTAssertNil(assembler.add(chunkId: "oversized", index: 0, total: 1, part: base64("12345")))
    XCTAssertEqual(assembler.add(chunkId: "oversized", index: 0, total: 1, part: base64("ok")), "ok")
  }

  func testDropsChunkSetWhenCumulativeBytesExceedLimit() {
    var assembler = SyncEnvelopeChunkAssembler(maxEnvelopeBytes: 6)
    XCTAssertNil(assembler.add(chunkId: "bytes", index: 0, total: 2, part: base64("abc")))
    XCTAssertNil(assembler.add(chunkId: "bytes", index: 1, total: 2, part: base64("defg")))
    XCTAssertEqual(assembler.add(chunkId: "bytes", index: 0, total: 1, part: base64("fresh")), "fresh")
  }

  func testReplacingPartDoesNotDoubleCountByteBudget() {
    var assembler = SyncEnvelopeChunkAssembler(maxEnvelopeBytes: 6)
    XCTAssertNil(assembler.add(chunkId: "replace", index: 0, total: 2, part: base64("abcde")))
    XCTAssertNil(assembler.add(chunkId: "replace", index: 0, total: 2, part: base64("a")))
    XCTAssertEqual(assembler.add(chunkId: "replace", index: 1, total: 2, part: base64("bcde")), "abcde")
  }

  func testCapsAggregateBytesAcrossConcurrentChunkSets() {
    var assembler = SyncEnvelopeChunkAssembler(
      maxEnvelopeBytes: 8,
      maxBufferedBytes: 8
    )
    XCTAssertNil(assembler.add(chunkId: "one", index: 0, total: 2, part: base64("12345")))
    XCTAssertNil(assembler.add(chunkId: "two", index: 0, total: 2, part: base64("6789")))
    XCTAssertEqual(assembler.pendingCount, 1)
  }

  func testOutboundFramesStayInsideBudgetAndReassemble() throws {
    let payload = ["text": String(repeating: "0123456789abcdef", count: 8_000)]
    let legacy = try syncEncodeEnvelopeFrames(
      type: "changeset_batch",
      requestId: "chunk-round-trip",
      projectId: "project-1",
      payload: payload,
      compressionCodec: .gzip,
      compressionThresholdBytes: Int.max,
      chunkedEnvelopes: false,
      maxFrameBytes: 32 * 1024
    )
    let direct = try syncEncodeEnvelopeText(
      type: "changeset_batch",
      requestId: "chunk-round-trip",
      projectId: "project-1",
      payload: payload,
      compressionCodec: .gzip,
      compressionThresholdBytes: Int.max
    )
    XCTAssertEqual(legacy, [direct], "No-capability output must remain byte-identical.")

    let frames = try syncEncodeEnvelopeFrames(
      type: "changeset_batch",
      requestId: "chunk-round-trip",
      projectId: "project-1",
      payload: payload,
      compressionCodec: .gzip,
      compressionThresholdBytes: Int.max,
      chunkedEnvelopes: true,
      maxFrameBytes: 32 * 1024
    )
    XCTAssertGreaterThan(frames.count, 1)
    XCTAssertTrue(frames.allSatisfy { $0.utf8.count <= 32 * 1024 })

    var assembler = SyncEnvelopeChunkAssembler()
    var reassembled: String?
    for frame in frames.reversed() {
      let decoded = try XCTUnwrap(
        syncPreprocessIncoming(frame)?.payload as? [String: Any]
      )
      reassembled = assembler.add(
        chunkId: try XCTUnwrap(decoded["chunkId"] as? String),
        index: try XCTUnwrap(decoded["index"] as? Int),
        total: try XCTUnwrap(decoded["total"] as? Int),
        part: try XCTUnwrap(decoded["part"] as? String)
      ) ?? reassembled
    }
    XCTAssertEqual(reassembled, direct)
  }

  func testCompressionAndChunkingMatrixRoundTrips() throws {
    var state: UInt32 = 0x9e3779b9
    var bytes = [UInt8](repeating: 0, count: 96 * 1024)
    for index in bytes.indices {
      state ^= state << 13
      state ^= state >> 17
      state ^= state << 5
      bytes[index] = UInt8(truncatingIfNeeded: state)
    }
    let text = Data(bytes).base64EncodedString()
    let payload = ["text": text]

    for compressed in [false, true] {
      for chunked in [false, true] {
        let frames = try syncEncodeEnvelopeFrames(
          type: "changeset_batch",
          requestId: "matrix-\(compressed)-\(chunked)",
          projectId: "project-1",
          payload: payload,
          compressionCodec: .deflate,
          compressionThresholdBytes: compressed ? 1 : Int.max,
          chunkedEnvelopes: chunked,
          maxFrameBytes: 32 * 1024
        )
        XCTAssertEqual(frames.count > 1, chunked)

        var encoded = frames[0]
        if chunked {
          var assembler = SyncEnvelopeChunkAssembler()
          var reassembled: String?
          for frame in frames.reversed() {
            let decoded = try XCTUnwrap(
              syncPreprocessIncoming(frame)?.payload as? [String: Any]
            )
            reassembled = assembler.add(
              chunkId: try XCTUnwrap(decoded["chunkId"] as? String),
              index: try XCTUnwrap(decoded["index"] as? Int),
              total: try XCTUnwrap(decoded["total"] as? Int),
              part: try XCTUnwrap(decoded["part"] as? String)
            ) ?? reassembled
          }
          encoded = try XCTUnwrap(reassembled)
        }

        let envelope = try XCTUnwrap(
          JSONSerialization.jsonObject(with: Data(encoded.utf8)) as? [String: Any]
        )
        XCTAssertEqual(envelope["compression"] as? String, compressed ? "deflate" : "none")
        let decoded = try XCTUnwrap(
          syncPreprocessIncoming(encoded)?.payload as? [String: Any]
        )
        XCTAssertEqual(decoded["text"] as? String, text)
      }
    }
  }

  func testExpiresIncompleteSetsAfterThirtySeconds() {
    var assembler = SyncEnvelopeChunkAssembler()
    XCTAssertNil(assembler.add(
      chunkId: "stale",
      index: 0,
      total: 2,
      part: Data("first".utf8).base64EncodedString(),
      now: 100
    ))
    XCTAssertEqual(assembler.pendingCount, 1)
    XCTAssertEqual(assembler.expireStale(now: 129.999), 0)
    XCTAssertEqual(assembler.pendingCount, 1)
    XCTAssertEqual(assembler.expireStale(now: 130), 1)
    XCTAssertEqual(assembler.pendingCount, 0)
  }

  func testResetClearsPartialChunks() {
    var assembler = SyncEnvelopeChunkAssembler()
    XCTAssertNil(assembler.add(chunkId: "e", index: 0, total: 2, part: base64("1")))
    assembler.reset()
    XCTAssertNil(assembler.add(chunkId: "e", index: 1, total: 2, part: base64("2")))
  }
  // MARK: - Binary envelope container

  private func binaryFrame(header: [String: Any], body: Data) -> Data {
    let headerJSON = try! JSONSerialization.data(withJSONObject: header)
    var frame = Data("ADE1".utf8)
    var length = UInt32(headerJSON.count).bigEndian
    withUnsafeBytes(of: &length) { frame.append(contentsOf: $0) }
    frame.append(headerJSON)
    frame.append(body)
    return frame
  }

  func testDecodesBinaryContainerHeaderAndBody() {
    let frame = binaryFrame(header: ["version": 1, "type": "chat_event"], body: Data("raw-bytes".utf8))
    XCTAssertTrue(SyncBinaryFrame.isBinaryFrame(frame))
    let decoded = SyncBinaryFrame.decode(frame)
    XCTAssertEqual(decoded?.header["type"] as? String, "chat_event")
    XCTAssertEqual(decoded?.body, Data("raw-bytes".utf8))
  }

  func testTextDeliveredAsDataIsNotTreatedAsBinary() {
    // Transports do deliver text frames as data; only the magic marks a
    // binary envelope, so a JSON frame must stay on the text path.
    let json = Data("{\"version\":1,\"type\":\"chat_event\"}".utf8)
    XCTAssertFalse(SyncBinaryFrame.isBinaryFrame(json))
    XCTAssertNil(SyncBinaryFrame.decode(json))
  }

  func testRejectsTruncatedAndOversizedHeaderLengths() {
    let frame = binaryFrame(header: ["version": 1, "type": "chat_event"], body: Data("body".utf8))
    XCTAssertNil(SyncBinaryFrame.decode(frame.prefix(6)))

    var lying = frame
    var huge = UInt32(SyncBinaryFrame.maxHeaderBytes + 1).bigEndian
    withUnsafeBytes(of: &huge) { bytes in
      for (offset, byte) in bytes.enumerated() { lying[lying.startIndex + 4 + offset] = byte }
    }
    XCTAssertNil(SyncBinaryFrame.decode(lying))
  }

  func testDecodesFromASlicedDataBuffer() {
    // URLSession hands back Data slices with a non-zero startIndex; absolute
    // indexing into one is how a container decoder silently reads garbage.
    let frame = binaryFrame(header: ["version": 1, "type": "chat_event"], body: Data("sliced".utf8))
    let padded = Data([0xEE, 0xEE]) + frame
    let slice = padded.dropFirst(2)
    XCTAssertTrue(SyncBinaryFrame.isBinaryFrame(slice))
    XCTAssertEqual(SyncBinaryFrame.decode(slice)?.body, Data("sliced".utf8))
  }

  func testBinaryChunkPartsReassembleIntoData() {
    var assembler = SyncEnvelopeChunkAssembler()
    XCTAssertNil(assembler.addBinary(chunkId: "bin", index: 0, total: 2, part: Data([0x01, 0x02])))
    XCTAssertEqual(
      assembler.addBinary(chunkId: "bin", index: 1, total: 2, part: Data([0x03])),
      Data([0x01, 0x02, 0x03])
    )
  }
}
