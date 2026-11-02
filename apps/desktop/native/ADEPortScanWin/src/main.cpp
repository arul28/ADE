// ade-port-scan: which TCP ports are listening on this Windows machine, who
// owns them, and the process facts ADE matches dev servers to lanes with.
//
// Why it exists: ADE's dev-server discovery used to start a new powershell.exe
// for every scan (`Get-CimInstance Win32_Process` plus `Get-NetTCPConnection`),
// about 1.3 s of wall time and 1 s of CPU per scan on a fast PC. The same
// facts come from three Win32 calls in a few milliseconds:
//
//   - NtQuerySystemInformation(SystemProcessInformation): every process's pid,
//     parent pid, image name and creation time in one call, no per-process
//     handle.
//   - GetExtendedTcpTable (IPv4 and IPv6, listeners only): port to owning pid.
//   - NtQueryInformationProcess(ProcessCommandLineInformation): a command line,
//     read only for the processes ADE asks about (listeners and their parents).
//
// Each mode prints one JSON document to stdout in the exact shape the
// PowerShell query it replaces printed, so apps/desktop/src/main/services/
// devServers parses both the same way, and exits 0. Any failure exits non-zero
// with a reason on stderr; the caller then falls back to PowerShell.
//
//   ade-port-scan.exe listeners [--depth N]
//     [{"pid":1,"ports":[5173],"name":"node.exe","commandLine":"...",
//       "ancestors":[{"pid":2,"commandLine":"..."}]}]
//     One row per listening pid, ports unique and ascending, ancestors nearest
//     first, at most N (default 6) of them.
//   ade-port-scan.exe port <n>
//     [1234]   the pids listening on TCP port n.
//   ade-port-scan.exe processes
//     [{"pid":1,"ppid":0,"started":1730000000000}]   started: ms since the
//     Unix epoch, 0 when the OS does not say.
//
// Like Win32_Process, a parent is whatever process holds the recorded parent
// pid now; the caller already treats the chain as a hint.

#define WIN32_LEAN_AND_MEAN
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <iphlpapi.h>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cwchar>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

