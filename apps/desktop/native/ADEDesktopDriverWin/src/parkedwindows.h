// The shared seat's parked windows, on disk, so they can always go back.
//
// Parking moves a window of the user's main desktop (or one a lane opened
// there) outside every monitor. A driver that dies before it unparks them
// would strand them there, so each parked window is recorded in
// <ADE home>\windows-desktop\parked-windows.json — its handle, its process id
// and that process's creation time, and where it came from — written
// atomically, the way owned-child.json is. A normal release removes the entry;
// the next host to start puts back every window whose record still matches a
// live window exactly (same handle, same process, same process start) and
// clears the file. A window disabled by a foreground shield (background.h) is
// marked while it is, and re-enabled when it is put back.

#pragma once

#include "common.h"

#include <map>
#include <mutex>
#include <string>

namespace ade {

class ParkedWindowsRecord {
 public:
  explicit ParkedWindowsRecord(std::wstring home) : home_(std::move(home)) {}

  // Records `hwnd` as parked, coming from `home` (its rect before parking).
  void add(HWND hwnd, const RECT& home);
  // A released or closed window.
  void remove(HWND hwnd);
  // Marks a recorded window as disabled by a foreground shield, or no longer.
  // A window that is not recorded is left alone.
  void setShielded(HWND hwnd, bool shielded);
  // Puts every recorded window that still matches back where it came from
  // and clears the record. With `tryOnly`, gives up at once when another
  // thread holds the record (a stuck worker), and returns -1.
  int restoreAll(bool tryOnly);

 private:
  struct Entry {
    DWORD pid = 0;
    uint64_t created = 0;
    RECT home{};
    bool shielded = false;
  };
  std::wstring file() const;
  // `flush`: write through to disk. A shield mark skips it: losing one costs
  // a missed re-enable, not a stranded window, and it is written twice per
  // UI Automation call.
  void writeLocked(bool flush = true);
  int restoreLocked(const std::map<uint64_t, Entry>& entries);

  std::wstring home_;
  std::mutex mutex_;
  std::map<uint64_t, Entry> entries_;  // keyed by the window handle
  bool loaded_ = false;
  void loadLocked();
};

// Where a released window goes: back to `home` when that was on a monitor,
// otherwise (a window a lane opened off-screen) to the primary work area.
RECT releaseTargetFor(HWND hwnd, const RECT* home);

}  // namespace ade
