import UIKit

enum ADEHaptics {
  private static var isAvailable: Bool {
    #if targetEnvironment(simulator)
    return false
    #else
    return true
    #endif
  }

  static func success() {
    guard isAvailable else { return }
    UINotificationFeedbackGenerator().notificationOccurred(.success)
  }

  static func warning() {
    guard isAvailable else { return }
    UINotificationFeedbackGenerator().notificationOccurred(.warning)
  }

  static func error() {
    guard isAvailable else { return }
    UINotificationFeedbackGenerator().notificationOccurred(.error)
  }

  static func light() {
    guard isAvailable else { return }
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
  }

  static func medium() {
    guard isAvailable else { return }
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
  }

  static func heavy() {
    guard isAvailable else { return }
    UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
  }
}
