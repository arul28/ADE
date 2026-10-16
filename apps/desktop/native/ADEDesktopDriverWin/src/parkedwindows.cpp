#include "parkedwindows.h"
#include "desk.h"

#include <fstream>
#include <iterator>

namespace ade {
namespace {

uint64_t handleKey(HWND hwnd) { return static_cast<uint64_t>(reinterpret_cast<uintptr_t>(hwnd)); }

uint64_t ticksOf(FILETIME time) {
  ULARGE_INTEGER value;
  value.LowPart = time.dwLowDateTime;
  value.HighPart = time.dwHighDateTime;
  return value.QuadPart;
}

DWORD windowPid(HWND hwnd) {
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  return pid;
}

}  // namespace

RECT releaseTargetFor(HWND hwnd, const RECT* home) {
  const int virtualRight = GetSystemMetrics(SM_XVIRTUALSCREEN) + GetSystemMetrics(SM_CXVIRTUALSCREEN);
  if (home && home->left < virtualRight) return *home;
  // A window that started off-screen (a lane launch) comes back to the
  // primary monitor's work area.
  RECT work;
  SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
  RECT cur;
  GetWindowRect(hwnd, &cur);
  return {work.left + 80, work.top + 80, work.left + 80 + (cur.right - cur.left), work.top + 80 + (cur.bottom - cur.top)};
}

std::wstring ParkedWindowsRecord::file() const {
  return joinPath(joinPath(home_, L"windows-desktop"), L"parked-windows.json");
}

void ParkedWindowsRecord::loadLocked() {
  if (loaded_) return;
  loaded_ = true;
  std::ifstream in(file(), std::ios::binary);
  if (!in) return;
  const std::string text((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  in.close();
  try {
    const Json record = Json::parse(text);
    for (const auto& item : record["windows"].items()) {
      Entry entry;
      entry.pid = static_cast<DWORD>(item["pid"].asInt(0));
      entry.created = std::stoull(item["created"].str("0"));
      entry.home = {static_cast<LONG>(item["left"].asInt()), static_cast<LONG>(item["top"].asInt()),
                    static_cast<LONG>(item["right"].asInt()), static_cast<LONG>(item["bottom"].asInt())};
      // Handles exceed a double's exact range on 64-bit: kept as decimal strings.
      entries_[std::stoull(item["hwnd"].str("0"))] = entry;
    }
  } catch (...) {
    logLine("parked-windows: record unreadable; ignoring it");
    entries_.clear();
  }
}

void ParkedWindowsRecord::writeLocked() {
  const auto target = file();
  if (entries_.empty()) { DeleteFileW(target.c_str()); return; }
  if (!ensureDir(joinPath(home_, L"windows-desktop"))) return;
  Json windows = Json::array();
  for (const auto& [hwnd, entry] : entries_) {
    windows.push(Json::Object{{"hwnd", std::to_string(hwnd)}, {"pid", static_cast<int64_t>(entry.pid)},
        {"created", std::to_string(entry.created)}, {"left", static_cast<int64_t>(entry.home.left)},
        {"top", static_cast<int64_t>(entry.home.top)}, {"right", static_cast<int64_t>(entry.home.right)},
        {"bottom", static_cast<int64_t>(entry.home.bottom)}});
  }
  const auto temp = target + L".tmp";
  {
    std::ofstream out(temp, std::ios::binary | std::ios::trunc);
    out << Json(Json::Object{{"windows", windows}}).dump();
    out.close();
    if (!out) { DeleteFileW(temp.c_str()); logLine("parked-windows: record not written"); return; }
  }
  if (!MoveFileExW(temp.c_str(), target.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
    logLine("parked-windows: record not written error=" + std::to_string(GetLastError()));
    DeleteFileW(temp.c_str());
  }
}

void ParkedWindowsRecord::add(HWND hwnd, const RECT& home) {
  const DWORD pid = windowPid(hwnd);
  const uint64_t created = pid ? ticksOf(processCreationTime(pid)) : 0;
  if (!pid || !created) return;  // Nothing a later host could match it by.
  std::lock_guard<std::mutex> lock(mutex_);
  loadLocked();
  entries_[handleKey(hwnd)] = Entry{pid, created, home};
  writeLocked();
}

void ParkedWindowsRecord::remove(HWND hwnd) {
  std::lock_guard<std::mutex> lock(mutex_);
  loadLocked();
  if (entries_.erase(handleKey(hwnd))) writeLocked();
}

int ParkedWindowsRecord::restoreLocked(const std::map<uint64_t, Entry>& entries) {
  int restored = 0;
  for (const auto& [key, entry] : entries) {
    const HWND hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(key));
    // Exactly the window that was parked: same handle, process and start.
    if (!IsWindow(hwnd) || windowPid(hwnd) != entry.pid || ticksOf(processCreationTime(entry.pid)) != entry.created) continue;
    const RECT target = releaseTargetFor(hwnd, &entry.home);
    // Asynchronous: a hung app's window still moves, and this never waits on it.
    SetWindowPos(hwnd, nullptr, target.left, target.top, target.right - target.left, target.bottom - target.top,
                 SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
    ++restored;
  }
  return restored;
}

int ParkedWindowsRecord::restoreAll(bool tryOnly) {
  std::unique_lock<std::mutex> lock(mutex_, std::defer_lock);
  if (tryOnly) {
    if (!lock.try_lock()) return -1;
  } else {
    lock.lock();
  }
  loadLocked();
  if (entries_.empty()) return 0;
  const int restored = restoreLocked(entries_);
  logLine("parked-windows: put back " + std::to_string(restored) + " of " + std::to_string(entries_.size()) + " recorded windows");
  entries_.clear();
  writeLocked();
  return restored;
}

}  // namespace ade
