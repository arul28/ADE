#include "childtask.h"

#define SECURITY_WIN32
#include <security.h>
#include <taskschd.h>

#include <cstdio>

namespace ade {
namespace {

template <class T>
struct Com {
  T* p = nullptr;
  ~Com() { if (p) p->Release(); }
  T** out() { return &p; }
  void** raw() { return reinterpret_cast<void**>(&p); }
  T* operator->() const { return p; }
};

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

bool connectRoot(Com<ITaskService>& service, Com<ITaskFolder>& folder) {
  HRESULT hr = CoCreateInstance(__uuidof(TaskScheduler), nullptr, CLSCTX_INPROC_SERVER, __uuidof(ITaskService), service.raw());
  VARIANT none;
  VariantInit(&none);
  if (SUCCEEDED(hr)) hr = service->Connect(none, none, none, none);
  Bstr root(L"\\");
  if (SUCCEEDED(hr)) hr = service->GetFolder(root.value, folder.out());
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
  Com<ITaskService> service;
  Com<ITaskFolder> folder;
  if (!connectRoot(service, folder)) return false;
  Com<ITaskDefinition> task;
  HRESULT hr = service->NewTask(0, task.out());
  const auto failed = [&](const char* step) {
    logLine(std::string("child-task: ") + step + " failed hr=" + hex(hr));
    return false;
  };
  if (FAILED(hr)) return failed("new task");

  Com<IRegistrationInfo> info;
  if (SUCCEEDED(task->get_RegistrationInfo(info.out()))) {
    Bstr author(L"ADE");
    Bstr description(L"Starts ADE's private Windows screen when ADE signs it in. ADE removes it after that sign-in.");
    info->put_Author(author.value);
    info->put_Description(description.value);
  }

  Com<IPrincipal> principal;
  hr = task->get_Principal(principal.out());
  if (FAILED(hr)) return failed("principal");
  Bstr userId(user);
  principal->put_UserId(userId.value);
  principal->put_LogonType(TASK_LOGON_INTERACTIVE_TOKEN);
  principal->put_RunLevel(TASK_RUNLEVEL_LUA);

  Com<ITaskSettings> settings;
  hr = task->get_Settings(settings.out());
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

  Com<ITriggerCollection> triggers;
  Com<ITrigger> trigger;
  Com<ILogonTrigger> logon;
  hr = task->get_Triggers(triggers.out());
  if (SUCCEEDED(hr)) hr = triggers->Create(TASK_TRIGGER_LOGON, trigger.out());
  if (SUCCEEDED(hr)) hr = trigger->QueryInterface(__uuidof(ILogonTrigger), logon.raw());
  if (FAILED(hr)) return failed("trigger");
  Bstr endBoundary(localTimeIn(lifetimeSeconds));
  logon->put_UserId(userId.value);
  hr = logon->put_EndBoundary(endBoundary.value);
  if (FAILED(hr)) return failed("trigger expiry");

  Com<IActionCollection> actions;
  Com<IAction> action;
  Com<IExecAction> exec;
  hr = task->get_Actions(actions.out());
  if (SUCCEEDED(hr)) hr = actions->Create(TASK_ACTION_EXEC, action.out());
  if (SUCCEEDED(hr)) hr = action->QueryInterface(__uuidof(IExecAction), exec.raw());
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
  Com<IRegisteredTask> registered;
  hr = folder->RegisterTaskDefinition(taskName.value, task.p, TASK_CREATE_OR_UPDATE, account, password,
                                      TASK_LOGON_INTERACTIVE_TOKEN, sddl, registered.out());
  if (FAILED(hr)) return failed("register");
  logLine("child-task: registered for the next sign-in");
  return true;
}

void removeChildLaunchTask(const std::wstring& name) {
  Com<ITaskService> service;
  Com<ITaskFolder> folder;
  if (!connectRoot(service, folder)) return;
  Bstr taskName(name);
  const HRESULT hr = folder->DeleteTask(taskName.value, 0);
  if (FAILED(hr) && hr != HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)) logLine("child-task: not removed hr=" + hex(hr));
}

}  // namespace ade
