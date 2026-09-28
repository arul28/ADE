import ADEMediaCore
import CoreGraphics
import CoreText
import CoreVideo
import Foundation

/// Draws a plan's overlays onto a rendered output frame.
///
/// The shapes are the shared spec both engines draw (S is the output's shorter
/// side, in pixels):
///
/// - Ring: stroke only, accent colour, `ringLineWidth × S` wide; radius and
///   alpha from `DemoOverlayGeometry.ring`.
/// - Pointer: `DEMO_POINTER_POLYGON` × `pointerHeight × S`, tip on the point,
///   white fill, `#111111` stroke 0.06 pointer units wide, round joins.
/// - Caption: semibold system text, `captionFontSize × S`, white, at most two
///   lines of 80% of the output width (the second ends in an ellipsis when the
///   text does not fit), line height 1.25 em. Box padding 0.5 em by 0.9 em,
///   `rgba(17,17,17,0.78)`, corner radius 0.4 em, a 0.2 em accent bar down its
///   left edge. Centred, its bottom `captionMargin × S` above the frame's.
///   Fades over 0.15 s at each end.
/// - Badge: bold system text, `badgeFontSize × S`, white, one line of height
///   1.25 em, padding 0.25 em by 0.5 em, `rgba(17,17,17,0.72)`, radius 0.35 em,
///   inset 0.8 × its font size from the top and right edges.
///
/// Drawn in that order after the picture: rings, pointer, badge, caption.
///
/// The drawing goes straight into the output pixel buffer with CoreGraphics
/// after the picture is rendered, so only the pixels an overlay covers are
/// touched. Captions and badges are laid out once and kept as images.
final class OverlayDrawer {
    private let plan: DemoPlan
    private let width: Int
    private let height: Int
    private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
    private let accent: CGColor
    private let rings: [DemoRing]
    private let cursor: DemoCursorTrack
    private var captionImages: [Int: TextImage] = [:]
    private var badgeImages: [Int: TextImage] = [:]

    private struct TextImage {
        var image: CGImage
        var width: Double
        var height: Double
    }

    init(plan: DemoPlan, width: Int, height: Int) {
        self.plan = plan
        self.width = width
        self.height = height
        let rgb = DemoOverlayGeometry.parseHexColor(plan.style.accent) ?? (0.49, 0.36, 1.0)
        accent = CGColor(srgbRed: rgb.red, green: rgb.green, blue: rgb.blue, alpha: 1)
        rings = plan.rings.filter { $0.t.isFinite && $0.x.isFinite && $0.y.isFinite }
        cursor = DemoCursorTrack(keys: plan.cursor)
    }

    /// Everything that is on screen at output time `time`, or nil when nothing
    /// is, so the caller can skip locking the frame at all.
    struct Visible {
        var rings: [DemoOverlayGeometry.RingState]
        var pointer: (x: Double, y: Double)?
        var caption: (index: Int, alpha: Double)?
        var badge: Int?
    }

    func visible(at time: Double, layout: DemoFrameLayout) -> Visible? {
        let ringStates = rings.compactMap { DemoOverlayGeometry.ring($0, at: time, style: plan.style, layout: layout) }
        let pointer = cursor.position(at: time).map { layout.outputPoint(x: $0.x, y: $0.y) }
        // When spans overlap, the one that started last is on top: it is the newer message.
        var caption: (Int, Double)?
        for (index, span) in plan.captions.enumerated() where span.isActive(at: time) && !span.text.isEmpty {
            if caption == nil || span.start >= plan.captions[caption!.0].start {
                caption = (index, DemoOverlayGeometry.captionAlpha(span, at: time))
            }
        }
        var badge: Int?
        for (index, span) in plan.badges.enumerated() where span.isActive(at: time) && !span.text.isEmpty {
            if badge == nil || span.start >= plan.badges[badge!].start { badge = index }
        }
        if ringStates.isEmpty, pointer == nil, caption == nil, badge == nil { return nil }
        return Visible(rings: ringStates, pointer: pointer, caption: caption, badge: badge)
    }

