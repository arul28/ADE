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
      DuoEdgeBarExperiments.view,
      DuoShellPreviews.view,
      DuoHomePreviews.view,
      DuoWorkPreviews.view,
      // Ahead of the split fixtures: `duo-files` is the Files window now.
      DuoWindowsPreviews.view,
      DuoSplitPreviews.view,
      DuoFoldPreviews.view,
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

#if DEBUG
/// Layout experiments for the edge bar (coordinator only; delete before ship).
enum DuoEdgeBarExperiments {
  @MainActor @ToolbarContentBuilder
  static var railItems: some ToolbarContent {
    ToolbarItemGroup(placement: .topBarTrailing) {
      Button("Tools", systemImage: "square.split.2x1") {}
      Button("Info", systemImage: "info.circle") {}
      Button("Proof", systemImage: "photo.on.rectangle.angled") {}
    }
    ToolbarItemGroup(placement: .bottomBar) {
      Button("Work", systemImage: "terminal") {}
      Button("Lanes", systemImage: "square.stack.3d.up") {}
      Button("PRs", systemImage: "arrow.triangle.pull") {}
    }
  }

  @MainActor static func chat(_ label: String) -> some View {
    Color.yellow.opacity(0.15).overlay(Text(label).font(.title))
  }

  @MainActor static func pane(_ label: String) -> some View {
    Color.blue.opacity(0.15).overlay(Text(label).font(.title))
  }

  @MainActor
  static func view(_ name: String) -> AnyView? {
    switch name {
    case "duo-exp-a":
      // Sibling stacks, pane's vertical bar disabled.
      guard #available(iOS 27.1, *) else { return nil }
      return AnyView(HStack(spacing: 0) {
        NavigationStack { chat("chat A").navigationTitle("Chat").toolbar { railItems } }
        NavigationStack {
          pane("pane A").navigationTitle("Pane")
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Rotate", systemImage: "rotate.right") {} } }
        }
        .toolbarVerticalBehavior(.disabled)
      })
    case "duo-exp-b":
      // One outer stack; pane is a nested stack with its bar hidden.
      return AnyView(NavigationStack {
        HStack(spacing: 0) {
          chat("chat B")
          NavigationStack {
            pane("pane B")
              .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Rotate", systemImage: "rotate.right") {} } }
          }
          .toolbar(.hidden, for: .navigationBar)
        }
        .navigationTitle("Chat")
        .toolbar { railItems }
      })
    case "duo-exp-c":
      // One outer stack; pane is plain content with its own toolbar items.
      return AnyView(NavigationStack {
        HStack(spacing: 0) {
          chat("chat C")
          pane("pane C")
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Rotate", systemImage: "rotate.right") {} } }
        }
        .navigationTitle("Chat")
        .toolbar { railItems }
      })
    default:
      return nil
    }
  }
}
#endif
