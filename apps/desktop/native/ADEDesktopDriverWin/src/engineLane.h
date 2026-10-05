#pragma once
// Internal lane state shared by lifecycle, input and media implementations.
#include "engine.h"

namespace ade {
struct LaunchWatch {
  DWORD pid = 0;
  int64_t sinceMs = 0;
  FILETIME since = {};
  std::set<HWND> before;
};

struct Engine::Lane {
  std::string laneId;
  std::string name;
  RECT area = {};
  int width = 0;
  int height = 0;
  int64_t displayId = 0;
  std::string createdAt;
  // Private seat: a stable per-lane directory under the ADE home, sent by the
  // host, for lane-private browser profiles. Empty on the shared seat.
  std::wstring dataDir;
  std::string lastActivityAt;
  int64_t lastActivityMs = 0;
  int slot = 0;
  // Shared mode: the windows parked here, what put them here, and where each
  // one came from so a release puts it back.
  std::map<HWND, std::string> origin;
  std::map<HWND, RECT> home;
  // Apps this lane launched (root pids) and the late-window watches.
  std::set<DWORD> launchedRoots;
  std::map<DWORD, FILETIME> launchedTimes;
  std::map<DWORD, DWORD> watchedLaunchRoots;
  std::vector<LaunchWatch> watches;
  // Lease (shared mode real input).
  std::string leaseHolder;
  int64_t leaseExpiresMs = 0;
  // Media.
  std::mutex media;
  std::unique_ptr<StreamByteServer> server;
  std::unique_ptr<H264Encoder> encoder;
  bool streaming = false;
  int streamFps = 30;
  bool cursorVisible = false;
  std::string codec;
  std::atomic<bool> wantKeyframe{false};
  std::unique_ptr<Mp4Recorder> recorder;
  std::wstring recordPath;
  int recordFps = 30;
  bool keepIdle = false;
  HWND recordWindow = nullptr;
  int64_t recordStartMs = 0;
  int64_t recordIdleCutMs = 0;
  int64_t recordLastChangeMs = 0;
  int64_t recordMediaMs = 0;  // media time written so far
  int64_t recordFrames = 0;
  int64_t recordLastWallMs = 0;
  uint64_t recordLastHash = 0;
  std::string recordError;
  std::thread mediaThread;
  std::atomic<bool> mediaRun{false};
  int64_t lastStreamErrorMs = 0;
  std::string windowsSignature;
};

inline std::vector<std::string> stringList(const Json& value) {
  std::vector<std::string> out;
  for (const auto& v : value.items()) {
    if (v.isString() && !v.asString().empty()) out.push_back(v.asString());
  }
  return out;
}

[[noreturn]] inline void failLocked() {
  fail(code::kLocked, "This PC is locked, so the private screen cannot take input. The agent waits until it is unlocked.");
}
}  // namespace ade
