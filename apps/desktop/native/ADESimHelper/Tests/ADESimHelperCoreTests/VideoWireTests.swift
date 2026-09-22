import XCTest
@testable import ADESimHelperCore

/// These tests guard the seam that decides whether ADE's SHIPPING renderer can
/// play this helper's stream unchanged. The constants are duplicated here as
/// literals on purpose: asserting `VideoRecord.magic == VideoRecord.magic`
/// proves nothing, whereas the literals below are the ones written down in
/// `src/shared/types/iosSimulator.ts`.
final class VideoRecordTests: XCTestCase {
    func testHeaderMatchesTheTypeScriptContract() {
        XCTAssertEqual(VideoRecord.magic, 0xADE1_F00D)
        XCTAssertEqual(VideoRecord.headerBytes, 12)
        XCTAssertEqual(VideoRecord.typeConfig, 1)
        XCTAssertEqual(VideoRecord.typeAccessUnit, 2)
        XCTAssertEqual(VideoRecord.flagKeyframe, 1)
    }

    func testEncodesTheExactLayoutTheParserReads() {
        let payload = Data([0xAA, 0xBB, 0xCC])
        let record = VideoRecord.encode(type: VideoRecord.typeAccessUnit, payload: payload, keyframe: true)
        XCTAssertEqual(record.count, 12 + 3)
        XCTAssertEqual([UInt8](record.prefix(4)), [0xAD, 0xE1, 0xF0, 0x0D])
        XCTAssertEqual(record[4], 2)
        XCTAssertEqual(record[5], 1)
        // Bytes 6..7 are reserved and must be zero; a reader that starts using
        // them would misread anything else.
        XCTAssertEqual(record[6], 0)
        XCTAssertEqual(record[7], 0)
        XCTAssertEqual([UInt8](record[8..<12]), [0, 0, 0, 3])
        XCTAssertEqual(Data(record.suffix(3)), payload)
    }

    func testDeltaFramesCarryNoKeyframeFlag() {
        let record = VideoRecord.encode(type: VideoRecord.typeAccessUnit, payload: Data([1]), keyframe: false)
        XCTAssertEqual(record[5], 0)
    }

    /// The renderer configures its decoder with no `description`, which only
    /// decodes Annex-B. Saying `annexB: false` here would produce a decoder that
    /// configures cleanly and then renders nothing.
    func testConfigDeclaresAnnexB() throws {
        let data = VideoRecord.config(codec: "avc1.640028", width: 1206, height: 2622)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["codec"] as? String, "avc1.640028")
        XCTAssertEqual(object["width"] as? Int, 1206)
        XCTAssertEqual(object["height"] as? Int, 2622)
        XCTAssertEqual(object["annexB"] as? Bool, true)
    }

    func testConfigOmitsUnknownDimensions() throws {
        let data = VideoRecord.config(codec: "avc1.640028", width: nil, height: nil)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(object["width"])
        XCTAssertNil(object["height"])
    }
}

final class AnnexBTests: XCTestCase {
    /// An avcC blob shaped exactly the way the vendored `H264Encoder` builds it.
    private func avcCBlob(sps: [UInt8], pps: [UInt8]) -> Data {
        var blob = Data([0x01, sps[1], sps[2], sps[3], 0xFF, 0xE1])
        blob.append(UInt8((sps.count >> 8) & 0xFF))
        blob.append(UInt8(sps.count & 0xFF))
        blob.append(contentsOf: sps)
        blob.append(0x01)
        blob.append(UInt8((pps.count >> 8) & 0xFF))
        blob.append(UInt8(pps.count & 0xFF))
        blob.append(contentsOf: pps)
        return blob
    }

    func testParsesParameterSetsAndCodecString() throws {
        // 0x64 High, 0x00 no constraints, 0x28 level 4.0 — a real iPhone stream.
        let sps: [UInt8] = [0x67, 0x64, 0x00, 0x28, 0xAC, 0xD9]
        let pps: [UInt8] = [0x68, 0xEB, 0xE3, 0xCB]
        let sets = try XCTUnwrap(AnnexB.parseAVCC(avcCBlob(sps: sps, pps: pps)))
        XCTAssertEqual([UInt8](sets.sps), sps)
        XCTAssertEqual([UInt8](sets.pps), pps)
        XCTAssertEqual(sets.codec, "avc1.640028")
    }

    func testParameterSetsRenderAsAnnexB() throws {
        let sps: [UInt8] = [0x67, 0x64, 0x00, 0x28]
        let pps: [UInt8] = [0x68, 0xEB]
        let sets = try XCTUnwrap(AnnexB.parseAVCC(avcCBlob(sps: sps, pps: pps)))
        XCTAssertEqual(
            [UInt8](sets.annexB),
            [0, 0, 0, 1] + sps + [0, 0, 0, 1] + pps
        )
    }

