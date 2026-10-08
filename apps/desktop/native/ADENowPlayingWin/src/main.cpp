// ade-now-playing.exe: what Windows says is playing, as NDJSON.
//
// Reads the Global System Media Transport Controls (the same source as the
// volume flyout and lock screen), so it works with any player that reports to
// the OS: browsers, Spotify, Apple Music, Windows Media Player, VLC.
//
// stdout: one JSON object per line.
//   {"type":"sessions","current":"<id>"|null,"sessions":[{
//     "id":"<id>","app":"<AppUserModelId>","title":"...","artist":"...","album":"...",
//     "status":"playing|paused|stopped|changing|closed|opened","positionMs":0,"durationMs":0,
//     "updatedAtMs":0,"canPlay":true,"canPause":true,"canNext":true,"canPrevious":true,
//     "artwork":"data:image/...;base64,..."|null,
//     "icon":"data:image/png;base64,..."|null,"name":"Spotify"|null}, ...]}
//   {"type":"error","message":"..."}
// Every session the OS lists is sent, not only the one Windows calls current,
// so ADE can skip its own and offer a switcher. "artwork" is present only when
// it changed for that session since the last line (null when the new track has
// none); "icon" and "name" (the app's shell icon and display name) only on the
// first line that carries that session. A reader keeps what it saw before.
// stdin: one command per line: `play|pause|toggle|next|previous [<id>]` | quit.
// Without an id a command goes to the session Windows calls current.
//
// The process exits when stdin closes, so it never outlives ADE. It only runs
// while a Now Playing widget is on screen; ADE starts and stops it.

#include <windows.h>
#include <wincrypt.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <tlhelp32.h>
#include <wincodec.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <iostream>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Media.Control.h>
#include <winrt/Windows.Storage.Streams.h>

#pragma comment(lib, "windowsapp.lib")
#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "windowscodecs.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "gdi32.lib")

using namespace winrt;
using winrt::Windows::Foundation::DateTime;
using winrt::Windows::Foundation::TimeSpan;
using namespace Windows::Media::Control;
using namespace Windows::Storage::Streams;

namespace {

std::mutex g_mutex;
std::condition_variable g_wake;
bool g_dirty = true;
std::atomic<bool> g_quit{false};
std::mutex g_out;

void Signal() {
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_dirty = true;
  }
  g_wake.notify_one();
}

std::string Utf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(CP_UTF8, 0, value.c_str(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  std::string out(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.c_str(), static_cast<int>(value.size()), out.data(), size, nullptr, nullptr);
  return out;
}

std::string Utf8(const hstring& value) { return Utf8(std::wstring(value.c_str(), value.size())); }

std::string Json(const std::string& value) {
  std::string out = "\"";
  for (const unsigned char c : value) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buffer[8];
          std::snprintf(buffer, sizeof(buffer), "\\u%04x", c);
          out += buffer;
        } else {
          out += static_cast<char>(c);
        }
    }
  }
  return out + "\"";
}

