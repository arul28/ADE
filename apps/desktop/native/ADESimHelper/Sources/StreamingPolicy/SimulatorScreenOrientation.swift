/// CoreSimulator's SimScreenUIOrientation values, shared by the framebuffer and
/// its properties-change callbacks. Zero means ambiguous, not portrait.
public enum SimulatorScreenOrientation {
    /// Device Hub's orientation-picker-control uses device orientation names,
    /// whereas screen orientation names describe the rotated framebuffer. A
    /// panel's mounting rotation converts that request into the physical pose.
    public static func vendorControlValue(forDeviceOrientation value: UInt32, nativeRotation: Int = 0) -> String? {
        let requestedRotation: Int
        switch value {
        case 1: requestedRotation = 0
        case 2: requestedRotation = 180
        case 3: requestedRotation = 270
        case 4: requestedRotation = 90
        default: return nil
        }
        switch (requestedRotation + nativeRotation % 360 + 360) % 360 {
        case 0: return "portrait"
        case 90: return "landscape-right"
        case 180: return "pud"
        case 270: return "landscape-left"
        default: return nil
        }
    }

    public static func name(for value: UInt32) -> String? {
        switch value {
        case 1: return "portrait"
        case 2: return "portrait_upside_down"
        case 3: return "landscape_left"
        case 4: return "landscape_right"
        default: return nil
        }
    }

    /// CoreDevice reports framebuffer rotation independently of the legacy
    /// SimScreen properties, which can remain stale after a hinge transition.
    public static func name(forRotation rotation: String) -> String? {
        switch rotation {
        case "rot0": return "portrait"
        case "rot90": return "landscape_left"
        case "rot180": return "portrait_upside_down"
        case "rot270": return "landscape_right"
        default: return nil
        }
    }
}
