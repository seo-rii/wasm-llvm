#ifndef WASM_IDLE_LLVM_WASI_THREAD_SHIM_H
#define WASM_IDLE_LLVM_WASI_THREAD_SHIM_H

#if defined(__wasi__)

#if defined(__clang__) && __has_feature(modules)
#pragma clang module import std
#else
#include <chrono>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <type_traits>
#include <utility>
#endif

namespace std {

class mutex {
public:
  void lock() noexcept {}
  bool try_lock() noexcept { return true; }
  void unlock() noexcept {}
};

class recursive_mutex : public mutex {};
class timed_mutex : public mutex {};
class recursive_timed_mutex : public mutex {};

class thread {
public:
  class id {
  public:
    friend constexpr bool operator==(id, id) noexcept { return true; }
    friend constexpr bool operator!=(id, id) noexcept { return false; }
    friend constexpr bool operator<(id, id) noexcept { return false; }
  };

  using native_handle_type = void *;

  thread() noexcept = default;
  template <class Function, class... Args>
  explicit thread(Function &&FunctionValue, Args &&...ArgumentValues) {
    std::invoke(std::forward<Function>(FunctionValue),
                std::forward<Args>(ArgumentValues)...);
  }
  thread(thread &&) noexcept = default;
  thread &operator=(thread &&) noexcept = default;

