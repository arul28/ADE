#include "video.h"

#include <winsock2.h>
#include <ws2tcpip.h>

#include <codecapi.h>
#include <mferror.h>
#include <strmif.h>
#include <wmcodecdsp.h>

#include <algorithm>
#include <cstdio>
#include <cstring>

using Microsoft::WRL::ComPtr;

namespace ade {

namespace {

constexpr uint32_t kRecordMagic = 0xade1f00d;  // IOS_VIDEO_RECORD_MAGIC in iosSimulator.ts
constexpr size_t kHeaderBytes = 12;

std::string hrText(const char* what, HRESULT hr) {
  char buf[64];
  std::snprintf(buf, sizeof(buf), " (hr=0x%08lx)", static_cast<unsigned long>(hr));
  return std::string(what) + buf;
}

bool hasNalType(const std::vector<uint8_t>& data, uint8_t type) {
  for (size_t i = 0; i + 3 < data.size(); ++i) {
    if (data[i] == 0 && data[i + 1] == 0) {
      size_t start = 0;
      if (data[i + 2] == 1) start = i + 3;
      else if (data[i + 2] == 0 && i + 4 < data.size() && data[i + 3] == 1) start = i + 4;
      if (start && start < data.size() && (data[start] & 0x1F) == type) return true;
    }
  }
  return false;
}

}  // namespace

bool ensureMediaFoundation() {
  static std::once_flag once;
  static bool ok = false;
  std::call_once(once, [] { ok = SUCCEEDED(MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET)); });
  return ok;
}

