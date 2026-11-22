import SwiftUI

// The band beside the clock: where the Hub's header sits on the Duo's outer
// display, how the Hub finds it, and the readout that says what it found.

/// The width of the empty band the status bar leaves on the leading side of
/// a tall top inset (nil where there is none), and why. The Duo's outer display,
/// upright, draws its clock and status in a block at the top trailing corner
/// (reported as an occlusion) under a top inset deep enough for a header row,
/// and leaves the rest of that band empty. Every other iPhone's top occlusion
/// is the Dynamic Island, centred, with no row's height beside it.
///
/// A call, a timer, a recording or navigation adds a pill to the block's
/// leading side, so the band can be much narrower than usual. The header has
/// tiers down to `hubStatusBandMinimumWidth` (`HubHeaderRow`); only a band
/// narrower than that puts the header on a row of its own.
///
/// A real iPhone Duo on iOS 27.2 reports no block at all, though it draws the
/// clock in the same place. With nothing reported, the display's shape
/// decides (`hubDisplayIsDuoOuter`) and the block takes its usual place
/// (`hubStatusBlockUsualWidth`). A pill is then unseen, and the header can
/// sit under it.
///
/// The reading also says, in plain words, what it saw and which check
/// decided. Settings › Advanced shows that (`HubLayoutDiagnostics`), so a
/// phone the simulator cannot copy can say which check failed.
func hubStatusBandReading(_ proxy: GeometryProxy) -> HubStatusBandReading {
  let width = proxy.size.width
  let topInset = proxy.safeAreaInsets.top
  let display = proxy.sizeWithSafeAreas
  let facts = "Top space \(Int(topInset)), width \(Int(width)), height \(Int(display.height))."
  func reading(_ band: CGFloat?, _ verdict: String, _ extra: String = "") -> HubStatusBandReading {
    HubStatusBandReading(width: band, detail: [verdict, facts, extra].filter { !$0.isEmpty }.joined(separator: " "))
  }
  guard !proxy.isLandscapeIgnoringKeyboard else { return reading(nil, "Full: landscape.") }
  guard topInset >= 64 else { return reading(nil, "Full: top space under 64.") }
  #if compiler(>=6.4)
  guard #available(iOS 27.1, *) else { return reading(nil, "Full: iOS older than 27.1.") }
  // The inactive ones are for the readout only.
  var regions = proxy.reservedRegions(kind: .occlusion, options: .includeInactive)
  #if DEBUG
  // `-adeHubNoStatusBlocks` stands in for a phone that reports no block.
  if hubDebugNoStatusBlocks { regions = [] }
  #endif
  let blocks = regions.isEmpty
    ? "No clock block reported."
    : "Blocks: " + regions.map { region in
      let f = region.frame
      return "\(region.isActive ? "" : "inactive ")x \(Int(f.minX))-\(Int(f.maxX)) y \(Int(f.minY))-\(Int(f.maxY))"
    }.joined(separator: "; ") + "."
  // Its bottom is not checked: with the ringer silenced the phone stacks a
  // bell over the clock, and the block can reach below the inset. The header
  // only needs the band to its leading side.
  let top = regions.filter { region in
    region.isActive && region.frame.minY < 0
  }
  let blockStart: CGFloat
  let source: String
  if top.contains(where: { $0.frame.maxX > width * 0.75 }) {
    // A block that reaches the trailing corner, not an island in the middle.
    // Every pill of the block, the leading one included, ends the band.
    guard let measured = top.map(\.frame.minX).filter({ $0 > width * 0.25 }).min() else {
      return reading(nil, "Full: the block starts in the leading quarter.", blocks)
    }
    blockStart = measured
    source = ""
  } else if top.isEmpty, hubDisplayIsDuoOuter(display) {
    blockStart = width - hubStatusBlockUsualWidth
    source = ", from the display's shape"
  } else {
    return reading(nil, "Full: no block in the top trailing corner.", blocks)
  }
  var leading = blockStart
  #if DEBUG
  // `-adeHubStatusBand <points>` stands in for a call or timer pill, which a
  // simulator cannot show: it narrows the band to that width.
  if let forced = hubDebugStatusBandWidth { leading = min(leading, forced) }
  #endif
  guard leading >= hubStatusBandMinimumWidth else {
    return reading(nil, "Full: band \(Int(leading)) is under \(Int(hubStatusBandMinimumWidth)).", blocks)
  }
  return reading(leading, "Compact: band \(Int(leading))\(source).", blocks)
  #else
  return reading(nil, "Full: built without Swift 6.4.")
  #endif
}

/// The status block's usual width on the Duo's outer display, upright: the
/// trailing 200 points. The iOS 27.1 simulator reports that block (x 266 to
/// 466 of 466) and draws its clock 27 points inside it. A real Duo on iOS 27.2
/// reports none and draws its clock from x 288 of 457: 31 points inside the
/// same trailing 200.
private let hubStatusBlockUsualWidth: CGFloat = 200

/// The Duo's outer display, upright, by its shape, for a phone that reports
/// no status block: 457 by 678 points, far squatter than a bar-shaped iPhone
/// (each over twice as tall as it is wide). The inner display is squat too,
/// and wider than any phone's outer display.
private func hubDisplayIsDuoOuter(_ display: CGSize) -> Bool {
  display.width < 520 && display.height < display.width * 1.7
}

/// `hubStatusBandReading`'s result: the band's width, nil when the header
/// takes a row of its own, and the facts it checked.
struct HubStatusBandReading: Equatable {
  var width: CGFloat?
  var detail: String
}

/// The Hub header's last reading, for Settings › Advanced.
@MainActor
@Observable
final class HubLayoutDiagnostics {
  static let shared = HubLayoutDiagnostics()
  var hubHeader: String?
}

#if DEBUG
private let hubDebugStatusBandWidth: CGFloat? = {
  let arguments = ProcessInfo.processInfo.arguments
  guard let index = arguments.firstIndex(of: "-adeHubStatusBand"),
        arguments.index(after: index) < arguments.endIndex,
        let value = Double(arguments[arguments.index(after: index)])
  else { return nil }
  return CGFloat(value)
}()

private let hubDebugNoStatusBlocks = ProcessInfo.processInfo.arguments.contains("-adeHubNoStatusBlocks")
#endif

/// The narrowest band beside the clock that the header's tightest tier fits
/// in. That tier is about 153 points wide: three 34-point icons, the machines
/// glyph with its spinner, and the capsule's padding. The band's header gives
/// 24 points to its margins (`HubPhoneLayout.header`).
let hubStatusBandMinimumWidth: CGFloat = 180
