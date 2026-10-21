/// Orders physical pose changes independently of the private HID transport.
public enum HingePoseControl {
    public static func apply(
        _ pose: String,
        tableModeAvailable: () async -> Bool,
        setAngle: (Double) async -> Bool,
        setTableMode: (Bool) async -> Bool,
        setOrientation: (String) async -> Bool,
        waitForLandscapeCover: () async -> Bool
    ) async -> Bool {
        let angle: Double
        let orientation: String
        let tableMode: Bool
        // Device Hub's physical orientations, before any panel-native rotation.
        switch pose {
        case "closed": (angle, orientation, tableMode) = (0, "portrait", false)
        case "open": (angle, orientation, tableMode) = (180, "portrait", false)
        case "laptop": (angle, orientation, tableMode) = (90, "landscape-left", false)
        case "book": (angle, orientation, tableMode) = (90, "portrait", false)
        case "tent": (angle, orientation, tableMode) = (80, "facedown", true)
        default: return false
        }
        // An unsupported Tent must not partially move the device.
        if tableMode, !(await tableModeAvailable()) { return false }
        if !tableMode, !(await setTableMode(false)) { return false }
        guard await setAngle(angle) else { return false }
        if tableMode {
            // Face down preserves the last interface orientation. Activate the
            // cover while holding landscape before replacing gravity.
            guard await setOrientation("landscape-left"),
                  await setTableMode(true),
                  await waitForLandscapeCover() else { return false }
        }
        return await setOrientation(orientation)
    }
}
