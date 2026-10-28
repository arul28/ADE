// ade-cli-launcher: runs the ADE CLI on Windows with the caller's command line
// intact.
//
// Why it exists: `ade.cmd` runs through cmd.exe, and cmd.exe ends a command at
// its first line feed, so a multi-line `--prompt` or `--text` was cut to its
// first line before the CLI ever started (ledger #46). ADE_CLI_PATH must name
// something that is not a batch file. A packaged ADE runs its CLI as
// `ADE.exe <resources>\ade-cli\cli.cjs` with ELECTRON_RUN_AS_NODE=1, which a
// single path cannot express, so this launcher does it.
//
// How it works: it reads `<its own name>.launch` beside itself (UTF-8, one
// directive per line, written by the ADE brain or desktop that copied it there;
// see apps/desktop/src/main/services/cli/windowsCliLauncher.ts), applies the
// environment it names, and starts `exe` with the fixed `arg`s followed by the
// rest of its own command line copied verbatim: no re-parsing, so quotes,
// backslashes and line feeds reach the CLI exactly as the caller wrote them.
// It waits and exits with the child's exit code.
//
//   ade-launch 1                 first line, the format version
//   exe <path>                   the program to run (required)
//   arg <value>                  a leading argument, quoted for the CRT
//   env NAME=VALUE               always set
//   default NAME=VALUE           set only when neither ADE_HOME nor
//                                ADE_RUNTIME_SOCKET_PATH is set (the shim's
//                                brain defaults)
//   prepend NAME=VALUE           VALUE;<existing value>
//   ifnone A,B NAME=VALUE        set only when none of A, B is set (the
//                                Node compile cache, as `ade.cmd` sets it)
//   unset NAME                   removed
//   ttynode 1                    run real Node instead of `exe` when
//                                ADE_CLI_NODE names one, or for `ade code`
//                                (Electron run as Node has no TTY on Windows,
//                                so the TUI cannot start under it); the same
//                                rule as ade-cli-windows-wrapper.cmd
//
// No job object: the CLI may start a detached brain that must outlive this
// process. Ctrl+C reaches the child, which shares this console; the launcher
// only waits. It ignores the event through a handler routine, not
// SetConsoleCtrlHandler(NULL, TRUE): that sets an ignore flag every child
// inherits, which would make the CLI impossible to interrupt.

#define WIN32_LEAN_AND_MEAN
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>

#include <string>
#include <vector>

namespace {

void writeError(const std::wstring& message) {
  HANDLE err = GetStdHandle(STD_ERROR_HANDLE);
  std::wstring line = L"ade: " + message + L"\r\n";
  if (err == NULL || err == INVALID_HANDLE_VALUE) return;
  DWORD mode = 0;
  DWORD written = 0;
  if (GetConsoleMode(err, &mode)) {
    WriteConsoleW(err, line.c_str(), static_cast<DWORD>(line.size()), &written, NULL);
    return;
  }
  int bytes = WideCharToMultiByte(CP_UTF8, 0, line.c_str(), static_cast<int>(line.size()), NULL, 0, NULL, NULL);
  if (bytes <= 0) return;
  std::string utf8(static_cast<size_t>(bytes), '\0');
  WideCharToMultiByte(CP_UTF8, 0, line.c_str(), static_cast<int>(line.size()), &utf8[0], bytes, NULL, NULL);
  WriteFile(err, utf8.data(), static_cast<DWORD>(utf8.size()), &written, NULL);
}

std::wstring widen(const std::string& value) {
  if (value.empty()) return std::wstring();
  int chars = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), NULL, 0);
  if (chars <= 0) return std::wstring();
  std::wstring out(static_cast<size_t>(chars), L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), &out[0], chars);
  return out;
}

bool readFile(const std::wstring& path, std::string& out) {
  HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                            NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) return false;
  LARGE_INTEGER size;
  if (!GetFileSizeEx(file, &size) || size.QuadPart > 1024 * 1024) {
    CloseHandle(file);
    return false;
  }
  out.resize(static_cast<size_t>(size.QuadPart));
  DWORD read = 0;
  BOOL ok = out.empty() ? TRUE : ReadFile(file, &out[0], static_cast<DWORD>(out.size()), &read, NULL);
  CloseHandle(file);
  if (!ok || read != out.size()) return false;
  return true;
}

