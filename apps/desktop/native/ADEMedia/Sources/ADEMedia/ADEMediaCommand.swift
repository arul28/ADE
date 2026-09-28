import ADEMediaCore
import Foundation

/// `ade-media`: ADE's demo-video engine on macOS.
///
///     ade-media analyze <input.mp4|.mov|.m4v>   → one DemoAnalysis JSON on stdout
///     ade-media render <request.json>           → one DemoRenderResult JSON on stdout
///
/// Both exit 0 on success. `render` reports `progress 0.42` lines on stderr, at
/// most about ten a second. On failure the exit code is 1 and the last stderr
/// line is `error: <message>`, which the desktop client shows as the error.
@main
enum ADEMediaCommand {
    static func main() async {
        setvbuf(stdout, nil, _IOFBF, 1 << 16)
        installStopHandlers()
        let arguments = Array(CommandLine.arguments.dropFirst())
        do {
            switch (arguments.first, arguments.count) {
            case ("analyze", 2):
                let analysis = try await Analyzer.analyze(path: arguments[1])
                try printJSON(analysis)
            case ("render", 2):
                let request = try readRequest(path: arguments[1])
                let reporter = ProgressReporter()
                let result = try await Renderer(request: request, progress: reporter.report).run()
                try printJSON(result)
            default:
                throw MediaError("Usage: ade-media analyze <input> | ade-media render <request.json>")
            }
            exit(0)
        } catch {
            let message = (error as? MediaError)?.message
                ?? (error as? DemoPlanError)?.message
                ?? String(describing: error)
            FileHandle.standardError.write(Data("error: \(message.replacingOccurrences(of: "\n", with: " "))\n".utf8))
            exit(1)
        }
    }

    static func readRequest(path: String) throws -> DemoRenderRequest {
        let data: Data
        do {
            data = try Data(contentsOf: URL(fileURLWithPath: path))
        } catch {
            throw MediaError("Could not read the render request \(path): \(error.localizedDescription)")
        }
        do {
            let request = try JSONDecoder().decode(DemoRenderRequest.self, from: data)
            guard request.plan.version == 1 else {
                throw MediaError("The plan is version \(request.plan.version); this ade-media reads version 1.")
            }
            guard !request.output.isEmpty, !request.input.isEmpty else {
                throw MediaError("The render request needs an input and an output path.")
            }
            return request
        } catch let error as MediaError {
            throw error
        } catch let DecodingError.keyNotFound(key, context) {
            throw MediaError("The render request is missing \(fieldPath(context.codingPath + [key])).")
        } catch let DecodingError.typeMismatch(_, context), let DecodingError.valueNotFound(_, context) {
            throw MediaError("The render request has a wrong value at \(fieldPath(context.codingPath)).")
        } catch {
            throw MediaError("The render request is not valid JSON: \(error.localizedDescription)")
        }
    }

    private static func fieldPath(_ keys: [CodingKey]) -> String {
        keys.map { $0.intValue.map { "[\($0)]" } ?? ".\($0.stringValue)" }.joined().trimmingCharacters(in: CharacterSet(charactersIn: "."))
    }

    static func printJSON<T: Encodable>(_ value: T) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(value)
        FileHandle.standardOutput.write(data + Data("\n".utf8))
    }

    /// SIGTERM, SIGINT and SIGHUP delete the partial output before exiting, so
    /// a cancelled render leaves nothing beside its target.
    private static var stopSources: [DispatchSourceSignal] = []

    static func installStopHandlers() {
        for signalNumber in [SIGTERM, SIGINT, SIGHUP] {
            signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .global())
            source.setEventHandler {
                PartialOutput.removeIfAny()
                FileHandle.standardError.write(Data("error: Stopped by signal \(signalNumber).\n".utf8))
                _exit(1)
            }
            source.resume()
            stopSources.append(source)
        }
    }
}

/// Throttles `progress` lines to about ten a second.
final class ProgressReporter: @unchecked Sendable {
    private let lock = NSLock()
    private var lastWrite: TimeInterval = 0
    private var lastValue = -1.0

    func report(_ fraction: Double) {
        let value = min(max(fraction, 0), 1)
        let now = ProcessInfo.processInfo.systemUptime
        lock.lock()
        defer { lock.unlock() }
        guard value >= 1 ? lastValue < 1 : now - lastWrite >= 0.1 && value > lastValue else { return }
        lastWrite = now
        lastValue = value
        FileHandle.standardError.write(Data(String(format: "progress %.3f\n", value).utf8))
    }
}
