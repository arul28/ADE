// Shared pieces of the Windows desktop driver: error codes, the error type a
// handler throws, logging, clocks, and the thread-safe line writer.
//
// The error codes are the macOS driver's codes (see `DriverProtocol.swift` and
// `apps/desktop/src/shared/types/macDesktop.ts`), because the Node service maps
// them straight onto its own errors. Windows adds the `WINDOWS_DESKTOP_*`
// codes, which the service knows too.

#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>

#include "json.h"

namespace ade {

extern const char* const kDriverVersion;

namespace code {
constexpr const char* kUnsupportedPlatform = "MAC_DESKTOP_UNSUPPORTED_PLATFORM";
constexpr const char* kDriverUnavailable = "MAC_DESKTOP_DRIVER_UNAVAILABLE";
constexpr const char* kDisplayUnavailable = "MAC_DESKTOP_DISPLAY_UNAVAILABLE";
constexpr const char* kNoDisplay = "MAC_DESKTOP_NO_DISPLAY";
constexpr const char* kNoWindow = "MAC_DESKTOP_NO_WINDOW";
constexpr const char* kAppOwnedByOtherLane = "MAC_DESKTOP_APP_OWNED_BY_OTHER_LANE";
constexpr const char* kWindowNotFound = "MAC_DESKTOP_WINDOW_NOT_FOUND";
constexpr const char* kHandleExpired = "MAC_DESKTOP_HANDLE_EXPIRED";
constexpr const char* kInputLeaseRequired = "MAC_DESKTOP_INPUT_LEASE_REQUIRED";
constexpr const char* kRecordingNotRunning = "MAC_DESKTOP_RECORDING_NOT_RUNNING";
// Windows-only. Mirrored in macDesktop.ts.
constexpr const char* kConsentRequired = "WINDOWS_DESKTOP_CONSENT_REQUIRED";
constexpr const char* kHeld = "WINDOWS_DESKTOP_HELD";
constexpr const char* kSetupRequired = "WINDOWS_DESKTOP_SETUP_REQUIRED";
constexpr const char* kLocked = "WINDOWS_DESKTOP_LOCKED";
constexpr const char* kSignInFailed = "WINDOWS_DESKTOP_SIGN_IN_FAILED";
constexpr const char* kWrongPassword = "WINDOWS_DESKTOP_WRONG_PASSWORD";
constexpr const char* kNotConsoleSession = "WINDOWS_DESKTOP_NOT_CONSOLE_SESSION";
constexpr const char* kCancelled = "WINDOWS_DESKTOP_CANCELLED";
// Driver-local faults.
constexpr const char* kUnknownOp = "unknown_op";
constexpr const char* kProtocolError = "protocol_error";
constexpr const char* kInvalidArgument = "invalid_argument";
constexpr const char* kInternalError = "internal_error";
}  // namespace code

// What a handler throws when it refuses. The dispatcher turns it into
// `{"ok":false,"error":{"code","message"}}`.
struct DriverError {
  std::string code;
  std::string message;
  Json details;  // optional extra fields merged into the error object
};

[[noreturn]] inline void fail(const char* c, const std::string& message) {
  throw DriverError{c, message, Json()};
}

// One line on stderr. The Node client forwards stderr to the brain log, so
// nothing here may print a password, a token, or a window title.
void logLine(const std::string& message);

// ISO-8601 UTC with milliseconds, e.g. 2026-09-30T12:00:00.000Z.
std::string isoNow();
std::string isoFromFileTime(const FILETIME& ft);
int64_t nowMs();

// Writes whole lines to one handle from any thread.
class LineWriter {
 public:
  explicit LineWriter(HANDLE handle) : handle_(handle) {}
  void setHandle(HANDLE handle) {
    std::lock_guard<std::mutex> lock(mutex_);
    handle_ = handle;
  }
  // False when the handle is gone (the reader closed its end).
  bool write(const Json& value);
  bool writeRaw(const std::string& line);

 private:
  std::mutex mutex_;
  HANDLE handle_;
};

// Reads newline-terminated lines. Returns false at end of stream.
class LineReader {
 public:
  explicit LineReader(HANDLE handle) : handle_(handle) {}
  bool next(std::string& line);

 private:
  HANDLE handle_;
  std::string buffer_;
};

// Reply helpers.
Json okReply(const std::string& id, Json result);
Json errorReply(const std::string& id, const DriverError& error);
Json eventLine(const std::string& name, Json fields);

// Request field readers that throw `invalid_argument` with the op name.
std::string requireString(const Json& req, const char* key);
int64_t requireInt(const Json& req, const char* key);

// The session this process runs in, and the physical console's session.
DWORD currentSessionId();
DWORD consoleSessionId();

// %USERPROFILE%\.ade, or ADE_HOME when set. The Node side passes the same
// directory explicitly; this is only the fallback.
std::wstring adeHomeDir();
std::wstring joinPath(const std::wstring& a, const std::wstring& b);
bool ensureDir(const std::wstring& path);
bool fileExists(const std::wstring& path);
std::wstring exePath();

// Lower-case copy, for case-insensitive compares of ASCII-ish text.
std::wstring lower(std::wstring s);
std::string lowerA(std::string s);

}  // namespace ade
