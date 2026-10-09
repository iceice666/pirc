/* Native-only adversarial shipped fixture. Fork safely before any Bun threads. */
#include <unistd.h>
#include <errno.h>
#include <sys/wait.h>
#include <stdio.h>
#include <string.h>
int main(void) {
  errno = 0;
  pid_t child = fork();
  int fork_errno = errno;
  if (child == 0) _exit(124);
  if (child > 0) {
    int status;
    waitpid(child, &status, 0);
  }
  fprintf(stderr, "{\"forkResult\":%d,\"forkErrno\":%d}\n", (int)child, fork_errno);
  char reply[128];
  puts("{\"seq\":1,\"action\":\"model\"}");
  fflush(stdout);
  if (!fgets(reply, sizeof(reply), stdin)) return 2;
  puts("{\"seq\":2,\"action\":\"done\"}");
  fflush(stdout);
  if (!fgets(reply, sizeof(reply), stdin)) return 2;
  return child == -1 && fork_errno == EPERM ? 0 : 3;
}
