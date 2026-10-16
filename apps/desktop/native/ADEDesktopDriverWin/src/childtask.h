// How the host starts its engine inside the private (child) session it signs
// in. The host cannot create a process in another session itself, and the
// startup entry (HKCU Run) is not prompt: Explorer holds startup apps until
// the new session goes idle, which on a busy PC took longer than the host
// waits. A per-user logon task fires as Windows signs the session in, so the
// host registers one, scoped to this sign-in, for each start.

#pragma once

#include "common.h"

#include <string>

namespace ade {

// Registers (or replaces) task `name`: at the next sign-in of this user, run
// `path args` with the user's interactive token at normal priority. The
// trigger expires after `lifetimeSeconds`, and Windows deletes the task once
// it has, so a leftover from a crashed host never fires at a later sign-in.
// False when Task Scheduler refused; the reason is logged.
bool registerChildLaunchTask(const std::wstring& name, const std::wstring& path, const std::wstring& args,
                             int lifetimeSeconds);

// Deletes task `name`. Missing is fine.
void removeChildLaunchTask(const std::wstring& name);

}  // namespace ade