    /// Draws `visible` onto `buffer`, a BGRA frame of the output size.
    func draw(_ visible: Visible, into buffer: CVPixelBuffer, layout: DemoFrameLayout) throws {
        guard CVPixelBufferLockBaseAddress(buffer, []) == kCVReturnSuccess else {
            throw MediaError("Could not lock an output frame to draw its overlays.")
        }
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let context = CGContext(
            data: CVPixelBufferGetBaseAddress(buffer),
            width: CVPixelBufferGetWidth(buffer),
            height: CVPixelBufferGetHeight(buffer),
            bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        ) else {
            throw MediaError("Could not draw on an output frame.")
        }
        // CoreGraphics is y-up; every position here is computed y-down, so it
        // is flipped once per point with `flip` rather than with the CTM,
        // which would also turn the cached text images upside down.
        let side = layout.shortSide
        let frameHeight = Double(height)
        func flip(_ y: Double) -> Double { frameHeight - y }

        for ring in visible.rings where ring.radius > 0 && ring.lineWidth > 0 {
            context.setStrokeColor(accent.copy(alpha: ring.alpha) ?? accent)
            context.setLineWidth(ring.lineWidth)
            context.strokeEllipse(in: CGRect(
                x: ring.x - ring.radius,
                y: flip(ring.y) - ring.radius,
                width: ring.radius * 2,
                height: ring.radius * 2
            ))
        }

        if let tip = visible.pointer {
            let pointerHeight = plan.style.pointerHeight * side
            if pointerHeight > 0 {
                let points = DemoOverlayGeometry.pointer(tipX: tip.x, tipY: tip.y, height: pointerHeight)
                let path = CGMutablePath()
                path.addLines(between: points.map { CGPoint(x: $0.x, y: flip($0.y)) })
                path.closeSubpath()
                context.addPath(path)
                context.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
                context.setStrokeColor(CGColor(srgbRed: 17 / 255, green: 17 / 255, blue: 17 / 255, alpha: 1))
                context.setLineWidth(demoPointerStrokeUnits * pointerHeight)
                context.setLineJoin(.round)
                context.drawPath(using: .fillStroke)
            }
        }

        if let index = visible.badge, let badge = badgeImage(index, side: side) {
            let inset = 0.8 * plan.style.badgeFontSize * side
            let x = Double(width) - inset - badge.width
            context.draw(badge.image, in: CGRect(x: x, y: flip(inset + badge.height), width: badge.width, height: badge.height))
        }

        if let (index, alpha) = visible.caption, alpha > 0, let caption = captionImage(index, side: side) {
            let bottom = Double(height) - plan.style.captionMargin * side
            let x = (Double(width) - caption.width) / 2
            context.saveGState()
            context.setAlpha(alpha)
            context.draw(caption.image, in: CGRect(x: x, y: flip(bottom), width: caption.width, height: caption.height))
            context.restoreGState()
        }
    }

    // MARK: - Text boxes

    private func captionImage(_ index: Int, side: Double) -> TextImage? {
        if let cached = captionImages[index] { return cached }
        let fontSize = plan.style.captionFontSize * side
        guard fontSize > 0 else { return nil }
        let image = textBox(
            text: plan.captions[index].text,
            font: systemFont(size: fontSize, weight: 0.3),
            fontSize: fontSize,
            maxTextWidth: Double(width) * 0.8 - 1.8 * fontSize,
            maxLines: 2,
            padX: 0.9 * fontSize,
            padY: 0.5 * fontSize,
            radius: 0.4 * fontSize,
            fillAlpha: 0.78,
            accentBar: 0.2 * fontSize
        )
        captionImages[index] = image
        return image
    }

    private func badgeImage(_ index: Int, side: Double) -> TextImage? {
        if let cached = badgeImages[index] { return cached }
        let fontSize = plan.style.badgeFontSize * side
        guard fontSize > 0 else { return nil }
        let image = textBox(
            text: plan.badges[index].text,
            font: systemFont(size: fontSize, weight: 0.4),
            fontSize: fontSize,
            maxTextWidth: Double(width) * 0.5,
            maxLines: 1,
            padX: 0.5 * fontSize,
            padY: 0.25 * fontSize,
            radius: 0.35 * fontSize,
            fillAlpha: 0.72,
            accentBar: 0
        )
        badgeImages[index] = image
        return image
    }

    /// The system UI font at a CSS-style weight: 0.3 is semibold (600), 0.4 bold (700).
    private func systemFont(size: Double, weight: Double) -> CTFont {
        let base = CTFontCreateUIFontForLanguage(.system, size, nil) ?? CTFontCreateWithName("Helvetica" as CFString, size, nil)
        let traits = [kCTFontWeightTrait: weight] as CFDictionary
        let descriptor = CTFontDescriptorCreateCopyWithAttributes(
            CTFontCopyFontDescriptor(base),
            [kCTFontTraitsAttribute: traits] as CFDictionary
        )
        return CTFontCreateWithFontDescriptor(descriptor, size, nil)
    }

