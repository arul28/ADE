import Foundation
import CoreGraphics

/// Where each window sits on the screen, for the accessibility reads.
///
/// An app in an iPadOS 26+ window (windowed mode, Stage Manager, Split View,
/// Slide Over) reports its elements' frames relative to ITS window, while a
/// hit-test takes screen points and SpringBoard's elements (status bar, window
/// controls, resize grabbers) come back in screen points. Measured on an iPad
/// Air 11-inch (M4), iOS 27.0: with the window at 415,0 a button drawn at
/// 431,154 read 16,154. No attribute names the window's position
/// (`AXPosition` is the same window-relative point, `AXWindow` is nil).
///
/// Each window is its own accessibility context (`_windowContextId`), so an
/// offset is found per context and kept per device:
///
/// 1. A remembered offset, or none at all (the window at the screen's
///    origin), is tried first and confirmed with a few hit-tests.
/// 2. Otherwise an element of the context is found at a screen point (the
///    point a hit-test asked about, or a coarse lattice over the screen), and
///    binary search finds where it stops answering on each side. The middle of
///    that span, minus the element's own middle, is the offset (an element
///    answers a little outside its frame: touch padding).
/// 3. A side the screen cuts off, or something drawn over it (the status bar
///    over a window's top), leaves two readings; the context's own small leaf
///    elements decide between them, since a 22-point field answers at its
///    centre and corners under the true offset only.
///
/// "Answers" means the hit is the element or one of its children: a
/// container answers with its children, so a hit counts when it is in the
/// same context and its frame lies inside the element's.
///
/// It runs only when the front app does not fill the display: an iPhone, an
/// iPad app in full screen and the iPhone Duo's turned inner panel never pay a
/// single extra hit.
final class WindowPlacement {
    struct Hit {
        let frame: CGRect
        let context: UInt32?
        /// SpringBoard's element: its frame is already on the screen, and its
        /// identifier, label and value are read (window chrome is found by them).
        var system: Bool = false
        var identifier: String? = nil
        var label: String? = nil
        var value: String? = nil
    }

    /// Never more than this many hit-tests for one read: a screen that keeps
    /// changing under the search must not stall the helper.
    static let maxHits = 500

    let enabled: Bool
    /// False for a point read (`ax-hit`, the focused element): it uses what is
    /// known and never searches, so a sweep of point reads stays fast.
    private let allowSearch: Bool
    private let appLabel: String?
    private let udid: String
    private let hitTest: (CGPoint) -> Hit?
    private let searchBounds: CGRect
    private let step: CGFloat
    private var offsets: [UInt32: CGPoint] = [:]
    private var failed: Set<UInt32> = []
    private var hits = 0

    private static let lock = NSLock()
    private static var known: [String: [UInt32: CGPoint]] = [:]

    /// False when the app fills the display, the picture is turned (the
    /// iPhone Duo's inner panel, whose probe space is not the frame space), or
    /// the display's size is unknown: a full-screen iPhone must never pay the
    /// search on a guess.
    static func needed(rootFrame: CGRect, screen: CGSize?, turned: Bool) -> Bool {
        if turned { return false }
        guard let display = screen, display.width > 1, display.height > 1 else { return false }
        func fills(_ width: CGFloat, _ height: CGFloat) -> Bool {
            abs(rootFrame.width - width) <= 1 && abs(rootFrame.height - height) <= 1
        }
        return !(fills(display.width, display.height) || fills(display.height, display.width))
    }

    /// `screen` is the screen as shown (landscape when held so), in points.
    init(
        udid: String,
        enabled: Bool,
        rootFrame: CGRect,
        screen: CGSize?,
        appLabel: String? = nil,
        allowSearch: Bool = true,
        hitTest: @escaping (CGPoint) -> Hit?
    ) {
        self.udid = udid
        self.enabled = enabled
        self.appLabel = appLabel
        self.allowSearch = allowSearch
        self.hitTest = hitTest
        if let display = screen, display.width > 1, display.height > 1 {
            searchBounds = CGRect(origin: .zero, size: display)
        } else {
            searchBounds = CGRect(x: 0, y: 0, width: 1400, height: 1400)
        }
        let shortest = min(rootFrame.width, rootFrame.height)
        step = min(120, max(40, shortest / 3))
    }

    /// The offset this read found for a context, if any.
    func knownOffset(context: UInt32) -> CGPoint? { offsets[context] }

