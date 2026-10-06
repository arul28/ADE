/// A scroll direction and line count as wheel deltas, for the two paths that
/// post a wheel event (`RealInput`, `BackgroundInput`).
///
/// `direction` names the way the CONTENT moves, matching the accessibility
/// path's vocabulary: "down" scrolls a page down, which on macOS is a negative
/// wheel delta. The amount is clamped to 1…50 lines.
public enum ScrollDelta {
    public static func lines(direction: String, amount: Int) throws -> (vertical: Int32, horizontal: Int32) {
        let lines = Int32(max(1, min(50, amount)))
        switch direction.lowercased() {
        case "up": return (lines, 0)
        case "down": return (-lines, 0)
        case "left": return (0, lines)
        case "right": return (0, -lines)
        default:
            throw DriverError(
                code: DriverErrorCode.invalidArgument,
                message: "\"\(direction)\" is not a scroll direction; use up, down, left or right."
            )
        }
    }
}
