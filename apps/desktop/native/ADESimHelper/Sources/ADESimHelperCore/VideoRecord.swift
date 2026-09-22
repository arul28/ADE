import Foundation

/// ADE's existing simulator-video wire format, reproduced byte-for-byte.
///
/// The authority is `src/shared/types/iosSimulator.ts`; this helper is now the
/// only writer, and the reader is
/// `src/renderer/components/chat/iosSimVideoRecords.ts`. Matching it exactly is
/// the whole point — the renderer's decoder must play this helper's stream with
/// no change at all, so the sim helper can replace `idb video-stream`
/// underneath a UI that never learns it happened.
///
/// Layout, big-endian, 12-byte header then payload:
///
///     0..3   magic  0xADE1F00D
///     4      type   1 = config, 2 = access unit
///     5      flags  bit 0 = keyframe
///     6..7   reserved, zero
///     8..11  payload length
public enum VideoRecord {
    public static let magic: UInt32 = 0xADE1_F00D
    public static let headerBytes = 12
    public static let typeConfig: UInt8 = 1
    public static let typeAccessUnit: UInt8 = 2
    public static let flagKeyframe: UInt8 = 1

    public static func encode(type: UInt8, payload: Data, keyframe: Bool = false) -> Data {
        var out = Data(capacity: headerBytes + payload.count)
        withUnsafeBytes(of: magic.bigEndian) { out.append(contentsOf: $0) }
        out.append(type)
        out.append(keyframe ? flagKeyframe : 0)
        out.append(0)
        out.append(0)
        withUnsafeBytes(of: UInt32(payload.count).bigEndian) { out.append(contentsOf: $0) }
        out.append(payload)
        return out
    }

    /// The `config` record's JSON body.
    ///
    /// `annexB: true` is not decoration: the renderer configures its
    /// `VideoDecoder` **without** a `description`, which only decodes Annex-B.
    /// Sending AVCC here — which is what the vendored encoder natively
    /// produces — yields a decoder that configures cleanly and then emits
    /// nothing. See `AnnexB.swift`.
    public static func config(codec: String, width: Int?, height: Int?) -> Data {
        var object: [String: Any] = ["codec": codec, "annexB": true]
        if let width { object["width"] = width }
        if let height { object["height"] = height }
        return (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
    }
}
