/* Adversarial test only: forges native readiness but installs no sandbox.
 * Supervisor kernel checks must reject it before application/IPC admission.
 */
#include <unistd.h>
__attribute__((constructor)) static void forge_worker_readiness(void) {
  close(3);
  write(4, "sealed\n", 7);
  close(4);
  char release;
  read(5, &release, 1);
  close(5);
}