void bgraToNv12(const Frame& frame, std::vector<uint8_t>& nv12) {
  const int w = evenDown(frame.width);
  const int h = evenDown(frame.height);
  nv12.resize(static_cast<size_t>(w) * h * 3 / 2);
  uint8_t* yPlane = nv12.data();
  uint8_t* uvPlane = nv12.data() + static_cast<size_t>(w) * h;
  const uint8_t* src = frame.bgra.data();
  const size_t stride = static_cast<size_t>(frame.width) * 4;
  for (int y = 0; y < h; ++y) {
    const uint8_t* row = src + y * stride;
    uint8_t* out = yPlane + static_cast<size_t>(y) * w;
    for (int x = 0; x < w; ++x) {
      const int b = row[x * 4], g = row[x * 4 + 1], r = row[x * 4 + 2];
      out[x] = static_cast<uint8_t>(((66 * r + 129 * g + 25 * b + 128) >> 8) + 16);
    }
  }
  for (int y = 0; y < h; y += 2) {
    const uint8_t* row0 = src + y * stride;
    const uint8_t* row1 = row0 + stride;
    uint8_t* out = uvPlane + static_cast<size_t>(y / 2) * w;
    for (int x = 0; x < w; x += 2) {
      int b = 0, g = 0, r = 0;
      for (int dy = 0; dy < 2; ++dy) {
        const uint8_t* p = (dy ? row1 : row0) + x * 4;
        b += p[0] + p[4];
        g += p[1] + p[5];
        r += p[2] + p[6];
      }
      b >>= 2;
      g >>= 2;
      r >>= 2;
      out[x] = static_cast<uint8_t>(((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128);
      out[x + 1] = static_cast<uint8_t>(((112 * r - 94 * g - 18 * b + 128) >> 8) + 128);
    }
  }
}

std::string avcCodecString(const std::vector<uint8_t>& data) {
  for (size_t i = 0; i + 3 < data.size(); ++i) {
    if (data[i] != 0 || data[i + 1] != 0) continue;
    size_t start = 0;
    if (data[i + 2] == 1) start = i + 3;
    else if (data[i + 2] == 0 && i + 4 < data.size() && data[i + 3] == 1) start = i + 4;
    if (!start || start + 3 >= data.size()) continue;
    if ((data[start] & 0x1F) != 7) continue;
    char buf[32];
    std::snprintf(buf, sizeof(buf), "avc1.%02x%02x%02x", data[start + 1], data[start + 2], data[start + 3]);
    return buf;
  }
  return "";
}

// ---------------------------------------------------------------------------
// H264Encoder
// ---------------------------------------------------------------------------

H264Encoder::~H264Encoder() { close(); }

void H264Encoder::close() {
  std::lock_guard<std::mutex> lock(mutex_);
  if (mft_) {
    mft_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
    mft_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
    mft_.Reset();
  }
  sequenceHeader_.clear();
}

bool H264Encoder::open(int width, int height, int fps, int bitrateKbps, std::string* error) {
  close();
  std::lock_guard<std::mutex> lock(mutex_);
  if (!ensureMediaFoundation()) {
    if (error) *error = "Media Foundation did not start";
    return false;
  }
  width_ = evenDown(width);
  height_ = evenDown(height);
  fps_ = std::max(1, fps);
  HRESULT hr = CoCreateInstance(CLSID_CMSH264EncoderMFT, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&mft_));
  if (FAILED(hr)) {
    if (error) *error = hrText("the H.264 encoder is not available", hr);
    return false;
  }
  ComPtr<ICodecAPI> codec;
  if (SUCCEEDED(mft_.As(&codec))) {
    VARIANT v;
    VariantInit(&v);
    v.vt = VT_BOOL;
    v.boolVal = VARIANT_TRUE;
    codec->SetValue(&CODECAPI_AVLowLatencyMode, &v);
    v.vt = VT_UI4;
    v.ulVal = eAVEncCommonRateControlMode_CBR;
    codec->SetValue(&CODECAPI_AVEncCommonRateControlMode, &v);
    v.ulVal = static_cast<ULONG>(fps_);  // one keyframe a second
    codec->SetValue(&CODECAPI_AVEncMPVGOPSize, &v);
    v.ulVal = static_cast<ULONG>(bitrateKbps) * 1000;
    codec->SetValue(&CODECAPI_AVEncCommonMeanBitRate, &v);
  }
  ComPtr<IMFMediaType> out;
  MFCreateMediaType(&out);
  out->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  out->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
  out->SetUINT32(MF_MT_AVG_BITRATE, static_cast<UINT32>(bitrateKbps) * 1000);
  MFSetAttributeSize(out.Get(), MF_MT_FRAME_SIZE, width_, height_);
  MFSetAttributeRatio(out.Get(), MF_MT_FRAME_RATE, fps_, 1);
  MFSetAttributeRatio(out.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
  out->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  out->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High);
  hr = mft_->SetOutputType(0, out.Get(), 0);
  if (FAILED(hr)) {
    if (error) *error = hrText("the encoder refused the output type", hr);
    mft_.Reset();
    return false;
  }
  ComPtr<IMFMediaType> in;
  MFCreateMediaType(&in);
  in->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  in->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
  MFSetAttributeSize(in.Get(), MF_MT_FRAME_SIZE, width_, height_);
  MFSetAttributeRatio(in.Get(), MF_MT_FRAME_RATE, fps_, 1);
  MFSetAttributeRatio(in.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
  in->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  hr = mft_->SetInputType(0, in.Get(), 0);
  if (FAILED(hr)) {
    if (error) *error = hrText("the encoder refused the input type", hr);
    mft_.Reset();
    return false;
  }
  ComPtr<IMFMediaType> current;
  if (SUCCEEDED(mft_->GetOutputCurrentType(0, &current))) {
    UINT32 size = 0;
    if (SUCCEEDED(current->GetBlobSize(MF_MT_MPEG_SEQUENCE_HEADER, &size)) && size > 0) {
      sequenceHeader_.resize(size);
      current->GetBlob(MF_MT_MPEG_SEQUENCE_HEADER, sequenceHeader_.data(), size, nullptr);
    }
  }
  mft_->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
  mft_->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);
  keyframeRequested_ = true;
  return true;
}

void H264Encoder::forceKeyframe() {
  std::lock_guard<std::mutex> lock(mutex_);
  keyframeRequested_ = true;
}

bool H264Encoder::encode(const std::vector<uint8_t>& nv12, int64_t ts,
                         const std::function<void(const std::vector<uint8_t>&, bool)>& onUnit, std::string* error) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!mft_) {
    if (error) *error = "encoder not open";
    return false;
  }
  if (keyframeRequested_) {
    ComPtr<ICodecAPI> codec;
    if (SUCCEEDED(mft_.As(&codec))) {
      VARIANT v;
      VariantInit(&v);
      v.vt = VT_UI4;
      v.ulVal = 1;
      codec->SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &v);
    }
    keyframeRequested_ = false;
  }
  ComPtr<IMFMediaBuffer> buffer;
  HRESULT hr = MFCreateMemoryBuffer(static_cast<DWORD>(nv12.size()), &buffer);
  if (FAILED(hr)) {
    if (error) *error = hrText("MFCreateMemoryBuffer", hr);
    return false;
  }
  BYTE* dst = nullptr;
  buffer->Lock(&dst, nullptr, nullptr);
  std::memcpy(dst, nv12.data(), nv12.size());
  buffer->Unlock();
  buffer->SetCurrentLength(static_cast<DWORD>(nv12.size()));
  ComPtr<IMFSample> sample;
  MFCreateSample(&sample);
  sample->AddBuffer(buffer.Get());
  sample->SetSampleTime(ts);
  sample->SetSampleDuration(10'000'000LL / fps_);
  hr = mft_->ProcessInput(0, sample.Get(), 0);
  if (hr == MF_E_NOTACCEPTING) {
    if (!drain(onUnit, error)) return false;
    hr = mft_->ProcessInput(0, sample.Get(), 0);
  }
  if (FAILED(hr)) {
    if (error) *error = hrText("ProcessInput", hr);
    return false;
  }
  return drain(onUnit, error);
}

