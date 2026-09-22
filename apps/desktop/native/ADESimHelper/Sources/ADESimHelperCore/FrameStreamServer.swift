import Foundation
import Network

/// Serves one device's H.264 stream over loopback HTTP.
///
/// Frames deliberately do NOT go over stdout. stdout is a line-oriented control
/// channel shared by every device this process drives; pushing megabits of
/// binary through it would mean base64 (a third more bytes, plus an encode per
/// frame), head-of-line blocking between devices, and a parser that has to tell
/// a frame from a reply. A socket per device gives each stream its own
/// backpressure and lets the renderer's existing `fetch`-based reader attach
/// unchanged.
///
/// Security: bound to 127.0.0.1 on an ephemeral port, with a random bearer
/// token minted per capture session. Loopback alone is not enough — anything
/// running as any user on the Mac can reach a loopback port — and the token is
/// compared in constant time.
public final class FrameStreamServer {
    /// A reader this far behind is not catching up. Dropping an access unit
    /// would corrupt every later frame (they reference it), so the only honest
    /// recovery is to close the connection; ADE's reader reconnects into a
    /// fresh keyframe. Same rule, same 4 MiB ceiling ADE's own stream server
    /// used before this helper replaced it.
    private static let maxBacklogBytes = 4 * 1024 * 1024

    public let token: String
    public let path: String

    private let listener: NWListener
    private let queue = DispatchQueue(label: "com.ade.sim-helper.stream")
    private var clients: [ObjectIdentifier: Client] = [:]
    private var configRecord: Data?
    private var started = false

    /// Called when a reader attaches and there is no cached config yet, so the
    /// owner can force the encoder to produce a keyframe now instead of at the
    /// next natural IDR (up to five seconds away, longer on an idle screen).
    public var onReaderAttached: (() -> Void)?

    private final class Client {
        let connection: NWConnection
        var backlogBytes = 0
        var sentConfig = false
        /// A decoder cannot start on a P-frame, so a client stays held until
        /// the first keyframe it could actually begin decoding.
        var started = false

        init(connection: NWConnection) {
            self.connection = connection
        }
    }

    public init(path: String = "/ios-simulator-video") throws {
        self.path = path
        self.token = Self.randomToken()
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        // Frames are latency-sensitive and already coalesced into whole access
        // units; Nagle would hold a small P-frame back waiting for company.
        if let tcp = parameters.defaultProtocolStack.internetProtocol as? NWProtocolTCP.Options {
            tcp.noDelay = true
        }
        listener = try NWListener(using: parameters)
    }

    /// Bind, and resolve with the port actually assigned.
    public func start() throws -> UInt16 {
        let semaphore = DispatchSemaphore(value: 0)
        var failure: Error?
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready:
                semaphore.signal()
            case let .failed(error):
                failure = error
                semaphore.signal()
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.start(queue: queue)
        // A bind to loopback either works immediately or is broken; waiting
        // forever would hang the whole helper on one device's stream.
        if semaphore.wait(timeout: .now() + 5) == .timedOut {
            listener.cancel()
            throw StreamError.listenTimedOut
        }
        if let failure {
            listener.cancel()
            throw failure
        }
        guard let port = listener.port?.rawValue else {
            listener.cancel()
            throw StreamError.noPort
        }
        started = true
        return port
    }

    public func stop() {
        queue.sync {
            for client in clients.values {
                client.connection.cancel()
            }
            clients.removeAll()
            configRecord = nil
        }
        if started {
            listener.cancel()
            started = false
        }
    }

    public var url: String {
        let port = listener.port?.rawValue ?? 0
        return "http://127.0.0.1:\(port)\(path)"
    }

    /// Publish the stream configuration. Replaces any previous one and re-sends
    /// it to attached readers at their next keyframe, which is what a resolution
    /// change requires: a `VideoDecoder` keeps the configuration it was given.
    public func setConfiguration(codec: String, width: Int?, height: Int?) {
        let record = VideoRecord.encode(
            type: VideoRecord.typeConfig,
            payload: VideoRecord.config(codec: codec, width: width, height: height)
        )
        queue.async { [weak self] in
            guard let self else { return }
            guard self.configRecord != record else { return }
            self.configRecord = record
            for client in self.clients.values {
                client.sentConfig = false
                client.started = false
            }
        }
    }

    /// Broadcast one Annex-B access unit.
    public func broadcast(accessUnit: Data, keyframe: Bool) {
        let record = VideoRecord.encode(
            type: VideoRecord.typeAccessUnit,
            payload: accessUnit,
            keyframe: keyframe
        )
        queue.async { [weak self] in
            guard let self else { return }
            guard let configRecord = self.configRecord else { return }
            for (key, client) in self.clients {
                if !client.started {
                    guard keyframe else { continue }
                    if !client.sentConfig {
                        client.sentConfig = true
                        self.send(configRecord, to: client, key: key)
                    }
                    client.started = true
                }
                self.send(record, to: client, key: key)
            }
        }
    }

    public var readerCount: Int {
        queue.sync { clients.count }
    }

