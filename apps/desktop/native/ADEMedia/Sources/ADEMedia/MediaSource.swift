import ADEMediaCore
import AVFoundation
import CoreVideo
import Foundation

/// A failure `ade-media` reports as its `error:` line.
struct MediaError: Error, CustomStringConvertible {
    var message: String
    init(_ message: String) { self.message = message }
    var description: String { message }

    /// An AVFoundation error, with the underlying reason when it has one: the
    /// top-level text alone is often just "The operation could not be completed".
    static func describing(_ error: Error?, context: String) -> MediaError {
        guard let error else { return MediaError(context) }
        let nsError = error as NSError
        var parts = [nsError.localizedDescription]
        if let reason = nsError.localizedFailureReason, !parts.contains(reason) { parts.append(reason) }
        if let underlying = nsError.userInfo[NSUnderlyingErrorKey] as? NSError {
            parts.append("\(underlying.domain) \(underlying.code)")
        }
        return MediaError("\(context): \(parts.joined(separator: " "))")
    }
}

/// One decoded frame: its time since the file's first frame, and the picture.
struct DecodedFrame {
    var time: Double
    var buffer: CVPixelBuffer
    /// Counts up from 0 in decode order, so "is this the same picture" is cheap.
    var index: Int
}

/// The video track of a movie file, decoded forward to BGRA.
///
/// Times are measured from the first decoded frame, the zero every demo track
/// and plan uses. Frames come out in presentation order; a frame whose time
/// does not move forward is dropped rather than handed on, so callers can rely
/// on strictly increasing times.
final class MediaSource {
    let url: URL
    /// The picture as stored, before `preferredTransform`.
    let naturalWidth: Int
    let naturalHeight: Int
    /// The track's orientation, rounded to quarter turns and mirrors.
    let orientation: (a: Int, b: Int, c: Int, d: Int)
    /// The picture as it is meant to be shown.
    let displayWidth: Int
    let displayHeight: Int
    /// The end of the file on the movie timeline.
    let endTime: CMTime

    private let asset: AVURLAsset
    private let track: AVAssetTrack
    private var reader: AVAssetReader?
    private var output: AVAssetReaderTrackOutput?
    private var origin: CMTime?
    private var lastTime: Double = -.infinity
    private var nextIndex = 0

    private init(url: URL, asset: AVURLAsset, track: AVAssetTrack, naturalSize: CGSize, transform: CGAffineTransform, endTime: CMTime) {
        self.url = url
        self.asset = asset
        self.track = track
        naturalWidth = Int(naturalSize.width.rounded())
        naturalHeight = Int(naturalSize.height.rounded())
        let rounded = (
            a: Int(transform.a.rounded()), b: Int(transform.b.rounded()),
            c: Int(transform.c.rounded()), d: Int(transform.d.rounded())
        )
        orientation = DemoOrientation.isAxisAligned(a: rounded.a, b: rounded.b, c: rounded.c, d: rounded.d)
            ? rounded
            : (1, 0, 0, 1)
        let quarterTurn = orientation.a == 0
        displayWidth = quarterTurn ? naturalHeight : naturalWidth
        displayHeight = quarterTurn ? naturalWidth : naturalHeight
        self.endTime = endTime
    }

    /// Opens `path` and checks it holds a video track this Mac can decode.
    static func open(path: String) async throws -> MediaSource {
        let url = URL(fileURLWithPath: path)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), !isDirectory.boolValue else {
            throw MediaError("The input file does not exist: \(path)")
        }
        let size = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? NSNumber)?.intValue ?? 0
        guard size > 0 else { throw MediaError("The input file is empty: \(path)") }

        let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        let tracks: [AVAssetTrack]
        do {
            tracks = try await asset.loadTracks(withMediaType: .video)
        } catch {
            throw MediaError.describing(error, context: "The input is not a readable movie (\(url.lastPathComponent))")
        }
        guard let track = tracks.first else {
            throw MediaError("The input has no video track: \(url.lastPathComponent)")
        }
        let (naturalSize, transform, timeRange) = try await track.load(.naturalSize, .preferredTransform, .timeRange)
        let duration = (try? await asset.load(.duration)) ?? .invalid
        guard naturalSize.width >= 1, naturalSize.height >= 1 else {
            throw MediaError("The input's video track has no picture size: \(url.lastPathComponent)")
        }
        var end = timeRange.end
        if duration.isNumeric, !end.isNumeric || duration > end { end = duration }
        return MediaSource(url: url, asset: asset, track: track, naturalSize: naturalSize, transform: transform, endTime: end)
    }

    /// Starts decoding from the beginning.
    ///
    /// `scaledTo` asks the decoder for a smaller picture (natural orientation),
    /// which the hardware scaler does far faster than any pass over full-size
    /// pixels. A decoder that ignores the request still works: every consumer
    /// reads the buffer's real size.
    func startReading(scaledTo size: (width: Int, height: Int)? = nil) throws {
        let reader: AVAssetReader
        do {
            reader = try AVAssetReader(asset: asset)
        } catch {
            throw MediaError.describing(error, context: "Could not open \(url.lastPathComponent) for reading")
        }
        var settings: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
            kCVPixelBufferMetalCompatibilityKey as String: true,
        ]
        if let size {
            settings[kCVPixelBufferWidthKey as String] = size.width
            settings[kCVPixelBufferHeightKey as String] = size.height
        }
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else {
            throw MediaError("This Mac cannot decode the video in \(url.lastPathComponent).")
        }
        reader.add(output)
        guard reader.startReading() else {
            throw MediaError.describing(reader.error, context: "Could not decode \(url.lastPathComponent)")
        }
        self.reader = reader
        self.output = output
    }

    /// The next frame, or nil at the end of the file.
    func nextFrame() throws -> DecodedFrame? {
        guard let reader, let output else { return nil }
        while true {
            guard let sample = output.copyNextSampleBuffer() else {
                if reader.status == .failed {
                    throw MediaError.describing(reader.error, context: "Decoding \(url.lastPathComponent) failed")
                }
                return nil
            }
            guard let buffer = CMSampleBufferGetImageBuffer(sample) else { continue }
            let pts = CMSampleBufferGetPresentationTimeStamp(sample)
            guard pts.isNumeric else { continue }
            if origin == nil { origin = pts }
            let time = CMTimeGetSeconds(CMTimeSubtract(pts, origin!))
            guard time > lastTime else { continue }
            lastTime = time
            defer { nextIndex += 1 }
            return DecodedFrame(time: time, buffer: buffer, index: nextIndex)
        }
    }

    /// Seconds from the first frame to the end of the file.
    var durationSeconds: Double {
        guard endTime.isNumeric else { return max(lastTime, 0) }
        let start = origin.map { CMTimeGetSeconds($0) } ?? 0
        return max(CMTimeGetSeconds(endTime) - start, lastTime, 0)
    }

    func cancel() {
        reader?.cancelReading()
    }
}
