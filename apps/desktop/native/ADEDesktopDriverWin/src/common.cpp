#include "common.h"

#include <shlobj.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cwctype>

namespace ade {

const char* const kDriverVersion = "1.0.0";

void logLine(const std::string& message) {
  static std::mutex mutex;
  std::lock_guard<std::mutex> lock(mutex);
  std::string line = "[ade-desktop-driver " + std::to_string(GetCurrentProcessId()) + "] " + message + "\n";
  HANDLE err = GetStdHandle(STD_ERROR_HANDLE);
  if (err && err != INVALID_HANDLE_VALUE) {
    DWORD written = 0;
    WriteFile(err, line.data(), static_cast<DWORD>(line.size()), &written, nullptr);
  }
}

namespace {
#if defined(_M_X64)
// Walks a suspended thread's stack. Plain data only: nothing here may allocate
// or take a lock the suspended thread could hold, and a bad frame stops the
// walk instead of crashing the driver.
int unwindSuspended(CONTEXT* context, DWORD64* frames, int capacity) {
  int count = 0;
  __try {
    while (count < capacity && context->Rip) {
      frames[count++] = context->Rip;
      DWORD64 imageBase = 0;
      PRUNTIME_FUNCTION entry = RtlLookupFunctionEntry(context->Rip, &imageBase, nullptr);
      if (!entry) {
        context->Rip = *reinterpret_cast<DWORD64*>(context->Rsp);
        context->Rsp += 8;
        continue;
      }
      PVOID handlerData = nullptr;
      DWORD64 establisher = 0;
      RtlVirtualUnwind(UNW_FLAG_NHANDLER, imageBase, context->Rip, entry, context, &handlerData, &establisher, nullptr);
    }
  } __except (EXCEPTION_EXECUTE_HANDLER) {
  }
  return count;
}
#endif

// module!export+0xoffset from the module's own export table: system DLLs carry
// no symbols here, but their exports name the API a thread is blocked in.
std::string describeAddress(DWORD64 address) {
  HMODULE module = nullptr;
  if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
          reinterpret_cast<LPCWSTR>(address), &module) || !module) {
    char buffer[24]; std::snprintf(buffer, sizeof(buffer), "0x%llx", static_cast<unsigned long long>(address));
    return buffer;
  }
  wchar_t path[MAX_PATH] = {};
  GetModuleFileNameW(module, path, MAX_PATH);
  const std::wstring name = baseName(path);
  std::string label(name.begin(), name.end());
  const auto base = reinterpret_cast<const BYTE*>(module);
  const DWORD rva = static_cast<DWORD>(address - reinterpret_cast<DWORD64>(module));
  const char* best = nullptr;
  DWORD bestRva = 0;
  const auto* dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(base);
  const auto* nt = reinterpret_cast<const IMAGE_NT_HEADERS*>(base + dos->e_lfanew);
  const auto& directory = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_EXPORT];
  if (dos->e_magic == IMAGE_DOS_SIGNATURE && nt->Signature == IMAGE_NT_SIGNATURE && directory.VirtualAddress) {
    const auto* exports = reinterpret_cast<const IMAGE_EXPORT_DIRECTORY*>(base + directory.VirtualAddress);
    const auto* names = reinterpret_cast<const DWORD*>(base + exports->AddressOfNames);
    const auto* ordinals = reinterpret_cast<const WORD*>(base + exports->AddressOfNameOrdinals);
    const auto* functions = reinterpret_cast<const DWORD*>(base + exports->AddressOfFunctions);
    for (DWORD i = 0; i < exports->NumberOfNames; ++i) {
      const DWORD candidate = functions[ordinals[i]];
      if (candidate <= rva && candidate > bestRva) { bestRva = candidate; best = reinterpret_cast<const char*>(base + names[i]); }
    }
  }
  char offset[32];
  std::snprintf(offset, sizeof(offset), "+0x%lx", static_cast<unsigned long>(best ? rva - bestRva : rva));
  return label + (best ? std::string("!") + best : std::string()) + offset;
}
}  // namespace

void logThreadStack(DWORD threadId, const std::string& label) {
#if defined(_M_X64)
  if (!threadId || threadId == GetCurrentThreadId()) return;
  HANDLE thread = OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION, FALSE, threadId);
  if (!thread) return;
  DWORD64 frames[40];
  int count = 0;
  if (SuspendThread(thread) != static_cast<DWORD>(-1)) {
    CONTEXT context;
    ZeroMemory(&context, sizeof(context));
    context.ContextFlags = CONTEXT_FULL;
    if (GetThreadContext(thread, &context)) count = unwindSuspended(&context, frames, 40);
    ResumeThread(thread);
  }
  CloseHandle(thread);
  std::string line = label + " stack:";
  for (int i = 0; i < count; ++i) line += " " + describeAddress(frames[i]);
  logLine(line);
#else
  (void)threadId; (void)label;
#endif
}