    // MARK: - private

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        // Only the request head is read. The helper answers exactly one route
        // and never reads a body, so there is no reason to keep parsing bytes
        // a caller sends afterwards.
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            guard let data, error == nil, !data.isEmpty else {
                connection.cancel()
                return
            }
            _ = isComplete
            self.handleRequest(String(decoding: data, as: UTF8.self), on: connection)
        }
    }

    private func handleRequest(_ head: String, on connection: NWConnection) {
        let lines = head.split(separator: "\r\n", omittingEmptySubsequences: false)
        guard let requestLine = lines.first else {
            respondAndClose(connection, status: "400 Bad Request")
            return
        }
        let parts = requestLine.split(separator: " ")
        // The renderer is another origin (the app's own scheme, or the Vite dev
        // server) and its `fetch` carries an `authorization` header, so the
        // browser sends a CORS preflight first. Without this answer every
        // in-app reader fails with "Failed to fetch" while curl works fine.
        // Allowing any origin is safe here: the bearer token, not the origin,
        // is what guards the stream, and the server binds loopback only.
        if parts.count >= 2, parts[0] == "OPTIONS" {
            respondAndClose(connection, status: "204 No Content", extraHeaders: Self.corsHeaders + [
                "Access-Control-Allow-Methods: GET, OPTIONS",
                "Access-Control-Allow-Headers: authorization",
                "Access-Control-Max-Age: 600",
            ])
            return
        }
        guard parts.count >= 2, parts[0] == "GET" else {
            respondAndClose(connection, status: "405 Method Not Allowed")
            return
        }
        // Strip a query string: ADE passes the token as a header, but a browser
        // tab opened by hand will carry one and it must not defeat the match.
        let requestPath = String(parts[1].split(separator: "?", maxSplits: 1)[0])
        guard requestPath == path else {
            respondAndClose(connection, status: "404 Not Found")
            return
        }
        guard authorized(lines: lines) else {
            respondAndClose(connection, status: "403 Forbidden")
            return
        }

        let response = ([
            "HTTP/1.1 200 OK",
            "Content-Type: application/octet-stream",
            "Cache-Control: no-store",
            // The renderer reads this with `fetch` and a stream reader, so the
            // body must never be buffered by an intermediary.
            "X-Content-Type-Options: nosniff",
        ] + Self.corsHeaders + [
            "Connection: close",
            "",
            "",
        ]).joined(separator: "\r\n")

        let client = Client(connection: connection)
        let key = ObjectIdentifier(connection)
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .cancelled, .failed:
                self?.clients.removeValue(forKey: key)
            default:
                break
            }
        }
        clients[key] = client
        connection.send(content: Data(response.utf8), completion: .idempotent)
        // Ask for a keyframe now rather than waiting for the encoder's own,
        // which on an idle screen can be a minute away.
        onReaderAttached?()
    }

    private func authorized(lines: [Substring]) -> Bool {
        let expected = "bearer \(token)"
        for line in lines.dropFirst() {
            if line.isEmpty { break }
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[line.startIndex..<colon].lowercased()
            guard name == "authorization" else { continue }
            let value = line[line.index(after: colon)...]
                .trimmingCharacters(in: .whitespaces)
                .lowercased()
            return Self.constantTimeEquals(value, expected)
        }
        return false
    }

    private func send(_ record: Data, to client: Client, key: ObjectIdentifier) {
        client.backlogBytes += record.count
        if client.backlogBytes > Self.maxBacklogBytes {
            clients.removeValue(forKey: key)
            client.connection.cancel()
            return
        }
        let size = record.count
        client.connection.send(content: record, completion: .contentProcessed { [weak client] _ in
            // Released in one place only: double-counting the release pushes the
            // drop threshold far past the ceiling this rule exists to enforce.
            guard let client else { return }
            client.backlogBytes = max(0, client.backlogBytes - size)
        })
    }

    /// Sent on every response so the renderer can read a 403/404 status
    /// instead of an opaque network failure.
    static let corsHeaders: [String] = ["Access-Control-Allow-Origin: *"]

    private func respondAndClose(_ connection: NWConnection, status: String, extraHeaders: [String] = corsHeaders) {
        let headers = (["HTTP/1.1 \(status)", "Content-Length: 0"] + extraHeaders + ["Connection: close"]).joined(separator: "\r\n")
        let response = headers + "\r\n\r\n"
        connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    static func randomToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        // A token from a non-cryptographic source is a token an attacker can
        // predict, and this one is the only thing standing between a local
        // process and the user's screen.
        if SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) != errSecSuccess {
            bytes = (0..<32).map { _ in UInt8.random(in: 0...255) }
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    /// Length-independent comparison. Hashing first keeps the loop's trip count
    /// from leaking how much of the token was right.
    static func constantTimeEquals(_ lhs: String, _ rhs: String) -> Bool {
        let left = [UInt8](Data(lhs.utf8).sha256())
        let right = [UInt8](Data(rhs.utf8).sha256())
        guard left.count == right.count else { return false }
        var difference: UInt8 = 0
        for index in 0..<left.count {
            difference |= left[index] ^ right[index]
        }
        return difference == 0
    }

    public enum StreamError: Error {
        case listenTimedOut
        case noPort
    }
}

import CommonCrypto

extension Data {
    func sha256() -> Data {
        var digest = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        withUnsafeBytes { buffer in
            _ = CC_SHA256(buffer.baseAddress, CC_LONG(buffer.count), &digest)
        }
        return Data(digest)
    }
}
