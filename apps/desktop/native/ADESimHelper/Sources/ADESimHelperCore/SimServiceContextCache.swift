import Foundation

/// The CoreSimulator connection every device lookup in the helper goes through.
///
/// `sharedServiceContextForDeveloperDir:` hands out one context per process.
/// When CoreSimulatorService restarts (an Xcode update, an idle exit, a crash)
/// that context goes on answering from the device list it last had: a device
/// made since is missing, and one booted since still reads Shutdown. The helper
/// lives as long as the ADE brain, so it outlives such a restart easily, and
/// then capture refuses the device ("Device not booted"), touch finds no port,
/// and a Duo's hinge never resets for the new boot.
///
/// So a lookup that misses the device, or finds it not booted, asks a new
/// context once. If the new one knows the device it becomes the context from
/// then on. A device that really is off costs one extra context (about 50 ms)
/// at most once a second. A listing cannot tell a stale set from a current
/// one, so it always asks a new context (inside the same once-a-second
/// limit) and keeps it.
enum SimServiceContextCache {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var adopted: NSObject?
    nonisolated(unsafe) private static var lastRefresh: Date?
    private static let refreshInterval: TimeInterval = 1

    /// Every device in the default set, from a new context when the last one
    /// is more than a second old.
    static func devices() -> [NSObject]? {
        let developerDir = Xcode.developerDir()
        if let fresh = refreshedContext(developerDir: developerDir), let listed = devices(in: fresh) {
            adopt(fresh)
            return listed
        }
        guard let context = current(developerDir: developerDir) else { return nil }
        return devices(in: context)
    }

    /// The device with this UDID, from a new context when the current one
    /// does not see it booted.
    static func device(udid: String) -> NSObject? {
        // `xcode-select -p` runs a process: once per lookup, not per step.
        let developerDir = Xcode.developerDir()
        let known = current(developerDir: developerDir).flatMap { find(udid, in: $0) }
        if let known, state(of: known) == "Booted" { return known }
        guard let fresh = refreshedContext(developerDir: developerDir), let found = find(udid, in: fresh) else { return known }
        adopt(fresh)
        return found
    }

    // MARK: - private

    private static func adopt(_ context: NSObject) {
        lock.lock()
        adopted = context
        lock.unlock()
    }

    private static func current(developerDir: String) -> NSObject? {
        lock.lock()
        let context = adopted
        lock.unlock()
        return context ?? shared(developerDir: developerDir)
    }

    private static func shared(developerDir: String) -> NSObject? {
        guard let contextClass = NSClassFromString("SimServiceContext") as? NSObject.Type else { return nil }
        let selector = NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")
        return contextClass.perform(selector, with: developerDir, with: nil)?
            .takeUnretainedValue() as? NSObject
    }

    /// A new connection to CoreSimulatorService, or nil inside the throttle.
    private static func refreshedContext(developerDir: String) -> NSObject? {
        lock.lock()
        if let lastRefresh, Date().timeIntervalSince(lastRefresh) < refreshInterval {
            lock.unlock()
            return nil
        }
        lastRefresh = Date()
        lock.unlock()

        guard let contextClass = NSClassFromString("SimServiceContext") as? NSObject.Type else { return nil }
        let selector = NSSelectorFromString("serviceContextForDeveloperDir:connectionType:error:")
        guard let method = class_getClassMethod(contextClass, selector) else { return nil }
        typealias Make = @convention(c) (AnyObject, Selector, NSString, Int, UnsafeMutablePointer<NSError?>?) -> Unmanaged<NSObject>?
        let make = unsafeBitCast(method_getImplementation(method), to: Make.self)
        // The shared context's connection type, so the new one talks to the
        // same service the same way.
        let connectionType = (shared(developerDir: developerDir)?.value(forKey: "connectionType") as? NSNumber)?.intValue ?? 0
        return make(contextClass, selector, developerDir as NSString, connectionType, nil)?
            .takeUnretainedValue()
    }

    private static func devices(in context: NSObject) -> [NSObject]? {
        guard let deviceSet = context.perform(NSSelectorFromString("defaultDeviceSetWithError:"), with: nil)?
            .takeUnretainedValue() as? NSObject else { return nil }
        return deviceSet.value(forKey: "devices") as? [NSObject]
    }

    private static func find(_ udid: String, in context: NSObject) -> NSObject? {
        devices(in: context)?.first { ($0.value(forKey: "UDID") as? NSUUID)?.uuidString == udid }
    }

    private static func state(of device: NSObject) -> String? {
        device.value(forKey: "stateString") as? String
    }
}
