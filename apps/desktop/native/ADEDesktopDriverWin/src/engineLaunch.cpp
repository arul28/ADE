#include "engineLane.h"

namespace ade {
namespace {
// Apps that hand a second launch to their running instance (one per profile).
// On the private seat that instance is the user's own, in the console session,
// so the launch would open on the user's desktop and nothing on the lane's.
enum class ProfileFlag { None, Chromium, Firefox };
ProfileFlag profileFlagFor(const std::wstring& exeName) {
  static const wchar_t* chromium[] = {L"chrome.exe", L"msedge.exe", L"brave.exe", L"vivaldi.exe", L"chromium.exe"};
  const auto name = lower(exeName);
  for (auto c : chromium) if (name == c) return ProfileFlag::Chromium;
  if (name == L"firefox.exe" || name == L"librewolf.exe" || name == L"waterfox.exe") return ProfileFlag::Firefox;
  return ProfileFlag::None;
}
bool callerChoseProfile(ProfileFlag kind, const std::vector<std::wstring>& args) {
  for (const auto& raw : args) {
    const auto a = lower(raw);
    if (kind == ProfileFlag::Chromium && a.rfind(L"--user-data-dir", 0) == 0) return true;
    if (kind == ProfileFlag::Firefox && (a == L"-profile" || a == L"--profile" || a == L"-p" || a == L"-no-remote" ||
                                        a == L"--no-remote" || a.rfind(L"--profile=", 0) == 0)) return true;
  }
  return false;
}
}  // namespace

Json addLaneBrowserProfile(const std::wstring& target, const std::wstring& laneDataDir, std::vector<std::wstring>& args) {
  // "chrome" names chrome.exe; the stem names the profile directory.
  std::wstring exeName = baseName(target);
  if (exeName.find(L'.') == std::wstring::npos) exeName += L".exe";
  const ProfileFlag profileKind = profileFlagFor(exeName);
  if (profileKind == ProfileFlag::None || laneDataDir.empty() || callerChoseProfile(profileKind, args)) return Json();
  std::wstring stem = lower(exeName);
  if (stem.size() > 4 && stem.substr(stem.size() - 4) == L".exe") stem.resize(stem.size() - 4);
  const std::wstring dir = joinPath(joinPath(laneDataDir, L"profiles"), stem);
  if (!ensureDir(dir)) {
    logLine("launch: lane profile directory unavailable; launching without one");
    return Json();
  }
  // Stable per lane, so sign-ins in this lane's browser persist for the lane.
  if (profileKind == ProfileFlag::Chromium) {
    args.insert(args.begin(), {L"--user-data-dir=" + dir, L"--no-first-run", L"--no-default-browser-check"});
  } else {
    args.insert(args.begin(), {L"-no-remote", L"-profile", dir});
  }
  logLine("launch: lane-private browser profile added");
  return Json(narrow(dir));
}
}  // namespace ade
