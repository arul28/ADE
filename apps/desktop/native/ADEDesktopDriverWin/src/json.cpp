#include "json.h"

#include <windows.h>

#include <cmath>
#include <cstdio>

namespace ade {

namespace {

void writeString(std::string& out, const std::string& s) {
  out.push_back('"');
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out.push_back(static_cast<char>(c));
        }
    }
  }
  out.push_back('"');
}

void appendUtf8(std::string& out, uint32_t cp) {
  if (cp < 0x80) {
    out.push_back(static_cast<char>(cp));
  } else if (cp < 0x800) {
    out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else if (cp < 0x10000) {
    out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else {
    out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  }
}

class Parser {
 public:
  explicit Parser(const std::string& text) : t_(text) {}

  Json parseDocument() {
    Json value = parseValue(0);
    skipSpace();
    if (p_ != t_.size()) fail("trailing characters");
    return value;
  }

 private:
  [[noreturn]] void fail(const char* what) {
    throw std::runtime_error(std::string("invalid JSON: ") + what);
  }
  void skipSpace() {
    while (p_ < t_.size() && (t_[p_] == ' ' || t_[p_] == '\t' || t_[p_] == '\n' || t_[p_] == '\r')) ++p_;
  }
  bool consume(const char* word) {
    size_t n = std::strlen(word);
    if (t_.compare(p_, n, word) == 0) {
      p_ += n;
      return true;
    }
    return false;
  }

  Json parseValue(int depth) {
    // A nesting cap keeps a hostile line from overflowing the stack.
    if (depth > 64) fail("nesting too deep");
    skipSpace();
    if (p_ >= t_.size()) fail("unexpected end");
    char c = t_[p_];
    if (c == '{') return parseObject(depth);
    if (c == '[') return parseArray(depth);
    if (c == '"') return Json(parseString());
    if (consume("true")) return Json(true);
    if (consume("false")) return Json(false);
    if (consume("null")) return Json();
    return parseNumber();
  }

  Json parseObject(int depth) {
    ++p_;
    Json::Object obj;
    skipSpace();
    if (p_ < t_.size() && t_[p_] == '}') {
      ++p_;
      return Json(std::move(obj));
    }
    for (;;) {
      skipSpace();
      if (p_ >= t_.size() || t_[p_] != '"') fail("expected key");
      std::string key = parseString();
      skipSpace();
      if (p_ >= t_.size() || t_[p_] != ':') fail("expected colon");
      ++p_;
      obj[key] = parseValue(depth + 1);
      skipSpace();
      if (p_ < t_.size() && t_[p_] == ',') { ++p_; continue; }
      if (p_ < t_.size() && t_[p_] == '}') { ++p_; break; }
      fail("expected , or }");
    }
    return Json(std::move(obj));
  }

  Json parseArray(int depth) {
    ++p_;
    Json::Array arr;
    skipSpace();
    if (p_ < t_.size() && t_[p_] == ']') {
      ++p_;
      return Json(std::move(arr));
    }
    for (;;) {
      arr.push_back(parseValue(depth + 1));
      skipSpace();
      if (p_ < t_.size() && t_[p_] == ',') { ++p_; continue; }
      if (p_ < t_.size() && t_[p_] == ']') { ++p_; break; }
      fail("expected , or ]");
    }
    return Json(std::move(arr));
  }

  uint32_t hex4() {
    if (p_ + 4 > t_.size()) fail("short escape");
    uint32_t v = 0;
    for (int i = 0; i < 4; ++i) {
      char c = t_[p_++];
      v <<= 4;
      if (c >= '0' && c <= '9') v |= c - '0';
      else if (c >= 'a' && c <= 'f') v |= c - 'a' + 10;
      else if (c >= 'A' && c <= 'F') v |= c - 'A' + 10;
      else fail("bad hex");
    }
    return v;
  }

  std::string parseString() {
    ++p_;
    std::string out;
    while (p_ < t_.size()) {
      char c = t_[p_++];
      if (c == '"') return out;
      if (c != '\\') {
        if (static_cast<unsigned char>(c) < 0x20) fail("unescaped control character");
        out.push_back(c);
        continue;
      }
      if (p_ >= t_.size()) break;
      char e = t_[p_++];
      switch (e) {
        case '"': out.push_back('"'); break;
        case '\\': out.push_back('\\'); break;
        case '/': out.push_back('/'); break;
        case 'b': out.push_back('\b'); break;
        case 'f': out.push_back('\f'); break;
        case 'n': out.push_back('\n'); break;
        case 'r': out.push_back('\r'); break;
        case 't': out.push_back('\t'); break;
        case 'u': {
          uint32_t cp = hex4();
          if (cp >= 0xD800 && cp <= 0xDBFF) {
            if (p_ + 6 > t_.size() || t_[p_] != '\\' || t_[p_ + 1] != 'u') fail("missing low surrogate");
            p_ += 2;
            uint32_t low = hex4();
            if (low < 0xDC00 || low > 0xDFFF) fail("bad low surrogate");
            cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
          }
          if (cp >= 0xDC00 && cp <= 0xDFFF) fail("unpaired low surrogate");
          appendUtf8(out, cp);
          break;
        }
        default: fail("bad escape");
      }
    }
    fail("unterminated string");
  }

  Json parseNumber() {
    size_t start = p_;
    bool isDouble = false;
    if (p_ < t_.size() && t_[p_] == '-') ++p_;
    auto digit = [&] { return p_ < t_.size() && t_[p_] >= '0' && t_[p_] <= '9'; };
    if (!digit()) fail("missing number digits");
    if (t_[p_] == '0') { ++p_; if (digit()) fail("leading zero"); }
    else while (digit()) ++p_;
    if (p_ < t_.size() && t_[p_] == '.') {
      isDouble = true; ++p_;
      if (!digit()) fail("missing fraction digits");
      while (digit()) ++p_;
    }
    if (p_ < t_.size() && (t_[p_] == 'e' || t_[p_] == 'E')) {
      isDouble = true; ++p_;
      if (p_ < t_.size() && (t_[p_] == '+' || t_[p_] == '-')) ++p_;
      if (!digit()) fail("missing exponent digits");
      while (digit()) ++p_;
    }
    std::string num = t_.substr(start, p_ - start);
    try {
      if (!isDouble) return Json(static_cast<int64_t>(std::stoll(num)));
      double value = std::stod(num);
      if (!std::isfinite(value)) fail("number out of range");
      return Json(value);
    } catch (...) {
      fail("bad number");
    }
  }

  const std::string& t_;
  size_t p_ = 0;
};

}  // namespace

void Json::dumpTo(std::string& out) const {
  switch (kind_) {
    case Kind::Null: out += "null"; break;
    case Kind::Bool: out += b_ ? "true" : "false"; break;
    case Kind::Int: out += std::to_string(i_); break;
    case Kind::Double: {
      if (!std::isfinite(d_)) {
        out += "null";
        break;
      }
      char buf[40];
      std::snprintf(buf, sizeof(buf), "%.17g", d_);
      out += buf;
      break;
    }
    case Kind::String: writeString(out, s_); break;
    case Kind::Array: {
      out.push_back('[');
      bool first = true;
      for (const auto& v : *a_) {
        if (!first) out.push_back(',');
        first = false;
        v.dumpTo(out);
      }
      out.push_back(']');
      break;
    }
    case Kind::Object: {
      out.push_back('{');
      bool first = true;
      for (const auto& kv : *o_) {
        if (!first) out.push_back(',');
        first = false;
        writeString(out, kv.first);
        out.push_back(':');
        kv.second.dumpTo(out);
      }
      out.push_back('}');
      break;
    }
  }
}

std::string Json::dump() const {
  std::string out;
  dumpTo(out);
  return out;
}

Json Json::parse(const std::string& text) { return Parser(text).parseDocument(); }

std::wstring widen(const std::string& utf8) {
  if (utf8.empty()) return std::wstring();
  int n = MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), nullptr, 0);
  std::wstring out(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), out.data(), n);
  return out;
}

std::string narrow(const std::wstring& wide) {
  if (wide.empty()) return std::string();
  int n = WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()), nullptr, 0, nullptr, nullptr);
  std::string out(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()), out.data(), n, nullptr, nullptr);
  return out;
}

}  // namespace ade
