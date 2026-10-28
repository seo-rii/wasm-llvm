volatile int total;

__attribute__((noinline)) int simple(int n) {
  int answer = n;
  answer += 10;
  return answer; // simple return
} // simple end

__attribute__((noinline)) int early(int n) {
  int answer = n + 20;
  if (n)
    return answer; // early return
  return 0;
} // early end

__attribute__((noinline)) int recursive(int n) {
  int answer = n + 30;
  if (n)
    answer += recursive(n - 1); // recursive call
  return answer; // recursive return
} // recursive end

struct Guard {
  int *answer;
  ~Guard() { ++*answer; }
};

__attribute__((noinline)) int cleanup(int n) {
  int answer = n + 40;
  Guard guard{&answer};
  return answer; // cleanup return
} // cleanup end

__attribute__((noinline)) void implicit(int n) {
  int answer = n + 50;
  total = answer; // implicit last
} // implicit end

int main() {
  total = simple(2); // simple caller
  total += early(2); // early caller
  total += recursive(2); // recursive caller
  total += cleanup(2);
  implicit(2);
  return 0;
}
