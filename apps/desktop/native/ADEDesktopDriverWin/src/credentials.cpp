#include "credentials.h"
#include <wincred.h>
#define SECURITY_WIN32
#include <security.h>
#include <secext.h>
#include <lm.h>
#pragma comment(lib, "netapi32.lib")

namespace ade {
std::string credentialAccountKind(const std::wstring& username) {
  const auto separator = username.find(L'\\');
  if (separator != std::wstring::npos) {
    const auto prefix = username.substr(0, separator);
    if (_wcsicmp(prefix.c_str(), L"MicrosoftAccount") == 0) return "microsoft";
    wchar_t computer[MAX_COMPUTERNAME_LENGTH + 1] = {};
    DWORD size = ARRAYSIZE(computer);
    if (prefix == L"." || (GetComputerNameW(computer, &size) && _wcsicmp(prefix.c_str(), computer) == 0)) return "local";
    return "domain";
  }
  return username.find(L'@') == std::wstring::npos ? "local" : "domain";
}
std::wstring credentialTarget(const std::wstring& home) {
  uint64_t hash = 14695981039346656037ULL;
  for (wchar_t c : lower(home)) { hash ^= static_cast<uint64_t>(c); hash *= 1099511628211ULL; }
  return L"ADE/WindowsDesktop/" + std::to_wstring(hash);
}

std::unique_ptr<WindowsCredential> readCredential(const std::wstring& target) {
  PCREDENTIALW stored = nullptr;
  if (!CredReadW(target.c_str(), CRED_TYPE_GENERIC, 0, &stored)) {
    if (GetLastError() == ERROR_NOT_FOUND) return nullptr;
    fail(code::kDriverUnavailable, "Windows could not open the saved screen credential.");
  }
  struct Release { PCREDENTIALW value; ~Release() {
    if (value->CredentialBlob) SecureZeroMemory(value->CredentialBlob, value->CredentialBlobSize);
    CredFree(value);
  } } release{stored};
  if (!stored->UserName || !stored->CredentialBlobSize || stored->CredentialBlobSize % sizeof(wchar_t) || stored->CredentialBlobSize > CRED_MAX_CREDENTIAL_BLOB_SIZE)
    fail(code::kDriverUnavailable, "The saved screen credential is invalid. Forget it and save it again.");
  auto out = std::make_unique<WindowsCredential>();
  out->username = stored->UserName;
  const auto* value = reinterpret_cast<const wchar_t*>(stored->CredentialBlob);
  out->password.resize(stored->CredentialBlobSize / sizeof(wchar_t) + 1, 0);
  memcpy(out->password.data(), value, stored->CredentialBlobSize);
  return out;
}

bool credentialSaved(const std::wstring& target) {
  PCREDENTIALW stored = nullptr;
  if (!CredReadW(target.c_str(), CRED_TYPE_GENERIC, 0, &stored)) return false;
  bool exists = stored->UserName && stored->CredentialBlobSize > 0;
  if (stored->CredentialBlob) SecureZeroMemory(stored->CredentialBlob, stored->CredentialBlobSize);
  CredFree(stored);
  return exists;
}

namespace {
struct PromptWait { HWND owner; int64_t deadline; const std::atomic<bool>* stopping; bool cancelled = false; };
thread_local PromptWait* promptWait = nullptr;
void CALLBACK cancelPrompt(HWND, UINT, UINT_PTR, DWORD) {
  if (!promptWait || (!promptWait->stopping->load() && nowMs() < promptWait->deadline)) return;
  if (!promptWait->cancelled) logLine("save: prompt deadline/cancellation; closing owned dialog");
  promptWait->cancelled = true;
  EnumThreadWindows(GetCurrentThreadId(), [](HWND window, LPARAM owner) -> BOOL {
    if (GetWindow(window, GW_OWNER) == reinterpret_cast<HWND>(owner)) {
      PostMessageW(window, WM_COMMAND, MAKEWPARAM(IDCANCEL, BN_CLICKED), 0);
      PostMessageW(window, WM_CLOSE, 0, 0);
    }
    return TRUE;
  }, reinterpret_cast<LPARAM>(promptWait->owner));
}
}
std::unique_ptr<WindowsCredential> promptCredential(HWND owner, const std::atomic<bool>& stopping, int64_t deadline) {
  wchar_t username[CREDUI_MAX_USERNAME_LENGTH + 1] = {};
  ULONG size = ARRAYSIZE(username);
  if (!GetUserNameExW(NameSamCompatible, username, &size)) username[0] = 0;
  // Level 24 resolves the Windows account's connected Internet identity; do
  // not infer a Microsoft account from a shortened SAM name or registry cache.
  wchar_t localName[UNLEN + 1] = {};
  DWORD localSize = ARRAYSIZE(localName);
  LPBYTE account = nullptr;
  const NET_API_STATUS identityResult = GetUserNameW(localName, &localSize)
      ? NetUserGetInfo(nullptr, localName, 24, &account) : ERROR_INVALID_NAME;
  logLine("save: account resolution result=" + std::to_string(identityResult));
  if (identityResult == NERR_Success) {
    auto* identity = reinterpret_cast<USER_INFO_24*>(account);
    HANDLE token = nullptr;
    DWORD bytes = 0;
    std::vector<BYTE> user;
    bool sameUser = false;
    if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
      GetTokenInformation(token, TokenUser, nullptr, 0, &bytes);
      user.resize(bytes);
      sameUser = GetTokenInformation(token, TokenUser, user.data(), bytes, &bytes) &&
          identity->usri24_user_sid && EqualSid(identity->usri24_user_sid,
              reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid);
      CloseHandle(token);
    }
    logLine("save: identity microsoft=" + std::to_string(identity->usri24_internet_provider_name && _wcsicmp(identity->usri24_internet_provider_name, L"MicrosoftAccount") == 0) +
        " connected=" + std::to_string(identity->usri24_internet_identity) + " matchesCurrentSid=" + std::to_string(sameUser));
    if (sameUser && identity->usri24_internet_identity && identity->usri24_internet_provider_name &&
        _wcsicmp(identity->usri24_internet_provider_name, L"MicrosoftAccount") == 0 &&
        identity->usri24_internet_principal_name && *identity->usri24_internet_principal_name) {
      auto principal = std::wstring(L"MicrosoftAccount\\") + identity->usri24_internet_principal_name;
      if (principal.size() < ARRAYSIZE(username)) wcscpy_s(username, principal.c_str());
    }
    NetApiBufferFree(account);
  }
  auto credential = std::make_unique<WindowsCredential>();
  credential->password.resize(CREDUI_MAX_PASSWORD_LENGTH + 1);
  CREDUI_INFOW info = {sizeof(info)};
  info.hwndParent = owner;
  info.pszCaptionText = L"Save your Windows password for ADE";
  info.pszMessageText = L"Enter your Windows password, not your PIN. ADE checks it before saving it on this PC.";
  BOOL save = FALSE;
  PromptWait wait{owner, deadline, &stopping};
  promptWait = &wait;
  UINT_PTR timer = SetTimer(nullptr, 0, 250, cancelPrompt);
  if (!timer) { promptWait = nullptr; fail(code::kDriverUnavailable, "Windows could not open a cancellable password dialog."); }
  struct Timer { UINT_PTR value; ~Timer() { KillTimer(nullptr, value); promptWait = nullptr; } } cleanup{timer};
  logLine("save: prompt opened accountPresent=" + std::to_string(*username != 0) + " accountKind=" + credentialAccountKind(username));
  DWORD result = CredUIPromptForCredentialsW(&info, L"ADE private Windows screen", nullptr, 0,
      username, ARRAYSIZE(username), credential->password.data(), static_cast<ULONG>(credential->password.size()), &save,
      CREDUI_FLAGS_GENERIC_CREDENTIALS | CREDUI_FLAGS_ALWAYS_SHOW_UI | CREDUI_FLAGS_DO_NOT_PERSIST | CREDUI_FLAGS_EXCLUDE_CERTIFICATES);
  logLine("save: prompt result=" + std::to_string(result) + " cancelled=" + std::to_string(wait.cancelled));
  if (wait.cancelled || stopping) fail(code::kCancelled, "The Windows password dialog timed out or was cancelled.");
  if (result == ERROR_CANCELLED) fail(code::kCancelled, "Saving the Windows password was cancelled.");
  if (result != NO_ERROR) fail(code::kDriverUnavailable, "Windows could not open the password dialog.");
  credential->username = username;
  logLine("save: submitted accountPresent=" + std::to_string(!credential->username.empty()) + " accountKind=" + credentialAccountKind(credential->username));
  size_t length = wcslen(credential->password.data());
  if (!length || credential->username.empty()) fail(code::kInvalidArgument, "Enter a Windows user name and password.");
  // Preserve the allocated buffer so its entire capacity is wiped on destruction.
  credential->password[length] = 0;
  return credential;
}

void saveCredential(const std::wstring& target, const WindowsCredential& credential) {
  CREDENTIALW stored = {};
  stored.Type = CRED_TYPE_GENERIC;
  stored.TargetName = const_cast<wchar_t*>(target.c_str());
  stored.UserName = const_cast<wchar_t*>(credential.username.c_str());
  stored.CredentialBlobSize = static_cast<DWORD>(wcslen(credential.password.data()) * sizeof(wchar_t));
  stored.CredentialBlob = reinterpret_cast<LPBYTE>(const_cast<wchar_t*>(credential.password.data()));
  stored.Persist = CRED_PERSIST_LOCAL_MACHINE;
  if (!CredWriteW(&stored, 0)) fail(code::kDriverUnavailable, "Windows could not save the screen credential.");
}
void forgetCredential(const std::wstring& target) {
  if (!CredDeleteW(target.c_str(), CRED_TYPE_GENERIC, 0) && GetLastError() != ERROR_NOT_FOUND)
    fail(code::kDriverUnavailable, "Windows could not forget the screen credential.");
}
}  // namespace ade
