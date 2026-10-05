// Child mode: the engine inside the private screen.
//
// Started by the host's logon task (or ADE's Run entry) when Windows signs
// the child session in. It
// connects back to the host over two named pipes and serves the engine's ops
// for the one holder lane. v1 leaves the user's own startup apps alone
// (decided 2026-09-30); the agent skill tells agents to ignore them.

#include "engine.h"
#include "modes.h"

#include <thread>
#include <vector>
#include <future>
#include <algorithm>
#include <chrono>

namespace ade {

namespace {

HANDLE openPipe(const std::wstring& name, DWORD access) {
  for (int i = 0; i < 200; ++i) {
    HANDLE h = CreateFileW(name.c_str(), access, 0, nullptr, OPEN_EXISTING, 0, nullptr);
    if (h != INVALID_HANDLE_VALUE) return h;
    if (GetLastError() == ERROR_PIPE_BUSY) WaitNamedPipeW(name.c_str(), 500);
    else Sleep(100);
  }
  return INVALID_HANDLE_VALUE;
}

Json childPing(Engine& engine) {
  Json out = Json::object();
  out["version"] = kDriverVersion;
  out["pid"] = static_cast<int64_t>(GetCurrentProcessId());
  out["sessionId"] = static_cast<int64_t>(currentSessionId());
  Json lanes = Json::array();
  for (auto& id : engine.laneIds()) lanes.push(id);
  out["displays"] = lanes;
  out["busy"] = engine.busy(120'000);
  return out;
}

}  // namespace

int runChild(const std::wstring& pipeBase) {
  if (currentSessionId() == consoleSessionId()) {
    logLine("child mode refused: this is not the active child session");
    return 2;
  }
  HANDLE in = openPipe(pipeToChild(pipeBase), GENERIC_READ);
  HANDLE outPipe = openPipe(pipeFromChild(pipeBase), GENERIC_WRITE);
  if (in == INVALID_HANDLE_VALUE || outPipe == INVALID_HANDLE_VALUE) {
    logLine("child mode: the host's pipes are not there");
    return 3;
  }
  ULONG inputHost = 0, outputHost = 0;
  DWORD hostSession = 0;
  if (!GetNamedPipeServerProcessId(in, &inputHost) ||
      !GetNamedPipeServerProcessId(outPipe, &outputHost) || inputHost != outputHost ||
      !ProcessIdToSessionId(inputHost, &hostSession) || hostSession != consoleSessionId()) {
    CloseHandle(in); CloseHandle(outPipe);
    logLine("child mode: pipes do not belong to one console host");
    return 3;
  }
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  LineWriter out(outPipe);
  Engine engine(Engine::Mode::Private, [&out](const Json& line) { out.write(line); });
  std::string error;
  if (!engine.init(&error)) {
    out.write(eventLine("child-failed", Json::Object{{"message", error}}));
    return 4;
  }
  Json hello = Json::object();
  hello["sessionId"] = static_cast<int64_t>(currentSessionId());
  hello["pid"] = static_cast<int64_t>(GetCurrentProcessId());
  hello["version"] = kDriverVersion;
  out.write(eventLine("child-hello", hello));

  LineReader reader(in);
  std::string line;
  // Keep every worker alive until shutdown has cancelled waits and joined it.
  // Detached workers used references to destroyed engine/writer objects.
  std::vector<std::future<void>> workers;
  while (reader.next(line)) {
    if (line.empty()) continue;
    Json req;
    try {
      req = Json::parse(line);
    } catch (const std::exception& e) {
      out.write(eventLine(code::kProtocolError, Json::Object{{"message", std::string(e.what())}}));
      continue;
    }
    const std::string id = req["id"].str();
    const std::string op = req["op"].str();
    if (op == "child.quit" || req["type"].str() == "quit") break;
    if (id.empty() || op.empty()) continue;
    workers.erase(std::remove_if(workers.begin(), workers.end(), [](std::future<void>& job) {
      if (job.wait_for(std::chrono::milliseconds(0)) != std::future_status::ready) return false;
      job.get(); return true;
    }), workers.end());
    if (workers.size() >= 32) {
      out.write(errorReply(id, {code::kDriverUnavailable, "The private screen is busy. Try again after pending actions finish.", Json()}));
      continue;
    }
    // Each request on its own thread: a two-minute `wait` must not hold the
    // health ping or another op behind it.
    workers.push_back(std::async(std::launch::async, [&engine, &out, req, id, op] {
      CoInitializeEx(nullptr, COINIT_MULTITHREADED);
      try {
        Json result = op == "ping" ? childPing(engine) : engine.handle(req);
        out.write(okReply(id, result));
      } catch (const DriverError& e) {
        out.write(errorReply(id, e));
      } catch (const std::exception& e) {
        out.write(errorReply(id, DriverError{code::kInternalError, e.what(), Json()}));
      }
      CoUninitialize();
    }));
  }
  engine.cancelRequests();
  for (auto& worker : workers) worker.get();
  engine.shutdown();
  CloseHandle(in);
  CloseHandle(outPipe);
  CoUninitialize();
  return 0;
}

}  // namespace ade
