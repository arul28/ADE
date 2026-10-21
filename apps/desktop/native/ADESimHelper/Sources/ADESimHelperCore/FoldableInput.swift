import Foundation
import CoreDeviceShim

/// Touch and key input for a foldable simulator (the iPhone Duo).
///
/// The Duo's legacy Indigo inner-screen target is disconnected, and sending to
/// it can abort the guest's `backboardd`. Input therefore goes through
/// CoreDevice's Universal HID digitizer, to touchscreen service `0x100 +
/// screenID` (`0x101` cover, `0x103` inner), with the keyboard service opened
/// alongside because opening it is what starts guest HID delivery. The
/// transport is the vendored serve-sim shim (`SSCoreDeviceSendTouches`,
/// `SSCoreDeviceSendKey`); this type is ADE's use of it.
///
/// Coordinates are fractions of the panel in its native orientation, which is
/// the orientation the captured framebuffer is in, so a point normalized
/// against the streamed frame needs no rotation.
actor FoldableInput {
    enum InputError: Error, LocalizedError {
        case unavailable(String)
        var errorDescription: String? {
            switch self {
            case let .unavailable(reason): return reason
            }
        }
    }

    private let udid: String
    private var digitizer: CoreDeviceCapabilityObject?
    private var keyboard: CoreDeviceCapabilityObject?
    /// The service a gesture started on, kept until its touch-up so a fold
    /// mid-drag cannot split one gesture across two panels.
    private var gestureService: UInt32?

    init(udid: String) {
        self.udid = udid
    }

    func setup() async throws {
        guard digitizer == nil else { return }
        guard SSCoreDeviceDigitizerAvailable() else {
            throw InputError.unavailable("This Xcode's CoreDevice has no touch transport for foldable simulators.")
        }
        guard SSCoreDeviceKeyboardAvailable() else {
            throw InputError.unavailable("This Xcode's CoreDevice has no keyboard transport for foldable simulators.")
        }
        let udid = self.udid
        let services = try await CoreDeviceHIDServices.open(
            digitizer: {
                try await CoreDeviceBridge.shared.capability(
                    udid: udid,
                    metadataSymbol: "$s10CoreDevice29UniversalHIDServiceCapabilityVN",
                    witnessSymbol: "$s10CoreDevice29UniversalHIDServiceCapabilityVAA0bE0AAWP"
                )
            },
            keyboard: {
                try await CoreDeviceBridge.shared.capability(
                    udid: udid,
                    metadataSymbol: "$s10CoreDevice21KeyboardHIDCapabilityVN",
                    witnessSymbol: "$s10CoreDevice21KeyboardHIDCapabilityVAA0B10CapabilityAAWP"
                )
            }
        )
        digitizer = services.digitizer
        keyboard = services.keyboard
    }

    /// `phase` is `begin`, `move` or `end`; points are 0…1 of the panel.
    func touch(phase: String, screenID: UInt32, points: [CGPoint]) async throws {
        try await setup()
        guard let digitizer else { return }
        if phase == "begin" || gestureService == nil { gestureService = 0x100 + screenID }
        let service = gestureService ?? (0x100 + screenID)
        let contacts = points.map { SSCoreDeviceTouch(x: Double($0.x), y: Double($0.y)) }
        let sent = contacts.withUnsafeBufferPointer {
            SSCoreDeviceSendTouches(digitizer.storage, service, $0.baseAddress, UInt8($0.count), phase != "end", 0)
        }
        if phase == "end" { gestureService = nil }
        if !sent { fputs("[hid] CoreDevice touch delivery failed for service \(service)\n", stderr) }
    }

    func key(usage: UInt32, down: Bool) async throws {
        try await setup()
        guard let keyboard else { return }
        if !SSCoreDeviceSendKey(keyboard.storage, usage, down) {
            fputs("[hid] CoreDevice key delivery failed for usage \(usage)\n", stderr)
        }
    }
}