    /// The contexts this read placed at `offset`.
    func contexts(withOffset offset: CGPoint) -> [UInt32] {
        offsets.filter { $0.value == offset }.map(\.key)
    }

    /// A better answer for a context than the hit-tests gave (its window's
    /// resize grabber, drawn in screen points).
    func correct(context: UInt32, to offset: CGPoint) {
        _ = remember(offset, context: context)
    }

    /// Places a context of the tree walk, whose small leaf elements (frames
    /// relative to the window) decide between ambiguous readings.
    func place(context: UInt32, leaves: [CGRect], any: CGRect, isWindow: Bool = false) -> CGPoint? {
        guard enabled else { return .zero }
        // iPadOS snaps a window flush to the screen's edges: a reading within
        // 3 points of one is that edge.
        let remember: (CGPoint, UInt32) -> CGPoint = { offset, context in
            guard isWindow else { return self.remember(offset, context: context) }
            let placed = any.offsetBy(dx: offset.x, dy: offset.y)
            var snapped = offset
            if abs(placed.minX - self.searchBounds.minX) <= 3 { snapped.x = self.searchBounds.minX - any.minX }
            else if abs(placed.maxX - self.searchBounds.maxX) <= 3 { snapped.x = self.searchBounds.maxX - any.maxX }
            if abs(placed.minY - self.searchBounds.minY) <= 3 { snapped.y = self.searchBounds.minY - any.minY }
            else if abs(placed.maxY - self.searchBounds.maxY) <= 3 { snapped.y = self.searchBounds.maxY - any.maxY }
            return self.remember(snapped, context: context)
        }
        if let measured = offsets[context] { return measured }
        if failed.contains(context) { return nil }
        let checks = Array(leaves.filter { $0.width >= 6 && $0.height >= 6 }
            .sorted { $0.width * $0.height < $1.width * $1.height }
            .prefix(5))
        // With leaves, most of those the offset puts on the screen must answer
        // there (one can be covered: the status bar, the keyboard; one can be
        // wide enough to pass a wrong guess); with none, the element itself
        // (a weaker check, used only then).
        let onScreen = searchBounds.insetBy(dx: 1, dy: 1)
        let fits: (CGPoint) -> Bool = { offset in
            if checks.isEmpty { return self.answers(at: offset, context: context, frame: any) }
            let shown = checks.filter { onScreen.intersects($0.offsetBy(dx: offset.x, dy: offset.y)) }
            guard !shown.isEmpty else { return false }
            let passing = shown.filter { self.answers(at: offset, context: context, frame: $0) }.count
            return passing * 2 > shown.count
        }
        // Everything this context has hangs off the screen (a resize grabber
        // in the corner answers only where it shows): nothing can be checked,
        // and such chrome is SpringBoard's, drawn where it says.
        let elements = checks.isEmpty ? [any] : checks
        if elements.allSatisfy({ !searchBounds.contains($0) && searchBounds.intersects($0) }) {
            return remember(.zero, context)
        }
        // The app's own window can also be confirmed by its edges.
        let confirmed: (CGPoint) -> Bool = { offset in
            (isWindow && self.edgesConfirm(offset, context: context, window: any)) || fits(offset)
        }
        // The app's window: its resize grabber is SpringBoard's, drawn in
        // screen points, and its centre is the window's corner. Looked for
        // where the remembered offset, no offset, or another window's offset
        // puts it; it gives the origin exactly.
        let cachedOffset = Self.cached(udid: udid, context: context)
        if isWindow {
            for guess in ([cachedOffset, .zero].compactMap { $0 } + hypotheses()) {
                if let exact = grabberOrigin(window: any, near: guess, radius: 0) { return remember(exact, context) }
            }
        }
        if let cached = cachedOffset, confirmed(cached) { return remember(cached, context) }
        if confirmed(.zero) { return remember(.zero, context) }
        // A window's own overlays (the keyboard's toolbar) are contexts of
        // their own, too small for the lattice to land on, at their window's
        // offset: the offsets already found are the next guesses.
        for guess in hypotheses() where fits(guess) { return remember(guess, context) }
        // The app's window, found by its own elements: a sparse window's empty
        // background answers no hit-test at all, so a lattice over the screen
        // can miss everything in it. Its largest elements are looked for only
        // where the window can put them.
        if isWindow, let found = searchForLeaves(context: context, window: any, leaves: leaves) {
            return remember(found, context)
        }
        // Two elements whose readings agree (within 5 points) settle it even
        // when the leaves cannot vote (a floating tab bar's pills answer away
        // from their frames).
        var readings: [CGPoint] = []
        var grabberTries = 0
        if let found = searchLattice(context: context, accept: { candidates, clipped in
            // A reading of the window (rough: the status bar covers its top,
            // the screen cuts a side) finds the grabber near where it puts the
            // corner, and the grabber gives the exact origin.
            if isWindow, grabberTries < 3 {
                for candidate in candidates.prefix(2) {
                    grabberTries += 1
                    if let exact = self.grabberOrigin(window: any, near: candidate, radius: 48) { return exact }
                }
            }
            if checks.isEmpty, !clipped, let first = candidates.first { return first }
            if !checks.isEmpty || isWindow, let fit = candidates.first(where: confirmed) { return fit }
            for candidate in candidates {
                if let earlier = readings.first(where: { abs($0.x - candidate.x) <= 5 && abs($0.y - candidate.y) <= 5 }) {
                    return CGPoint(
                        x: ((earlier.x + candidate.x)).rounded() / 2,
                        y: ((earlier.y + candidate.y)).rounded() / 2
                    )
                }
            }
            readings.append(contentsOf: candidates)
            return nil
        }) {
            return remember(refine(found, context: context, leaves: checks), context)
        }
        failed.insert(context)
        return nil
    }

