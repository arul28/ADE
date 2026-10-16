import XCTest
@testable import ADEMediaCore

/// The analysis rules the planner's thresholds depend on: box averaging, the
/// changed fraction and its box, orientation, and frame skipping.
final class DemoAnalysisCoreTests: XCTestCase {
    /// A BGRA frame filled with one grey, with `patch` painted another grey.
    private func frame(width: Int, height: Int, grey: UInt8, patch: (x: Range<Int>, y: Range<Int>, grey: UInt8)? = nil) -> [UInt8] {
        var bytes = [UInt8](repeating: 255, count: width * height * 4)
        for y in 0..<height {
            for x in 0..<width {
                var value = grey
                if let patch, patch.x.contains(x), patch.y.contains(y) { value = patch.grey }
                let offset = (y * width + x) * 4
                bytes[offset] = value
                bytes[offset + 1] = value
                bytes[offset + 2] = value
            }
        }
        return bytes
    }

    private func thumbnail(_ bytes: [UInt8], width: Int, height: Int, to size: (Int, Int)) -> DemoThumbnail {
        bytes.withUnsafeBytes {
            DemoThumbnail.boxAverage(bgra: $0, sourceWidth: width, sourceHeight: height, bytesPerRow: width * 4, width: size.0, height: size.1)!
        }
    }

    func testThumbnailSizeKeepsAspectAndNeverScalesUp() {
        let cases: [(source: (Int, Int), thumbnail: (Int, Int))] = [
            ((2560, 1440), (256, 144)),
            ((1206, 2622), (118, 256)),
            ((200, 100), (200, 100)),
        ]
        for (source, expected) in cases {
            let size = DemoThumbnail.size(forSourceWidth: source.0, height: source.1)
            XCTAssertEqual(size.width, expected.0, "\(source)")
            XCTAssertEqual(size.height, expected.1, "\(source)")
        }
    }

    func testBoxAverageIsTheMeanOfEachCell() {
        // 4×2 source into 2×1: left cell is two 0s and two 200s, right is all 100.
        let bytes = frame(width: 4, height: 2, grey: 100, patch: (0..<2, 0..<1, 0))
        var mixed = bytes
        for x in 0..<2 { for channel in 0..<3 { mixed[(1 * 4 + x) * 4 + channel] = 200 } }
        let thumb = thumbnail(mixed, width: 4, height: 2, to: (2, 1))
        XCTAssertEqual(thumb.luma, [100, 100])
        // A buffer too short for its claimed size is refused, not read past.
        let short = [UInt8](repeating: 0, count: 10)
        XCTAssertNil(short.withUnsafeBytes {
            DemoThumbnail.boxAverage(bgra: $0, sourceWidth: 4, sourceHeight: 2, bytesPerRow: 16, width: 2, height: 1)
        })
    }

    func testChangeFractionAndBox() {
        let before = thumbnail(frame(width: 40, height: 20, grey: 50), width: 40, height: 20, to: (40, 20))
        let small = thumbnail(frame(width: 40, height: 20, grey: 50, patch: (10..<20, 5..<10, 60)), width: 40, height: 20, to: (40, 20))
        let large = thumbnail(frame(width: 40, height: 20, grey: 50, patch: (10..<20, 5..<10, 200)), width: 40, height: 20, to: (40, 20))

        let noise = DemoChange.compare(previous: before, current: small)
        XCTAssertEqual(noise.changed, 0, "a change of 10 grey levels is under the delta")
        XCTAssertNil(noise.box)

        let change = DemoChange.compare(previous: before, current: large)
        XCTAssertEqual(change.changed, 50.0 / 800, accuracy: 1e-12)
        XCTAssertEqual(change.box!, [0.25, 0.25, 0.25, 0.25])

        let resized = DemoChange.compare(previous: before, current: thumbnail(frame(width: 20, height: 20, grey: 50), width: 20, height: 20, to: (20, 20)))
        XCTAssertEqual(resized.changed, 1)
    }

    func testOrientationTurnsTheThumbnailUpright() {
        // 3×2, values 0...5 row-major.
        let thumb = DemoThumbnail(width: 3, height: 2, luma: [0, 1, 2, 3, 4, 5])
        // iPhone portrait: a quarter turn clockwise.
        let turned = thumb.oriented(a: 0, b: 1, c: -1, d: 0)
        XCTAssertEqual(turned.width, 2)
        XCTAssertEqual(turned.height, 3)
        XCTAssertEqual(turned.luma, [3, 0, 4, 1, 5, 2])
        let halfTurn = thumb.oriented(a: -1, b: 0, c: 0, d: -1)
        XCTAssertEqual(halfTurn.luma, [5, 4, 3, 2, 1, 0])
        XCTAssertEqual(thumb.oriented(a: 1, b: 0, c: 0, d: 1), thumb)
    }

    func testAccumulatorFoldsSkippedFramesIntoTheNext() {
        let grey = DemoThumbnail(width: 2, height: 1, luma: [0, 0])
        let changed = DemoThumbnail(width: 2, height: 1, luma: [200, 0])
        var accumulator = DemoAnalysisAccumulator()
        accumulator.add(at: 0, thumbnail: grey)
        XCTAssertFalse(accumulator.shouldAnalyse(at: 0.01), "closer than 1/30 s")
        XCTAssertTrue(accumulator.shouldAnalyse(at: 1.0 / 30))
        accumulator.add(at: 0.5, thumbnail: changed)
        accumulator.add(at: 0.4, thumbnail: grey) // not after the last: ignored
        XCTAssertEqual(accumulator.frames, [
            DemoAnalysisFrame(t: 0, changed: 1),
            DemoAnalysisFrame(t: 0.5, changed: 0.5, box: [0, 0, 0.5, 1]),
        ])
    }
}
