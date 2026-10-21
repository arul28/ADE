import Foundation
import CoreDeviceShim

extension CoreDeviceBridge {
    func readHingeAngle(udid: String) async -> Double? {
        let latest = HingeReadbackSamples()
        do {
            return try await withThrowingTaskGroup(of: Double?.self) { group in
                group.addTask {
                    try await self.consumeHingeSamples(udid: udid) { await latest.update($0) }
                    return await latest.sample?.angle
                }
                group.addTask {
                    let deadline = ContinuousClock.now.advanced(by: .seconds(1))
                    repeat {
                        try await Task.sleep(for: .milliseconds(50))
                        if await latest.isSettled { return await latest.sample?.angle }
                    } while ContinuousClock.now < deadline
                    return await latest.sample?.angle
                }
                defer { group.cancelAll() }
                return try await group.next() ?? nil
            }
        } catch {
            if !Task.isCancelled { fputs("[hid] Hinge readback unavailable: \(error)\n", stderr) }
            return nil
        }
    }

    func consumeHingeSamples(udid: String,
                            onSample: @escaping @Sendable (HingeAngleSample) async -> Void) async throws {
        guard #available(macOS 15.0, *), SSCoreDeviceHingeReadbackAvailable() else { return }
        try Task.checkCancellation()
        try await withMotionManager(udid: udid) { manager in
            try await self.consumeHingeSamples(manager: manager, onSample: onSample)
        }
    }

    func consumeHingeSamples(manager: UnsafeMutableRawPointer,
                            onSample: @escaping @Sendable (HingeAngleSample) async -> Void) async throws {
        guard #available(macOS 15.0, *), SSCoreDeviceHingeReadbackAvailable(),
              let metadata = SSCoreDeviceHingeReadbackMetadata(),
              let configMetadata = SSCoreDeviceHingeConfigMetadata(),
              let errorMetadata = SSCoreDeviceErrorMetadata(),
              let pointer = SSCoreDeviceHingeReadbackPointer(),
              let type = unsafeBitCast(metadata, to: Any.Type.self) as? any Encodable.Type,
              let configType = unsafeBitCast(configMetadata, to: Any.Type.self) as? any Decodable.Type
        else { return }
        try Task.checkCancellation()
        func configure<C: Decodable>(_: C.Type) async throws {
            // Open Apple's Codable type instead of assuming the layout
            // of its resilient config or snapshot structures.
            let config = UnsafeMutablePointer<C>.allocate(capacity: 1)
            defer { config.deallocate() }
            let data = try JSONEncoder().encode(HingeReadbackConfig())
            config.initialize(to: try JSONDecoder().decode(C.self, from: data))
            defer { config.deinitialize(count: 1) }
            typealias Monitor = @convention(thin) (UnsafeMutableRawPointer, UnsafeMutableRawPointer, UnsafeMutableRawPointer, UnsafeMutableRawPointer) async throws(CoreDeviceCallFailed) -> Void
            let monitor = unsafeBitCast(pointer, to: Monitor.self)
            try await consumeMonitorStream(
                of: type, errorMetadata: errorMetadata,
                start: { try await monitor($0, $1, config, manager) },
                decode: { (data: Data) -> HingeAngleSample? in
                    guard let decoded = try? JSONDecoder().decode(HingeReadbackSample.self, from: data) else { return nil }
                    let sample = HingeAngleSample(angle: decoded.angle.converted(to: .degrees).value,
                                                  timestamp: decoded.timestamp, isAngleValid: decoded.isAngleValid)
                    return sample.timestamp.isFinite && sample.timestamp >= 0 ? sample : nil
                },
                timestamp: \.timestamp, onSample: onSample
            )
        }
        try await configure(configType)
    }

    /// Starts one CoreDevice monitor stream and delivers each batch in timestamp order.
    @available(macOS 15.0, *)
    func consumeMonitorStream<Value: Encodable, Sample>(
        of _: Value.Type, errorMetadata: UnsafeMutableRawPointer,
        start: (UnsafeMutableRawPointer, UnsafeMutableRawPointer) async throws -> Void,
        afterStart: () async throws -> Void = {},
        decode: (Data) -> Sample?, timestamp: (Sample) -> Double,
        onSample: (Sample) async -> Void
    ) async throws {
        let output = UnsafeMutablePointer<AsyncThrowingStream<[Value], Error>>.allocate(capacity: 1)
        let errorBuffer = UnsafeMutableRawPointer.allocate(byteCount: Int(SSCoreDeviceValueSize(errorMetadata)), alignment: 16)
        defer { output.deallocate(); errorBuffer.deallocate() }
        do { try await start(UnsafeMutableRawPointer(output), errorBuffer) }
        catch {
            SSCoreDeviceDestroyValue(errorBuffer, errorMetadata)
            throw error
        }
        let stream = output.move()
        try Task.checkCancellation()
        try await afterStart()
        for try await batch in stream {
            try Task.checkCancellation()
            let samples = batch.compactMap { value in (try? JSONEncoder().encode(value)).flatMap(decode) }
            for sample in samples.sorted(by: { timestamp($0) < timestamp($1) }) {
                try Task.checkCancellation()
                await onSample(sample)
            }
        }
    }
}

struct HingeAngleSample: Equatable, Sendable {
    let angle: Double
    let timestamp: Double
    let isAngleValid: Bool

    init(angle: Double, timestamp: Double, isAngleValid: Bool = true) {
        self.angle = angle
        self.timestamp = timestamp
        self.isAngleValid = isAngleValid
    }

    var isValid: Bool { isAngleValid && angle.isFinite && (0...180).contains(angle) && timestamp.isFinite && timestamp >= 0 }
}

private struct HingeReadbackConfig: Encodable {
    let changeThreshold = Measurement(value: 1.0, unit: UnitAngle.degrees)
    let updateInterval = Duration.milliseconds(100)
}

private struct HingeReadbackSample: Decodable {
    let angle: Measurement<UnitAngle>
    let isAngleValid: Bool
    let timestamp: Double
}

private actor HingeReadbackSamples {
    private(set) var sample: HingeAngleSample?
    private var changed = ContinuousClock.now

    func update(_ value: HingeAngleSample) {
        guard value.isValid, value.timestamp > (sample?.timestamp ?? -.infinity) else { return }
        if sample?.angle != value.angle { changed = .now }
        sample = value
    }

    var isSettled: Bool { sample != nil && ContinuousClock.now - changed >= .milliseconds(200) }
}