    /// The window's offset from one of its own elements, looked for where the
    /// window can put it: each of its largest elements in turn, sampled finer
    /// than its own size over the screen positions a window this size allows
    /// (at least 40 points of it on the screen, its top no more than 60 above
    /// the screen). A hit is measured exactly, then made exact by the grabber
    /// when it is there.
    private func searchForLeaves(context: UInt32, window: CGRect, leaves: [CGRect]) -> CGPoint? {
        let targets = leaves
            .filter { $0.width >= 12 && $0.height >= 12 && window.contains($0) }
            .sorted { $0.width * $0.height > $1.width * $1.height }
            .prefix(3)
        let lowest = CGPoint(x: searchBounds.minX - window.width + 40, y: searchBounds.minY - 60)
        let highest = CGPoint(
            x: searchBounds.maxX - 40,
            y: max(searchBounds.minY - 60, searchBounds.maxY - window.height + 60)
        )
        func span(_ from: CGFloat, _ to: CGFloat, _ step: CGFloat) -> [CGFloat] {
            guard from <= to else { return [] }
            var values: [CGFloat] = []
            var value = from
            while value <= to {
                values.append(value)
                value += step
            }
            return values
        }
        // Snapped layouts first (halves, thirds, quarters, flush to an edge):
        // one hit per guess on the largest element.
        if let leaf = targets.first {
            let width = searchBounds.width, height = searchBounds.height
            func slots(_ span: CGFloat, _ size: CGFloat) -> [CGFloat] {
                var values: [CGFloat] = [0, span - size, (span - size) / 2]
                for fraction in [1.0 / 4, 1.0 / 3, 1.0 / 2, 2.0 / 3, 3.0 / 4] { values.append(span * CGFloat(fraction)) }
                var unique: [CGFloat] = []
                for value in values where value > -size && value < span && !unique.contains(where: { abs($0 - value) < 1 }) {
                    unique.append(value)
                }
                return unique
            }
            for y in slots(height, window.height) {
                for x in slots(width, window.width) {
                    if hits >= Self.maxHits { return nil }
                    let point = CGPoint(x: x + leaf.midX - window.minX, y: y + leaf.midY - window.minY)
                    guard searchBounds.insetBy(dx: 1, dy: 1).contains(point),
                          Self.within(hit(point), frame: leaf, context: context),
                          let reading = measure(context: context, anchor: point, frame: leaf) else { continue }
                    for candidate in reading.candidates {
                        if let exact = grabberOrigin(window: window, near: candidate, radius: 24) { return exact }
                    }
                    if let first = reading.candidates.first { return first }
                }
            }
        }
        for leaf in targets {
            let centre = CGPoint(x: leaf.midX, y: leaf.midY)
            let xs = span(max(searchBounds.minX + 1, lowest.x + centre.x), min(searchBounds.maxX - 1, highest.x + centre.x), max(8, leaf.width * 0.8))
            let ys = span(max(searchBounds.minY + 1, lowest.y + centre.y), min(searchBounds.maxY - 1, highest.y + centre.y), max(8, leaf.height * 0.8))
            for y in ys {
                for x in xs {
                    if hits >= Self.maxHits { return nil }
                    let point = CGPoint(x: x, y: y)
                    guard Self.within(hit(point), frame: leaf, context: context) else { continue }
                    guard let reading = measure(context: context, anchor: point, frame: leaf) else { continue }
                    for candidate in reading.candidates {
                        if let exact = grabberOrigin(window: window, near: candidate, radius: 24) { return exact }
                    }
                    if let first = reading.candidates.first { return first }
                }
            }
        }
        return nil
    }

