// A small JSON value for the NDJSON wire.
//
// The driver carries the same request and reply shapes as the macOS driver
// (`apps/desktop/src/shared/types/macDesktop.ts` is the contract). The Windows
// SDK has no JSON library a plain Win32 console program can use without WinRT
// plumbing, and the shapes are small, so this file holds a parser and a writer
// and nothing else. Integers and doubles are separate kinds on purpose: a
// window id or a pid must serialize as `41`, not `41.0`.

#pragma once

#include <cstdint>
#include <map>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace ade {

class Json {
 public:
  enum class Kind { Null, Bool, Int, Double, String, Array, Object };
  using Array = std::vector<Json>;
  using Object = std::map<std::string, Json>;

  Json() : kind_(Kind::Null) {}
  Json(std::nullptr_t) : kind_(Kind::Null) {}
  Json(bool v) : kind_(Kind::Bool), b_(v) {}
  Json(int v) : kind_(Kind::Int), i_(v) {}
  Json(int64_t v) : kind_(Kind::Int), i_(v) {}
  Json(uint32_t v) : kind_(Kind::Int), i_(v) {}
  Json(unsigned long v) : kind_(Kind::Int), i_(static_cast<int64_t>(v)) {}
  Json(double v) : kind_(Kind::Double), d_(v) {}
  Json(const char* v) : kind_(Kind::String), s_(v) {}
  Json(std::string v) : kind_(Kind::String), s_(std::move(v)) {}
  Json(Array v) : kind_(Kind::Array), a_(std::make_shared<Array>(std::move(v))) {}
  Json(Object v) : kind_(Kind::Object), o_(std::make_shared<Object>(std::move(v))) {}

  static Json array() { return Json(Array{}); }
  static Json object() { return Json(Object{}); }

  Kind kind() const { return kind_; }
  bool isNull() const { return kind_ == Kind::Null; }
  bool isObject() const { return kind_ == Kind::Object; }
  bool isArray() const { return kind_ == Kind::Array; }
  bool isString() const { return kind_ == Kind::String; }
  bool isNumber() const { return kind_ == Kind::Int || kind_ == Kind::Double; }
  bool isBool() const { return kind_ == Kind::Bool; }

  bool asBool(bool fallback = false) const { return kind_ == Kind::Bool ? b_ : fallback; }
  int64_t asInt(int64_t fallback = 0) const {
    if (kind_ == Kind::Int) return i_;
    if (kind_ == Kind::Double && d_ >= static_cast<double>(std::numeric_limits<int64_t>::min()) &&
        d_ < -static_cast<double>(std::numeric_limits<int64_t>::min())) return static_cast<int64_t>(d_);
    return fallback;
  }
  double asDouble(double fallback = 0) const {
    if (kind_ == Kind::Double) return d_;
    if (kind_ == Kind::Int) return static_cast<double>(i_);
    return fallback;
  }
  const std::string& asString() const {
    static const std::string empty;
    return kind_ == Kind::String ? s_ : empty;
  }
  std::string str(const std::string& fallback = "") const { return kind_ == Kind::String ? s_ : fallback; }

  const Array& items() const {
    static const Array empty;
    return kind_ == Kind::Array ? *a_ : empty;
  }
  Array& items() {
    if (kind_ != Kind::Array) { *this = array(); }
    return *a_;
  }
  const Object& fields() const {
    static const Object empty;
    return kind_ == Kind::Object ? *o_ : empty;
  }

  // Reads a member; a missing member (or a non-object) reads as null.
  const Json& operator[](const std::string& key) const {
    static const Json null;
    if (kind_ != Kind::Object) return null;
    auto it = o_->find(key);
    return it == o_->end() ? null : it->second;
  }
  // Writes a member, turning a null into an object first.
  Json& operator[](const std::string& key) {
    if (kind_ != Kind::Object) { *this = object(); }
    return (*o_)[key];
  }
  bool has(const std::string& key) const {
    return kind_ == Kind::Object && o_->count(key) > 0;
  }
  void push(Json value) { items().push_back(std::move(value)); }

  std::string dump() const;
  static Json parse(const std::string& text);  // throws std::runtime_error

 private:
  void dumpTo(std::string& out) const;
  Kind kind_;
  bool b_ = false;
  int64_t i_ = 0;
  double d_ = 0;
  std::string s_;
  std::shared_ptr<Array> a_;
  std::shared_ptr<Object> o_;
};

// UTF-8 <-> UTF-16 for the Win32 boundary. Every string on the wire is UTF-8.
std::wstring widen(const std::string& utf8);
std::string narrow(const std::wstring& wide);

}  // namespace ade
