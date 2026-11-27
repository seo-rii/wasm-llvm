#include <cstdio>
#include <stacktrace>

int main() {
    if (std::stacktrace::current().empty()) return 1;
    std::puts("trace");
}