    /// The window's origin from its own resize grabber ("Resize <app>",
    /// `resize-grabber`, its value naming the corner it sits on), looked for
    /// a little inside the bottom corners `near` puts there, within `radius`
    /// points of that. Nil when the grabber is not there.
    private func grabberOrigin(window: CGRect, near offset: CGPoint, radius: CGFloat) -> CGPoint? {
        let placed = window.offsetBy(dx: offset.x, dy: offset.y)
        let corners: [(point: CGPoint, inward: CGPoint)] = [
            (CGPoint(x: placed.maxX, y: placed.maxY), CGPoint(x: -8, y: -8)),
            (CGPoint(x: placed.minX, y: placed.maxY), CGPoint(x: 8, y: -8)),
        ]
        let step: CGFloat = 12
        var deltas: [CGPoint] = [.zero]
        if radius > 0 {
            var ring: [CGPoint] = []
            var dy = -radius
            while dy <= radius {
                var dx = -radius
                while dx <= radius {
                    if dx != 0 || dy != 0 { ring.append(CGPoint(x: dx, y: dy)) }
                    dx += step
                }
                dy += step
            }
            deltas += ring.sorted { hypot($0.x, $0.y) < hypot($1.x, $1.y) }
        }
        // A corner off the screen (a guess that puts the window too low) is
        // looked for at the nearest point on it: a grabber in the screen's own
        // corner answers there.
        let onScreen = searchBounds.insetBy(dx: 2, dy: 2)
        var tried = Set<String>()
        for delta in deltas {
            for corner in corners {
                let raw = CGPoint(x: corner.point.x + corner.inward.x + delta.x, y: corner.point.y + corner.inward.y + delta.y)
                let point = CGPoint(
                    x: min(max(raw.x, onScreen.minX), onScreen.maxX),
                    y: min(max(raw.y, onScreen.minY), onScreen.maxY)
                )
                guard tried.insert("\(Int(point.x)),\(Int(point.y))").inserted else { continue }
                if hits >= Self.maxHits { return nil }
                guard let found = hit(point), found.system, found.identifier == "resize-grabber" else { continue }
                if let appLabel, let label = found.label, label != "Resize \(appLabel)" { continue }
                let names = (found.value ?? "").lowercased()
                let centre = CGPoint(x: found.frame.midX, y: found.frame.midY)
                let origin = CGPoint(
                    x: names.contains("left") ? centre.x : centre.x - window.width,
                    y: names.contains("top") ? centre.y : centre.y - window.height
                )
                return CGPoint(x: ((origin.x - window.minX) * 2).rounded() / 2, y: ((origin.y - window.minY) * 2).rounded() / 2)
            }
        }
        return nil
    }

    /// A reading from a big or oddly padded element is right to within its
    /// inset; one more measurement of the smallest leaf that sits wholly on
    /// the screen, started where that reading puts it, makes it exact.
    private func refine(_ offset: CGPoint, context: UInt32, leaves: [CGRect]) -> CGPoint {
        let onScreen = searchBounds.insetBy(dx: 2, dy: 2)
        for leaf in leaves {
            let placed = leaf.offsetBy(dx: offset.x, dy: offset.y)
            guard onScreen.contains(placed) else { continue }
            guard let reading = measure(context: context, anchor: CGPoint(x: placed.midX, y: placed.midY), frame: leaf),
                  !reading.clipped, let exact = reading.candidates.first else { continue }
            if abs(exact.x - offset.x) <= 12, abs(exact.y - offset.y) <= 12 { return exact }
        }
        return offset
    }

