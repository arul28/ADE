// ade-now-playing.exe: what Windows says is playing, as NDJSON.
//
// Reads the Global System Media Transport Controls (the same source as the
// volume flyout and lock screen), so it works with any player that reports to
// the OS: browsers, Spotify, Apple Music, Windows Media Player, VLC.
//
// stdout: one JSON object per line.
//   {"type":"state","session":null}
//   {"type":"state","session":{"app":"...","title":"...","artist":"...","album":"...",
//     "status":"playing|paused|stopped|changing|closed|opened","positionMs":0,"durationMs":0,
//     "updatedAtMs":0,"canPlay":true,"canPause":true,"canNext":true,"canPrevious":true,
//     "artwork":"data:image/png;base64,..."|null}}
//   {"type":"error","message":"..."}
// "artwork" is present only when it changed since the last line (null when the
// new track has none); a reader keeps the previous artwork otherwise.
// stdin: one command per line: play | pause | toggle | next | previous | quit
//
// The process exits when stdin closes, so it never outlives ADE. It only runs
// while a Now Playing widget is on screen; ADE starts and stops it.

#include <windows.h>
#include <wincrypt.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Media.Control.h>
#include <winrt/Windows.Storage.Streams.h>

#pragma comment(lib, "windowsapp.lib")
#pragma comment(lib, "crypt32.lib")

using namespace winrt;
using namespace Windows::Foundation;
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

std::string Utf8(const hstring& value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(CP_UTF8, 0, value.c_str(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  std::string out(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.c_str(), static_cast<int>(value.size()), out.data(), size, nullptr, nullptr);
  return out;
}

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
    DWORD length = 0;
    CryptBinaryToStringA(bytes.data(), size, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &length);
    std::string base64(length, '\0');
    CryptBinaryToStringA(bytes.data(), size, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, base64.data(), &length);
    base64.resize(length);
    std::string type = Utf8(stream.ContentType());
    if (type.empty() || type.find("image/") != 0) type = "image/png";
    return "data:" + type + ";base64," + base64;
  } catch (...) {
    return {};
  }
}

struct Tracker {
  GlobalSystemMediaTransportControlsSessionManager manager{nullptr};
  GlobalSystemMediaTransportControlsSession session{nullptr};
  event_token mediaToken{};
  event_token playbackToken{};
  event_token timelineToken{};
  std::string artworkKey;
  std::string artwork;
  // What was last written, so an unchanged state is not sent again, and the
  // artwork (the large part) goes out only when it changes.
  std::string lastLine;
  std::string sentArtworkKey = "";

  void Attach() {
    if (session) {
      try {
        session.MediaPropertiesChanged(mediaToken);
        session.PlaybackInfoChanged(playbackToken);
        session.TimelinePropertiesChanged(timelineToken);
      } catch (...) {
      }
    }
    session = manager.GetCurrentSession();
    if (!session) return;
    mediaToken = session.MediaPropertiesChanged([](auto&&, auto&&) { Signal(); });
    playbackToken = session.PlaybackInfoChanged([](auto&&, auto&&) { Signal(); });
    timelineToken = session.TimelinePropertiesChanged([](auto&&, auto&&) { Signal(); });
  }

  void Publish() {
    if (!session) {
      if (lastLine == "null") return;
      lastLine = "null";
      sentArtworkKey = "";
      Emit("{\"type\":\"state\",\"session\":null}");
      return;
    }
    try {
      const auto props = session.TryGetMediaPropertiesAsync().get();
      const auto playback = session.GetPlaybackInfo();
      const auto timeline = session.GetTimelineProperties();
      const auto controls = playback.Controls();
      const std::string title = Utf8(props.Title());
      const std::string artist = Utf8(props.Artist());
      const std::string album = Utf8(props.AlbumTitle());
      const std::string key = title + "\x1f" + artist + "\x1f" + album;
      if (key != artworkKey) {
        artworkKey = key;
        artwork = ReadArtwork(props.Thumbnail());
      }
      std::string line = "{\"type\":\"state\",\"session\":{";
      line += "\"app\":" + Json(Utf8(session.SourceAppUserModelId()));
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
      std::string body = line;
      if (sentArtworkKey != artworkKey) body += ",\"artwork\":" + (artwork.empty() ? std::string("null") : Json(artwork));
      body += "}}";
      // Compare without the artwork: same state, same track, nothing to send.
      const std::string signature = line + "|" + artworkKey;
      if (signature == lastLine) return;
      lastLine = signature;
      sentArtworkKey = artworkKey;
      Emit(body);
    } catch (const hresult_error& error) {
      Emit("{\"type\":\"error\",\"message\":" + Json(Utf8(error.message())) + "}");
    }
  }

  void Command(const std::string& command) {
    const auto current = session;
    if (!current) return;
    try {
      if (command == "play") current.TryPlayAsync().get();
      else if (command == "pause") current.TryPauseAsync().get();
      else if (command == "toggle") current.TryTogglePlayPauseAsync().get();
      else if (command == "next") current.TrySkipNextAsync().get();
      else if (command == "previous") current.TrySkipPreviousAsync().get();
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
  std::atomic<bool> sessionChanged{true};
  tracker.manager.CurrentSessionChanged([&](auto&&, auto&&) {
    sessionChanged = true;
    Signal();
  });

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
    if (sessionChanged.exchange(false)) tracker.Attach();
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
