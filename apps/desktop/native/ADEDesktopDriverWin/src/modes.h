// The driver's process modes. One binary, started three ways:
//
//   ade-desktop-driver.exe host [--ade-home <dir>]
//       Started by the brain in the console session, NDJSON on stdin/stdout.
//       Owns the private screen's lifecycle and the shared desktop.
//   ade-desktop-driver.exe child --pipe <base>
//       Started inside the private (child) session by a one-use logon task
//       the host registers (childtask.h), or, as a fallback, by ADE's Run
//       entry from <adeDir>\windows-desktop\child-launch.json. Serves the
//       engine over two named pipes back to the host.
//   ade-desktop-driver.exe setup-elevated
//       Started elevated by the host for the one-time setup: turns on child
//       sessions and allows local Remote Desktop. Exit code 0 on success.

#pragma once

#include <string>

namespace ade {

int runHost(const std::wstring& adeHome);
int runChild(const std::wstring& pipeBase);
int runSetupElevated();
int runSetupPrompt();

// cleanup-child --session <id> is an internal recovery helper: it only signs
// out that exact child of its console session after a host hard timeout.

// Two one-way pipes, because a synchronous pipe handle serializes a blocking
// read against a write on the same handle.
inline std::wstring pipeToChild(const std::wstring& base) { return base + L"-in"; }
inline std::wstring pipeFromChild(const std::wstring& base) { return base + L"-out"; }

}  // namespace ade
