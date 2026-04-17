import UIKit

enum ADEHaptics {
  static func success() {
    UINotificationFeedbackGenerator().notificationOccurred(.success)
  }

  static func warning() {
    UINotificationFeedbackGenerator().notificationOccurred(.warning)
  }

  static func error() {
    UINotificationFeedbackGenerator().notificationOccurred(.error)
  }

  static func light() {
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
  }

  static func medium() {
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
  }

  static func heavy() {
    UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
  }
}
