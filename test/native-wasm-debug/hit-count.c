volatile int total;

__attribute__((noinline)) void add(int n) {
  int answer = n + 10;
  total += answer; // hit target
}

int main(void) {
  for (int i = 1; i <= 4; ++i)
    add(i);
  return 0;
}
