import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

/// VideoToolbox H.264, emitting Annex-B access units.
///
/// SPS/PPS are re-emitted in front of every keyframe rather than only once. A
/// viewer can attach at any moment, and a decoder that joined after the single
/// copy of the parameter sets went past would sit on a black frame forever.
final class H264Encoder {
    private var session: VTCompressionSession?
    private let width: Int
    private let height: Int
    private var codecString: String?
    private let onAccessUnit: (Data, Bool, String?) -> Void

    init(width: Int, height: Int, fps: Int, onAccessUnit: @escaping (Data, Bool, String?) -> Void) throws {
        self.width = width
        self.height = height
        self.onAccessUnit = onAccessUnit

        var session: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(width),
            height: Int32(height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: nil,
            refcon: nil,
            compressionSessionOut: &session
        )
        guard status == noErr, let session else {
            throw CaptureError.failed("VideoToolbox refused an H.264 session (status \(status)).")
        }
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        // Main, not High: the browser's WebCodecs decoder holds up to four
        // frames before it outputs the first one on a High-profile stream
        // (w3c/webcodecs#732), which is over a hundred milliseconds of built-in
        // lag at thirty frames a second. Main decodes one-in, one-out.
        VTSessionSetProperty(
            session,
            key: kVTCompressionPropertyKey_ProfileLevel,
            value: kVTProfileLevel_H264_Main_AutoLevel
        )
        // The setting every low-latency screen streamer names: without it
        // VideoToolbox is free to hold frames for rate control.
        VTSessionSetProperty(
            session,
            key: kVTVideoEncoderSpecification_EnableLowLatencyRateControl,
            value: kCFBooleanTrue
        )
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxFrameDelayCount, value: NSNumber(value: 0))
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        // A keyframe every two seconds: the cost of a viewer's cold start.
        VTSessionSetProperty(
            session,
            key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration,
            value: NSNumber(value: 2.0)
        )
        VTSessionSetProperty(
            session,
            key: kVTCompressionPropertyKey_ExpectedFrameRate,
            value: NSNumber(value: max(1, fps))
        )
        VTCompressionSessionPrepareToEncodeFrames(session)
        self.session = session
    }

    func setRate(fps: Int) {
        guard let session else { return }
        VTSessionSetProperty(
            session,
            key: kVTCompressionPropertyKey_ExpectedFrameRate,
            value: NSNumber(value: max(1, fps))
        )
    }

    /// Encodes one frame.
    ///
    /// `forceKeyframe` exists for the viewer that attaches to a still screen.
    /// A lane's desktop with nothing happening on it produces no new capture
    /// frames at all, so "the next keyframe is at most two seconds away" is
    /// only true while something is moving; a reader that arrives during the
    /// quiet would otherwise wait for the next thing to happen before it had a
    /// picture. The caller re-submits the last captured buffer with this set.
    func encode(pixelBuffer: CVPixelBuffer, presentationTime: CMTime, forceKeyframe: Bool = false) {
        guard let session else { return }
        let frameProperties: CFDictionary? = forceKeyframe
            ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary
            : nil
        VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: pixelBuffer,
            presentationTimeStamp: presentationTime,
            duration: .invalid,
            frameProperties: frameProperties,
            infoFlagsOut: nil
        ) { [weak self] status, _, sampleBuffer in
            guard status == noErr, let sampleBuffer, let self else { return }
            self.handle(sampleBuffer)
        }
    }

    private func handle(_ sampleBuffer: CMSampleBuffer) {
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }
        let isKeyframe = Self.isKeyframe(sampleBuffer)
        var payload = Data()

        if isKeyframe, let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer) {
            for index in 0..<2 {
                var parameterSet: UnsafePointer<UInt8>?
                var parameterSetSize = 0
                var parameterSetCount = 0
                var nalUnitHeaderLength: Int32 = 0
                let status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                    formatDescription,
                    parameterSetIndex: index,
                    parameterSetPointerOut: &parameterSet,
                    parameterSetSizeOut: &parameterSetSize,
                    parameterSetCountOut: &parameterSetCount,
                    nalUnitHeaderLengthOut: &nalUnitHeaderLength
                )
                guard status == noErr, let parameterSet else { continue }
                payload.append(contentsOf: [0x00, 0x00, 0x00, 0x01])
                payload.append(parameterSet, count: parameterSetSize)
                if index == 0, codecString == nil, parameterSetSize >= 4 {
                    codecString = String(
                        format: "avc1.%02X%02X%02X",
                        parameterSet[1],
                        parameterSet[2],
                        parameterSet[3]
                    ).lowercased()
                }
            }
        }

        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        var totalLength = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(
            blockBuffer,
            atOffset: 0,
            lengthAtOffsetOut: nil,
            totalLengthOut: &totalLength,
            dataPointerOut: &dataPointer
        ) == noErr, let dataPointer else { return }

        // AVCC (4-byte big-endian length prefixes) to Annex-B start codes.
        var offset = 0
        while offset + 4 <= totalLength {
            var nalLength: UInt32 = 0
            memcpy(&nalLength, dataPointer + offset, 4)
            nalLength = CFSwapInt32BigToHost(nalLength)
            guard nalLength > 0, offset + 4 + Int(nalLength) <= totalLength else { break }
            payload.append(contentsOf: [0x00, 0x00, 0x00, 0x01])
            payload.append(
                UnsafeBufferPointer(
                    start: UnsafeRawPointer(dataPointer + offset + 4).assumingMemoryBound(to: UInt8.self),
                    count: Int(nalLength)
                )
            )
            offset += 4 + Int(nalLength)
        }
        guard !payload.isEmpty else { return }
        onAccessUnit(payload, isKeyframe, codecString)
    }

    private static func isKeyframe(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false),
              CFArrayGetCount(attachments) > 0
        else { return true }
        let first = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFDictionary.self)
        guard let dictionary = first as? [CFString: Any] else { return true }
        // "not a sync sample" absent, or false, means this *is* a keyframe.
        return !((dictionary[kCMSampleAttachmentKey_NotSync] as? Bool) ?? false)
    }

    func stop() {
        guard let session else { return }
        VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
        VTCompressionSessionInvalidate(session)
        self.session = nil
    }
}
