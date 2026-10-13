// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  char cwd[4096];
  char line[32];
  if (argc != 2 || !getcwd(cwd, sizeof(cwd)) || strcmp(cwd, argv[1]) != 0)
    return 1;
  FILE *input = fopen("input.txt", "r");
  if (!input)
    return 2;
  int ok = fgets(line, sizeof(line), input) && strcmp(line, "cwd-ok\n") == 0;
  fclose(input);
  return ok ? 0 : 3;
}
