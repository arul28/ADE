import Foundation
import CoreGraphics

/// Reads the simulator inventory out of CoreSimulator directly.
///
/// This is the same `SimServiceContext` path the vendored `FrameCapture` uses to
/// find a device, extended to enumerate them and to read the screen geometry off
/// the device type. Going through the framework rather than shelling out to
/// `xcrun simctl list --json` matters for two reasons: it is roughly two orders
/// of magnitude faster (no process spawn, no JSON), and `simctl` does not report
/// `mainScreenSize`/`mainScreenScale` at all, which is exactly what the point
/// conversion needs.
public enum SimDeviceLookup {
    public struct Device: Equatable, Sendable {
        public let udid: String
        public let name: String
        public let state: String
        public let deviceType: String?
        public let runtime: String?
        public let metrics: DeviceMetrics?

        public var payload: [String: Any] {
            var object: [String: Any] = ["udid": udid, "name": name, "state": state]
            if let deviceType { object["deviceType"] = deviceType }
            if let runtime { object["runtime"] = runtime }
            if let metrics {
                object["pointWidth"] = metrics.pointWidth
                object["pointHeight"] = metrics.pointHeight
                object["scale"] = metrics.scale
            }
            return object
        }
    }

    /// Every device in the default device set, booted or not.
    public static func list() -> [Device] {
        SimFrameworks.load()
        guard let devices = allSimDevices() else { return [] }
        return devices.compactMap(describe)
    }

    /// Screen geometry for one device, or nil if CoreSimulator will not say.
    public static func metrics(udid: String) -> DeviceMetrics? {
        SimFrameworks.load()
        guard let device = FrameCapture.findSimDevice(udid: udid) else { return nil }
        return metrics(forDevice: device)
    }

    // MARK: - private

    private static func allSimDevices() -> [NSObject]? {
        guard let contextClass = NSClassFromString("SimServiceContext") as? NSObject.Type else { return nil }
        let sharedSel = NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")
        guard let context = contextClass.perform(sharedSel, with: Xcode.developerDir(), with: nil)?
            .takeUnretainedValue() as? NSObject else { return nil }
        let deviceSetSel = NSSelectorFromString("defaultDeviceSetWithError:")
        guard let deviceSet = context.perform(deviceSetSel, with: nil)?
            .takeUnretainedValue() as? NSObject else { return nil }
        return deviceSet.value(forKey: "devices") as? [NSObject]
    }

    private static func describe(_ device: NSObject) -> Device? {
        guard let udid = (device.value(forKey: "UDID") as? NSUUID)?.uuidString else { return nil }
        let deviceType = device.value(forKey: "deviceType") as? NSObject
        return Device(
            udid: udid,
            name: (device.value(forKey: "name") as? String) ?? "Simulator",
            state: (device.value(forKey: "stateString") as? String) ?? "Unknown",
            deviceType: deviceType?.value(forKey: "identifier") as? String,
            runtime: (device.value(forKey: "runtime") as? NSObject)?.value(forKey: "identifier") as? String,
            metrics: metrics(forDevice: device)
        )
    }

    private static func metrics(forDevice device: NSObject) -> DeviceMetrics? {
        guard let deviceType = device.value(forKey: "deviceType") as? NSObject else { return nil }
        // `mainScreenSize` is an NSSize in PIXELS, despite the name — an
        // iPhone 17 Pro reports 1206x2622, which is its 402x874 point screen at
        // 3x, and is exactly the framebuffer size the capture layer produces.
        // Dividing by `mainScreenScale` is therefore required to get points;
        // taking the value at face value silently makes every touch coordinate
        // three times too large.
        guard
            let sizeValue = deviceType.value(forKey: "mainScreenSize") as? NSValue,
            let scaleNumber = deviceType.value(forKey: "mainScreenScale") as? NSNumber
        else { return nil }
        let size = sizeValue.sizeValue
        let scale = scaleNumber.doubleValue
        guard size.width > 0, size.height > 0, scale > 0 else { return nil }
        return DeviceMetrics(
            pointWidth: Double(size.width) / scale,
            pointHeight: Double(size.height) / scale,
            scale: scale
        )
    }
}
