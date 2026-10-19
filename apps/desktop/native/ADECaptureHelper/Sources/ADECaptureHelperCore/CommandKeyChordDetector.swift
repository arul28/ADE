import Foundation

/// Rising-edge detector for "both Command keys held at once", fed by the key
/// code a `.flagsChanged` event names.
///
/// macOS 27 stopped putting the device-dependent left/right masks in the
/// `NSEvent.modifierFlags` class property the helper used to poll: both keys
/// now report only the generic Command bit, so a chord detector reading 0x8
/// and 0x10 can never fire. A `.flagsChanged` event still names which physical
/// key changed — 55 is left Command, 54 is right Command — so the event tap
/// feeds that key code here and this keeps the two states.
///
/// Each event is one transition of that key, so the state toggles. The
/// `commandDown` sample is the resync: a `.flagsChanged` event with the generic
/// Command bit clear means no Command key is down, and any half-remembered
/// press is dropped rather than treated as the chord.
public struct CommandKeyChordDetector {
    public static let leftCommandKeyCode: Int64 = 55
    public static let rightCommandKeyCode: Int64 = 54

    private var leftDown = false
    private var rightDown = false
    private var engaged = false

    public init() {}

    /// Feed one `.flagsChanged` sample.
    /// - Parameters:
    ///   - keyCode: `NSEvent.keyCode` / `CGEvent` keyboard key code.
    ///   - commandDown: whether the event's flags still contain generic Command.
    /// - Returns: true exactly once per press of the chord.
    public mutating func consume(keyCode: Int64, commandDown: Bool) -> Bool {
        guard keyCode == Self.leftCommandKeyCode || keyCode == Self.rightCommandKeyCode else {
            return false
        }
        if !commandDown {
            leftDown = false
            rightDown = false
        } else if keyCode == Self.leftCommandKeyCode {
            leftDown.toggle()
        } else {
            rightDown.toggle()
        }
        let bothDown = leftDown && rightDown
        defer { engaged = bothDown }
        return bothDown && !engaged
    }

    /// Drop the latch without reporting a chord — used when the tap is
    /// re-enabled after the system disabled it and events may have been lost.
    public mutating func reset() {
        leftDown = false
        rightDown = false
        engaged = false
    }

    public var isEngaged: Bool { engaged }
}