void Emit(const std::string& line) {
  std::lock_guard<std::mutex> lock(g_out);
  std::fwrite(line.data(), 1, line.size(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}

const char* StatusName(GlobalSystemMediaTransportControlsSessionPlaybackStatus status) {
  switch (status) {
    case GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing: return "playing";
    case GlobalSystemMediaTransportControlsSessionPlaybackStatus::Paused: return "paused";
    case GlobalSystemMediaTransportControlsSessionPlaybackStatus::Stopped: return "stopped";
    case GlobalSystemMediaTransportControlsSessionPlaybackStatus::Changing: return "changing";
    case GlobalSystemMediaTransportControlsSessionPlaybackStatus::Opened: return "opened";
    default: return "closed";
  }
}

long long ToMs(TimeSpan span) {
  return std::chrono::duration_cast<std::chrono::milliseconds>(span).count();
}

long long ToUnixMs(DateTime time) {
  // FILETIME ticks (100 ns since 1601) to Unix ms.
  const long long ticks = time.time_since_epoch().count();
  return (ticks - 116444736000000000LL) / 10000;
}

std::string Base64(const uint8_t* bytes, DWORD size) {
  DWORD length = 0;
  CryptBinaryToStringA(bytes, size, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &length);
  std::string base64(length, '\0');
  CryptBinaryToStringA(bytes, size, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, base64.data(), &length);
  base64.resize(length);
  return base64;
}

// The artwork as a data URL, read once per track (it is the expensive part).
std::string ReadArtwork(const IRandomAccessStreamReference& reference) {
  if (!reference) return {};
  try {
    auto stream = reference.OpenReadAsync().get();
    const auto size = static_cast<uint32_t>(std::min<uint64_t>(stream.Size(), 4u * 1024u * 1024u));
    if (size == 0) return {};
    DataReader reader(stream);
    reader.LoadAsync(size).get();
    std::vector<uint8_t> bytes(size);
    reader.ReadBytes(bytes);
    std::string type = Utf8(stream.ContentType());
    if (type.empty() || type.find("image/") != 0) type = "image/png";
    return "data:" + type + ";base64," + Base64(bytes.data(), size);
  } catch (...) {
    return {};
  }
}

// ── App icons ───────────────────────────────────────────────────────────────
// The player's own icon, as Explorer draws it: `shell:AppsFolder\<AUMID>`
// covers Store apps and desktop apps with a registered id (Chrome, Edge,
// Firefox); an id that is just an executable name ("Spotify.exe") is found
// through the running process with that name. Read once per app.

struct AppIcon {
  std::string png;
  std::string name;
};

std::wstring ProcessPathForExe(const std::wstring& exe) {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return {};
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  std::wstring found;
  if (Process32FirstW(snapshot, &entry)) {
    do {
      if (_wcsicmp(entry.szExeFile, exe.c_str()) != 0) continue;
      HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, entry.th32ProcessID);
      if (!process) continue;
      wchar_t buffer[MAX_PATH * 2];
      DWORD length = static_cast<DWORD>(std::size(buffer));
      if (QueryFullProcessImageNameW(process, 0, buffer, &length)) found.assign(buffer, length);
      CloseHandle(process);
    } while (found.empty() && Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return found;
}

std::string EncodePng(HBITMAP bitmap) {
  std::string result;
  IWICImagingFactory* factory = nullptr;
  if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, __uuidof(*factory), reinterpret_cast<void**>(&factory)))) return result;
  IWICBitmap* source = nullptr;
  IWICFormatConverter* converter = nullptr;
  IStream* stream = nullptr;
  IWICBitmapEncoder* encoder = nullptr;
  IWICBitmapFrameEncode* frame = nullptr;
  do {
    if (FAILED(factory->CreateBitmapFromHBITMAP(bitmap, nullptr, WICBitmapUsePremultipliedAlpha, &source))) break;
    if (FAILED(factory->CreateFormatConverter(&converter))) break;
    if (FAILED(converter->Initialize(source, GUID_WICPixelFormat32bppBGRA, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom))) break;
    if (FAILED(CreateStreamOnHGlobal(nullptr, TRUE, &stream))) break;
    if (FAILED(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder))) break;
    if (FAILED(encoder->Initialize(stream, WICBitmapEncoderNoCache))) break;
    if (FAILED(encoder->CreateNewFrame(&frame, nullptr))) break;
    if (FAILED(frame->Initialize(nullptr))) break;
    UINT width = 0, height = 0;
    converter->GetSize(&width, &height);
    frame->SetSize(width, height);
    WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
    frame->SetPixelFormat(&format);
    if (FAILED(frame->WriteSource(converter, nullptr))) break;
    if (FAILED(frame->Commit()) || FAILED(encoder->Commit())) break;
    HGLOBAL memory = nullptr;
    if (FAILED(GetHGlobalFromStream(stream, &memory))) break;
    STATSTG stat{};
    stream->Stat(&stat, STATFLAG_NONAME);
    const auto size = static_cast<DWORD>(stat.cbSize.QuadPart);
    const void* bytes = GlobalLock(memory);
    if (bytes && size > 0) result = "data:image/png;base64," + Base64(static_cast<const uint8_t*>(bytes), size);
    GlobalUnlock(memory);
  } while (false);
  if (frame) frame->Release();
  if (encoder) encoder->Release();
  if (stream) stream->Release();
  if (converter) converter->Release();
  if (source) source->Release();
  factory->Release();
  return result;
}

AppIcon ReadShellIcon(const std::wstring& parsingName) {
  AppIcon icon;
  IShellItem* item = nullptr;
  if (FAILED(SHCreateItemFromParsingName(parsingName.c_str(), nullptr, __uuidof(*item), reinterpret_cast<void**>(&item)))) return icon;
  PWSTR display = nullptr;
  if (SUCCEEDED(item->GetDisplayName(SIGDN_NORMALDISPLAY, &display)) && display) {
    icon.name = Utf8(std::wstring(display));
    CoTaskMemFree(display);
  }
  IShellItemImageFactory* images = nullptr;
  if (SUCCEEDED(item->QueryInterface(__uuidof(*images), reinterpret_cast<void**>(&images)))) {
    HBITMAP bitmap = nullptr;
    if (SUCCEEDED(images->GetImage(SIZE{96, 96}, SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK, &bitmap)) && bitmap) {
      icon.png = EncodePng(bitmap);
      DeleteObject(bitmap);
    }
    images->Release();
  }
  item->Release();
  return icon;
}

