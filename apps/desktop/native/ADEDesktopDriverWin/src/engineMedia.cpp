#include "engineLane.h"
#include <algorithm>

namespace ade {
namespace { constexpr int64_t kIdleCutAfterMs = 1'500; }

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

void Engine::ensureMediaThread(const std::shared_ptr<Lane>& lane) {
  if (lane->mediaRun.exchange(true)) return;
  if (lane->mediaThread.joinable()) lane->mediaThread.join();
  lane->mediaThread = std::thread([this, lane] { mediaLoop(lane); });
}

void Engine::stopMedia(Lane& lane) {
  {
    std::lock_guard<std::mutex> lock(lane.media);
    lane.streaming = false;
    if (lane.recorder) {
      std::string err;
      lane.recorder->finish(&err);
      lane.recorder.reset();
    }
  }
  lane.mediaRun = false;
  if (lane.mediaThread.joinable() && lane.mediaThread.get_id() != std::this_thread::get_id()) lane.mediaThread.join();
  std::lock_guard<std::mutex> lock(lane.media);
  if (lane.server) lane.server->stop();
  lane.server.reset();
  lane.encoder.reset();
}

void Engine::mediaLoop(std::shared_ptr<Lane> lane) {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL);
  const int64_t start = nowMs();
  std::vector<uint8_t> nv12;
  while (lane->mediaRun && running_) {
    int fps;
    bool streaming, recording, readers;
    HWND recordWindow;
    {
      std::lock_guard<std::mutex> lock(lane->media);
      streaming = lane->streaming && lane->server && lane->encoder;
      readers = streaming && lane->server->clientCount() > 0;
      recording = lane->recorder != nullptr;
      recordWindow = lane->recordWindow;
      fps = std::max(streaming ? lane->streamFps : 0, recording ? lane->recordFps : 0);
    }
    if (!streaming && !recording) break;
    int64_t frameStart = nowMs();
    if (readers || recording) {
      // The stream always shows the whole lane; a window recording also
      // captures its window. Each consumer gets its own frame.
      Frame screenFrame, windowFrame;
      std::string err;
      const bool wantScreen = readers || (recording && !recordWindow);
      const bool wantWindow = recording && recordWindow;
      std::unique_lock<std::recursive_mutex> operation(operationMutex_, std::try_to_lock);
      if (!operation.owns_lock()) { Sleep(10); continue; }
      bool screenOk = wantScreen && captureLane(*lane, screenFrame, nullptr, &err);
      bool windowOk = wantWindow && captureLane(*lane, windowFrame, recordWindow, &err);
      operation.unlock();
      const bool ok = (!wantScreen || screenOk) && (!wantWindow || windowOk);
      if (!ok) {
        if (nowMs() - lane->lastStreamErrorMs > 5000) {
          lane->lastStreamErrorMs = nowMs();
          std::string message = err.find("handle is invalid") != std::string::npos
                                    ? "This PC is locked, so the private screen shows no picture. It resumes after unlock."
                                    : "No frame from the Windows screen: " + err;
          emit_(eventLine("stream-error", Json::Object{{"laneId", lane->laneId}, {"message", message}}));
        }
      }
      {
        // Frames must match the encoder's size; a window recording keeps the
        // window's first size and crops or pads later frames.
        std::lock_guard<std::mutex> lock(lane->media);
        if (screenOk && streaming && readers && lane->streaming && lane->server && lane->encoder) {
          const Frame& frame = screenFrame;
          Frame sized = frame;
          if (sized.width != lane->encoder->width() || sized.height != lane->encoder->height()) {
            Frame canvas;
            canvas.resize(lane->encoder->width(), lane->encoder->height());
            blit(frame, canvas, 0, 0);
            sized = std::move(canvas);
          }
          bgraToNv12(sized, nv12);
          if (lane->wantKeyframe.exchange(false)) lane->encoder->forceKeyframe();
          std::string encErr;
          int64_t ts = (nowMs() - start) * 10'000;
          auto* server = lane->server.get();
          auto& codec = lane->codec;
          bool encoded = lane->encoder->encode(nv12, ts, [&](const std::vector<uint8_t>& unit, bool key) {
            if (key && codec.empty()) {
              codec = avcCodecString(unit);
              if (!codec.empty()) server->setConfig(codec);
            }
            server->broadcast(2, key, unit);
          }, &encErr);
          if (!encoded && nowMs() - lane->lastStreamErrorMs > 5000) {
            lane->lastStreamErrorMs = nowMs();
            emit_(eventLine("stream-error", Json::Object{{"laneId", lane->laneId}, {"message", encErr}}));
          }
        }
        // The recorder may have been swapped since the snapshot above; only
        // feed it a frame of the kind it asked for.
        const bool recorderFrameOk = lane->recordWindow ? windowOk && lane->recordWindow == recordWindow : screenOk;
        if (lane->recorder && recorderFrameOk) {
          const Frame& frame = lane->recordWindow ? windowFrame : screenFrame;
          Frame sized = frame;
          if (sized.width != lane->recorder->width() || sized.height != lane->recorder->height()) {
            Frame canvas;
            canvas.resize(lane->recorder->width(), lane->recorder->height());
            blit(frame, canvas, 0, 0);
            sized = std::move(canvas);
          }
          int64_t now = nowMs();
          uint64_t hash = frameHash(sized);
          if (hash != lane->recordLastHash) {
            lane->recordLastHash = hash;
            lane->recordLastChangeMs = now;
          }
          int64_t step = now - lane->recordLastWallMs;
          lane->recordLastWallMs = now;
          bool idle = !lane->keepIdle && now - lane->recordLastChangeMs > kIdleCutAfterMs;
          if (idle) {
            lane->recordIdleCutMs += step;
          } else {
            bgraToNv12(sized, nv12);
            std::string recErr;
            int64_t duration = std::max<int64_t>(1, step) * 10'000;
            if (!lane->recorder->write(nv12, lane->recordMediaMs * 10'000, duration, &recErr)) {
              lane->recordError = recErr;
            } else {
              ++lane->recordFrames;
            }
            lane->recordMediaMs += std::max<int64_t>(1, step);
          }
        }
      }
    }
    int64_t budget = 1000 / std::max(1, fps);
    int64_t spent = nowMs() - frameStart;
    if (spent < budget) Sleep(static_cast<DWORD>(budget - spent));
  }
  lane->mediaRun = false;
  CoUninitialize();
}

Json Engine::startStream(const Json& req) {
  auto lane = requireLane(requireString(req, "laneId"));
  int fps = static_cast<int>(std::max<int64_t>(1, std::min<int64_t>(60, req["fps"].asInt(30))));
  int port = 0;
  {
    std::lock_guard<std::mutex> lock(lane->media);
    if (!lane->server) {
      lane->server = std::make_unique<StreamByteServer>();
      Lane* raw = lane.get();
      port = lane->server->start([raw] { raw->wantKeyframe = true; });
      if (!port) {
        lane->server.reset();
        fail(code::kDisplayUnavailable, "The stream could not open a loopback port.");
      }
      lane->encoder = std::make_unique<H264Encoder>();
      std::string err;
      // About 0.08 bit per pixel per frame at the active rate.
      int kbps = static_cast<int>(std::max<int64_t>(2000, std::min<int64_t>(
                                                                24000, static_cast<int64_t>(lane->width) * lane->height * 30 / 12500)));
      if (!lane->encoder->open(lane->width, lane->height, 30, kbps, &err)) {
        lane->server->stop();
        lane->server.reset();
        lane->encoder.reset();
        fail(code::kDisplayUnavailable, "The H.264 encoder did not start: " + err);
      }
      lane->codec.clear();
    } else {
      port = lane->server->port();
    }
    lane->streaming = true;
    lane->streamFps = fps;
  }
  lane->wantKeyframe = true;
  ensureMediaThread(lane);
  touch(*lane);
  Json out = Json::object();
  out["port"] = port;
  out["width"] = evenDown(lane->width);
  out["height"] = evenDown(lane->height);
  out["codec"] = lane->codec.empty() ? Json() : Json(lane->codec);
  return out;
}

Json Engine::setStreamRate(const Json& req) {
  auto lane = requireLane(requireString(req, "laneId"));
  int fps = static_cast<int>(std::max<int64_t>(1, std::min<int64_t>(60, requireInt(req, "fps"))));
  std::lock_guard<std::mutex> lock(lane->media);
  lane->streamFps = fps;
  Json out = Json::object();
  out["fps"] = fps;
  return out;
}

Json Engine::setStreamCursor(const Json& req) {
  auto lane = requireLane(requireString(req, "laneId"));
  bool visible = req["visible"].asBool();
  std::lock_guard<std::mutex> lock(lane->media);
  lane->cursorVisible = visible;
  Json out = Json::object();
  out["visible"] = visible;
  return out;
}

Json Engine::stopStream(const Json& req) {
  auto lane = requireLane(requireString(req, "laneId"));
  bool stopped = false;
  bool keepThread;
  {
    std::lock_guard<std::mutex> lock(lane->media);
    stopped = lane->streaming;
    lane->streaming = false;
    keepThread = lane->recorder != nullptr;
    if (lane->server) lane->server->stop();
    lane->server.reset();
    lane->encoder.reset();
    lane->codec.clear();
  }
  if (!keepThread) {
    lane->mediaRun = false;
    if (lane->mediaThread.joinable()) lane->mediaThread.join();
  }
  Json out = Json::object();
  out["stopped"] = stopped;
  return out;
}

// Called without operationMutex_: opening the MP4 sink writer takes 1-2 s and
// must not freeze the live view or queue window.list behind it.
Json Engine::startRecording(const Json& req) {
  auto lane = requireLane(requireString(req, "laneId"));
  std::wstring path = widen(requireString(req, "filePath"));
  int fps = static_cast<int>(std::max<int64_t>(1, std::min<int64_t>(60, req["fps"].asInt(30))));
  HWND window = req["windowId"].isNumber() ? hwndFromId(req["windowId"].asInt()) : nullptr;
  int width = lane->width, height = lane->height;
  if (window) {
    // laneWindows reads the shared seat's parked-window map: under the lock.
    std::lock_guard<std::recursive_mutex> validate(operationMutex_);
    const auto owned = laneWindows(*lane);
    if (std::none_of(owned.begin(), owned.end(), [&](const WinInfo& entry) { return entry.hwnd == window; }))
      fail(code::kWindowNotFound, "That window is not on this lane's screen.");
    RECT r;
    if (!GetWindowRect(window, &r)) fail(code::kWindowNotFound, "That window is not open.");
    width = r.right - r.left;
    height = r.bottom - r.top;
  }
  {
    std::lock_guard<std::mutex> lock(lane->media);
    if (lane->recorder) fail(code::kInvalidArgument, "Lane " + lane->laneId + " is already recording.");
  }
  const int64_t openStart = nowMs();
  auto recorder = std::make_unique<Mp4Recorder>();
  std::string err;
  if (!recorder->open(path, width, height, fps, &err)) fail(code::kInternalError, err);
  logLine("record: writer opened in " + std::to_string(nowMs() - openStart) + "ms");
  std::unique_lock<std::recursive_mutex> operation(operationMutex_);
  if (!running_) fail(code::kCancelled, "The Windows screen is stopping.");
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = lanes_.find(lane->laneId);
    if (it == lanes_.end() || it->second != lane) fail(code::kNoDisplay, "Lane " + lane->laneId + "'s screen stopped while the recording started.");
  }
  {
    std::lock_guard<std::mutex> lock(lane->media);
    if (lane->recorder) fail(code::kInvalidArgument, "Lane " + lane->laneId + " is already recording.");
    lane->recorder = std::move(recorder);
    lane->recordPath = path;
    lane->recordFps = fps;
    lane->keepIdle = req["keepIdle"].asBool();
    lane->recordWindow = window;
    lane->recordStartMs = nowMs();
    lane->recordIdleCutMs = 0;
    lane->recordLastChangeMs = nowMs();
    lane->recordLastWallMs = nowMs();
    lane->recordMediaMs = 0;
    lane->recordLastHash = 0;
    lane->recordFrames = 0;
    lane->recordError.clear();
  }
  ensureMediaThread(lane);
  touch(*lane);
  Json out = Json::object();
  out["startedAt"] = isoNow();
  return out;
}

// Called without operationMutex_: Finalize writes the MP4 index.
Json Engine::stopRecording(const Json& req) {
  auto lane = requireLane(requireString(req, "laneId"));
  std::unique_ptr<Mp4Recorder> recorder;
  int64_t wall = 0, idleCut = 0, media = 0, frames = 0;
  std::wstring path;
  {
    std::lock_guard<std::mutex> lock(lane->media);
    if (!lane->recorder) fail(code::kRecordingNotRunning, "Lane " + lane->laneId + " is not recording.");
    recorder = std::move(lane->recorder);
    wall = nowMs() - lane->recordStartMs;
    idleCut = lane->recordIdleCutMs;
    media = lane->recordMediaMs;
    path = lane->recordPath;
    frames = lane->recordFrames;
    lane->recordWindow = nullptr;
  }
  std::string err;
  if (!recorder->finish(&err)) fail(code::kInternalError, err);
  // Joining the media thread races stream.start's ensureMediaThread unless
  // both run under the operation lock.
  std::unique_lock<std::recursive_mutex> operation(operationMutex_);
  bool streaming;
  {
    std::lock_guard<std::mutex> lock(lane->media);
    streaming = lane->streaming;
  }
  if (!streaming) {
    lane->mediaRun = false;
    if (lane->mediaThread.joinable()) lane->mediaThread.join();
  }
  Json out = Json::object();
  out["filePath"] = narrow(path);
  out["durationMs"] = media;
  out["wallDurationMs"] = wall;
  out["idleCutMs"] = idleCut;
  out["frameCount"] = frames;
  return out;
}


}  // namespace ade
