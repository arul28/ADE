import AppKit
import Foundation
import ADEAttentionNotchCore

final class StandardIOTransport {
    private let decoder = JSONDecoder()
    private let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()
    private let outputLock = NSLock()

    @MainActor
    func start(deliver: @escaping @MainActor (NotchInput) -> Void) {
        Task.detached(priority: .utility) { [decoder] in
            while let line = readLine(strippingNewline: true) {
                guard !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                do {
                    let input = try NotchInputDecoder.decode(line: line, decoder: decoder)
                    await MainActor.run { deliver(input) }
                } catch {
                    await MainActor.run {
                        self.send(NotchOutput(type: "protocol_error", message: String(describing: error)))
                    }
                }
            }
            await MainActor.run {
                NSApplication.shared.terminate(nil)
            }
        }
    }

    func send(_ output: NotchOutput) {
        do {
            var data = try encoder.encode(output)
            data.append(0x0A)
            outputLock.lock()
            defer { outputLock.unlock() }
            FileHandle.standardOutput.write(data)
        } catch {
            let message = "ADE Attention Notch could not encode output: \(error)\n"
            FileHandle.standardError.write(Data(message.utf8))
        }
    }
}