    /// The offset for one element outside the tree walk (a hit-test's own
    /// element, the focused element, an element the grid found). `seed` is a
    /// screen point the element is known to cover.
    func offset(context: UInt32?, frame: CGRect, seed: CGPoint?) -> CGPoint? {
        guard enabled, let context else { return .zero }
        if let measured = offsets[context] { return measured }
        let coversSeed: (CGPoint) -> Bool = { offset in
            seed.map { frame.offsetBy(dx: offset.x, dy: offset.y).insetBy(dx: -1, dy: -1).contains($0) } ?? true
        }
        if let cached = Self.cached(udid: udid, context: context), coversSeed(cached),
           answers(at: cached, context: context, frame: frame) {
            return remember(cached, context: context)
        }
        if coversSeed(.zero), answers(at: .zero, context: context, frame: frame) {
            return remember(.zero, context: context)
        }
        // Hanging off the screen (a resize grabber in the corner), an element
        // answers only where it shows and its edges cannot be read; when it
        // already covers the hit-test's point where it is, it stays there.
        if let seed, frame.insetBy(dx: -1, dy: -1).contains(seed), !searchBounds.contains(frame) {
            return remember(.zero, context: context)
        }
        for guess in hypotheses() where coversSeed(guess) && answers(at: guess, context: context, frame: frame) {
            return remember(guess, context: context)
        }
        // A point read never searches: a sweep of them (finding a window's
        // grabber) must stay fast. Unknown is said, not guessed.
        if failed.contains(context) || !allowSearch { return nil }
        if let seed, let reading = measure(context: context, anchor: seed, frame: frame),
           let offset = reading.candidates.first(where: coversSeed) {
            // A reading with a side cut off is kept only if nothing better turns up.
            if !reading.clipped { return remember(offset, context: context) }
        }
        failed.insert(context)
        return nil
    }

    /// A window placed at `offset`: a little inside each edge it answers (one
    /// may not: the strip its window controls sit in answers nothing), just
    /// outside it does not. Edges on or past the screen's are skipped.
    private func edgesConfirm(_ offset: CGPoint, context: UInt32, window: CGRect) -> Bool {
        guard window.width > 48, window.height > 48 else { return false }
        let placed = window.offsetBy(dx: offset.x, dy: offset.y)
        let onScreen = searchBounds.insetBy(dx: 1, dy: 1)
        let inside = [
            CGPoint(x: placed.midX, y: placed.minY + 16), CGPoint(x: placed.midX, y: placed.maxY - 16),
            CGPoint(x: placed.minX + 16, y: placed.midY), CGPoint(x: placed.maxX - 16, y: placed.midY),
        ].filter { onScreen.contains($0) }
        let outside = [
            CGPoint(x: placed.midX, y: placed.minY - 6), CGPoint(x: placed.midX, y: placed.maxY + 6),
            CGPoint(x: placed.minX - 6, y: placed.midY), CGPoint(x: placed.maxX + 6, y: placed.midY),
        ].filter { onScreen.contains($0) }
        guard inside.count >= 3, !outside.isEmpty else { return false }
        guard outside.allSatisfy({ hit($0)?.context != context }) else { return false }
        let answering = inside.filter { hit($0)?.context == context }.count
        return answering >= inside.count - 1 && answering >= 2
    }

    /// Offsets this read found, then the ones remembered for this device.
    private func hypotheses() -> [CGPoint] {
        var guesses: [CGPoint] = []
        for offset in offsets.values where offset != .zero && !guesses.contains(offset) { guesses.append(offset) }
        Self.lock.lock()
        let remembered = Self.known[udid]?.values.map { $0 } ?? []
        Self.lock.unlock()
        for offset in remembered where offset != .zero && !guesses.contains(offset) { guesses.append(offset) }
        return Array(guesses.prefix(6))
    }

    // MARK: - Measuring

    private func hit(_ point: CGPoint) -> Hit? {
        guard hits < Self.maxHits else { return nil }
        hits += 1
        return hitTest(point)
    }

    /// The hit is the element or one of its children: same window, and a
    /// frame inside the element's (both relative to the window).
    private static func within(_ hit: Hit?, frame: CGRect, context: UInt32) -> Bool {
        guard let hit, hit.context == context else { return false }
        return frame.insetBy(dx: -0.5, dy: -0.5).contains(hit.frame)
    }

