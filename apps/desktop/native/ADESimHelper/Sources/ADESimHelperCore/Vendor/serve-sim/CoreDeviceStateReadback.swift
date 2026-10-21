import Foundation
import CoreDeviceShim

extension CoreDeviceBridge {
    func consumeDeviceStateUpdates(udid: String,
                                   onUpdate: @escaping @Sendable (DeviceStateUpdate) async -> Void) async throws -> Bool {
        guard #available(macOS 15.0, *), SSCoreDeviceMotionAvailable(),
              SSCoreDeviceHingeReadbackAvailable() || SSCoreDeviceStateReadbackAvailable() else { return false }
        try Task.checkCancellation()
        return try await withMotionManager(udid: udid) { manager in
            try Task.checkCancellation()
            let angle = SSCoreDeviceHingeReadbackAvailable() && SSCoreDeviceMotionSupportsHinge(manager)
            let motion = SSCoreDeviceStateReadbackAvailable() && SSCoreDeviceMotionSupportsState(manager)
            guard angle || motion else { return false }
            try await withThrowingTaskGroup(of: Void.self) { group in
                if angle {
                    group.addTask {
                        try await self.consumeHingeSamples(manager: manager) { await onUpdate(.angle($0)) }
                    }
                }
                if motion {
                    group.addTask {
                        try await self.consumeMotionSamples(udid: udid, manager: manager, onUpdate: onUpdate)
                    }
                }
                defer { group.cancelAll() }
                _ = try await group.next()
            }
            return true
        }
    }

    @available(macOS 15.0, *)
    private func consumeMotionSamples(udid: String, manager: UnsafeMutableRawPointer,
                                      onUpdate: @escaping @Sendable (DeviceStateUpdate) async -> Void) async throws {
        guard let metadata = SSCoreDeviceStateReadbackMetadata(), let errorMetadata = SSCoreDeviceErrorMetadata(),
              let pointer = SSCoreDeviceStateReadbackPointer(),
              let type = unsafeBitCast(metadata, to: Any.Type.self) as? any Encodable.Type else { return }
        typealias Monitor = @convention(thin) (UnsafeMutableRawPointer, UnsafeMutableRawPointer,
                                               UnsafeMutableRawPointer) async throws(CoreDeviceCallFailed) -> Void
        let monitor = unsafeBitCast(pointer, to: Monitor.self)
        try await consumeMonitorStream(
            of: type, errorMetadata: errorMetadata,
            start: { try await monitor($0, $1, manager) },
            afterStart: {
                guard let orientation = try? await self.readPhysicalOrientation(udid: udid) else { return }
                try Task.checkCancellation()
                await onUpdate(.orientation(orientation))
            },
            decode: { try? JSONDecoder().decode(DeviceMotionSample.self, from: $0) },
            timestamp: \.timestamp, onSample: { await onUpdate(.motion($0)) }
        )
    }

    private func readPhysicalOrientation(udid: String) async throws -> PhysicalOrientationSample? {
        guard SSCoreDeviceOrientationReadbackAvailable(), let metadata = SSCoreDeviceOrientationReadbackMetadata(),
              let pointer = SSCoreDeviceOrientationReadbackPointer(),
              let type = unsafeBitCast(metadata, to: Any.Type.self) as? any Encodable.Type else { return nil }
        let capability = try await capability(udid: udid,
            metadataSymbol: "$s10CoreDevice28OrientationControlCapabilityVN",
            witnessSymbol: "$s10CoreDevice28OrientationControlCapabilityVAA0bE0AAWP")
        try Task.checkCancellation()
        let result = UnsafeMutableRawPointer.allocate(byteCount: Int(SSCoreDeviceValueSize(metadata)), alignment: 16)
        defer { result.deallocate() }
        typealias Read = @convention(thin) (UnsafeMutableRawPointer, UnsafeRawPointer,
                                          UnsafeRawPointer, UnsafeRawPointer) async throws -> Void
        let read = unsafeBitCast(pointer, to: Read.self)
        let timestamp = hingeClock()
        try await read(result, capability.storage.load(fromByteOffset: 24, as: UnsafeRawPointer.self),
                       capability.storage.load(fromByteOffset: 32, as: UnsafeRawPointer.self), capability.storage)
        let readCompletedAt = hingeClock()
        defer { SSCoreDeviceDestroyValue(result, metadata) }
        try Task.checkCancellation()
        func decode<T: Encodable>(_: T.Type) throws -> PhysicalOrientationSample {
            let value = result.assumingMemoryBound(to: T.self).pointee
            let info = try JSONDecoder().decode(OrientationReadback.self, from: JSONEncoder().encode(value))
            return .init(orientation: ObservedPhysicalOrientation.name(info.currentDeviceOrientation),
                         timestamp: timestamp, readCompletedAt: readCompletedAt)
        }
        return try _openExistential(type, do: decode)
    }
}

private struct OrientationReadback: Decodable { let currentDeviceOrientation: String }