    func testRejectsBlobsItDidNotWrite() {
        XCTAssertNil(AnnexB.parseAVCC(Data()))
        XCTAssertNil(AnnexB.parseAVCC(Data([0x02, 0x64, 0x00, 0x28, 0xFF, 0xE1, 0x00, 0x01, 0x67])))
        // Declares a 512-byte SPS it does not contain.
        XCTAssertNil(AnnexB.parseAVCC(Data([0x01, 0x64, 0x00, 0x28, 0xFF, 0xE1, 0x02, 0x00, 0x67])))
    }

    func testConvertsLengthPrefixedNalsToStartCodes() throws {
        var avcc = Data([0, 0, 0, 2]); avcc.append(contentsOf: [0x65, 0x88])
        avcc.append(contentsOf: [0, 0, 0, 3]); avcc.append(contentsOf: [0x41, 0x9A, 0x02])
        let annexB = try XCTUnwrap(AnnexB.fromAVCC(avcc))
        XCTAssertEqual(
            [UInt8](annexB),
            [0, 0, 0, 1, 0x65, 0x88, 0, 0, 0, 1, 0x41, 0x9A, 0x02]
        )
    }

    /// A truncated access unit is undecodable AND corrupts every later frame
    /// that references it, so refusing is the only honest answer.
    func testRefusesLengthsThatDoNotTileTheBuffer() {
        XCTAssertNil(AnnexB.fromAVCC(Data([0, 0, 0, 9, 0x65, 0x88])))
        XCTAssertNil(AnnexB.fromAVCC(Data([0, 0, 0])))
        XCTAssertNil(AnnexB.fromAVCC(Data([0, 0, 0, 0])))
        XCTAssertNil(AnnexB.fromAVCC(Data()))
    }

    func testUnwrapsTheVendoredEnvelope() throws {
        // 4-byte big-endian length covering tag + payload, then the tag.
        let payload: [UInt8] = [0xDE, 0xAD, 0xBE, 0xEF]
        var wrapped = Data([0, 0, 0, UInt8(payload.count + 1), AVCCEnvelope.keyframeTag])
        wrapped.append(contentsOf: payload)
        XCTAssertEqual([UInt8](try XCTUnwrap(AnnexB.unwrapEnvelope(wrapped))), payload)
    }

    func testRejectsAnEnvelopeWhoseLengthDisagrees() {
        XCTAssertNil(AnnexB.unwrapEnvelope(Data([0, 0, 0, 99, 0x02, 0xAA])))
        XCTAssertNil(AnnexB.unwrapEnvelope(Data([0, 0, 0, 1])))
    }

    /// The end-to-end shape: what the vendored engine hands over becomes an
    /// access unit ADE's decoder can start on.
    func testEnvelopeToDecodableKeyframe() throws {
        let sps: [UInt8] = [0x67, 0x64, 0x00, 0x28]
        let pps: [UInt8] = [0x68, 0xEB]
        let sets = try XCTUnwrap(AnnexB.parseAVCC(avcCBlob(sps: sps, pps: pps)))

        var avcc = Data([0, 0, 0, 2]); avcc.append(contentsOf: [0x65, 0x88])
        let envelope = AVCCEnvelope.keyframe(avcc: avcc)
        let unwrapped = try XCTUnwrap(AnnexB.unwrapEnvelope(envelope))
        let unit = sets.annexB + (try XCTUnwrap(AnnexB.fromAVCC(unwrapped)))

        XCTAssertEqual(
            [UInt8](unit),
            [0, 0, 0, 1] + sps + [0, 0, 0, 1] + pps + [0, 0, 0, 1, 0x65, 0x88]
        )
    }
}

final class StreamFormatTests: XCTestCase {
    func testEnvelopeTagsAreTheValuesTheConsumerFlagsImply() {
        XCTAssertEqual(AVCCEnvelope.descriptionTag, 0x01)
        XCTAssertEqual(AVCCEnvelope.keyframeTag, 0x02)
        XCTAssertEqual(AVCCEnvelope.deltaTag, 0x03)
        XCTAssertEqual(AVCCEnvelope.seedTag, 0x04)
    }

    func testEnvelopeLengthCoversTagPlusPayload() {
        let wrapped = AVCCEnvelope.delta(avcc: Data([1, 2, 3, 4, 5]))
        XCTAssertEqual(wrapped.count, 4 + 1 + 5)
        XCTAssertEqual([UInt8](wrapped.prefix(4)), [0, 0, 0, 6])
        XCTAssertEqual(wrapped[4], AVCCEnvelope.deltaTag)
    }

    func testStreamFormatRawValues() {
        XCTAssertEqual(StreamFormat.mjpeg.rawValue, "mjpeg")
        XCTAssertEqual(StreamFormat.avcc.rawValue, "avcc")
        XCTAssertEqual(StreamFormat(rawValue: "avcc"), .avcc)
        XCTAssertNil(StreamFormat(rawValue: "webm"))
    }
}