bool H264Encoder::drain(const std::function<void(const std::vector<uint8_t>&, bool)>& onUnit, std::string* error) {
  for (;;) {
    MFT_OUTPUT_STREAM_INFO info = {};
    mft_->GetOutputStreamInfo(0, &info);
    ComPtr<IMFSample> sample;
    ComPtr<IMFMediaBuffer> buffer;
    MFCreateSample(&sample);
    MFCreateMemoryBuffer(std::max<DWORD>(info.cbSize, 1024 * 1024), &buffer);
    sample->AddBuffer(buffer.Get());
    MFT_OUTPUT_DATA_BUFFER out = {};
    out.pSample = sample.Get();
    DWORD status = 0;
    HRESULT hr = mft_->ProcessOutput(0, 1, &out, &status);
    if (out.pEvents) out.pEvents->Release();
    if (hr == MF_E_TRANSFORM_NEED_MORE_INPUT) return true;
    if (hr == MF_E_TRANSFORM_STREAM_CHANGE) {
      ComPtr<IMFMediaType> type;
      if (SUCCEEDED(mft_->GetOutputAvailableType(0, 0, &type))) mft_->SetOutputType(0, type.Get(), 0);
      continue;
    }
    if (FAILED(hr)) {
      if (error) *error = hrText("ProcessOutput", hr);
      return false;
    }
    ComPtr<IMFMediaBuffer> contiguous;
    sample->ConvertToContiguousBuffer(&contiguous);
    BYTE* data = nullptr;
    DWORD length = 0;
    contiguous->Lock(&data, nullptr, &length);
    std::vector<uint8_t> unit(data, data + length);
    contiguous->Unlock();
    UINT32 clean = 0;
    sample->GetUINT32(MFSampleExtension_CleanPoint, &clean);
    bool keyframe = clean != 0 || hasNalType(unit, 5);
    if (keyframe && !hasNalType(unit, 7) && !sequenceHeader_.empty()) {
      unit.insert(unit.begin(), sequenceHeader_.begin(), sequenceHeader_.end());
    }
    if (!unit.empty()) onUnit(unit, keyframe);
  }
}

// ---------------------------------------------------------------------------
// StreamByteServer
// ---------------------------------------------------------------------------

namespace {
// Non-blocking writes have one record-wide deadline. A stalled local reader
// is disconnected rather than retaining the media mutex and blocking Stop.
bool sendRecord(SOCKET socket, const std::vector<uint8_t>& bytes, int64_t deadline) {
  size_t offset = 0;
  while (offset < bytes.size() && nowMs() < deadline) {
    int sent = send(socket, reinterpret_cast<const char*>(bytes.data() + offset), static_cast<int>(bytes.size() - offset), 0);
    if (sent > 0) { offset += sent; continue; }
    if (sent == 0 || WSAGetLastError() != WSAEWOULDBLOCK) return false;
    fd_set writable; FD_ZERO(&writable); FD_SET(socket, &writable);
    auto remaining = std::max<int64_t>(0, deadline - nowMs());
    timeval timeout{0, static_cast<long>(std::min<int64_t>(remaining, 25) * 1000)};
    if (select(0, nullptr, &writable, nullptr, &timeout) == SOCKET_ERROR) return false;
  }
  return offset == bytes.size();
}

bool ensureWinsock() {
  static std::once_flag once;
  static bool ok = false;
  std::call_once(once, [] {
    WSADATA data;
    ok = WSAStartup(MAKEWORD(2, 2), &data) == 0;
  });
  return ok;
}
}  // namespace

