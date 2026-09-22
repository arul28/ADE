import Foundation

/// Converts what the vendored encoder produces into what ADE's renderer reads.
///
/// The vendored `H264Encoder` emits **AVCC**: each NAL prefixed with a 4-byte
/// big-endian length, with SPS/PPS carried out-of-band in an `avcC` blob.
/// ADE's renderer (`IosSimH264Video.tsx`) configures its `VideoDecoder` with a
/// codec string and no `description`, which means it decodes **Annex-B** only.
///
/// This is the one real format delta between serve-sim and ADE, and it is
/// resolved here rather than by changing either side: upstream keeps its AVCC
/// wire (its own client uses WebCodecs *with* a description), and ADE keeps a
/// decoder that already ships.
public enum AnnexB {
    /// The 4-byte Annex-B start code. The 3-byte form is legal too; the 4-byte
    /// one is what VideoToolbox's own Annex-B writers emit and what ADE's
    /// server-side parser was written against.
    public static let startCode = Data([0x00, 0x00, 0x00, 0x01])

    /// SPS and PPS lifted out of an `avcC` parameter-set blob.
    public struct ParameterSets: Equatable {
        public let sps: Data
        public let pps: Data
        /// AVC profile/compat/level, i.e. the `avc1.PPCCLL` suffix.
        public let profile: UInt8
        public let compatibility: UInt8
        public let level: UInt8

        /// The codec string the renderer hands to `VideoDecoder.configure`.
        public var codec: String {
            String(format: "avc1.%02X%02X%02X", profile, compatibility, level)
        }

        /// SPS and PPS as Annex-B NALs, ready to prefix a keyframe.
        public var annexB: Data {
            var out = Data()
            out.append(AnnexB.startCode)
            out.append(sps)
            out.append(AnnexB.startCode)
            out.append(pps)
            return out
        }
    }

    /// Parse the `avcC` blob the vendored encoder emits once per session.
    ///
    /// Layout (ISO/IEC 14496-15 §5.2.4.1), only the single-SPS/single-PPS shape
    /// VideoToolbox produces is accepted — anything else is a blob this helper
    /// did not write and must not guess at.
    public static func parseAVCC(_ blob: Data) -> ParameterSets? {
        let bytes = [UInt8](blob)
        // configurationVersion, profile, compat, level, lengthSizeMinusOne,
        // numOfSPS, spsLength(2) = 8 bytes before the first SPS.
        guard bytes.count >= 8, bytes[0] == 0x01 else { return nil }
        let spsLength = Int(bytes[6]) << 8 | Int(bytes[7])
        guard spsLength > 0, bytes.count >= 8 + spsLength + 3 else { return nil }
        let sps = Data(bytes[8..<(8 + spsLength)])

        // numOfPPS then ppsLength(2).
        let ppsCountIndex = 8 + spsLength
        let ppsLengthIndex = ppsCountIndex + 1
        guard bytes.count >= ppsLengthIndex + 2 else { return nil }
        let ppsLength = Int(bytes[ppsLengthIndex]) << 8 | Int(bytes[ppsLengthIndex + 1])
        let ppsStart = ppsLengthIndex + 2
        guard ppsLength > 0, bytes.count >= ppsStart + ppsLength else { return nil }
        let pps = Data(bytes[ppsStart..<(ppsStart + ppsLength)])

        return ParameterSets(
            sps: sps,
            pps: pps,
            profile: bytes[1],
            compatibility: bytes[2],
            level: bytes[3]
        )
    }

    /// Rewrite length-prefixed AVCC NALs as Annex-B start-code NALs.
    ///
    /// Returns nil when the lengths do not tile the buffer exactly: a partial
    /// tail means the bytes are not what this function was told they are, and
    /// emitting a truncated access unit would corrupt every later frame that
    /// references it.
    public static func fromAVCC(_ avcc: Data, nalLengthSize: Int = 4) -> Data? {
        guard (1...4).contains(nalLengthSize) else { return nil }
        let bytes = [UInt8](avcc)
        var out = Data(capacity: bytes.count + 16)
        var offset = 0
        while offset < bytes.count {
            guard offset + nalLengthSize <= bytes.count else { return nil }
            var length = 0
            for index in 0..<nalLengthSize {
                length = (length << 8) | Int(bytes[offset + index])
            }
            offset += nalLengthSize
            guard length > 0, offset + length <= bytes.count else { return nil }
            out.append(startCode)
            out.append(contentsOf: bytes[offset..<(offset + length)])
            offset += length
        }
        return out.isEmpty ? nil : out
    }

    /// Strip the 5-byte `AVCCEnvelope` header the vendored `CaptureEngine`
    /// wraps every chunk in (4-byte big-endian length, then a 1-byte tag).
    ///
    /// ADE subscribes through `addAVCCConsumer` because `CaptureEngine`'s
    /// generic `addConsumer` is private, so the envelope arrives whether ADE
    /// wants it or not — see `Vendor/serve-sim/VENDORED.md`.
    public static func unwrapEnvelope(_ data: Data) -> Data? {
        let bytes = [UInt8](data)
        guard bytes.count > 5 else { return nil }
        let declared = Int(bytes[0]) << 24 | Int(bytes[1]) << 16 | Int(bytes[2]) << 8 | Int(bytes[3])
        // `declared` covers the tag byte plus the payload.
        guard declared == bytes.count - 4 else { return nil }
        return Data(bytes[5...])
    }
}
