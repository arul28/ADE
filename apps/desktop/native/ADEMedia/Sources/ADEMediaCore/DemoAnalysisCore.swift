import Foundation

/// A small greyscale picture, row-major, one byte per pixel.
public struct DemoThumbnail: Equatable, Sendable {
    public var width: Int
    public var height: Int
    public var luma: [UInt8]

    public init(width: Int, height: Int, luma: [UInt8]) {
        self.width = width
        self.height = height
        self.luma = luma
    }

    /// The thumbnail size for a source frame: longest side
    /// `DemoAnalysisRules.thumbnailLongSide`, aspect kept. A source already
    /// smaller than that keeps its own size; it is never scaled up.
    public static func size(forSourceWidth width: Int, height: Int) -> (width: Int, height: Int) {
        let longest = max(width, height)
        let side = DemoAnalysisRules.thumbnailLongSide
        guard longest > side else { return (max(width, 1), max(height, 1)) }
        let scale = Double(side) / Double(longest)
        return (
            max(1, Int((Double(width) * scale).rounded())),
            max(1, Int((Double(height) * scale).rounded()))
        )
    }

    /// A box-averaged greyscale copy of a 32-bit BGRA frame.
    ///
    /// Source pixel `x` falls in thumbnail column `x * width / sourceWidth`
    /// (integer division), and likewise for rows, so every source pixel counts
    /// exactly once and every cell is the plain mean of the pixels it covers.
    /// Luma is BT.709 in 8-bit fixed point, the weights the Mac Desktop
    /// driver's `ScreenChange` uses. A target larger than the frame shrinks to
    /// the frame. Nil for a buffer too short to hold the frame it claims.
    public static func boxAverage(
        bgra bytes: UnsafeRawBufferPointer,
        sourceWidth: Int,
        sourceHeight: Int,
        bytesPerRow: Int,
        width targetWidth: Int,
        height targetHeight: Int
    ) -> DemoThumbnail? {
        guard
            sourceWidth > 0,
            sourceHeight > 0,
            bytesPerRow >= sourceWidth * 4,
            bytes.count >= bytesPerRow * (sourceHeight - 1) + sourceWidth * 4,
            let base = bytes.baseAddress?.assumingMemoryBound(to: UInt8.self)
        else { return nil }
        let width = min(max(targetWidth, 1), sourceWidth)
        let height = min(max(targetHeight, 1), sourceHeight)

        var columnCell = [Int](repeating: 0, count: sourceWidth)
        for x in 0..<sourceWidth { columnCell[x] = x * width / sourceWidth }
        var sums = [UInt64](repeating: 0, count: width * height)
        var counts = [UInt32](repeating: 0, count: width * height)
        var rowSums = [UInt32](repeating: 0, count: width)
        var rowCounts = [UInt32](repeating: 0, count: width)

        columnCell.withUnsafeBufferPointer { cells in
            rowSums.withUnsafeMutableBufferPointer { rowSum in
                rowCounts.withUnsafeMutableBufferPointer { rowCount in
                    for y in 0..<sourceHeight {
                        let row = base + y * bytesPerRow
                        for index in 0..<width {
                            rowSum[index] = 0
                            rowCount[index] = 0
                        }
                        var offset = 0
                        for x in 0..<sourceWidth {
                            // Bytes are B, G, R, A.
                            let value = 19 * UInt32(row[offset]) + 183 * UInt32(row[offset + 1]) + 54 * UInt32(row[offset + 2])
                            let cell = cells[x]
                            rowSum[cell] &+= value
                            rowCount[cell] &+= 1
                            offset += 4
                        }
                        let target = (y * height / sourceHeight) * width
                        for index in 0..<width {
                            sums[target + index] += UInt64(rowSum[index])
                            counts[target + index] += rowCount[index]
                        }
                    }
                }
            }
        }

        var luma = [UInt8](repeating: 0, count: width * height)
        for index in luma.indices {
            let count = UInt64(max(counts[index], 1)) * 256
            luma[index] = UInt8(min(255, (sums[index] + count / 2) / count))
        }
        return DemoThumbnail(width: width, height: height, luma: luma)
    }