// One argument quoted so CommandLineToArgvW and the MSVC CRT read it back
// unchanged.
std::wstring quoteArg(const std::wstring& arg) {
  if (!arg.empty() && arg.find_first_of(L" \t\n\v\"") == std::wstring::npos) return arg;
  std::wstring out = L"\"";
  for (size_t i = 0;; ++i) {
    size_t backslashes = 0;
    while (i < arg.size() && arg[i] == L'\\') {
      ++i;
      ++backslashes;
    }
    if (i >= arg.size()) {
      out.append(backslashes * 2, L'\\');
      break;
    }
    if (arg[i] == L'"') {
      out.append(backslashes * 2 + 1, L'\\');
      out.push_back(L'"');
    } else {
      out.append(backslashes, L'\\');
      out.push_back(arg[i]);
    }
  }
  out.push_back(L'"');
  return out;
}

// What follows argv[0] in this process's command line, verbatim. argv[0] is
// read the way the CRT reads it: a quoted name ends at the next quote, an
// unquoted one at the first space or tab.
const wchar_t* argumentsAfterProgramName(const wchar_t* line) {
  const wchar_t* p = line;
  if (*p == L'"') {
    ++p;
    while (*p && *p != L'"') ++p;
    if (*p == L'"') ++p;
  } else {
    while (*p && *p != L' ' && *p != L'\t') ++p;
  }
  while (*p == L' ' || *p == L'\t') ++p;
  return p;
}

bool envIsSet(const wchar_t* name) {
  return GetEnvironmentVariableW(name, NULL, 0) > 0;
}

bool splitAssignment(const std::wstring& value, std::wstring& name, std::wstring& assigned) {
  size_t equals = value.find(L'=');
  if (equals == std::wstring::npos || equals == 0) return false;
  name = value.substr(0, equals);
  assigned = value.substr(equals + 1);
  return true;
}

std::wstring sidecarPathFor(const std::wstring& modulePath) {
  size_t slash = modulePath.find_last_of(L"\\/");
  size_t dot = modulePath.find_last_of(L'.');
  std::wstring stem = (dot != std::wstring::npos && (slash == std::wstring::npos || dot > slash))
                          ? modulePath.substr(0, dot)
                          : modulePath;
  return stem + L".launch";
}

void makeInheritable(DWORD which) {
  HANDLE handle = GetStdHandle(which);
  if (handle != NULL && handle != INVALID_HANDLE_VALUE) {
    SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
  }
}

// Handlers, unlike the ignore flag, are not inherited by the child.
BOOL WINAPI ignoreInterrupt(DWORD event) {
  return event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT ? TRUE : FALSE;
}

// The first argument after the program name, unquoted, for the `code` check.
std::wstring firstArgument(const wchar_t* rest) {
  const wchar_t* p = rest;
  std::wstring out;
  if (*p == L'"') {
    ++p;
    while (*p && *p != L'"') out.push_back(*p++);
  } else {
    while (*p && *p != L' ' && *p != L'\t') out.push_back(*p++);
  }
  return out;
}

std::wstring envValue(const wchar_t* name) {
  DWORD size = GetEnvironmentVariableW(name, NULL, 0);
  if (size == 0) return std::wstring();
  std::vector<wchar_t> buffer(size);
  DWORD got = GetEnvironmentVariableW(name, buffer.data(), size);
  return std::wstring(buffer.data(), got);
}

// Runs `exe <args>` with no window and returns its exit code, or -1.
long runQuietly(const std::wstring& exe, const std::wstring& args) {
  std::wstring line = quoteArg(exe) + L" " + args;
  std::vector<wchar_t> mutableLine(line.begin(), line.end());
  mutableLine.push_back(L'\0');
  STARTUPINFOW startup;
  ZeroMemory(&startup, sizeof(startup));
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process;
  ZeroMemory(&process, sizeof(process));
  if (!CreateProcessW(exe.c_str(), mutableLine.data(), NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &startup, &process)) {
    return -1;
  }
  CloseHandle(process.hThread);
  DWORD code = 1;
  if (WaitForSingleObject(process.hProcess, 10000) != WAIT_OBJECT_0) {
    // A probe that hangs is a failed probe; it must not outlive the launcher.
    TerminateProcess(process.hProcess, 1);
  } else if (!GetExitCodeProcess(process.hProcess, &code)) {
    code = 1;
  }
  CloseHandle(process.hProcess);
  return static_cast<long>(code);
}

