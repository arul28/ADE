import Foundation

struct DeviceStateSnapshot: Codable, Equatable, Sendable {
    let generation: UInt64
    let revision: UInt64
    let state: CoreDeviceBridge.HingeState
}

struct DeviceMotionSample: Decodable, Sendable {
    struct Property: Decodable, Sendable {
        let int: Int?
        private enum CodingKeys: String, CodingKey { case int }
        init(from decoder: Decoder) throws {
            let container = try? decoder.container(keyedBy: CodingKeys.self)
            int = try? container?.decode(Int.self, forKey: .int)
        }
    }
    let properties: [String: Property]
    let timestamp: Double
}

enum DeviceStateUpdate: Sendable {
    case angle(HingeAngleSample)
    case motion(DeviceMotionSample)
    case orientation(PhysicalOrientationSample)
}

struct PhysicalOrientationSample: Sendable {
    let orientation: String?
    let timestamp: Double
    let readCompletedAt: Double?

    init(orientation: String?, timestamp: Double, readCompletedAt: Double? = nil) {
        self.orientation = orientation
        self.timestamp = timestamp
        self.readCompletedAt = readCompletedAt
    }
}

enum ObservedPhysicalOrientation {
    static let names = ["portrait", "pud", "landscape-left", "landscape-right", "faceup", "facedown"]
    private static let nativeNames = ["portrait", "portraitUpsideDown", "landscapeLeft", "landscapeRight", "faceUp", "faceDown"]

    static func name(_ value: Int?) -> String? {
        guard let value, (1...names.count).contains(value) else { return nil }
        return names[value - 1]
    }

    static func name(_ value: String) -> String? {
        nativeNames.firstIndex(of: value).map { names[$0] }
    }
}

struct ObservedDeviceState {
    let generation: UInt64
    private(set) var revision: UInt64 = 0
    private(set) var state = CoreDeviceBridge.HingeState()
    private(set) var angleTimestamp: Double?
    private var motionTimestamp: Double?
    private(set) var orientationTimestamp: Double?

    init(generation: UInt64) { self.generation = generation }

    var snapshot: DeviceStateSnapshot { .init(generation: generation, revision: revision, state: state) }

    @discardableResult
    mutating func apply(_ update: DeviceStateUpdate, since startedAt: Double) -> Bool {
        let previous = state
        switch update {
        case .angle(let sample):
            guard fresh(sample.timestamp, since: startedAt, after: angleTimestamp) else { return false }
            angleTimestamp = sample.timestamp
            state.angle = sample.isValid ? sample.angle : nil
        case .motion(let sample):
            guard fresh(sample.timestamp, since: startedAt, after: motionTimestamp) else { return false }
            motionTimestamp = sample.timestamp
            if sample.timestamp > (orientationTimestamp ?? -.infinity) {
                orientationTimestamp = sample.timestamp
                state.orientation = ObservedPhysicalOrientation.name(sample.properties["propertyA"]?.int)
            }
            // @ref LLP 0004#confirmed-hinge-state — native tabletop activity, not the requested sensor setting
            if let pose = sample.properties["propertyC"]?.int, (0...10).contains(pose) {
                state.tableMode = pose != 0
            } else { state.tableMode = nil }
        case .orientation(let sample):
            guard fresh(sample.timestamp, since: startedAt, after: orientationTimestamp) else { return false }
            orientationTimestamp = sample.timestamp
            state.orientation = sample.orientation
        }
        if state != previous { revision &+= 1 }
        return true
    }

    private func fresh(_ timestamp: Double, since startedAt: Double, after previous: Double?) -> Bool {
        timestamp.isFinite && timestamp >= startedAt && timestamp > (previous ?? -.infinity)
    }

    @discardableResult
    mutating func clear() -> Bool {
        guard state != CoreDeviceBridge.HingeState() else { return false }
        state = CoreDeviceBridge.HingeState()
        revision &+= 1
        return true
    }
}

// @ref LLP 0004#live-pose-observation — admission fences do not replace preview or recording observations
struct HingeControlEligibility {
    var angle: (value: Double, sentAt: Double)?
    var orientation: (value: String, sentAt: Double)?
    private var orientationUncertainUntil: Double?

    mutating func recordOrientationRead(_ sample: PhysicalOrientationSample, since startedAt: Double) {
        guard let orientation, let end = sample.readCompletedAt,
              sample.timestamp.isFinite, end.isFinite,
              sample.timestamp >= startedAt, end >= sample.timestamp,
              sample.timestamp <= orientation.sentAt, orientation.sentAt <= end else { return }
        orientationUncertainUntil = max(orientationUncertainUntil ?? -.infinity, end)
    }

    func state(observed: ObservedDeviceState) -> CoreDeviceBridge.HingeState {
        var state = observed.state
        if let angle, (observed.angleTimestamp ?? -.infinity) <= angle.sentAt { state.angle = angle.value }
        if let orientation {
            if let end = orientationUncertainUntil, orientation.sentAt <= end,
               (observed.orientationTimestamp ?? -.infinity) <= end {
                state.orientation = nil
            } else if (observed.orientationTimestamp ?? -.infinity) <= orientation.sentAt {
                state.orientation = orientation.value
            }
        }
        return state
    }
}