namespace {

using NTSTATUS_T = LONG;
constexpr NTSTATUS_T kStatusInfoLengthMismatch = static_cast<NTSTATUS_T>(0xC0000004L);
constexpr NTSTATUS_T kStatusBufferTooSmall = static_cast<NTSTATUS_T>(0xC0000023L);
constexpr NTSTATUS_T kStatusBufferOverflow = static_cast<NTSTATUS_T>(0x80000005L);
constexpr ULONG kSystemProcessInformation = 5;
constexpr ULONG kProcessCommandLineInformation = 60;  // Windows 8.1 and later.
/** FILETIME of 1970-01-01T00:00:00Z. */
constexpr int64_t kUnixEpochFiletime = 116444736000000000LL;

struct UnicodeStringView {
  USHORT Length;
  USHORT MaximumLength;
  PWSTR Buffer;
};

// The documented head of SYSTEM_PROCESS_INFORMATION, with the fields winternl.h
// leaves as Reserved1 (CreateTime sits 24 bytes in) and Reserved2 (the parent
// pid) named. Stable since Windows 2000; Task Manager and toolhelp read it.
struct SystemProcessInfo {
  ULONG NextEntryOffset;
  ULONG NumberOfThreads;
  LARGE_INTEGER WorkingSetPrivateSize;
  ULONG HardFaultCount;
  ULONG NumberOfThreadsHighWatermark;
  ULONGLONG CycleTime;
  LARGE_INTEGER CreateTime;
  LARGE_INTEGER UserTime;
  LARGE_INTEGER KernelTime;
  UnicodeStringView ImageName;
  LONG BasePriority;
  HANDLE UniqueProcessId;
  HANDLE InheritedFromUniqueProcessId;
};

using NtQuerySystemInformationFn = NTSTATUS_T(NTAPI*)(ULONG, PVOID, ULONG, PULONG);
using NtQueryInformationProcessFn = NTSTATUS_T(NTAPI*)(HANDLE, ULONG, PVOID, ULONG, PULONG);

struct ProcessFacts {
  DWORD ppid = 0;
  std::wstring name;
  int64_t startedMs = 0;
};

[[noreturn]] void fail(const char* what, unsigned long code) {
  char line[256];
  int length = std::snprintf(line, sizeof(line), "ade-port-scan: %s failed (0x%08lX)\r\n", what, code);
  DWORD written = 0;
  HANDLE err = GetStdHandle(STD_ERROR_HANDLE);
  if (err != NULL && err != INVALID_HANDLE_VALUE && length > 0) WriteFile(err, line, static_cast<DWORD>(length), &written, NULL);
  ExitProcess(2);
}

FARPROC ntdllProc(const char* name) {
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  FARPROC proc = ntdll ? GetProcAddress(ntdll, name) : nullptr;
  if (!proc) fail(name, GetLastError());
  return proc;
}

/**
 * A creation FILETIME as ms since the Unix epoch, rounded the way the
 * PowerShell query did: WMI keeps whole microseconds and `[long]` rounds the
 * millisecond double half to even. A stop compares two readings of this value
 * for equality, so both ways of reading it must agree.
 */
int64_t unixMillis(int64_t created) {
  if (created <= kUnixEpochFiletime) return 0;
  const int64_t micros = (created - kUnixEpochFiletime) / 10;
  int64_t millis = micros / 1000;
  const int64_t rest = micros % 1000;
  if (rest > 500 || (rest == 500 && (millis & 1) != 0)) ++millis;
  return millis;
}

std::map<DWORD, ProcessFacts> readProcessTable() {
  auto query = reinterpret_cast<NtQuerySystemInformationFn>(ntdllProc("NtQuerySystemInformation"));
  // A too-small buffer costs a whole collection before it fails (about 9 ms
  // with 490 processes, which needed 1.3 MB), so start well above that. Not
  // zero-filled: the kernel writes what it returns, and untouched pages stay
  // uncommitted.
  size_t size = 4 << 20;
  std::unique_ptr<unsigned char[]> buffer(new unsigned char[size]);
  NTSTATUS_T status = 0;
  for (int attempt = 0; attempt < 8; ++attempt) {
    ULONG needed = 0;
    status = query(kSystemProcessInformation, buffer.get(), static_cast<ULONG>(size), &needed);
    if (status != kStatusInfoLengthMismatch) break;
    // Processes start between the two calls; leave room for them.
    size = std::max<size_t>(size * 2, static_cast<size_t>(needed) + (256 << 10));
    buffer.reset(new unsigned char[size]);
  }
  if (status < 0) fail("NtQuerySystemInformation", static_cast<unsigned long>(status));

  std::map<DWORD, ProcessFacts> table;
  size_t offset = 0;
  for (;;) {
    const auto* entry = reinterpret_cast<const SystemProcessInfo*>(buffer.get() + offset);
    const auto pid = static_cast<DWORD>(reinterpret_cast<ULONG_PTR>(entry->UniqueProcessId));
    ProcessFacts facts;
    facts.ppid = static_cast<DWORD>(reinterpret_cast<ULONG_PTR>(entry->InheritedFromUniqueProcessId));
    if (entry->ImageName.Buffer && entry->ImageName.Length > 0) {
      facts.name.assign(entry->ImageName.Buffer, entry->ImageName.Length / sizeof(wchar_t));
    } else if (pid == 0) {
      facts.name = L"System Idle Process";  // Win32_Process's name for it.
    }
    facts.startedMs = unixMillis(entry->CreateTime.QuadPart);
    table[pid] = std::move(facts);
    if (entry->NextEntryOffset == 0) break;
    offset += entry->NextEntryOffset;
    if (offset >= size) break;
  }
  return table;
}

/** Listening TCP ports by owning pid, IPv4 and IPv6, as Get-NetTCPConnection -State Listen reports them. */
std::map<DWORD, std::set<unsigned>> readListeners() {
  std::map<DWORD, std::set<unsigned>> byPid;
  for (ULONG family : {static_cast<ULONG>(AF_INET), static_cast<ULONG>(AF_INET6)}) {
    std::vector<unsigned char> buffer(64 << 10);
    DWORD result = NO_ERROR;
    for (int attempt = 0; attempt < 8; ++attempt) {
      DWORD size = static_cast<DWORD>(buffer.size());
      result = GetExtendedTcpTable(buffer.data(), &size, FALSE, family, TCP_TABLE_OWNER_PID_LISTENER, 0);
      if (result != ERROR_INSUFFICIENT_BUFFER) break;
      buffer.resize(static_cast<size_t>(size) + (16 << 10));
    }
    if (result != NO_ERROR) fail(family == AF_INET ? "GetExtendedTcpTable(IPv4)" : "GetExtendedTcpTable(IPv6)", result);
    if (family == AF_INET) {
      const auto* table = reinterpret_cast<const MIB_TCPTABLE_OWNER_PID*>(buffer.data());
      for (DWORD i = 0; i < table->dwNumEntries; ++i) {
        const auto& row = table->table[i];
        byPid[row.dwOwningPid].insert(ntohs(static_cast<u_short>(row.dwLocalPort)));
      }
    } else {
      const auto* table = reinterpret_cast<const MIB_TCP6TABLE_OWNER_PID*>(buffer.data());
      for (DWORD i = 0; i < table->dwNumEntries; ++i) {
        const auto& row = table->table[i];
        byPid[row.dwOwningPid].insert(ntohs(static_cast<u_short>(row.dwLocalPort)));
      }
    }
  }
  return byPid;
}

/**
 * The process's command line, or empty when it exited or is not ours to read.
 * The handle asks for the access Win32_Process needs to read one (it reads the
 * process's memory), not the limited access the query itself needs, so an
 * elevated process stays as unreadable as it was through PowerShell and the
 * lane matching does not change.
 */
std::wstring readCommandLine(DWORD pid) {
  static auto query = reinterpret_cast<NtQueryInformationProcessFn>(ntdllProc("NtQueryInformationProcess"));
  if (pid == 0 || pid == 4) return std::wstring();
  HANDLE process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
  if (!process) return std::wstring();
  std::vector<unsigned char> buffer(4096);
  std::wstring line;
  for (int attempt = 0; attempt < 3; ++attempt) {
    ULONG needed = 0;
    const NTSTATUS_T status = query(process, kProcessCommandLineInformation, buffer.data(), static_cast<ULONG>(buffer.size()), &needed);
    if ((status == kStatusInfoLengthMismatch || status == kStatusBufferTooSmall || status == kStatusBufferOverflow) && needed > buffer.size()) {
      buffer.resize(needed);
      continue;
    }
    if (status >= 0) {
      const auto* text = reinterpret_cast<const UnicodeStringView*>(buffer.data());
      if (text->Buffer && text->Length > 0) line.assign(text->Buffer, text->Length / sizeof(wchar_t));
    }
    break;
  }
  CloseHandle(process);
  return line;
}

// --- JSON out -------------------------------------------------------------

std::string utf8(const std::wstring& text) {
  if (text.empty()) return std::string();
  const int size = WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  std::string out(size > 0 ? static_cast<size_t>(size) : 0, '\0');
  if (size > 0) WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), size, nullptr, nullptr);
  return out;
}

