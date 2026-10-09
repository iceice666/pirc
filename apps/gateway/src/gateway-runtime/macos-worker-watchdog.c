/* Trusted native launch supervisor. Owns the child PID until waitpid and watches
 * the gateway's kernel process identity, not worker-supplied PIDs or EOF claims.
 */
#include <sys/event.h>
#include <sys/wait.h>
#include <sys/resource.h>
#include <spawn.h>
#include <signal.h>
#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
#include <errno.h>
#include <string.h>
#include <limits.h>

static pid_t parse_pid(const char *value) {
  char *end = NULL;
  errno = 0;
  long pid = strtol(value, &end, 10);
  return errno || !end || *end || pid <= 1 || pid > INT_MAX ? -1 : (pid_t)pid;
}
static int wait_child(pid_t child, int terminate) {
  if (terminate) kill(child, SIGKILL);
  int status;
  while (waitpid(child, &status, 0) < 0) { if (errno != EINTR) return 125; }
  return WIFEXITED(status) ? WEXITSTATUS(status) : 125;
}
int main(int argc, char **argv) {
  if (argc != 4) return 125;
  pid_t parent = parse_pid(argv[1]);
  if (parent <= 1 || getppid() != parent || signal(SIGPIPE, SIG_IGN) == SIG_ERR) return 125;
  sigset_t termination;
  sigemptyset(&termination);
  sigaddset(&termination, SIGTERM);
  if (sigprocmask(SIG_BLOCK, &termination, NULL) != 0) return 125;
  int queue = kqueue();
  if (queue < 0) return 125;
  struct kevent changes[2];
  EV_SET(&changes[0], parent, EVFILT_PROC, EV_ADD | EV_ENABLE, NOTE_EXIT, 0, NULL);
  EV_SET(&changes[1], SIGTERM, EVFILT_SIGNAL, EV_ADD | EV_ENABLE, 0, 0, NULL);
  if (kevent(queue, changes, 2, NULL, 0, NULL) < 0) return 125;
  /* Kqueue sees signals generated after attachment, not earlier pending ones.
   * Check pending termination before any child exists to close that gap. */
  sigset_t pending;
  if (sigpending(&pending) != 0 || sigismember(&pending, SIGTERM) || getppid() != parent)
    return 125;
  posix_spawn_file_actions_t actions;
  if (posix_spawn_file_actions_init(&actions) != 0) return 125;
  posix_spawnattr_t attributes;
  if (posix_spawnattr_init(&attributes) != 0) return 125;
  if (posix_spawnattr_setflags(&attributes, POSIX_SPAWN_CLOEXEC_DEFAULT) != 0) return 125;
  for (int fd = 0; fd <= 5; fd++) {
    /* An explicit dup2 action retains only the six guest pipes/profile. Darwin's
     * CLOEXEC_DEFAULT closes every other descriptor, including trusted FD6. */
    if (posix_spawn_file_actions_adddup2(&actions, fd, fd) != 0) {
      posix_spawn_file_actions_destroy(&actions);
      posix_spawnattr_destroy(&attributes);
      return 125;
    }
  }
  size_t size = strlen(argv[3]) + sizeof("DYLD_INSERT_LIBRARIES=");
  char *injection = malloc(size);
  if (!injection) return 125;
  snprintf(injection, size, "DYLD_INSERT_LIBRARIES=%s", argv[3]);
  char *environment[] = {injection, "HOME=/nonexistent", "TMPDIR=/nonexistent",
    "BUN_JSC_forceRAMSize=268435456", NULL};
  char *arguments[] = {argv[2], NULL};
  pid_t child;
  int launched = posix_spawn(&child, argv[2], &actions, &attributes, arguments, environment);
  posix_spawn_file_actions_destroy(&actions);
  posix_spawnattr_destroy(&attributes);
  free(injection);
  if (launched != 0) return 125;
  EV_SET(&changes[0], child, EVFILT_PROC, EV_ADD | EV_ENABLE, NOTE_EXIT, 0, NULL);
  if (kevent(queue, changes, 1, NULL, 0, NULL) < 0) return wait_child(child, 1);
  /* Close every guest pipe in the trusted parent. Only this native status FD is
   * supervisor-visible and it was closed by posix_spawn before guest exec.
   */
  for (int fd = 0; fd <= 5; fd++) close(fd);
  char status[64];
  int bytes = snprintf(status, sizeof(status), "{\"child-pid\":%d}\n", child);
  for (int sent = 0; sent < bytes; ) {
    ssize_t written = write(6, status + sent, (size_t)(bytes - sent));
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) return wait_child(child, 1);
    sent += (int)written;
  }
  close(6);
  if (getppid() != parent) return wait_child(child, 1);
  for (;;) {
    struct kevent event;
    int count = kevent(queue, NULL, 0, &event, 1, NULL);
    if (count < 0) { if (errno == EINTR) continue; return wait_child(child, 1); }
    if (event.filter == EVFILT_PROC && event.ident == (uintptr_t)child)
      return wait_child(child, 0);
    if ((event.filter == EVFILT_PROC && event.ident == (uintptr_t)parent) ||
        (event.filter == EVFILT_SIGNAL && event.ident == SIGTERM))
      return wait_child(child, 1);
  }
}
