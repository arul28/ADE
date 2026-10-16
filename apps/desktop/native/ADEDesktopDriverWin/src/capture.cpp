#include "capture.h"

#include <wincodec.h>
#include <wrl/client.h>

#include <algorithm>
#include <cstring>

using Microsoft::WRL::ComPtr;

namespace ade {

namespace {

std::string lastErrorText(const char* what) {
  DWORD err = GetLastError();
  wchar_t* msg = nullptr;
  FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, nullptr,
                 err, 0, reinterpret_cast<LPWSTR>(&msg), 0, nullptr);
  std::string text = std::string(what) + " failed (" + std::to_string(err) + ")";
  if (msg) {
    std::string m = narrow(msg);
    while (!m.empty() && (m.back() == '\n' || m.back() == '\r' || m.back() == ' ')) m.pop_back();
    text += ": " + m;
    LocalFree(msg);
  }
  return text;
}

// Reads a DIB section into a top-down BGRA frame.
bool readDib(HDC memDc, HBITMAP bitmap, int w, int h, Frame& out) {
  BITMAPINFO bi = {};
  bi.bmiHeader.biSize = sizeof(bi.bmiHeader);
  bi.bmiHeader.biWidth = w;
  bi.bmiHeader.biHeight = -h;  // top-down
  bi.bmiHeader.biPlanes = 1;
  bi.bmiHeader.biBitCount = 32;
  bi.bmiHeader.biCompression = BI_RGB;
  out.resize(w, h);
  int lines = GetDIBits(memDc, bitmap, 0, h, out.bgra.data(), &bi, DIB_RGB_COLORS);
  if (lines != h) return false;
  // GDI leaves alpha at 0; the encoders and PNG want an opaque frame.
  for (size_t i = 3; i < out.bgra.size(); i += 4) out.bgra[i] = 255;
  return true;
}

void drawCursorInto(HDC memDc, const RECT& rect) {
  CURSORINFO ci = {sizeof(ci)};
  if (!GetCursorInfo(&ci) || !(ci.flags & CURSOR_SHOWING)) return;
  ICONINFO ii = {};
  if (!GetIconInfo(ci.hCursor, &ii)) return;
  int x = ci.ptScreenPos.x - static_cast<int>(ii.xHotspot) - rect.left;
  int y = ci.ptScreenPos.y - static_cast<int>(ii.yHotspot) - rect.top;
  DrawIconEx(memDc, x, y, ci.hCursor, 0, 0, 0, nullptr, DI_NORMAL);
  if (ii.hbmMask) DeleteObject(ii.hbmMask);
  if (ii.hbmColor) DeleteObject(ii.hbmColor);
}

}  // namespace

bool captureScreenRect(const RECT& rect, Frame& out, bool drawCursor, std::string* error) {
  int w = rect.right - rect.left;
  int h = rect.bottom - rect.top;
  if (w <= 0 || h <= 0) {
    if (error) *error = "empty capture rectangle";
    return false;
  }
  HDC screen = GetDC(nullptr);
  if (!screen) {
    if (error) *error = lastErrorText("GetDC");
    return false;
  }
  HDC mem = CreateCompatibleDC(screen);
  HBITMAP bmp = CreateCompatibleBitmap(screen, w, h);
  HGDIOBJ old = SelectObject(mem, bmp);
  bool ok = BitBlt(mem, 0, 0, w, h, screen, rect.left, rect.top, SRCCOPY) != FALSE;
  if (!ok && error) *error = lastErrorText("BitBlt");
  if (ok && drawCursor) drawCursorInto(mem, rect);
  SelectObject(mem, old);
  if (ok) {
    ok = readDib(mem, bmp, w, h, out);
    if (!ok && error) *error = "GetDIBits returned a short frame";
  }
  DeleteObject(bmp);
  DeleteDC(mem);
  ReleaseDC(nullptr, screen);
  return ok;
}

bool captureWindow(HWND hwnd, Frame& out, std::string* error) {
  RECT r;
  if (!GetWindowRect(hwnd, &r)) {
    if (error) *error = lastErrorText("GetWindowRect");
    return false;
  }
  int w = r.right - r.left;
  int h = r.bottom - r.top;
  if (w <= 0 || h <= 0) {
    if (error) *error = "the window has no size";
    return false;
  }
  HDC screen = GetDC(nullptr);
  HDC mem = CreateCompatibleDC(screen);
  HBITMAP bmp = CreateCompatibleBitmap(screen, w, h);
  HGDIOBJ old = SelectObject(mem, bmp);
  // PW_RENDERFULLCONTENT (2) draws DirectComposition content as well, which
  // is what makes a modern (UWP, Chromium, WinUI) window come out non-black.
  bool ok = PrintWindow(hwnd, mem, 2) != FALSE;
  if (!ok && error) *error = lastErrorText("PrintWindow");
  SelectObject(mem, old);
  if (ok) {
    ok = readDib(mem, bmp, w, h, out);
    if (!ok && error) *error = "GetDIBits returned a short frame";
  }
  DeleteObject(bmp);
  DeleteDC(mem);
  ReleaseDC(nullptr, screen);
  return ok;
}