  bool joinable() const noexcept { return false; }
  void join() noexcept {}
  void detach() noexcept {}
  id get_id() const noexcept { return {}; }
  native_handle_type native_handle() noexcept { return nullptr; }
  static unsigned hardware_concurrency() noexcept { return 1; }
};

namespace this_thread {
inline thread::id get_id() noexcept { return {}; }
inline void yield() noexcept {}
template <class Rep, class Period>
void sleep_for(const chrono::duration<Rep, Period> &) noexcept {}
template <class Clock, class Duration>
void sleep_until(const chrono::time_point<Clock, Duration> &) noexcept {}
} // namespace this_thread

class shared_mutex : public mutex {
public:
  void lock_shared() noexcept {}
  bool try_lock_shared() noexcept { return true; }
  void unlock_shared() noexcept {}
};

class shared_timed_mutex : public shared_mutex {};

template <class Mutex> class shared_lock {
public:
  shared_lock() noexcept = default;
  explicit shared_lock(Mutex &M) : MutexPtr(&M), Owns(true) { M.lock_shared(); }
  shared_lock(Mutex &M, defer_lock_t) noexcept : MutexPtr(&M) {}
  shared_lock(Mutex &M, try_to_lock_t)
      : MutexPtr(&M), Owns(M.try_lock_shared()) {}
  shared_lock(Mutex &M, adopt_lock_t) : MutexPtr(&M), Owns(true) {}
  shared_lock(shared_lock &&Other) noexcept
      : MutexPtr(exchange(Other.MutexPtr, nullptr)),
        Owns(exchange(Other.Owns, false)) {}
  shared_lock &operator=(shared_lock &&Other) noexcept {
    if (Owns)
      MutexPtr->unlock_shared();
    MutexPtr = exchange(Other.MutexPtr, nullptr);
    Owns = exchange(Other.Owns, false);
    return *this;
  }
  ~shared_lock() {
    if (Owns)
      MutexPtr->unlock_shared();
  }

  void lock() {
    MutexPtr->lock_shared();
    Owns = true;
  }
  bool try_lock() {
    Owns = MutexPtr->try_lock_shared();
    return Owns;
  }
  void unlock() {
    MutexPtr->unlock_shared();
    Owns = false;
  }
  bool owns_lock() const noexcept { return Owns; }
  explicit operator bool() const noexcept { return Owns; }
  Mutex *mutex() const noexcept { return MutexPtr; }
  Mutex *release() noexcept {
    Owns = false;
    return exchange(MutexPtr, nullptr);
  }

private:
  Mutex *MutexPtr = nullptr;
  bool Owns = false;
};

enum class cv_status { no_timeout, timeout };

class condition_variable {
public:
  void notify_one() noexcept {}
  void notify_all() noexcept {}
  void wait(unique_lock<mutex> &) noexcept {}
  template <class Predicate>
  void wait(unique_lock<mutex> &, Predicate PredicateFn) {
    (void)PredicateFn();
  }
  template <class Rep, class Period>
  cv_status wait_for(unique_lock<mutex> &,
                     const chrono::duration<Rep, Period> &) {
    return cv_status::no_timeout;
  }
  template <class Rep, class Period, class Predicate>
  bool wait_for(unique_lock<mutex> &, const chrono::duration<Rep, Period> &,
                Predicate PredicateFn) {
    return PredicateFn();
  }
  template <class Clock, class Duration>
  cv_status wait_until(unique_lock<mutex> &,
                       const chrono::time_point<Clock, Duration> &) {
    return cv_status::no_timeout;
  }
  template <class Clock, class Duration, class Predicate>
  bool wait_until(unique_lock<mutex> &,
                  const chrono::time_point<Clock, Duration> &,
                  Predicate PredicateFn) {
    return PredicateFn();
  }
};

class condition_variable_any {
public:
  void notify_one() noexcept {}
  void notify_all() noexcept {}
  template <class Lock> void wait(Lock &) noexcept {}
  template <class Lock, class Predicate>
  void wait(Lock &, Predicate PredicateFn) {
    (void)PredicateFn();
  }
  template <class Lock, class Rep, class Period>
  cv_status wait_for(Lock &, const chrono::duration<Rep, Period> &) {
    return cv_status::no_timeout;
  }
  template <class Lock, class Rep, class Period, class Predicate>
  bool wait_for(Lock &, const chrono::duration<Rep, Period> &,
                Predicate PredicateFn) {
    return PredicateFn();
  }
  template <class Lock, class Clock, class Duration>
  cv_status wait_until(Lock &, const chrono::time_point<Clock, Duration> &) {
    return cv_status::no_timeout;
  }
  template <class Lock, class Clock, class Duration, class Predicate>
  bool wait_until(Lock &, const chrono::time_point<Clock, Duration> &,
                  Predicate PredicateFn) {
    return PredicateFn();
  }
};

enum class future_status { ready, timeout, deferred };
enum class launch { async = 1, deferred = 2 };

constexpr launch operator|(launch Left, launch Right) noexcept {
  return static_cast<launch>(static_cast<int>(Left) | static_cast<int>(Right));
}

constexpr launch operator&(launch Left, launch Right) noexcept {
  return static_cast<launch>(static_cast<int>(Left) & static_cast<int>(Right));
}

template <class Value> struct __wasm_idle_future_state {
  optional<Value> ValueStorage;
};

template <> struct __wasm_idle_future_state<void> { bool Ready = false; };

template <class Value> class shared_future;

template <class Value> class future {
  template <class> friend class promise;
  template <class> friend class shared_future;

public:
  future() noexcept = default;
  future(future &&) noexcept = default;
  future &operator=(future &&) noexcept = default;
  future(const future &) = delete;
  future &operator=(const future &) = delete;

  bool valid() const noexcept { return State && State->ValueStorage.has_value(); }
  void wait() const {
    if (!valid())
      terminate();
  }
  template <class Rep, class Period>
  future_status wait_for(const chrono::duration<Rep, Period> &) const {
    return valid() ? future_status::ready : future_status::timeout;
  }
  template <class Clock, class Duration>
  future_status wait_until(const chrono::time_point<Clock, Duration> &) const {
    return valid() ? future_status::ready : future_status::timeout;
  }
  Value get() {
    wait();
    Value Result = std::move(*State->ValueStorage);
    State.reset();
    return Result;
  }
  shared_future<Value> share() noexcept;

private:
  explicit future(shared_ptr<__wasm_idle_future_state<Value>> StateValue)
      : State(std::move(StateValue)) {}

  shared_ptr<__wasm_idle_future_state<Value>> State;
};

template <> class future<void> {
  template <class> friend class promise;
  template <class> friend class shared_future;

public:
  future() noexcept = default;
  future(future &&) noexcept = default;
  future &operator=(future &&) noexcept = default;
  future(const future &) = delete;
  future &operator=(const future &) = delete;

  bool valid() const noexcept { return State && State->Ready; }
  void wait() const {
    if (!valid())
      terminate();
  }
  template <class Rep, class Period>
  future_status wait_for(const chrono::duration<Rep, Period> &) const {
    return valid() ? future_status::ready : future_status::timeout;
  }
  template <class Clock, class Duration>
  future_status wait_until(const chrono::time_point<Clock, Duration> &) const {
    return valid() ? future_status::ready : future_status::timeout;
  }
  void get() {
    wait();
    State.reset();
  }
  shared_future<void> share() noexcept;

private:
  explicit future(shared_ptr<__wasm_idle_future_state<void>> StateValue)
      : State(std::move(StateValue)) {}

  shared_ptr<__wasm_idle_future_state<void>> State;
};

template <class Value> class promise {
public:
  promise() : State(make_shared<__wasm_idle_future_state<Value>>()) {}
  promise(promise &&) noexcept = default;
  promise &operator=(promise &&) noexcept = default;
  promise(const promise &) = delete;
  promise &operator=(const promise &) = delete;

  future<Value> get_future() { return future<Value>(State); }
  void set_value(const Value &Result) { State->ValueStorage.emplace(Result); }
  void set_value(Value &&Result) {
    State->ValueStorage.emplace(std::move(Result));
  }

private:
  shared_ptr<__wasm_idle_future_state<Value>> State;
};

template <> class promise<void> {
public:
  promise() : State(make_shared<__wasm_idle_future_state<void>>()) {}
  promise(promise &&) noexcept = default;
  promise &operator=(promise &&) noexcept = default;
  promise(const promise &) = delete;
  promise &operator=(const promise &) = delete;

  future<void> get_future() { return future<void>(State); }
  void set_value() { State->Ready = true; }

private:
  shared_ptr<__wasm_idle_future_state<void>> State;
};

template <class Value> class shared_future {
public:
  shared_future() noexcept = default;
  shared_future(const shared_future &) noexcept = default;
  shared_future(shared_future &&) noexcept = default;
  shared_future &operator=(const shared_future &) noexcept = default;
  shared_future &operator=(shared_future &&) noexcept = default;
  shared_future(future<Value> &&Other) noexcept
      : State(std::move(Other.State)) {}

  bool valid() const noexcept { return State && State->ValueStorage.has_value(); }
  void wait() const {
    if (!valid())
      terminate();
  }
  template <class Rep, class Period>
  future_status wait_for(const chrono::duration<Rep, Period> &) const {
    return valid() ? future_status::ready : future_status::timeout;
  }
  template <class Clock, class Duration>
  future_status wait_until(const chrono::time_point<Clock, Duration> &) const {
    return valid() ? future_status::ready : future_status::timeout;
  }
  const Value &get() const {
    wait();
    return *State->ValueStorage;
  }

private:
  shared_ptr<__wasm_idle_future_state<Value>> State;
};

template <> class shared_future<void> {
public:
  shared_future() noexcept = default;
  shared_future(const shared_future &) noexcept = default;
  shared_future(shared_future &&) noexcept = default;
  shared_future &operator=(const shared_future &) noexcept = default;
  shared_future &operator=(shared_future &&) noexcept = default;
  shared_future(future<void> &&Other) noexcept
      : State(std::move(Other.State)) {}

  bool valid() const noexcept { return State && State->Ready; }
  void wait() const {
    if (!valid())
      terminate();
  }
  template <class Rep, class Period>
  future_status wait_for(const chrono::duration<Rep, Period> &) const {
    return valid() ? future_status::ready : future_status::timeout;
  }
  template <class Clock, class Duration>
  future_status wait_until(const chrono::time_point<Clock, Duration> &) const {
    return valid() ? future_status::ready : future_status::timeout;
  }
  void get() const { wait(); }

private:
  shared_ptr<__wasm_idle_future_state<void>> State;
};

template <class Value> shared_future<Value> future<Value>::share() noexcept {
  return shared_future<Value>(std::move(*this));
}

inline shared_future<void> future<void>::share() noexcept {
  return shared_future<void>(std::move(*this));
}

template <class Function, class... Args>
auto async(launch, Function &&FunctionValue, Args &&...ArgumentValues)
    -> future<invoke_result_t<decay_t<Function>, decay_t<Args>...>> {
  using Result = invoke_result_t<decay_t<Function>, decay_t<Args>...>;
  promise<Result> Promise;
  auto Future = Promise.get_future();
  if constexpr (is_void_v<Result>) {
    invoke(std::forward<Function>(FunctionValue),
           std::forward<Args>(ArgumentValues)...);
    Promise.set_value();
  } else {
    Promise.set_value(invoke(std::forward<Function>(FunctionValue),
                             std::forward<Args>(ArgumentValues)...));
  }
  return Future;
}

template <class Function, class... Args>
auto async(Function &&FunctionValue, Args &&...ArgumentValues)
    -> future<invoke_result_t<decay_t<Function>, decay_t<Args>...>> {
  return async(launch::deferred, std::forward<Function>(FunctionValue),
               std::forward<Args>(ArgumentValues)...);
}

} // namespace std

#endif
#endif