    /// Lays `text` out in wrapped lines and draws it in a rounded box.
    private func textBox(
        text: String,
        font: CTFont,
        fontSize: Double,
        maxTextWidth: Double,
        maxLines: Int,
        padX: Double,
        padY: Double,
        radius: Double,
        fillAlpha: Double,
        accentBar: Double
    ) -> TextImage? {
        let white = CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)
        let attributes: [CFString: Any] = [kCTFontAttributeName: font, kCTForegroundColorAttributeName: white]
        let singleLine = text.replacingOccurrences(of: "\n", with: " ")
        let attributed = CFAttributedStringCreate(nil, singleLine as CFString, attributes as CFDictionary)!
        let typesetter = CTTypesetterCreateWithAttributedString(attributed)
        let length = CFAttributedStringGetLength(attributed)
        let wrapWidth = max(maxTextWidth, fontSize)

        var lines: [CTLine] = []
        var start = 0
        while start < length, lines.count < maxLines {
            let isLast = lines.count == maxLines - 1
            let count = CTTypesetterSuggestLineBreak(typesetter, start, wrapWidth)
            if isLast, start + count < length {
                // The rest does not fit: one line, cut with an ellipsis.
                let rest = CTTypesetterCreateLine(typesetter, CFRange(location: start, length: length - start))
                let token = CTLineCreateWithAttributedString(
                    CFAttributedStringCreate(nil, "…" as CFString, attributes as CFDictionary)!
                )
                lines.append(CTLineCreateTruncatedLine(rest, wrapWidth, .end, token) ?? rest)
                break
            }
            lines.append(CTTypesetterCreateLine(typesetter, CFRange(location: start, length: max(count, 1))))
            start += max(count, 1)
        }
        guard !lines.isEmpty else { return nil }

        let lineHeight = 1.25 * fontSize
        let textWidth = lines.map { CTLineGetTypographicBounds($0, nil, nil, nil) - CTLineGetTrailingWhitespaceWidth($0) }.max() ?? 0
        let boxWidth = (textWidth + 2 * padX).rounded(.up)
        let boxHeight = (Double(lines.count) * lineHeight + 2 * padY).rounded(.up)
        guard boxWidth >= 1, boxHeight >= 1,
              let context = CGContext(
                  data: nil,
                  width: Int(boxWidth),
                  height: Int(boxHeight),
                  bitsPerComponent: 8,
                  bytesPerRow: 0,
                  space: colorSpace,
                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
              )
        else { return nil }

        let box = CGRect(x: 0, y: 0, width: boxWidth, height: boxHeight)
        let shape = CGPath(roundedRect: box, cornerWidth: min(radius, boxHeight / 2), cornerHeight: min(radius, boxHeight / 2), transform: nil)
        context.addPath(shape)
        context.setFillColor(CGColor(srgbRed: 17 / 255, green: 17 / 255, blue: 17 / 255, alpha: fillAlpha))
        context.fillPath()
        if accentBar > 0 {
            context.saveGState()
            context.addPath(shape)
            context.clip()
            context.setFillColor(accent)
            context.fill(CGRect(x: 0, y: 0, width: accentBar, height: boxHeight))
            context.restoreGState()
        }

        // Each line is centred vertically in its 1.25 em slot, top to bottom.
        for (row, line) in lines.enumerated() {
            var ascent: CGFloat = 0
            var descent: CGFloat = 0
            let lineWidth = CTLineGetTypographicBounds(line, &ascent, &descent, nil) - CTLineGetTrailingWhitespaceWidth(line)
            let slotTop = padY + Double(row) * lineHeight
            let baselineFromTop = slotTop + (lineHeight - (ascent + descent)) / 2 + ascent
            let x = lines.count == 1 ? padX : padX + (textWidth - lineWidth) / 2
            context.textPosition = CGPoint(x: x, y: boxHeight - baselineFromTop)
            CTLineDraw(line, context)
        }
        guard let image = context.makeImage() else { return nil }
        return TextImage(image: image, width: boxWidth, height: boxHeight)
    }
}