void appendJsonString(std::string& out, const std::wstring& text) {
  static const char* hex = "0123456789abcdef";
  out.push_back('"');
  for (unsigned char c : utf8(text)) {
    if (c == '"' || c == '\\') {
      out.push_back('\\');
      out.push_back(static_cast<char>(c));
    } else if (c < 0x20) {
      out += "\\u00";
      out.push_back(hex[c >> 4]);
      out.push_back(hex[c & 0xF]);
    } else {
      out.push_back(static_cast<char>(c));
    }
  }
  out.push_back('"');
}

void writeOut(const std::string& text) {
  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  if (out == NULL || out == INVALID_HANDLE_VALUE) fail("GetStdHandle", GetLastError());
  size_t offset = 0;
  while (offset < text.size()) {
    DWORD written = 0;
    const DWORD chunk = static_cast<DWORD>(std::min<size_t>(text.size() - offset, 1 << 20));
    if (!WriteFile(out, text.data() + offset, chunk, &written, NULL) || written == 0) fail("WriteFile", GetLastError());
    offset += written;
  }
}

// --- Modes ----------------------------------------------------------------

int listeners(int depth) {
  const auto byPid = readListeners();
  const auto table = readProcessTable();
  std::map<DWORD, std::wstring> commandLines;
  auto commandLineOf = [&](DWORD pid) -> const std::wstring& {
    auto found = commandLines.find(pid);
    if (found == commandLines.end()) found = commandLines.emplace(pid, readCommandLine(pid)).first;
    return found->second;
  };
  std::string out = "[";
  bool firstRow = true;
  for (const auto& [pid, ports] : byPid) {
    if (!firstRow) out.push_back(',');
    firstRow = false;
    const auto self = table.find(pid);
    out += "{\"pid\":" + std::to_string(pid) + ",\"ports\":[";
    bool firstPort = true;
    for (unsigned port : ports) {
      if (!firstPort) out.push_back(',');
      firstPort = false;
      out += std::to_string(port);
    }
    out += "],\"name\":";
    appendJsonString(out, self != table.end() ? self->second.name : std::wstring());
    out += ",\"commandLine\":";
    appendJsonString(out, self != table.end() ? commandLineOf(pid) : std::wstring());
    out += ",\"ancestors\":[";
    bool firstAncestor = true;
    auto parent = self != table.end() ? table.find(self->second.ppid) : table.end();
    for (int i = 0; i < depth && parent != table.end(); ++i) {
      if (!firstAncestor) out.push_back(',');
      firstAncestor = false;
      out += "{\"pid\":" + std::to_string(parent->first) + ",\"commandLine\":";
      appendJsonString(out, commandLineOf(parent->first));
      out.push_back('}');
      parent = table.find(parent->second.ppid);
    }
    out += "]}";
  }
  out.push_back(']');
  writeOut(out);
  return 0;
}