AppIcon ReadAppIconOnSta(const std::wstring& aumid) {
  AppIcon icon;
  // The shell's image factories want a single-threaded apartment.
  std::thread worker([&] {
    if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) return;
    const bool exe = aumid.size() > 4 && _wcsicmp(aumid.c_str() + aumid.size() - 4, L".exe") == 0;
    if (!exe) icon = ReadShellIcon(L"shell:AppsFolder\\" + aumid);
    if (icon.png.empty()) {
      const std::wstring path = exe ? ProcessPathForExe(aumid) : std::wstring();
      if (!path.empty()) {
        AppIcon fromPath = ReadShellIcon(path);
        icon.png = fromPath.png;
        if (icon.name.empty() && !fromPath.name.empty()) icon.name = fromPath.name;
      }
    }
    CoUninitialize();
  });
  worker.join();
  return icon;
}

// ── Sessions ────────────────────────────────────────────────────────────────

struct Tracked {
  GlobalSystemMediaTransportControlsSession session{nullptr};
  event_token mediaToken{};
  event_token playbackToken{};
  event_token timelineToken{};
  std::string artworkKey;
  std::string artwork;
  std::string sentArtworkKey = "\x01";  // never equal to a real key at first
  bool iconSent = false;
};

struct Tracker {
  GlobalSystemMediaTransportControlsSessionManager manager{nullptr};
  // Keyed by the id ADE sees: the AUMID, with "#2", "#3"… for repeats.
  std::map<std::string, Tracked> tracked;
  std::map<std::wstring, AppIcon> icons;
  std::string lastSignature;

  static void Detach(Tracked& entry) {
    try {
      entry.session.MediaPropertiesChanged(entry.mediaToken);
      entry.session.PlaybackInfoChanged(entry.playbackToken);
      entry.session.TimelinePropertiesChanged(entry.timelineToken);
    } catch (...) {
    }
  }

  void Attach() {
    std::map<std::string, Tracked> next;
    std::map<std::string, int> seen;
    for (const auto& session : manager.GetSessions()) {
      const std::string aumid = Utf8(session.SourceAppUserModelId());
      const int count = ++seen[aumid];
      const std::string id = count == 1 ? aumid : aumid + "#" + std::to_string(count);
      auto existing = tracked.find(id);
      if (existing != tracked.end() && existing->second.session == session) {
        next.emplace(id, std::move(existing->second));
        tracked.erase(existing);
        continue;
      }
      Tracked entry;
      entry.session = session;
      entry.mediaToken = session.MediaPropertiesChanged([](auto&&, auto&&) { Signal(); });
      entry.playbackToken = session.PlaybackInfoChanged([](auto&&, auto&&) { Signal(); });
      entry.timelineToken = session.TimelinePropertiesChanged([](auto&&, auto&&) { Signal(); });
      next.emplace(id, std::move(entry));
    }
    for (auto& [id, entry] : tracked) Detach(entry);
    tracked = std::move(next);
    // A session that went away and came back sends its icon again.
    lastSignature.clear();
  }

  std::string CurrentId() {
    try {
      const auto current = manager.GetCurrentSession();
      if (!current) return {};
      for (const auto& [id, entry] : tracked) {
        if (entry.session == current) return id;
      }
    } catch (...) {
    }
    return {};
  }

