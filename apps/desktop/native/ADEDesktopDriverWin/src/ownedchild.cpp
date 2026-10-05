#include "ownedchild.h"
#include "rdp.h"

#include <fstream>
#include <iterator>

namespace ade {

std::wstring OwnedChildRecord::file() const { return joinPath(joinPath(home_, L"windows-desktop"), L"owned-child.json"); }

void OwnedChildRecord::remember(DWORD session) {
  if (!session) return;
  SessionIdentity identity;
  if (!querySessionIdentity(session, &identity) || (!identity.logonTime && !identity.connectTime)) return;
  // FILETIME ticks exceed a double's exact range: kept as decimal strings.
  const std::string record = Json(Json::Object{{"sessionId", static_cast<int64_t>(session)},
      {"user", narrow(identity.user)}, {"logonTime", std::to_string(identity.logonTime)},
      {"connectTime", std::to_string(identity.connectTime)}}).dump();
  if (record == record_) return;
  if (!ensureDir(joinPath(home_, L"windows-desktop"))) return;
  const auto target = file();
  const auto temp = target + L".tmp";
  {
    std::ofstream out(temp, std::ios::binary | std::ios::trunc);
    out << record;
    out.close();
    if (!out) { DeleteFileW(temp.c_str()); logLine("owned-child: record not written"); return; }
  }
  if (!MoveFileExW(temp.c_str(), target.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
    logLine("owned-child: record not written error=" + std::to_string(GetLastError()));
    DeleteFileW(temp.c_str());
    return;
  }
  record_ = record;
  logLine("owned-child: recorded child=" + std::to_string(session));
}

void OwnedChildRecord::forget() {
  record_.clear();
  DeleteFileW(file().c_str());
}

bool OwnedChildRecord::adopt(DWORD existing, std::atomic<DWORD>& cleanupSession) {
  std::ifstream in(file(), std::ios::binary);
  if (!in) return false;
  const std::string text((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  in.close();
  Json record;
  try { record = Json::parse(text); } catch (...) { forget(); return false; }
  SessionIdentity identity;
  const bool same = record.isObject()
      && record["sessionId"].asInt(0) == static_cast<int64_t>(existing)
      && querySessionIdentity(existing, &identity)
      && (identity.logonTime || identity.connectTime)
      && lower(widen(record["user"].str())) == lower(identity.user)
      && record["logonTime"].str() == std::to_string(identity.logonTime)
      && record["connectTime"].str() == std::to_string(identity.connectTime);
  if (!same) {
    // What ADE recorded is gone: the one child slot now holds another session.
    logLine("owned-child: the existing child session is not the one ADE recorded; leaving it alone");
    forget();
    return false;
  }
  logLine("owned-child: signing out the private session a previous ADE driver started child=" + std::to_string(existing));
  cleanupSession = existing;
  const bool signedOut = signOutSession(existing, nowMs() + 10'000);
  cleanupSession = 0;
  if (signedOut) forget();
  return signedOut;
}

void OwnedChildRecord::requireNoForeign(std::atomic<DWORD>& cleanupSession) {
  const DWORD existing = childSessionId();
  if (!existing) {
    if (fileExists(file())) forget();  // Ours is already gone.
    return;
  }
  if (adopt(existing, cleanupSession) && !childSessionId()) return;
  fail(code::kHeld, "Another private Windows session is signed in on this PC (session " + std::to_string(existing)
      + "), and ADE did not start it, so ADE leaves it alone: it may be Power Automate or a Windows agent workspace. "
      "Sign it out in Task Manager > Users (or run `logoff " + std::to_string(existing) + "`), then try again, or use the shared desktop.");
}

}  // namespace ade
