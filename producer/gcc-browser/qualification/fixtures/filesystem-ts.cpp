#include <cstdio>
#include <experimental/filesystem>

int main() {
    if (!std::experimental::filesystem::is_directory(".")) return 1;
    std::puts("directory");
}