  void Publish() {
    std::string signature;
    std::string body;
    const std::string current = CurrentId();
    for (auto& [id, entry] : tracked) {
      try {
        const auto props = entry.session.TryGetMediaPropertiesAsync().get();
        const auto playback = entry.session.GetPlaybackInfo();
        const auto timeline = entry.session.GetTimelineProperties();
        const auto controls = playback.Controls();
        const std::wstring aumidWide(entry.session.SourceAppUserModelId().c_str());
        const std::string title = Utf8(props.Title());
        const std::string artist = Utf8(props.Artist());
        const std::string album = Utf8(props.AlbumTitle());
        const std::string key = title + "\x1f" + artist + "\x1f" + album;
        if (key != entry.artworkKey) {
          entry.artworkKey = key;
          entry.artwork = ReadArtwork(props.Thumbnail());
        }
        std::string line = "{\"id\":" + Json(id);
        line += ",\"app\":" + Json(Utf8(aumidWide));
        line += ",\"title\":" + Json(title);
        line += ",\"artist\":" + Json(artist);
        line += ",\"album\":" + Json(album);
        line += ",\"status\":" + Json(StatusName(playback.PlaybackStatus()));
        line += ",\"positionMs\":" + std::to_string(ToMs(timeline.Position() - timeline.StartTime()));
        line += ",\"durationMs\":" + std::to_string(ToMs(timeline.EndTime() - timeline.StartTime()));
        line += ",\"updatedAtMs\":" + std::to_string(ToUnixMs(timeline.LastUpdatedTime()));
        line += std::string(",\"canPlay\":") + (controls.IsPlayEnabled() ? "true" : "false");
        line += std::string(",\"canPause\":") + (controls.IsPauseEnabled() ? "true" : "false");
        line += std::string(",\"canNext\":") + (controls.IsNextEnabled() ? "true" : "false");
        line += std::string(",\"canPrevious\":") + (controls.IsPreviousEnabled() ? "true" : "false");
        signature += line + "|" + key + "\n";
        std::string extra;
        if (entry.sentArtworkKey != entry.artworkKey) {
          extra += ",\"artwork\":" + (entry.artwork.empty() ? std::string("null") : Json(entry.artwork));
        }
        if (!entry.iconSent) {
          auto cached = icons.find(aumidWide);
          if (cached == icons.end()) cached = icons.emplace(aumidWide, ReadAppIconOnSta(aumidWide)).first;
          extra += ",\"icon\":" + (cached->second.png.empty() ? std::string("null") : Json(cached->second.png));
          extra += ",\"name\":" + (cached->second.name.empty() ? std::string("null") : Json(cached->second.name));
        }
        if (!body.empty()) body += ",";
        body += line + extra + "}";
      } catch (const hresult_error&) {
        // A session closing under us; the next SessionsChanged drops it.
      }
    }
    signature = current + "\n" + signature;
    if (signature == lastSignature) return;
    lastSignature = signature;
    for (auto& [id, entry] : tracked) {
      entry.sentArtworkKey = entry.artworkKey;
      entry.iconSent = true;
    }
    Emit("{\"type\":\"sessions\",\"current\":" + (current.empty() ? std::string("null") : Json(current)) + ",\"sessions\":[" + body + "]}");
  }

  void Command(const std::string& input) {
    const auto space = input.find(' ');
    const std::string command = input.substr(0, space);
    const std::string id = space == std::string::npos ? std::string() : input.substr(space + 1);
    GlobalSystemMediaTransportControlsSession target{nullptr};
    if (id.empty()) {
      target = manager.GetCurrentSession();
    } else {
      const auto found = tracked.find(id);
      if (found != tracked.end()) target = found->second.session;
    }
    if (!target) return;
    try {
      if (command == "play") target.TryPlayAsync().get();
      else if (command == "pause") target.TryPauseAsync().get();
      else if (command == "toggle") target.TryTogglePlayPauseAsync().get();
      else if (command == "next") target.TrySkipNextAsync().get();
      else if (command == "previous") target.TrySkipPreviousAsync().get();
    } catch (const hresult_error& error) {
      Emit("{\"type\":\"error\",\"message\":" + Json(Utf8(error.message())) + "}");
    }
    Signal();
  }
};

}  // namespace

int main() {
  SetConsoleOutputCP(CP_UTF8);
  init_apartment(apartment_type::multi_threaded);
  Tracker tracker;
  try {
    tracker.manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync().get();
  } catch (const hresult_error& error) {
    Emit("{\"type\":\"error\",\"message\":" + Json(Utf8(error.message())) + "}");
    return 1;
  }
  std::atomic<bool> sessionsChanged{true};
  tracker.manager.SessionsChanged([&](auto&&, auto&&) {
    sessionsChanged = true;
    Signal();
  });
  tracker.manager.CurrentSessionChanged([&](auto&&, auto&&) { Signal(); });

  std::mutex commandMutex;
  std::vector<std::string> commands;
  std::thread input([&] {
    std::string line;
    while (std::getline(std::cin, line)) {
      while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
      if (line == "quit") break;
      {
        std::lock_guard<std::mutex> lock(commandMutex);
        commands.push_back(line);
      }
      Signal();
    }
    // stdin closed: ADE is gone or the widget left the screen.
    g_quit = true;
    Signal();
  });

  while (!g_quit) {
    {
      std::unique_lock<std::mutex> lock(g_mutex);
      // Events drive updates; the timeout is a backstop for players that
      // change tracks without raising one.
      g_wake.wait_for(lock, std::chrono::seconds(5), [] { return g_dirty || g_quit.load(); });
      g_dirty = false;
    }
    if (g_quit) break;
    if (sessionsChanged.exchange(false)) {
      try {
        tracker.Attach();
      } catch (const hresult_error& error) {
        Emit("{\"type\":\"error\",\"message\":" + Json(Utf8(error.message())) + "}");
      }
    }
    std::vector<std::string> pending;
    {
      std::lock_guard<std::mutex> lock(commandMutex);
      pending.swap(commands);
    }
    for (const auto& command : pending) tracker.Command(command);
    tracker.Publish();
  }
  input.detach();
  return 0;
}
