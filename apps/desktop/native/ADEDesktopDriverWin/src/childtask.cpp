#include "childtask.h"

#define SECURITY_WIN32
#include <security.h>
#include <taskschd.h>
#include <wrl/client.h>

#include <cstdio>

namespace ade {
namespace {
using Microsoft::WRL::ComPtr;

struct Bstr {
  BSTR value;
  explicit Bstr(const std::wstring& text) : value(SysAllocString(text.c_str())) {}
  ~Bstr() { SysFreeString(value); }
  Bstr(const Bstr&) = delete;
  Bstr& operator=(const Bstr&) = delete;
};

std::string hex(HRESULT hr) {
  char buffer[16];
  std::snprintf(buffer, sizeof(buffer), "0x%08lx", static_cast<unsigned long>(hr));
  return buffer;
}

bool connectRoot(ComPtr<ITaskService>& service, ComPtr<ITaskFolder>& folder) {
  HRESULT hr = CoCreateInstance(__uuidof(TaskScheduler), nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&service));
  VARIANT none;
  VariantInit(&none);
  if (SUCCEEDED(hr)) hr = service->Connect(none, none, none, none);
  Bstr root(L"\\");
  if (SUCCEEDED(hr)) hr = service->GetFolder(root.value, folder.GetAddressOf());
  if (FAILED(hr)) logLine("child-task: Task Scheduler unavailable hr=" + hex(hr));
  return SUCCEEDED(hr);
}

// DOMAIN\user, the form both the principal and the logon trigger take.
std::wstring currentUser() {
  wchar_t name[512] = {};
  ULONG size = 512;
  return GetUserNameExW(NameSamCompatible, name, &size) ? std::wstring(name) : std::wstring();
}

// Task Scheduler's local "YYYY-MM-DDTHH:MM:SS", `seconds` from now.
std::wstring localTimeIn(int seconds) {
  FILETIME now;
  GetSystemTimeAsFileTime(&now);
  ULARGE_INTEGER ticks;
  ticks.LowPart = now.dwLowDateTime;
  ticks.HighPart = now.dwHighDateTime;
  ticks.QuadPart += static_cast<ULONGLONG>(seconds) * 10'000'000ULL;
  FILETIME later{ticks.LowPart, ticks.HighPart}, local;
  SYSTEMTIME st;
  FileTimeToLocalFileTime(&later, &local);
  FileTimeToSystemTime(&local, &st);
  wchar_t buffer[32];
  swprintf(buffer, 32, L"%04u-%02u-%02uT%02u:%02u:%02u", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
  return buffer;
}

}  // namespace

bool registerChildLaunchTask(const std::wstring& name, const std::wstring& path, const std::wstring& args,
                             int lifetimeSeconds) {
  const std::wstring user = currentUser();
  if (user.empty()) { logLine("child-task: this account has no name for Task Scheduler"); return false; }
  ComPtr<ITaskService> service;
  ComPtr<ITaskFolder> folder;
  if (!connectRoot(service, folder)) return false;
  ComPtr<ITaskDefinition> task;
  HRESULT hr = service->NewTask(0, task.GetAddressOf());
  const auto failed = [&](const char* step) {
    logLine(std::string("child-task: ") + step + " failed hr=" + hex(hr));
    return false;
  };
  if (FAILED(hr)) return failed("new task");

  ComPtr<IRegistrationInfo> info;
  if (SUCCEEDED(task->get_RegistrationInfo(info.GetAddressOf()))) {
    Bstr author(L"ADE");
    Bstr description(L"Starts ADE's private Windows screen when ADE signs it in. ADE removes it after that sign-in.");
    info->put_Author(author.value);
    info->put_Description(description.value);
  }

  ComPtr<IPrincipal> principal;
  hr = task->get_Principal(principal.GetAddressOf());
  if (FAILED(hr)) return failed("principal");
  Bstr userId(user);
  principal->put_UserId(userId.value);
  principal->put_LogonType(TASK_LOGON_INTERACTIVE_TOKEN);
  principal->put_RunLevel(TASK_RUNLEVEL_LUA);

  ComPtr<ITaskSettings> settings;
  hr = task->get_Settings(settings.GetAddressOf());
  if (FAILED(hr)) return failed("settings");
  Bstr noLimit(L"PT0S");
  settings->put_DisallowStartIfOnBatteries(VARIANT_FALSE);
  settings->put_StopIfGoingOnBatteries(VARIANT_FALSE);
  settings->put_ExecutionTimeLimit(noLimit.value);
  settings->put_MultipleInstances(TASK_INSTANCES_PARALLEL);
  // 4 is an ordinary app's. The default, 7, also lowers memory and I/O
  // priority, and the engine then stalls in page-ins on a busy PC.
  settings->put_Priority(4);
  // With every trigger expired, Windows deletes the task itself.
  settings->put_DeleteExpiredTaskAfter(noLimit.value);

  ComPtr<ITriggerCollection> triggers;
  ComPtr<ITrigger> trigger;
  ComPtr<ILogonTrigger> logon;
  hr = task->get_Triggers(triggers.GetAddressOf());
  if (SUCCEEDED(hr)) hr = triggers->Create(TASK_TRIGGER_LOGON, trigger.GetAddressOf());
  if (SUCCEEDED(hr)) hr = trigger.As(&logon);
  if (FAILED(hr)) return failed("trigger");
  Bstr endBoundary(localTimeIn(lifetimeSeconds));
  logon->put_UserId(userId.value);
  hr = logon->put_EndBoundary(endBoundary.value);
  if (FAILED(hr)) return failed("trigger expiry");

  ComPtr<IActionCollection> actions;
  ComPtr<IAction> action;
  ComPtr<IExecAction> exec;
  hr = task->get_Actions(actions.GetAddressOf());
  if (SUCCEEDED(hr)) hr = actions->Create(TASK_ACTION_EXEC, action.GetAddressOf());
  if (SUCCEEDED(hr)) hr = action.As(&exec);
  if (FAILED(hr)) return failed("action");
  Bstr program(path), arguments(args);
  exec->put_Path(program.value);
  exec->put_Arguments(arguments.value);

  Bstr taskName(name);
  VARIANT account, password, sddl;
  VariantInit(&account);
  VariantInit(&password);
  VariantInit(&sddl);
  account.vt = VT_BSTR;
  account.bstrVal = userId.value;
  ComPtr<IRegisteredTask> registered;
  hr = folder->RegisterTaskDefinition(taskName.value, task.Get(), TASK_CREATE_OR_UPDATE, account, password,
                                      TASK_LOGON_INTERACTIVE_TOKEN, sddl, registered.GetAddressOf());
  if (FAILED(hr)) return failed("register");
  logLine("child-task: registered for the next sign-in");
  return true;
}

void removeChildLaunchTask(const std::wstring& name) {
  ComPtr<ITaskService> service;
  ComPtr<ITaskFolder> folder;
  if (!connectRoot(service, folder)) return;
  Bstr taskName(name);
  const HRESULT hr = folder->DeleteTask(taskName.value, 0);
  if (FAILED(hr) && hr != HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)) logLine("child-task: not removed hr=" + hex(hr));
}

}  // namespace ade