    /// This thumbnail as the video is meant to be shown.
    ///
    /// `a`, `b`, `c`, `d` are the track's `preferredTransform`, each rounded to
    /// -1, 0 or 1: quarter turns and mirrors. Any other transform is treated as
    /// none, since a video at an arbitrary angle is not something a recorder
    /// writes.
    public func oriented(a: Int, b: Int, c: Int, d: Int) -> DemoThumbnail {
        guard DemoOrientation.isAxisAligned(a: a, b: b, c: c, d: d), !(a == 1 && b == 0 && c == 0 && d == 1) else {
            return self
        }
        let outWidth = abs(a) * width + abs(c) * height
        let outHeight = abs(b) * width + abs(d) * height
        let offsetX = (a < 0 ? width - 1 : 0) + (c < 0 ? height - 1 : 0)
        let offsetY = (b < 0 ? width - 1 : 0) + (d < 0 ? height - 1 : 0)
        var out = [UInt8](repeating: 0, count: outWidth * outHeight)
        for y in 0..<height {
            for x in 0..<width {
                let outX = a * x + c * y + offsetX
                let outY = b * x + d * y + offsetY
                out[outY * outWidth + outX] = luma[y * width + x]
            }
        }
        return DemoThumbnail(width: outWidth, height: outHeight, luma: out)
    }
}

public enum DemoOrientation {
    /// True for the eight quarter-turn and mirror transforms.
    public static func isAxisAligned(a: Int, b: Int, c: Int, d: Int) -> Bool {
        let values = [a, b, c, d]
        guard values.allSatisfy({ abs($0) <= 1 }) else { return false }
        return (a != 0 && d != 0 && b == 0 && c == 0) || (a == 0 && d == 0 && b != 0 && c != 0)
    }
}

/// How much one thumbnail differs from the one before it.
public enum DemoChange {
    /// The changed fraction and the changed pixels' normalized bounding box
    /// (nil when nothing changed). Thumbnails of different sizes — a display
    /// resized mid-recording — changed completely.
    public static func compare(previous: DemoThumbnail, current: DemoThumbnail) -> (changed: Double, box: DemoRect?) {
        guard
            previous.width == current.width,
            previous.height == current.height,
            previous.luma.count == current.luma.count,
            !current.luma.isEmpty
        else { return (1, [0, 0, 1, 1]) }

        let delta = DemoAnalysisRules.pixelDelta
        var changed = 0
        var minX = Int.max, minY = Int.max, maxX = -1, maxY = -1
        let width = current.width
        previous.luma.withUnsafeBufferPointer { before in
            current.luma.withUnsafeBufferPointer { after in
                for index in 0..<after.count {
                    let difference = Int(after[index]) - Int(before[index])
                    guard difference > delta || difference < -delta else { continue }
                    changed += 1
                    let x = index % width
                    let y = index / width
                    if x < minX { minX = x }
                    if x > maxX { maxX = x }
                    if y < minY { minY = y }
                    if y > maxY { maxY = y }
                }
            }
        }
        guard changed > 0 else { return (0, nil) }
        let w = Double(current.width)
        let h = Double(current.height)
        return (
            Double(changed) / Double(current.luma.count),
            [Double(minX) / w, Double(minY) / h, Double(maxX - minX + 1) / w, Double(maxY - minY + 1) / h]
        )
    }
}

/// Builds a `DemoAnalysis`'s frame list, one decoded frame at a time.
///
/// Every analysed frame is compared with the previous analysed one, so a frame
/// that is skipped (closer than `DemoAnalysisRules.minIntervalSeconds` to the
/// last analysed frame) folds its change into the next. The caller asks
/// `shouldAnalyse` before it pays for a thumbnail, and keeps the newest
/// skipped frame so the file's last picture can still be analysed at the end.
public struct DemoAnalysisAccumulator: Sendable {
    public private(set) var frames: [DemoAnalysisFrame] = []
    private var previous: DemoThumbnail?
    private var lastTime: Double?

    public init() {}

    /// False for a frame too close to the last analysed one, or not after it.
    public func shouldAnalyse(at time: Double) -> Bool {
        guard let lastTime else { return true }
        return time - lastTime >= DemoAnalysisRules.minIntervalSeconds - 1e-9
    }

    /// Adds a frame. A frame at or before the last one is ignored.
    public mutating func add(at time: Double, thumbnail: DemoThumbnail) {
        if let lastTime, time <= lastTime { return }
        let frame: DemoAnalysisFrame
        if let previous {
            let change = DemoChange.compare(previous: previous, current: thumbnail)
            frame = DemoAnalysisFrame(t: Self.rounded(time), changed: Self.rounded(change.changed), box: change.box.map { $0.map(Self.rounded) })
        } else {
            frame = DemoAnalysisFrame(t: Self.rounded(time), changed: 1)
        }
        frames.append(frame)
        previous = thumbnail
        lastTime = time
    }

    /// Five decimals: a tenth of a millisecond, and far finer than a thumbnail pixel.
    static func rounded(_ value: Double) -> Double {
        (value * 100_000).rounded() / 100_000
    }
}