StreamByteServer::~StreamByteServer() { stop(); }

std::vector<uint8_t> StreamByteServer::record(uint8_t type, bool keyframe, const uint8_t* data, size_t size) {
  std::vector<uint8_t> out(kHeaderBytes + size);
  out[0] = static_cast<uint8_t>(kRecordMagic >> 24);
  out[1] = static_cast<uint8_t>(kRecordMagic >> 16);
  out[2] = static_cast<uint8_t>(kRecordMagic >> 8);
  out[3] = static_cast<uint8_t>(kRecordMagic);
  out[4] = type;
  out[5] = keyframe ? 1 : 0;
  out[6] = 0;
  out[7] = 0;
  out[8] = static_cast<uint8_t>(size >> 24);
  out[9] = static_cast<uint8_t>(size >> 16);
  out[10] = static_cast<uint8_t>(size >> 8);
  out[11] = static_cast<uint8_t>(size);
  if (size) std::memcpy(out.data() + kHeaderBytes, data, size);
  return out;
}

int StreamByteServer::start(std::function<void()> onClientAttached) {
  if (!ensureWinsock()) return 0;
  onClientAttached_ = std::move(onClientAttached);
  SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (s == INVALID_SOCKET) return 0;
  sockaddr_in addr = {};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = 0;
  if (bind(s, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0 || listen(s, 8) != 0) {
    closesocket(s);
    return 0;
  }
  int len = sizeof(addr);
  getsockname(s, reinterpret_cast<sockaddr*>(&addr), &len);
  listen_ = static_cast<uintptr_t>(s);
  port_ = ntohs(addr.sin_port);
  running_ = true;
  acceptThread_ = std::thread([this] { acceptLoop(); });
  return port_;
}

void StreamByteServer::acceptLoop() {
  while (running_) {
    SOCKET c = accept(static_cast<SOCKET>(listen_), nullptr, nullptr);
    if (c == INVALID_SOCKET) {
      if (!running_) return;
      Sleep(50);
      continue;
    }
    int one = 1;
    setsockopt(c, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&one), sizeof(one));
    u_long nonblocking = 1;
    if (ioctlsocket(c, FIONBIO, &nonblocking) != 0) { closesocket(c); continue; }
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (!running_ || clients_.size() >= 8 ||
          (!configRecord_.empty() && !sendRecord(c, configRecord_, nowMs() + 100))) {
        closesocket(c); continue;
      }
      // Publish only after the complete config record. All record writers use
      // this same lock, so no frame can precede or interleave with config.
      clients_.push_back(static_cast<uintptr_t>(c));
    }
    if (onClientAttached_) onClientAttached_();
  }
}

void StreamByteServer::stop() {
  if (!running_.exchange(false)) return;
  closesocket(static_cast<SOCKET>(listen_));
  if (acceptThread_.joinable()) acceptThread_.join();
  std::lock_guard<std::mutex> lock(mutex_);
  for (auto c : clients_) closesocket(static_cast<SOCKET>(c));
  clients_.clear();
}

void StreamByteServer::setConfig(const std::string& codec) {
  auto rec = record(1, false, reinterpret_cast<const uint8_t*>(codec.data()), codec.size());
  std::lock_guard<std::mutex> lock(mutex_);
  if (rec == configRecord_) return;
  configRecord_ = rec;
  for (auto it = clients_.begin(); it != clients_.end();) {
    if (!sendRecord(static_cast<SOCKET>(*it), rec, nowMs() + 250)) {
      closesocket(static_cast<SOCKET>(*it)); it = clients_.erase(it);
    } else ++it;
  }
}

void StreamByteServer::broadcast(uint8_t type, bool keyframe, const std::vector<uint8_t>& payload) {
  auto rec = record(type, keyframe, payload.data(), payload.size());
  std::lock_guard<std::mutex> lock(mutex_);
  for (auto it = clients_.begin(); it != clients_.end();) {
    if (!sendRecord(static_cast<SOCKET>(*it), rec, nowMs() + 250)) {
      closesocket(static_cast<SOCKET>(*it)); it = clients_.erase(it);
    } else ++it;
  }
}