std::string isoFromFileTime(const FILETIME& ft) {
  SYSTEMTIME st;
  FileTimeToSystemTime(&ft, &st);
  char buf[40];
  std::snprintf(buf, sizeof(buf), "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", st.wYear, st.wMonth, st.wDay, st.wHour,
                st.wMinute, st.wSecond, st.wMilliseconds);
  return buf;
}

std::string isoNow() {
  FILETIME ft;
  GetSystemTimeAsFileTime(&ft);
  return isoFromFileTime(ft);
}

int64_t nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

bool LineWriter::writeRaw(const std::string& line) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!handle_ || handle_ == INVALID_HANDLE_VALUE) return false;
  std::string data = line;
  data.push_back('\n');
  const char* p = data.data();
  size_t left = data.size();
  while (left > 0) {
    DWORD written = 0;
    if (!WriteFile(handle_, p, static_cast<DWORD>(left), &written, nullptr) || written == 0) return false;
    p += written;
    left -= written;
  }
  return true;
}

bool LineWriter::write(const Json& value) { return writeRaw(value.dump()); }

bool LineReader::next(std::string& line) {
  for (;;) {
    size_t nl = buffer_.find('\n');
    if (nl != std::string::npos) {
      line = buffer_.substr(0, nl);
      buffer_.erase(0, nl + 1);
      if (!line.empty() && line.back() == '\r') line.pop_back();
      return true;
    }
    // A single line longer than this is a protocol fault, not a message.
    if (buffer_.size() > 8 * 1024 * 1024) {
      logLine("screen protocol line exceeded its limit");
      return false;
    }
    char chunk[16384];
    DWORD read = 0;
    if (!ReadFile(handle_, chunk, sizeof(chunk), &read, nullptr) || read == 0) {
      if (!buffer_.empty()) {
        line.swap(buffer_);
        buffer_.clear();
        return true;
      }
      return false;
    }
    buffer_.append(chunk, read);
  }
}

Json okReply(const std::string& id, Json result) {
  Json reply = Json::object();
  reply["id"] = id;
  reply["ok"] = true;
  reply["result"] = result.isNull() ? Json::object() : std::move(result);
  return reply;
}

Json errorReply(const std::string& id, const DriverError& error) {
  Json reply = Json::object();
  reply["id"] = id;
  reply["ok"] = false;
  Json err = error.details.isObject() ? error.details : Json::object();
  err["code"] = error.code;
  err["message"] = error.message;
  reply["error"] = err;
  return reply;
}

Json eventLine(const std::string& name, Json fields) {
  Json line = fields.isObject() ? std::move(fields) : Json::object();
  line["event"] = name;
  return line;
}

std::string requireString(const Json& req, const char* key) {
  const std::string& value = req[key].asString();
  if (value.empty()) {
    fail(code::kInvalidArgument, req["op"].str() + " needs a non-empty \"" + key + "\".");
  }
  return value;
}

int64_t requireInt(const Json& req, const char* key) {
  if (!req[key].isNumber()) {
    fail(code::kInvalidArgument, req["op"].str() + " needs a numeric \"" + key + "\".");
  }
  return req[key].asInt();
}

DWORD currentSessionId() {
  DWORD sid = 0;
  ProcessIdToSessionId(GetCurrentProcessId(), &sid);
  return sid;
}

DWORD consoleSessionId() { return WTSGetActiveConsoleSessionId(); }

std::wstring joinPath(const std::wstring& a, const std::wstring& b) {
  if (a.empty()) return b;
  if (a.back() == L'\\' || a.back() == L'/') return a + b;
  return a + L"\\" + b;
}

std::wstring adeHomeDir() {
  wchar_t buf[MAX_PATH * 2];
  DWORD n = GetEnvironmentVariableW(L"ADE_HOME", buf, static_cast<DWORD>(std::size(buf)));
  if (n > 0 && n < std::size(buf)) return std::wstring(buf, n);
  PWSTR profile = nullptr;
  std::wstring out;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_Profile, 0, nullptr, &profile))) {
    out = joinPath(profile, L".ade");
    CoTaskMemFree(profile);
  }
  return out;
}

bool ensureDir(const std::wstring& path) {
  int rc = SHCreateDirectoryExW(nullptr, path.c_str(), nullptr);
  return rc == ERROR_SUCCESS || rc == ERROR_ALREADY_EXISTS || rc == ERROR_FILE_EXISTS;
}

bool fileExists(const std::wstring& path) {
  DWORD attrs = GetFileAttributesW(path.c_str());
  return attrs != INVALID_FILE_ATTRIBUTES && !(attrs & FILE_ATTRIBUTE_DIRECTORY);
}

std::wstring exePath() {
  wchar_t buf[MAX_PATH * 2];
  DWORD n = GetModuleFileNameW(nullptr, buf, static_cast<DWORD>(std::size(buf)));
  return std::wstring(buf, n);
}

std::wstring lower(std::wstring s) {
  std::transform(s.begin(), s.end(), s.begin(), [](wchar_t c) { return static_cast<wchar_t>(std::towlower(c)); });
  return s;
}

std::string lowerA(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return s;
}

}  // namespace ade
