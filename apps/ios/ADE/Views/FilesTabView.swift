import SwiftUI

struct FilesTabView: View {
  var isActive = true

  var body: some View {
    FilesRootScreen(isTabActive: isActive)
  }
}
// EXPERIMENT (remove before review): a change for the incremental build test.