size_t StreamByteServer::clientCount() {
  std::lock_guard<std::mutex> lock(mutex_);
  return clients_.size();
}

// ---------------------------------------------------------------------------
// Mp4Recorder
// ---------------------------------------------------------------------------

Mp4Recorder::~Mp4Recorder() {
  std::string ignored;
  finish(&ignored);
}

bool Mp4Recorder::open(const std::wstring& path, int width, int height, int fps, std::string* error) {
  if (!ensureMediaFoundation()) {
    if (error) *error = "Media Foundation did not start";
    return false;
  }
  width_ = evenDown(width);
  height_ = evenDown(height);
  ComPtr<IMFAttributes> attrs;
  MFCreateAttributes(&attrs, 2);
  attrs->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, TRUE);
  attrs->SetGUID(MF_TRANSCODE_CONTAINERTYPE, MFTranscodeContainerType_MPEG4);
  HRESULT hr = MFCreateSinkWriterFromURL(path.c_str(), nullptr, attrs.Get(), &writer_);
  if (FAILED(hr)) {
    if (error) *error = hrText("could not create the recording file", hr);
    writer_.Reset();
    return false;
  }
  ComPtr<IMFMediaType> out;
  MFCreateMediaType(&out);
  out->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  out->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
  // About 0.1 bit per pixel per frame: sharp text at a size that stays small.
  UINT32 bitrate = static_cast<UINT32>(std::min<int64_t>(20'000'000, std::max<int64_t>(
                                                                          2'000'000,
                                                                          static_cast<int64_t>(width_) * height_ * fps / 10)));
  out->SetUINT32(MF_MT_AVG_BITRATE, bitrate);
  out->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  MFSetAttributeSize(out.Get(), MF_MT_FRAME_SIZE, width_, height_);
  MFSetAttributeRatio(out.Get(), MF_MT_FRAME_RATE, fps, 1);
  MFSetAttributeRatio(out.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
  hr = writer_->AddStream(out.Get(), &stream_);
  ComPtr<IMFMediaType> in;
  MFCreateMediaType(&in);
  in->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  in->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
  in->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  MFSetAttributeSize(in.Get(), MF_MT_FRAME_SIZE, width_, height_);
  MFSetAttributeRatio(in.Get(), MF_MT_FRAME_RATE, fps, 1);
  MFSetAttributeRatio(in.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
  if (SUCCEEDED(hr)) hr = writer_->SetInputMediaType(stream_, in.Get(), nullptr);
  if (SUCCEEDED(hr)) hr = writer_->BeginWriting();
  if (FAILED(hr)) {
    if (error) *error = hrText("could not start the recording", hr);
    writer_.Reset();
    return false;
  }
  return true;
}

bool Mp4Recorder::write(const std::vector<uint8_t>& nv12, int64_t ts, int64_t duration, std::string* error) {
  if (!writer_) return false;
  ComPtr<IMFMediaBuffer> buffer;
  HRESULT hr = MFCreateMemoryBuffer(static_cast<DWORD>(nv12.size()), &buffer);
  if (FAILED(hr)) {
    if (error) *error = hrText("MFCreateMemoryBuffer", hr);
    return false;
  }
  BYTE* dst = nullptr;
  buffer->Lock(&dst, nullptr, nullptr);
  std::memcpy(dst, nv12.data(), nv12.size());
  buffer->Unlock();
  buffer->SetCurrentLength(static_cast<DWORD>(nv12.size()));
  ComPtr<IMFSample> sample;
  MFCreateSample(&sample);
  sample->AddBuffer(buffer.Get());
  sample->SetSampleTime(ts);
  sample->SetSampleDuration(duration);
  hr = writer_->WriteSample(stream_, sample.Get());
  if (FAILED(hr)) {
    if (error) *error = hrText("WriteSample", hr);
    return false;
  }
  return true;
}

bool Mp4Recorder::finish(std::string* error) {
  if (!writer_) return true;
  HRESULT hr = writer_->Finalize();
  writer_.Reset();
  if (FAILED(hr)) {
    if (error) *error = hrText("could not finish the recording", hr);
    return false;
  }
  return true;
}

}  // namespace ade
