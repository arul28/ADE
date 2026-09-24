import Foundation
import Network
import ADEDesktopDriverCore

/// A plain TCP fan-out on 127.0.0.1.
///
/// Loopback-only and unauthenticated by design: the security boundary is the
/// Node service's token-guarded HTTP endpoint in front of it, exactly as it is
/// for `iosVideoStreamServer.ts`. Binding anything but loopback here would move
/// that boundary onto the network, so the host is not configurable.
final class StreamByteServer {
    private var listener: NWListener?
    private var connections: [NWConnection] = []
    private let queue = DispatchQueue(label: "com.ade.desktop-driver.stream")
    private let lock = NSLock()
    private var configRecord: Data?

    /// Called on the server queue each time a reader attaches.
    ///
    /// The one thing a new reader needs and cannot be given from a cache is a
    /// keyframe that the deltas after it actually follow, so the engine
    /// re-encodes the last captured frame as an IDR rather than this class
    /// replaying a stale one out of order.
    var onClientAttached: (() -> Void)?

    private(set) var port: UInt16 = 0

    var clientCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return connections.count
    }

    func start() throws -> UInt16 {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: .any)
        let listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        // Pumped, not blocked. `start` is called from a `stream.start` request,
        // which is handled on the main thread like everything else here, so a
        // semaphore wait would hold the health ping and every other lane behind
        // a listener that is taking its time. The flag is set on the `NWListener`
        // queue and read on the main thread, hence the lock around it.
        let settled = SettledFlag()
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready, .failed, .cancelled:
                settled.set()
            default:
                break
            }
        }
        listener.start(queue: queue)
        RunLoopPump.wait(until: { settled.isSet }, timeout: 5)
        guard let assigned = listener.port?.rawValue, assigned != 0 else {
            listener.cancel()
            throw CaptureError.failed("The stream server never got a loopback port.")
        }
        self.listener = listener
        self.port = assigned
        return assigned
    }

    /// Records the codec string and hands it to everyone already reading.
    ///
    /// The codec is only known once the first keyframe has been encoded, so a
    /// reader that attached before that moment has had no config record at all
    /// and cannot configure a decoder. Broadcasting on the transition is what
    /// closes that window; it is one 23-byte record, once per stream.
    func setConfig(codec: String) {
        let record = StreamRecord.configRecord(codec: codec)
        lock.lock()
        let changed = configRecord != record
        configRecord = record
        let targets = changed ? connections : []
        lock.unlock()
        for connection in targets {
            connection.send(content: record, completion: .contentProcessed { _ in })
        }
    }

    private func accept(_ connection: NWConnection) {
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .cancelled, .failed:
                self?.drop(connection)
            default:
                break
            }
        }
        connection.start(queue: queue)
        lock.lock()
        connections.append(connection)
        let config = configRecord
        lock.unlock()
        // A reader that attaches mid-stream needs the codec string before it can
        // configure its decoder; the next keyframe carries the parameter sets.
        if let config {
            connection.send(content: config, completion: .contentProcessed { _ in })
        }
        onClientAttached?()
    }

    private func drop(_ connection: NWConnection) {
        lock.lock()
        connections.removeAll { $0 === connection }
        lock.unlock()
    }

    func broadcast(_ data: Data) {
        lock.lock()
        let targets = connections
        lock.unlock()
        for connection in targets {
            connection.send(content: data, completion: .contentProcessed { _ in })
        }
    }

    func stop() {
        lock.lock()
        let targets = connections
        connections.removeAll()
        lock.unlock()
        for connection in targets {
            connection.cancel()
        }
        listener?.cancel()
        listener = nil
        port = 0
    }
}
