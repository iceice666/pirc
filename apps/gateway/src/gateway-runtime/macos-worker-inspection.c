/* Fixed-signature supervisor wrapper for the variadic Darwin sandbox API.
 * On arm64 variadic arguments use a different ABI from fixed FFI arguments.
 */
#include <unistd.h>
#include <fcntl.h>
extern int sandbox_check(pid_t, const char *, int, ...);
int pirc_worker_denied(pid_t pid, const char *operation, const char *path) {
  return path ? sandbox_check(pid, operation, 1, path)
              : sandbox_check(pid, operation, 0);
}
/* Native test support: force the host canary FD inheritable before launch.
 * This wrapper grants no capability beyond the kernel's existing FD rights.
 */
int pirc_worker_fd_flags(int fd, int flags) {
  return flags < 0 ? fcntl(fd, F_GETFD) : fcntl(fd, F_SETFD, flags);
}
