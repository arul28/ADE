import Foundation

struct SSHHostKeyPinStore {
  private let defaults: UserDefaults
  private let key = "ade.ssh.hostKeyPins.v1"

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
  }

  func fingerprint(host: String, port: Int) -> String? {
    pins()[storageKey(host: host, port: port)]
  }

  func save(_ fingerprint: String, host: String, port: Int) {
    var updated = pins()
    updated[storageKey(host: host, port: port)] = fingerprint
    defaults.set(updated, forKey: key)
  }

  func clear(host: String, port: Int) {
    var updated = pins()
    updated.removeValue(forKey: storageKey(host: host, port: port))
    defaults.set(updated, forKey: key)
  }

  private func pins() -> [String: String] {
    defaults.dictionary(forKey: key) as? [String: String] ?? [:]
  }

  private func storageKey(host: String, port: Int) -> String {
    "\(host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()):\(port)"
  }
}
