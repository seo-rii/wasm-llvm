#include <deque>
#include <functional>
#include <queue>
#include <stack>
#include <vector>

struct Greater {
  bool operator()(int left, int right) const { return left > right; }
};

int main() {
  std::stack<int> empty_stack;
  std::priority_queue<int> empty_heap;
  std::stack<int> deque_stack(std::deque<int>{1, 2, 3});
  std::stack<int, std::vector<int>> vector_stack(std::vector<int>{4, 5, 6});
  std::priority_queue<int> max_heap(std::less<int>(), {1, 4, 2});
  std::priority_queue<int, std::vector<int>, Greater> min_heap(Greater(), {4, 1, 2});
  std::priority_queue<int, std::deque<int>, std::greater<int>> deque_heap(
      std::greater<int>(), {4, 1, 2});
  std::stack<std::vector<int>> nested_stack;
  nested_stack.push({7, 8});
  std::priority_queue<std::vector<int>> nested_heap;
  nested_heap.push({1, 2});
  nested_heap.push({3, 4});
  volatile int checkpoint = 0; // adaptors first stop
  max_heap.pop();
  min_heap.push(0);
  deque_stack.pop();
  vector_stack.push(9);
  checkpoint += 1; // adaptors second stop
  return 0;
}
