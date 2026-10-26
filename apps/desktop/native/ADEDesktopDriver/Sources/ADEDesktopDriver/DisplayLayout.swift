/// The active displays as the placement pass and the pointer fence read them.
///
/// Both ask the same question — can the person reach each of their screens? —
/// so both read the screens the same way: real displays with a size, one per
/// mirror set (a mirror cannot be placed on its own), the main display found by
/// id rather than guessed from list order, and every ADE lane display whichever
/// helper made it.

import CoreGraphics
import ADEDesktopDriverCore

struct DisplayLayout {
    typealias Display = (id: CGDirectDisplayID, frame: CGRect)

    let real: [Display]
    /// Index into `real`. Nil when the main display is not among them; then
    /// nothing is moved and nothing is unfenced, because "cut off from the
    /// main display" has no meaning.
    let mainIndex: Int?
    let lanes: [Display]

    static func current() -> DisplayLayout {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else {
            return DisplayLayout(real: [], mainIndex: nil, lanes: [])
        }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else {
            return DisplayLayout(real: [], mainIndex: nil, lanes: [])
        }
        let displays = ids.prefix(Int(count))
            .map { (id: $0, frame: CGDisplayBounds($0)) }
            .filter { $0.frame.width > 0 && $0.frame.height > 0 }
        let lanes = displays.filter { VirtualDisplayIdentity.isADEDisplay($0.id) }
        let real = displays.filter {
            !VirtualDisplayIdentity.isADEDisplay($0.id)
                && CGDisplayMirrorsDisplay($0.id) == kCGNullDirectDisplay
        }
        let main = CGMainDisplayID()
        return DisplayLayout(real: real, mainIndex: real.firstIndex { $0.id == main }, lanes: lanes)
    }

    /// The lane displays a person must be let across to reach a real display
    /// that is otherwise cut off. See `Geometry.laneDisplaysOnRouteToCutOffRealDisplays`.
    func laneDisplaysOnRouteToCutOffRealDisplays() -> Set<CGDirectDisplayID> {
        guard let mainIndex else { return [] }
        let route = Geometry.laneDisplaysOnRouteToCutOffRealDisplays(
            realDisplayFrames: real.map(\.frame),
            mainIndex: mainIndex,
            laneDisplayFrames: lanes.map(\.frame)
        )
        return Set(route.map { lanes[$0].id })
    }
}