    /// The element answers at its centre and a little in from each side
    /// (a quarter of the way, at most 8 points: corners belong to a rounded
    /// cell) once placed at `offset`, which pins the offset to that inset.
    /// Points on or past the screen's edge answer nothing, so they are skipped.
    private func answers(at offset: CGPoint, context: UInt32, frame: CGRect) -> Bool {
        guard frame.width > 4, frame.height > 4 else { return false }
        let placed = frame.offsetBy(dx: offset.x, dy: offset.y)
        let onScreen = searchBounds.insetBy(dx: 1, dy: 1)
        let insetX = min(8, frame.width / 4)
        let insetY = min(8, frame.height / 4)
        let points = [
            CGPoint(x: placed.midX, y: placed.midY),
            CGPoint(x: placed.minX + insetX, y: placed.midY),
            CGPoint(x: placed.maxX - insetX, y: placed.midY),
            CGPoint(x: placed.midX, y: placed.minY + insetY),
            CGPoint(x: placed.midX, y: placed.maxY - insetY),
        ].filter { onScreen.contains($0) }
        guard !points.isEmpty else { return false }
        return points.allSatisfy { Self.within(hit($0), frame: frame, context: context) }
    }

    /// Walks a coarse lattice over the screen for elements of this context,
    /// smallest first in each row, and offers each one's readings to `accept`.
    private func searchLattice(context: UInt32, accept: ([CGPoint], Bool) -> CGPoint?) -> CGPoint? {
        var tried: [CGRect] = []
        var y = searchBounds.minY + step / 2
        while y < searchBounds.maxY {
            var row: [(point: CGPoint, frame: CGRect)] = []
            var x = searchBounds.minX + step / 2
            while x < searchBounds.maxX {
                let point = CGPoint(x: x, y: y)
                x += step
                if hits >= Self.maxHits { return nil }
                guard let found = hit(point), found.context == context, found.frame.width > 4, found.frame.height > 4 else { continue }
                if tried.contains(found.frame) { continue }
                tried.append(found.frame)
                row.append((point, found.frame))
            }
            for candidate in row.sorted(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) {
                if let reading = measure(context: context, anchor: candidate.point, frame: candidate.frame),
                   let offset = accept(reading.candidates, reading.clipped) {
                    return offset
                }
                if hits >= Self.maxHits { return nil }
            }
            y += step
        }
        return nil
    }

    /// The offsets one element found at `anchor` allows: where it stops
    /// answering on each side, read as the middle of that span, or, where the
    /// screen cuts a side off, from the other side and from the screen edge
    /// (`clipped`). Each must also answer at the element's centre and corners.
    private func measure(context: UInt32, anchor: CGPoint, frame: CGRect) -> (candidates: [CGPoint], clipped: Bool)? {
        guard frame.width > 0, frame.height > 0 else { return nil }
        let margin: CGFloat = 32  // beyond any touch padding
        var clipped = false
        func edge(inside: CGFloat, outside: CGFloat, probe: (CGFloat) -> CGPoint) -> CGFloat? {
            var answering = inside
            var silent = outside
            while abs(answering - silent) > 0.25 {
                let middle = (answering + silent) / 2
                if Self.within(hit(probe(middle)), frame: frame, context: context) { answering = middle } else { silent = middle }
                if hits >= Self.maxHits { return nil }
            }
            return answering
        }
        func axis(anchor: CGFloat, span: CGFloat, low: CGFloat, high: CGFloat, start: CGFloat, end: CGFloat, probe: (CGFloat) -> CGPoint) -> [CGFloat]? {
            guard
                let first = edge(inside: anchor, outside: anchor - span - margin, probe: probe),
                let last = edge(inside: anchor, outside: anchor + span + margin, probe: probe)
            else { return nil }
            let clippedLow = first <= low + 1
            let clippedHigh = last >= high - 1
            if clippedLow || clippedHigh { clipped = true }
            // A side the screen cuts off: read the other side, or put the
            // element's edge on the screen's (the other side may be covered by
            // something else, the status bar).
            if clippedLow && !clippedHigh { return [last - end, low - start] }
            if clippedHigh && !clippedLow { return [first - start, high - end] }
            return [(first + last) / 2 - (start + end) / 2]
        }
        guard
            let xs = axis(anchor: anchor.x, span: frame.width, low: searchBounds.minX, high: searchBounds.maxX,
                          start: frame.minX, end: frame.maxX, probe: { CGPoint(x: $0, y: anchor.y) }),
            let ys = axis(anchor: anchor.y, span: frame.height, low: searchBounds.minY, high: searchBounds.maxY,
                          start: frame.minY, end: frame.maxY, probe: { CGPoint(x: anchor.x, y: $0) })
        else { return nil }
        // Window origins sit on half points; the search lands within a quarter.
        let round: (CGFloat) -> CGFloat = { ($0 * 2).rounded() / 2 }
        var candidates: [CGPoint] = []
        for x in xs {
            for y in ys {
                let offset = CGPoint(x: round(x), y: round(y))
                if !candidates.contains(offset), answers(at: offset, context: context, frame: frame) { candidates.append(offset) }
            }
        }
        return candidates.isEmpty ? nil : (candidates, clipped)
    }

