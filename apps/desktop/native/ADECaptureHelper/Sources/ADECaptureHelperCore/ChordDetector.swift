import Foundation

/// Device-dependent modifier bits macOS puts in `NSEvent.modifierFlags.rawValue`.
///
/// `NSEvent.ModifierFlags.command` only says "a Command key is down"; it cannot
/// tell left from right. The raw value carries the device-dependent masks from
/// `IOKit/hidsystem/IOLLEvent.h` alongside it, and those do:
///
///   NX_DEVICELCMDKEYMASK  = 0x00000008
///   NX_DEVICERCMDKEYMASK  = 0x00000010
///
/// This was the pre-macOS-27 route and costs no permission: the static flags
/// property is a hardware-state read, not an event tap. macOS 27 stopped
/// populating the left/right bits there, so this detector is now the fallback
/// for older systems only; `CommandKeyChordDetector` reads the key code from a
/// listen-only event tap on the macOS versions where the poll is blind.
public enum ModifierMask {
    public static let leftCommand: UInt = 0x0000_0008
    public static let rightCommand: UInt = 0x0000_0010
}

/// Rising-edge detector for "both Command keys held at once".
///
/// Pure and synchronous so it can be reasoned about (and unit-tested) without a
/// run loop. The polling timer feeds it raw flag values; it answers whether
/// *this* sample is the moment the chord became true.
///
/// Latching is the whole job. Modifier keys are held, and a 40ms poll sees the
/// same "both down" sample a dozen times for one deliberate press. The chord
/// fires once on the transition into both-down and cannot fire again until at
/// least one of the two keys has been released.
public struct ChordDetector {
    private var engaged = false

    public init() {}

    /// Feed one sample of `NSEvent.modifierFlags.rawValue`.
    /// - Returns: true exactly once per press of the chord.
    public mutating func consume(rawFlags: UInt) -> Bool {
        let left = (rawFlags & ModifierMask.leftCommand) != 0
        let right = (rawFlags & ModifierMask.rightCommand) != 0
        let bothDown = left && right
        defer { engaged = bothDown }
        return bothDown && !engaged
    }

    /// Drop the latch without reporting a chord — used when the gesture is
    /// switched off while the keys happen to be down, so re-enabling it does not
    /// immediately fire on a press the user made while it was disabled.
    public mutating func reset() {
        engaged = false
    }

    public var isEngaged: Bool { engaged }
}
