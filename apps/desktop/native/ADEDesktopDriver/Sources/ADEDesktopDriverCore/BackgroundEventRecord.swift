/// The window-server event records a background click sends ahead of itself.
///
/// A click posted straight to a process skips the window server, so nothing
/// makes the target window key and the app treats the click as the one that
/// only activates it, and drops it. Two records, sent to the target process
/// alone, stand in for what the window server would have done:
///
/// - `focus`: "this window of yours is now focused" (kind `0x0D`, flag
///   `0x8A = 1`). No matching defocus goes to the user's frontmost app, so the
///   user keeps their app; only the target's idea of its own focus changes.
/// - `makeKey`: a down/up pair (kinds `0x01`/`0x02`) aimed at an invalid
///   location. The app takes it as its activating click, so the real click
///   that follows is delivered instead of being swallowed. No view can be hit
///   at that location.
///
/// The layout is undocumented. It follows yabai's `window_manager_make_key_window`
/// and the target-only focus record of background-computer-use, and was checked
/// live on macOS 27. A macOS release that changes it makes the first click land
/// as an activation again; it cannot move the user's pointer either way.
public enum BackgroundEventRecord {
    public static let length = 0xF8

    public static func focus(windowId: UInt32) -> [UInt8] {
        var record = [UInt8](repeating: 0, count: length)
        record[0x04] = 0xF8
        record[0x08] = 0x0D
        write(windowId, into: &record)
        record[0x8A] = 0x01
        return record
    }

    /// `down` is the first record of the pair, `false` the second.
    public static func makeKey(windowId: UInt32, down: Bool) -> [UInt8] {
        var record = [UInt8](repeating: 0, count: length)
        record[0x04] = 0xF8
        record[0x08] = down ? 0x01 : 0x02
        record[0x3A] = 0x10
        write(windowId, into: &record)
        for offset in 0x20..<0x30 { record[offset] = 0xFF }
        return record
    }

    private static func write(_ windowId: UInt32, into record: inout [UInt8]) {
        withUnsafeBytes(of: windowId.littleEndian) { bytes in
            for (offset, byte) in bytes.enumerated() { record[0x3C + offset] = byte }
        }
    }
}
