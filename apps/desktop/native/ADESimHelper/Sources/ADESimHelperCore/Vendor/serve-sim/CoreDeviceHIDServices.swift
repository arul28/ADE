import Foundation

/// Opening the keyboard service starts guest delivery even without key encoding.
// @ref LLP 0004#touch-transport — service failure rejects the shared input setup.
enum CoreDeviceHIDServices {
    static let keyboardServiceUnavailable = 9

    static func open<Capability>(
        digitizer: () async throws -> Capability,
        keyboard: () async throws -> Capability,
        retryDelay: () async throws -> Void = { try await Task.sleep(nanoseconds: 250_000_000) }
    ) async throws -> (digitizer: Capability, keyboard: Capability) {
        // Capabilities can become available after the simulator is listed.
        for attempt in 0..<10 {
            var transport = "touch"
            do {
                let digitizer = try await digitizer()
                transport = "keyboard"
                let keyboard = try await keyboard()
                return (digitizer, keyboard)
            } catch {
                if attempt == 9 {
                    if transport == "keyboard" {
                        throw NSError(domain: "HIDInjector", code: keyboardServiceUnavailable,
                                      userInfo: [NSLocalizedDescriptionKey: "CoreDevice keyboard service could not be opened, so guest input cannot start: \(error)",
                                                 NSUnderlyingErrorKey: error])
                    }
                    throw NSError(domain: "HIDInjector", code: 8,
                                  userInfo: [NSLocalizedDescriptionKey: "CoreDevice \(transport) capability lookup failed: \(error)",
                                             NSUnderlyingErrorKey: error])
                }
                try await retryDelay()
            }
        }
        preconditionFailure("Capability lookup must return or throw on its last attempt")
    }
}
