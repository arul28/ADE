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

/// Supplies the app-level models the real root injects, so a fixture can
/// mount any screen that reads them (the Work header's Activity bell, …).
struct DuoPreviewHost: View {
  let name: String
  @StateObject private var activityDrawer = ActivityDrawerModel()

  var body: some View {
    DuoPreviewRouter.view(named: name)
      .environmentObject(activityDrawer)
  }
}
#endif
