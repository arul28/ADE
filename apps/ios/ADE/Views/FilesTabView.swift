import SwiftUI

struct FilesTabView: View {
  var isActive = true

  var body: some View {
    FilesRootScreen(isTabActive: isActive)
  }
}
