import SwiftUI

#if DEBUG
/// Fixture screens for the iPhone Duo layouts, selected like the other
/// fixture screens:
///
///     xcrun simctl launch <udid> com.ade.ios -adePreviewScreen duo-work
///
/// Each area owns its fixtures in its own file; this only routes by name.
enum DuoPreviewRouter {
  static var requestedName: String? {
    let arguments = ProcessInfo.processInfo.arguments
    guard let flagIndex = arguments.firstIndex(of: "-adePreviewScreen"),
          arguments.index(after: flagIndex) < arguments.endIndex else {
      return nil
    }
    let name = arguments[arguments.index(after: flagIndex)]
    return name.hasPrefix("duo-") ? name : nil
  }

  @MainActor
  static func view(named name: String) -> AnyView {
    let providers: [(String) -> AnyView?] = [
      DuoShellPreviews.view,
      DuoHomePreviews.view,
      DuoWorkPreviews.view,
      DuoSplitPreviews.view,
      DuoFoldPreviews.view,
      DuoWindowsPreviews.view,
      LiveInspectMarkupPreviews.view,
    ]
    for provider in providers {
      if let view = provider(name) { return view }
    }
    return AnyView(Text("No Duo fixture named \(name)").padding())
  }
}
#endif
