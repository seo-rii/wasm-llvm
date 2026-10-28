#ifndef __STDCPP_THREADS__
#error "The Linux x86-64 target must define __STDCPP_THREADS__"
#else
static_assert(__STDCPP_THREADS__ == 1, "The Linux target must support C++ threads");
#endif

#include <cstdio>
#include <thread>

struct ThreadState {
    int value = 0;
    int *final_value = nullptr;
    int *destructors = nullptr;

    ~ThreadState() {
        if (final_value) *final_value = value;
        if (destructors) ++*destructors;
    }
};

thread_local ThreadState state;

int main() {
    int input;
    if (std::scanf("%d", &input) != 1 || input < -1000 || input > 1000) return 2;

    // Main-thread TLS stays independent and has no pointers to automatic data.
    state.value = 7;
    int worker_value = 0;
    int final_value = 0;
    int destructors = 0;
    std::thread worker([&] {
        state.value += input * 3;
        state.final_value = &final_value;
        state.destructors = &destructors;
        worker_value = state.value;
    });
    // join synchronizes the worker's writes, including its TLS destructor.
    worker.join();

    std::printf("%d %d %d %d\n", worker_value, final_value, destructors, state.value);
    return worker_value == input * 3 && final_value == worker_value &&
                   destructors == 1 && state.value == 7
               ? 0
               : 3;
}