// A `node.exe` on PATH that is Node 22 or newer, or empty.
std::wstring findNode22() {
  std::vector<wchar_t> buffer(32768);
  DWORD length = SearchPathW(NULL, L"node.exe", NULL, static_cast<DWORD>(buffer.size()), buffer.data(), NULL);
  if (length == 0 || length >= buffer.size()) return std::wstring();
  std::wstring node(buffer.data(), length);
  long code = runQuietly(node, L"-e \"process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)\"");
  return code == 0 ? node : std::wstring();
}

}  // namespace

int wmain() {
  std::vector<wchar_t> moduleBuffer(32768);
  DWORD moduleLength = GetModuleFileNameW(NULL, moduleBuffer.data(), static_cast<DWORD>(moduleBuffer.size()));
  if (moduleLength == 0 || moduleLength >= moduleBuffer.size()) {
    writeError(L"the ADE CLI launcher could not find its own path.");
    return 127;
  }
  const std::wstring sidecar = sidecarPathFor(std::wstring(moduleBuffer.data(), moduleLength));

  std::string raw;
  if (!readFile(sidecar, raw)) {
    writeError(L"the ADE CLI launcher has no " + sidecar + L". Restart ADE so it writes one, or run ade.cmd.");
    return 127;
  }
  if (raw.size() >= 3 && static_cast<unsigned char>(raw[0]) == 0xEF && static_cast<unsigned char>(raw[1]) == 0xBB &&
      static_cast<unsigned char>(raw[2]) == 0xBF) {
    raw.erase(0, 3);
  }

  std::vector<std::wstring> lines;
  size_t start = 0;
  while (start <= raw.size()) {
    size_t end = raw.find('\n', start);
    std::string line = raw.substr(start, end == std::string::npos ? std::string::npos : end - start);
    if (!line.empty() && line.back() == '\r') line.pop_back();
    lines.push_back(widen(line));
    if (end == std::string::npos) break;
    start = end + 1;
  }
  if (lines.empty() || lines[0] != L"ade-launch 1") {
    writeError(L"the ADE CLI launcher does not understand " + sidecar + L". Update ADE, or run ade.cmd.");
    return 127;
  }

  const bool callerPickedBrain = envIsSet(L"ADE_HOME") || envIsSet(L"ADE_RUNTIME_SOCKET_PATH");
  std::wstring exe;
  std::vector<std::wstring> fixedArgs;
  bool ttyNode = false;
  for (size_t i = 1; i < lines.size(); ++i) {
    const std::wstring& line = lines[i];
    if (line.empty()) continue;
    size_t space = line.find(L' ');
    std::wstring key = space == std::wstring::npos ? line : line.substr(0, space);
    std::wstring value = space == std::wstring::npos ? std::wstring() : line.substr(space + 1);
    std::wstring name;
    std::wstring assigned;
    if (key == L"exe") {
      exe = value;
    } else if (key == L"arg") {
      fixedArgs.push_back(value);
    } else if (key == L"env" && splitAssignment(value, name, assigned)) {
      SetEnvironmentVariableW(name.c_str(), assigned.c_str());
    } else if (key == L"default" && splitAssignment(value, name, assigned)) {
      if (!callerPickedBrain) SetEnvironmentVariableW(name.c_str(), assigned.c_str());
    } else if (key == L"prepend" && splitAssignment(value, name, assigned)) {
      DWORD size = GetEnvironmentVariableW(name.c_str(), NULL, 0);
      std::wstring existing;
      if (size > 0) {
        std::vector<wchar_t> buffer(size);
        DWORD got = GetEnvironmentVariableW(name.c_str(), buffer.data(), size);
        existing.assign(buffer.data(), got);
      }
      std::wstring next = existing.empty() ? assigned : assigned + L";" + existing;
      SetEnvironmentVariableW(name.c_str(), next.c_str());
    } else if (key == L"unset" && !value.empty()) {
      SetEnvironmentVariableW(value.c_str(), NULL);
    } else if (key == L"ifnone") {
      size_t gap = value.find(L' ');
      if (gap != std::wstring::npos && splitAssignment(value.substr(gap + 1), name, assigned)) {
        std::wstring guards = value.substr(0, gap);
        bool anySet = false;
        size_t from = 0;
        while (from <= guards.size()) {
          size_t comma = guards.find(L',', from);
          std::wstring guard = guards.substr(from, comma == std::wstring::npos ? std::wstring::npos : comma - from);
          if (!guard.empty() && envIsSet(guard.c_str())) anySet = true;
          if (comma == std::wstring::npos) break;
          from = comma + 1;
        }
        if (!anySet) SetEnvironmentVariableW(name.c_str(), assigned.c_str());
      }
    } else if (key == L"ttynode") {
      ttyNode = value == L"1";
    }
    // Unknown directives are ignored, so a newer writer can add one an older
    // launcher safely skips.
  }
  if (exe.empty()) {
    writeError(L"the ADE CLI launcher's " + sidecar + L" names no program. Restart ADE, or run ade.cmd.");
    return 127;
  }

  std::wstring commandLine = quoteArg(exe);
  for (const std::wstring& arg : fixedArgs) {
    commandLine += L" ";
    commandLine += quoteArg(arg);
  }
  const wchar_t* rest = argumentsAfterProgramName(GetCommandLineW());
  if (ttyNode) {
    const std::wstring cliNode = envValue(L"ADE_CLI_NODE");
    if (!cliNode.empty()) {
      exe = cliNode;
    } else if (firstArgument(rest) == L"code") {
      const std::wstring node = findNode22();
      if (node.empty()) {
        writeError(L"'code' needs an interactive terminal, which the bundled ADE runtime cannot provide on Windows. "
                   L"Install Node.js 22 or newer and run this command again, or set ADE_CLI_NODE to a Node 22+ executable.");
        return 127;
      }
      exe = node;
    }
    commandLine = quoteArg(exe);
    for (const std::wstring& arg : fixedArgs) {
      commandLine += L" ";
      commandLine += quoteArg(arg);
    }
  }
  if (*rest) {
    commandLine += L" ";
    commandLine += rest;
  }
  std::vector<wchar_t> mutableCommandLine(commandLine.begin(), commandLine.end());
  mutableCommandLine.push_back(L'\0');

  makeInheritable(STD_INPUT_HANDLE);
  makeInheritable(STD_OUTPUT_HANDLE);
  makeInheritable(STD_ERROR_HANDLE);
  STARTUPINFOW startup;
  ZeroMemory(&startup, sizeof(startup));
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION process;
  ZeroMemory(&process, sizeof(process));

  // The child owns Ctrl+C: it shares this console and gets the event itself.
  // A handler routine is not inherited; the NULL/TRUE ignore flag would be.
  SetConsoleCtrlHandler(ignoreInterrupt, TRUE);
  // A bare name (ADE_CLI_NODE=node, as ade.cmd accepts) is found on PATH:
  // CreateProcessW searches only when it is given no application name.
  const bool bareName = exe.find_first_of(L"\\/:") == std::wstring::npos;
  if (!CreateProcessW(bareName ? NULL : exe.c_str(), mutableCommandLine.data(), NULL, NULL, TRUE, 0, NULL, NULL, &startup,
                      &process)) {
    DWORD error = GetLastError();
    writeError(L"could not start " + exe + L" (Windows error " + std::to_wstring(error) + L").");
    return 127;
  }
  CloseHandle(process.hThread);
  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD exitCode = 1;
  if (!GetExitCodeProcess(process.hProcess, &exitCode)) exitCode = 1;
  CloseHandle(process.hProcess);
  return static_cast<int>(exitCode);
}
