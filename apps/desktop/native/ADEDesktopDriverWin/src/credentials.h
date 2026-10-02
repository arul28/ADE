#pragma once
#include "common.h"
#include <memory>

namespace ade {
// Passwords stay inside this native process and Windows Credential Manager.
// They never enter JSON, command-line arguments, logs, or the renderer.
struct WindowsCredential {
  std::wstring username;
  std::vector<wchar_t> password;
  WindowsCredential() = default;
  WindowsCredential(const WindowsCredential&) = delete;
  WindowsCredential& operator=(const WindowsCredential&) = delete;
  ~WindowsCredential() { if (!password.empty()) SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t)); }
};
std::wstring credentialTarget(const std::wstring& home);
bool credentialSaved(const std::wstring& target);
std::unique_ptr<WindowsCredential> readCredential(const std::wstring& target);
std::unique_ptr<WindowsCredential> promptCredential(HWND owner, const std::atomic<bool>& stopping, int64_t deadline);
void saveCredential(const std::wstring& target, const WindowsCredential& credential);
void forgetCredential(const std::wstring& target);
}  // namespace ade