    private func remember(_ offset: CGPoint, context: UInt32) -> CGPoint {
        offsets[context] = offset
        Self.lock.lock()
        Self.known[udid, default: [:]][context] = offset
        Self.lock.unlock()
        return offset
    }

    private static func cached(udid: String, context: UInt32) -> CGPoint? {
        lock.lock()
        defer { lock.unlock() }
        return known[udid]?[context]
    }

    /// Forget a device's windows (a power cycle renumbers every context).
    static func forget(udid: String) {
        lock.lock()
        known.removeValue(forKey: udid)
        lock.unlock()
    }
}

/// How the picture iOS shows sits on a rigid device's framebuffer (an iPad or
/// iPhone held landscape), the same quarter turns the touch path uses
/// (`DeviceSession.readScreenTurns` / `toFrame`).
///
/// Measured on an iPad Air 11-inch (M4), iPadOS 27.0, held landscape-left:
/// hit-tests take the PORTRAIT framebuffer's points, and SpringBoard's
/// elements (status bar, window controls, resize grabbers) come back in them
/// (the battery at 10,15, 13x29), while the app's own elements come back in
/// the landscape picture (relative to their window). So a screen point is
/// turned onto the framebuffer before a hit-test, and a SpringBoard frame is
/// turned back onto the screen.
struct ScreenTurn: Sendable {
    /// Quarter turns clockwise of the picture on its framebuffer: 0–3.
    let turns: Int
    /// The framebuffer, in points (portrait for an iPad or iPhone).
    let frame: CGSize

    init(turns: Int, frame: CGSize) {
        self.turns = ((turns % 4) + 4) % 4
        self.frame = frame
    }

    init(orientation: String?, frame: CGSize) {
        switch orientation?.replacingOccurrences(of: "-", with: "_") {
        case "landscape_left": self.init(turns: 1, frame: frame)
        case "landscape_right": self.init(turns: 3, frame: frame)
        case "portrait_upside_down": self.init(turns: 2, frame: frame)
        default: self.init(turns: 0, frame: frame)
        }
    }

    var isTurned: Bool { turns != 0 }

    /// The screen as the agent and the screenshot see it.
    var screen: CGSize { turns % 2 == 1 ? CGSize(width: frame.height, height: frame.width) : frame }

    /// A screen point onto the framebuffer (`DeviceSession.toFrame`).
    func toFrame(_ point: CGPoint) -> CGPoint {
        let width = frame.width, height = frame.height
        switch turns {
        case 1: return CGPoint(x: point.y, y: height - point.x)
        case 2: return CGPoint(x: width - point.x, y: height - point.y)
        case 3: return CGPoint(x: width - point.y, y: point.x)
        default: return point
        }
    }

    /// A framebuffer point onto the screen: the inverse of `toFrame`.
    func toScreen(_ point: CGPoint) -> CGPoint {
        let width = frame.width, height = frame.height
        switch turns {
        case 1: return CGPoint(x: height - point.y, y: point.x)
        case 2: return CGPoint(x: width - point.x, y: height - point.y)
        case 3: return CGPoint(x: point.y, y: width - point.x)
        default: return point
        }
    }

    func toScreen(_ rect: CGRect) -> CGRect {
        guard isTurned else { return rect }
        let a = toScreen(CGPoint(x: rect.minX, y: rect.minY))
        let b = toScreen(CGPoint(x: rect.maxX, y: rect.maxY))
        return CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
    }
}
