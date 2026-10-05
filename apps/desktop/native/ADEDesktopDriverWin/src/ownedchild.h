// Which child session this driver started survives the driver: a driver that
// replaces a crashed one signs out exactly that session (same id, account,
// logon and connect time) and nothing else. Windows allows one child session
// per console session, and one ADE did not start (Power Automate, a Windows
// agent workspace) is never signed out.
//
// The record is <ADE home>\windows-desktop\owned-child.json, written
// atomically and removed on sign-out.

#pragma once

#include "common.h"

#include <atomic>
#include <string>

namespace ade {

class OwnedChildRecord {
 public:
  explicit OwnedChildRecord(std::wstring home) : home_(std::move(home)) {}

  std::wstring file() const;
  // Records `session` as the child this driver started. No-op for 0.
  void remember(DWORD session);
  void forget();
  // True when `existing` is exactly the child a previous ADE driver recorded
  // and it is now signed out. Anything else is left alone. `cleanupSession`
  // names the session being signed out while it happens.
  bool adopt(DWORD existing, std::atomic<DWORD>& cleanupSession);
  // Refuses with HELD while a child session this driver may not sign out
  // exists, after adopting one a crashed ADE driver left behind.
  void requireNoForeign(std::atomic<DWORD>& cleanupSession);

 private:
  std::wstring home_;
  std::string record_;  // The owned-child.json this driver last wrote.
};

}  // namespace ade
