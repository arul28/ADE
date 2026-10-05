// H.264 for the live view and for recordings.
//
// The live view speaks the macOS driver's wire exactly, so the Node stream
// server and every viewer work unchanged: a loopback TCP socket carrying
// 12-byte-header records (`apps/desktop/src/main/services/media/videoRecords.ts`):
// u32 magic, u8 type, u8 flags, u16 reserved, u32 length, big-endian. Type 1 is
// the config record (the bare codec string, e.g. `avc1.64002a`); type 2 is one
// Annex-B access unit, flag 1 on a keyframe. Parameter sets travel inline on
// every keyframe, so a reader that attaches late decodes from its first
// keyframe.
//
// Encoding is the Media Foundation H.264 encoder MFT (software, synchronous),
// which every Windows 10/11 edition ships. Recordings go through the Media
// Foundation sink writer to MP4.

#pragma once

#include "capture.h"

#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mftransform.h>
#include <wrl/client.h>

#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace ade {

// Starts Media Foundation once per process.
bool ensureMediaFoundation();

// BGRA (top-down) to NV12, BT.601 limited range. `w` and `h` must be even.
void bgraToNv12(const Frame& frame, std::vector<uint8_t>& nv12);

// Even dimensions: NV12 has 2x2 chroma blocks.
inline int evenDown(int v) { return v & ~1; }

class H264Encoder {
 public:
  ~H264Encoder();
  bool open(int width, int height, int fps, int bitrateKbps, std::string* error);
  void close();
  // Encodes one NV12 frame. `onUnit(annexB, keyframe)` runs for each output.
  bool encode(const std::vector<uint8_t>& nv12, int64_t timestamp100ns,
              const std::function<void(const std::vector<uint8_t>&, bool)>& onUnit, std::string* error);
  void forceKeyframe();
  int width() const { return width_; }
  int height() const { return height_; }

 private:
  bool drain(const std::function<void(const std::vector<uint8_t>&, bool)>& onUnit, std::string* error);
  Microsoft::WRL::ComPtr<IMFTransform> mft_;
  std::vector<uint8_t> sequenceHeader_;
  int width_ = 0;
  int height_ = 0;
  int fps_ = 30;
  bool keyframeRequested_ = false;
  std::mutex mutex_;
};

// Finds the SPS in an Annex-B unit and returns `avc1.PPCCLL`, or "".
std::string avcCodecString(const std::vector<uint8_t>& annexB);

// The loopback byte server a lane's viewers read from (through Node).
//
// Writes never block the media thread. A reader that stops reading (the brain's
// event loop stalls for seconds at a turn start) keeps its connection: the
// unsent tail of the current record waits in its queue, later frames are
// skipped for it, and once it drains it resumes at the next keyframe. Only a
// reader stalled past kStalledReaderDropMs, or a socket error, is disconnected.
class StreamByteServer {
 public:
  ~StreamByteServer();
  // Binds 127.0.0.1 on an ephemeral port. Returns 0 on failure.
  int start(std::function<void()> onClientAttached);
  void stop();
  void setConfig(const std::string& codec);
  void broadcast(uint8_t type, bool keyframe, const std::vector<uint8_t>& payload);
  size_t clientCount();
  int port() const { return port_; }

 private:
  struct Client {
    uintptr_t socket = ~static_cast<uintptr_t>(0);
    std::vector<uint8_t> pending;  // the unsent tail of one whole record
    size_t offset = 0;
    bool needKeyframe = false;     // frames were skipped; resume at a keyframe
    bool needConfig = false;       // config changed while a record was pending
    int64_t stalledSinceMs = 0;
  };
  // Sends what the socket takes, waiting at most `waitMs`. False on a socket error.
  static bool flush(Client& client, int64_t waitMs);
  void acceptLoop();
  static std::vector<uint8_t> record(uint8_t type, bool keyframe, const uint8_t* data, size_t size);
  uintptr_t listen_ = ~static_cast<uintptr_t>(0);
  int port_ = 0;
  std::thread acceptThread_;
  std::mutex mutex_;
  std::vector<Client> clients_;
  std::vector<uint8_t> configRecord_;
  std::function<void()> onClientAttached_;
  std::atomic<bool> running_{false};
};

// MP4 recording through the sink writer.
class Mp4Recorder {
 public:
  ~Mp4Recorder();
  bool open(const std::wstring& path, int width, int height, int fps, std::string* error);
  bool write(const std::vector<uint8_t>& nv12, int64_t timestamp100ns, int64_t duration100ns, std::string* error);
  bool finish(std::string* error);
  bool isOpen() const { return writer_ != nullptr; }
  int width() const { return width_; }
  int height() const { return height_; }

 private:
  Microsoft::WRL::ComPtr<IMFSinkWriter> writer_;
  DWORD stream_ = 0;
  int width_ = 0;
  int height_ = 0;
};

}  // namespace ade
