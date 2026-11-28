#include <barrier>
#include <cstdio>
#include <thread>

int main() {
    std::barrier ready(2);
    std::jthread worker([&](std::stop_token stop) {
        ready.arrive_and_wait();
        while (!stop.stop_requested()) std::this_thread::yield();
    });
    ready.arrive_and_wait();
    if (!worker.request_stop()) return 1;
    worker.join();
    std::puts("ok");
}