void blit(const Frame& src, Frame& dst, int x, int y) {
  int x0 = std::max(0, x);
  int y0 = std::max(0, y);
  int x1 = std::min(dst.width, x + src.width);
  int y1 = std::min(dst.height, y + src.height);
  if (x1 <= x0 || y1 <= y0) return;
  for (int row = y0; row < y1; ++row) {
    const uint8_t* s = src.bgra.data() + (static_cast<size_t>(row - y) * src.width + (x0 - x)) * 4;
    uint8_t* d = dst.bgra.data() + (static_cast<size_t>(row) * dst.width + x0) * 4;
    std::memcpy(d, s, static_cast<size_t>(x1 - x0) * 4);
  }
}

bool savePng(const Frame& frame, const std::wstring& path, std::string* error) {
  if (frame.empty()) {
    if (error) *error = "no frame to save";
    return false;
  }
  ComPtr<IWICImagingFactory> factory;
  HRESULT hr = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory));
  ComPtr<IWICStream> stream;
  ComPtr<IWICBitmapEncoder> encoder;
  ComPtr<IWICBitmapFrameEncode> frameEncode;
  if (SUCCEEDED(hr)) hr = factory->CreateStream(&stream);
  if (SUCCEEDED(hr)) hr = stream->InitializeFromFilename(path.c_str(), GENERIC_WRITE);
  if (SUCCEEDED(hr)) hr = factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder);
  if (SUCCEEDED(hr)) hr = encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache);
  if (SUCCEEDED(hr)) hr = encoder->CreateNewFrame(&frameEncode, nullptr);
  if (SUCCEEDED(hr)) hr = frameEncode->Initialize(nullptr);
  if (SUCCEEDED(hr)) hr = frameEncode->SetSize(frame.width, frame.height);
  WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
  if (SUCCEEDED(hr)) hr = frameEncode->SetPixelFormat(&format);
  if (SUCCEEDED(hr)) {
    hr = frameEncode->WritePixels(frame.height, frame.width * 4, static_cast<UINT>(frame.bgra.size()),
                                  const_cast<BYTE*>(frame.bgra.data()));
  }
  if (SUCCEEDED(hr)) hr = frameEncode->Commit();
  if (SUCCEEDED(hr)) hr = encoder->Commit();
  if (FAILED(hr)) {
    if (error) *error = "PNG write failed (hr=" + std::to_string(static_cast<long>(hr)) + ")";
    return false;
  }
  return true;
}

bool saveElementMap(const Frame& frame, const std::vector<MapBox>& boxes, const std::wstring& path,
                    std::string* error) {
  if (frame.empty()) {
    if (error) *error = "no frame for the element map";
    return false;
  }
  // Draw with GDI onto a DIB copy of the frame.
  BITMAPINFO bi = {};
  bi.bmiHeader.biSize = sizeof(bi.bmiHeader);
  bi.bmiHeader.biWidth = frame.width;
  bi.bmiHeader.biHeight = -frame.height;
  bi.bmiHeader.biPlanes = 1;
  bi.bmiHeader.biBitCount = 32;
  bi.bmiHeader.biCompression = BI_RGB;
  void* bits = nullptr;
  HDC screen = GetDC(nullptr);
  HDC mem = CreateCompatibleDC(screen);
  HBITMAP dib = CreateDIBSection(mem, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
  ReleaseDC(nullptr, screen);
  if (!dib || !bits) {
    DeleteDC(mem);
    if (error) *error = "CreateDIBSection failed";
    return false;
  }
  std::memcpy(bits, frame.bgra.data(), frame.bgra.size());
  HGDIOBJ oldBmp = SelectObject(mem, dib);
  HPEN pen = CreatePen(PS_SOLID, 2, RGB(255, 45, 85));
  HGDIOBJ oldPen = SelectObject(mem, pen);
  HGDIOBJ oldBrush = SelectObject(mem, GetStockObject(NULL_BRUSH));
  HFONT font = CreateFontW(16, 0, 0, 0, FW_BOLD, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
  HGDIOBJ oldFont = SelectObject(mem, font);
  SetBkMode(mem, OPAQUE);
  SetBkColor(mem, RGB(255, 45, 85));
  SetTextColor(mem, RGB(255, 255, 255));
  for (const auto& box : boxes) {
    Rectangle(mem, box.rect.left, box.rect.top, box.rect.right, box.rect.bottom);
    std::wstring label = std::to_wstring(box.index);
    TextOutW(mem, box.rect.left + 1, box.rect.top + 1, label.c_str(), static_cast<int>(label.size()));
  }
  SelectObject(mem, oldFont);
  SelectObject(mem, oldBrush);
  SelectObject(mem, oldPen);
  SelectObject(mem, oldBmp);
  DeleteObject(font);
  DeleteObject(pen);
  GdiFlush();
  Frame copy;
  copy.width = frame.width;
  copy.height = frame.height;
  copy.bgra.assign(static_cast<uint8_t*>(bits), static_cast<uint8_t*>(bits) + frame.bgra.size());
  for (size_t i = 3; i < copy.bgra.size(); i += 4) copy.bgra[i] = 255;
  DeleteObject(dib);
  DeleteDC(mem);
  return savePng(copy, path, error);
}

uint64_t frameHash(const Frame& frame) {
  uint64_t h = 1469598103934665603ULL;
  const uint32_t* px = reinterpret_cast<const uint32_t*>(frame.bgra.data());
  size_t count = frame.bgra.size() / 4;
  for (size_t i = 0; i < count; i += 16) {
    h ^= px[i];
    h *= 1099511628211ULL;
  }
  return h;
}

}  // namespace ade
