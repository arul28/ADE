import Combine
import SwiftUI
import UIKit

/// `SyncService`'s publishes, held back while a native menu is open.
///
/// SwiftUI rebuilds an open `Menu` (a toolbar's, a header's, a picker's)
/// whenever a view above it re-renders, even when nothing the menu shows
/// changed: the menu flickers, and a scrolled one jumps back to its top. A live
/// machine publishes several times a second, so a long menu (a chat's ⋯, the
/// lane picker) could not be scrolled at all. The screens that hold menus
/// observe this instead of `SyncService`. It forwards every publish, except
/// that while a menu is up it holds them and sends one when the menu closes.
/// Only those screens wait: rows and panes under them that observe
/// `SyncService` themselves stay live.
///
/// It always reads `SyncService.shared` (the app's one instance); an
/// `.environmentObject(syncService)` injection does not reach a view that
/// observes this, so a fixture with its own service must be the last created.
@MainActor
final class SyncMenuSafePublisher: ObservableObject {
  static let shared = SyncMenuSafePublisher()

  private weak var attachedService: SyncService?
  private var subscription: AnyCancellable?
  private var heldPublish: Task<Void, Never>?
  private static let maxHold: Duration = .seconds(10)

  /// The app's sync service (`SyncService.shared`), observed through this
  /// publisher.
  var service: SyncService {
    guard let current = SyncService.shared else {
      preconditionFailure("SyncMenuSafePublisher read before SyncService was created")
    }
    if attachedService !== current { attach(current) }
    return current
  }

  private func attach(_ service: SyncService) {
    attachedService = service
    subscription = service.objectWillChange.sink { [weak self] _ in
      MainActor.assumeIsolated { self?.forward() }
    }
  }

  private func forward() {
    guard heldPublish == nil else { return }
    guard Self.menuIsPresented() else {
      objectWillChange.send()
      return
    }
    // One publish stands for every change made while the menu was up. Held
    // `maxHold` at most, so a menu container that lingers can never freeze
    // the screens: they then update at that pace instead.
    heldPublish = Task { @MainActor [weak self] in
      let started = ContinuousClock.now
      while Self.menuIsPresented(), ContinuousClock.now - started < Self.maxHold {
        try? await Task.sleep(for: .milliseconds(150))
      }
      guard let self else { return }
      self.heldPublish = nil
      self.objectWillChange.send()
    }
  }

  /// A native menu (a `Menu`, a context menu) is up in one of the app's
  /// windows: UIKit adds its container straight to the window while it shows.
  static func menuIsPresented() -> Bool {
    for scene in UIApplication.shared.connectedScenes {
      guard let windowScene = scene as? UIWindowScene,
            windowScene.activationState != .background
      else { continue }
      for window in windowScene.windows where !window.isHidden {
        for view in window.subviews where NSStringFromClass(type(of: view)).contains("ContextMenuContainer") {
          return true
        }
      }
    }
    return false
  }
}

extension SyncService {
  /// Bindings to the service's settable state (`$syncService.x` for a view
  /// that observes it through `SyncMenuSafePublisher`).
  var bindings: ObservedObject<SyncService>.Wrapper {
    ObservedObject(wrappedValue: self).projectedValue
  }
}
