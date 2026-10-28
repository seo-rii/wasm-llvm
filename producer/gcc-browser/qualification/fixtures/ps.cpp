#include <bits/stdc++.h>
#include <ext/pb_ds/assoc_container.hpp>
#include <ext/pb_ds/tree_policy.hpp>

using namespace __gnu_pbds;
using ordered_set = tree<long long, null_type, std::less<long long>, rb_tree_tag,
                         tree_order_statistics_node_update>;

static_assert(sizeof(void *) == 8 && sizeof(long) == 8);
static_assert(__LDBL_MANT_DIG__ == 64);

struct UnwindGuard {
    int &count;
    ~UnwindGuard() { ++count; }
};

__attribute__((noinline)) void raise_for_unwind(int &destructors) {
    UnwindGuard guard{destructors};
    throw std::runtime_error("handled");
}

int main() {
    int count;
    long long cutoff;
    if (!(std::cin >> count >> cutoff) || count < 1 || count > 10000) return 2;
    std::vector<long long> values(count);
    ordered_set ordered;
    for (auto &value : values) {
        if (!(std::cin >> value)) return 2;
        ordered.insert(value);
    }
    int destructors = 0;
    try {
        raise_for_unwind(destructors);
    } catch (const std::runtime_error &error) {
        std::cout << ordered.size() << ' ' << ordered.order_of_key(cutoff) << ' '
                  << *ordered.find_by_order(ordered.size() / 2) << ' '
                  << std::accumulate(values.begin(), values.end(), 0LL) << ' '
                  << destructors << ' ' << error.what() << '\n';
    }
    return destructors == 1 ? 0 : 3;
}