int port(unsigned wanted) {
  std::string out = "[";
  bool first = true;
  for (const auto& [pid, ports] : readListeners()) {
    if (ports.count(wanted) == 0) continue;
    if (!first) out.push_back(',');
    first = false;
    out += std::to_string(pid);
  }
  out.push_back(']');
  writeOut(out);
  return 0;
}

int processes() {
  std::string out = "[";
  bool first = true;
  for (const auto& [pid, facts] : readProcessTable()) {
    if (!first) out.push_back(',');
    first = false;
    out += "{\"pid\":" + std::to_string(pid) + ",\"ppid\":" + std::to_string(facts.ppid) + ",\"started\":" + std::to_string(facts.startedMs) + "}";
  }
  out.push_back(']');
  writeOut(out);
  return 0;
}

bool parseNumber(const wchar_t* text, unsigned long max, unsigned long& value) {
  if (!text || !*text) return false;
  wchar_t* end = nullptr;
  value = std::wcstoul(text, &end, 10);
  return end && *end == L'\0' && value <= max;
}

[[noreturn]] void usage() {
  const char line[] = "usage: ade-port-scan.exe listeners [--depth N] | port <n> | processes\r\n";
  DWORD written = 0;
  HANDLE err = GetStdHandle(STD_ERROR_HANDLE);
  if (err != NULL && err != INVALID_HANDLE_VALUE) WriteFile(err, line, sizeof(line) - 1, &written, NULL);
  ExitProcess(64);
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc < 2) usage();
  const std::wstring mode = argv[1];
  if (mode == L"listeners") {
    unsigned long depth = 6;
    if (argc == 4 && std::wcscmp(argv[2], L"--depth") == 0) {
      if (!parseNumber(argv[3], 32, depth)) usage();
    } else if (argc != 2) {
      usage();
    }
    return listeners(static_cast<int>(depth));
  }
  if (mode == L"port" && argc == 3) {
    unsigned long value = 0;
    if (!parseNumber(argv[2], 65535, value) || value == 0) usage();
    return port(static_cast<unsigned>(value));
  }
  if (mode == L"processes" && argc == 2) return processes();
  usage();
}
