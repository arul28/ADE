// Frame capture and still images.
//
// Two sources, one frame type:
//
// * the whole desktop of this session (Mode A, the private screen): GDI
//   `BitBlt` from the screen DC: about 25 ms for 1280x800 in a child
//   session, and the one source that keeps working when the session's host
//   window is hidden.
// * one window (Mode B, the shared desktop): `PrintWindow` with
//   `PW_RENDERFULLCONTENT`, which draws a window that sits off every monitor.
//   About 22-32 ms per frame.
//
// Frames are top-down BGRA.

#pragma once

#include "common.h"

#include <cstdint>
#include <string>
#include <vector>

namespace ade {

struct Frame {
  int width = 0;
  int height = 0;
  std::vector<uint8_t> bgra;  // width * height * 4, top-down
  bool empty() const { return width <= 0 || height <= 0 || bgra.empty(); }
  void resize(int w, int h) {
    width = w;
    height = h;
    bgra.assign(static_cast<size_t>(w) * h * 4, 0);
  }
};

// Captures a rectangle of this session's desktop. Returns an error text on
// failure (a locked console makes this fail with "The handle is invalid").
bool captureScreenRect(const RECT& rect, Frame& out, bool drawCursor, std::string* error);

// Captures one window, including one that sits off every monitor.
bool captureWindow(HWND hwnd, Frame& out, std::string* error);

// Copies `src` into `dst` at (x, y), clipped.
void blit(const Frame& src, Frame& dst, int x, int y);

// Writes a PNG through WIC. COM must be initialized on the calling thread.
bool savePng(const Frame& frame, const std::wstring& path, std::string* error);

// Draws numbered boxes over a copy of the frame, for `observe --map`.
struct MapBox {
  RECT rect;  // in frame pixels
  int index;
};
bool saveElementMap(const Frame& frame, const std::vector<MapBox>& boxes, const std::wstring& path,
                    std::string* error);

// A cheap change detector for idle cuts: samples every 16th pixel.
uint64_t frameHash(const Frame& frame);

}  // namespace ade
