/// Calling Objective-C methods this binary is not allowed to link against.
///
/// The virtual-display classes are private CoreGraphics SPI. Linking them would
/// make ADE fail to launch the day Apple removes them; naming them through the
/// runtime makes that day a `reason` string instead. So every call in
/// `VirtualDisplayHost` goes through here.
///
/// `perform(_:with:)` covers object arguments, but not `initWithWidth:height:
/// refreshRate:` (two `uint32_t` and a `double`), not `applySettings:` (returns
/// `BOOL`), and not `displayID` (returns `uint32_t`). Those need a typed
/// `objc_msgSend`, which Swift does not export — hence the `dlsym`. There is no
/// safer route: `NSInvocation` is unavailable in Swift, and a C shim target
/// would be the same unsafety with a build-system cost on top.
///
/// Every helper is failable. A selector that is not there returns nil and the
/// caller reports the display unavailable; nothing here is allowed to trap.

import Foundation
import ObjectiveC

enum ObjCDynamic {
    /// `objc_msgSend`, resolved once. Swift marks the symbol unavailable, so it
    /// is fetched from the process's own image list instead.
    private static let msgSendPointer: UnsafeMutableRawPointer? = {
        let rtldDefault = UnsafeMutableRawPointer(bitPattern: -2)
        return dlsym(rtldDefault, "objc_msgSend")
    }()

    static var isAvailable: Bool { msgSendPointer != nil }

    static func objectClass(_ name: String) -> AnyClass? {
        NSClassFromString(name)
    }

    /// `[[Cls alloc] init]` for a class with a plain designated initialiser.
    static func makeInstance(_ className: String) -> NSObject? {
        guard let cls = NSClassFromString(className) as? NSObject.Type else { return nil }
        return cls.init()
    }

    /// `[[Cls alloc] initWithDescriptor:descriptor]`.
    ///
    /// The `alloc` result is taken *retained* — `alloc` follows the create rule,
    /// so consuming that +1 is what makes ARC's later release balance. Getting
    /// this wrong is not a leak you can ignore: `CGVirtualDisplay` tears its
    /// display down in `dealloc`, so an over-retained object leaves a real
    /// display on the user's Mac forever.
    static func makeInstance(_ className: String, initSelector: String, argument: AnyObject) -> NSObject? {
        guard let cls = NSClassFromString(className) else { return nil }
        let selector = NSSelectorFromString(initSelector)
        guard cls.instancesRespond(to: selector) else { return nil }
        guard let allocated = (cls as AnyObject).perform(NSSelectorFromString("alloc"))?
            .takeRetainedValue() as? NSObject
        else { return nil }
        guard let initialised = allocated.perform(selector, with: argument)?
            .takeUnretainedValue() as? NSObject
        else { return nil }
        return initialised
    }

    /// `[[Cls alloc] initWithWidth:height:refreshRate:]`.
    static func makeMode(
        _ className: String,
        width: UInt32,
        height: UInt32,
        refreshRate: Double
    ) -> NSObject? {
        guard let msgSendPointer else { return nil }
        guard let cls = NSClassFromString(className) else { return nil }
        let selector = NSSelectorFromString("initWithWidth:height:refreshRate:")
        guard cls.instancesRespond(to: selector) else { return nil }
        guard let allocated = (cls as AnyObject).perform(NSSelectorFromString("alloc"))?
            .takeRetainedValue() as? NSObject
        else { return nil }
        typealias InitMode = @convention(c) (AnyObject, Selector, UInt32, UInt32, Double) -> Unmanaged<AnyObject>?
        let send = unsafeBitCast(msgSendPointer, to: InitMode.self)
        guard let returned = send(allocated, selector, width, height, refreshRate) else { return nil }
        return returned.takeUnretainedValue() as? NSObject
    }

    /// A `BOOL`-returning one-object-argument message.
    static func sendBool(_ target: NSObject, selector selectorName: String, argument: AnyObject) -> Bool? {
        guard let msgSendPointer else { return nil }
        let selector = NSSelectorFromString(selectorName)
        guard target.responds(to: selector) else { return nil }
        typealias SendBool = @convention(c) (AnyObject, Selector, AnyObject) -> ObjCBool
        let send = unsafeBitCast(msgSendPointer, to: SendBool.self)
        return send(target, selector, argument).boolValue
    }

    /// A `uint32_t`-returning zero-argument message, e.g. `displayID`.
    static func sendUInt32(_ target: NSObject, selector selectorName: String) -> UInt32? {
        guard let msgSendPointer else { return nil }
        let selector = NSSelectorFromString(selectorName)
        guard target.responds(to: selector) else { return nil }
        typealias SendUInt32 = @convention(c) (AnyObject, Selector) -> UInt32
        let send = unsafeBitCast(msgSendPointer, to: SendUInt32.self)
        return send(target, selector)
    }

    /// KVC, but only when the setter actually exists.
    ///
    /// A bare `setValue(_:forKey:)` against a missing key raises
    /// `NSUnknownKeyException`, and an Objective-C exception crossing Swift is a
    /// crash, not a catch. Probing the setter first is what turns "this macOS
    /// dropped the property" into a reported reason.
    @discardableResult
    static func setProperty(_ target: NSObject, _ key: String, _ value: Any?) -> Bool {
        guard !key.isEmpty else { return false }
        let setterName = "set\(key.prefix(1).uppercased())\(key.dropFirst()):"
        guard target.responds(to: NSSelectorFromString(setterName)) else { return false }
        target.setValue(value, forKey: key)
        return true
    }

    static func hasClass(_ name: String) -> Bool {
        NSClassFromString(name) != nil
    }
}
