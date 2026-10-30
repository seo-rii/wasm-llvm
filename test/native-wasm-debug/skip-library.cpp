#include <algorithm>

__attribute__((noinline)) bool descending(int left, int right) {
  bool result = left > right; // comparator breakpoint
  return result;
}

int main() {
  int values[] = {4, 1, 3};
  std::sort(values, values + 3); // library entry
  std::sort(values, values + 3, descending); // callback call
  int top = values[0]; // after call
  return top == 4 ? 0 : 1;
}
