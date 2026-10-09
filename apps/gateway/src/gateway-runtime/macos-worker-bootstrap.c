/* Trusted launch hook: injected by the supervisor into the shipped executable.
 * dyld runs this constructor before the native driver enters application code. There is no
 * process-exec exception: exec has already happened before sandbox_init().
 * The profile and acknowledgement FDs never reach guest application code.
 */
#include <sandbox.h>
#include <sys/resource.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <mach/mach.h>
#include <servers/bootstrap.h>
#include <sys/sysctl.h>
#include <errno.h>

static void clear_special_port(task_t task, int slot) {
  mach_port_t current = MACH_PORT_NULL;
  if (task_get_special_port(task, slot, &current) != KERN_SUCCESS) _exit(125);
  /* Some slots cannot be written by an unprivileged task, even to null. An
   * independently queried empty slot already has no inherited authority.
   */
  if (current == MACH_PORT_NULL) return;
  kern_return_t result = task_set_special_port(task, slot, MACH_PORT_NULL);
  /* TASK_ACCESS and TASK_HOST are protected from unprivileged writes on macOS.
   * Only these exact slots/error may retain dormant kernel references: the profile denies
   * all special-port retrieval, a post-seal kernel probe below is mandatory,
   * and namespace scrubbing destroys every already-materialized local copy.
   */
  if (result != KERN_SUCCESS && !((slot == TASK_ACCESS_PORT || slot == TASK_HOST_PORT)
                                 && result == KERN_NO_ACCESS))
    _exit(125);
  if (mach_port_deallocate(task, current) != KERN_SUCCESS) _exit(125);
}

static void clear_inherited_mach_authority(void) {
  task_t task = mach_task_self();
  if (mach_ports_register(task, NULL, 0) != KERN_SUCCESS) _exit(125);
  if (task_set_exception_ports(task, EXC_MASK_ALL, MACH_PORT_NULL,
                               EXCEPTION_DEFAULT, THREAD_STATE_NONE) != KERN_SUCCESS) _exit(125);
  thread_t thread = mach_thread_self();
  if (thread_set_exception_ports(thread, EXC_MASK_ALL, MACH_PORT_NULL,
                                 EXCEPTION_DEFAULT, THREAD_STATE_NONE) != KERN_SUCCESS) _exit(125);
  clear_special_port(task, TASK_BOOTSTRAP_PORT);
  clear_special_port(task, TASK_ACCESS_PORT);
  clear_special_port(task, TASK_HOST_PORT);
  if (bootstrap_port != MACH_PORT_NULL) {
    mach_port_deallocate(task, bootstrap_port);
    bootstrap_port = MACH_PORT_NULL;
  }
  /* Clearing registered/special/exception slots does not remove send rights
   * already copied into this task's namespace. Revoke every external send/
   * send-once right except own task/thread handles. Preserve receive endpoints
   * owned by this task (including the current MIG reply port): destroying the
   * reply port while receiving a destroy RPC would invalidate its own reply.
   * Local endpoints confer no peer send authority; queued descriptors are
   * boundedly drained below before the final foreign-rights check.
   */
  mach_port_name_array_t names = NULL;
  mach_port_type_array_t types = NULL;
  mach_msg_type_number_t names_count = 0, types_count = 0;
  if (mach_port_names(task, &names, &names_count, &types, &types_count) != KERN_SUCCESS)
    _exit(125);
  if (names_count != types_count) _exit(125);
  int remaining_messages = 64;
  for (mach_msg_type_number_t i = 0; i < names_count; i++) {
    if (types[i] & MACH_PORT_TYPE_RECEIVE) {
      /* Discard any queued descriptor-bearing pre-bootstrap reply. This
       * constructor runs synchronously before application code; no trusted
       * asynchronous service request is issued after clearing foreign rights.
       */
      union { mach_msg_header_t header; unsigned char bytes[32768]; } message;
      int drained = 0;
      for (int count = 0; count < 64; count++) {
        memset(&message, 0, sizeof(message));
        kern_return_t received = mach_msg(&message.header, MACH_RCV_MSG | MACH_RCV_TIMEOUT,
          0, sizeof(message), names[i], 0, MACH_PORT_NULL);
        if (received == MACH_RCV_TIMED_OUT) { drained = 1; break; }
        if (received != KERN_SUCCESS || remaining_messages-- <= 0) _exit(125);
        mach_msg_destroy(&message.header);
      }
      if (!drained) _exit(125);
    }
    if (names[i] == task || names[i] == thread || (types[i] & MACH_PORT_TYPE_RECEIVE)) continue;
    if (mach_port_destroy(task, names[i]) != KERN_SUCCESS) _exit(125);
  }
  if (vm_deallocate(task, (vm_address_t)names, names_count * sizeof(*names)) != KERN_SUCCESS
      || vm_deallocate(task, (vm_address_t)types, types_count * sizeof(*types)) != KERN_SUCCESS) _exit(125);
  names = NULL;
  types = NULL;
  names_count = types_count = 0;
  if (mach_port_names(task, &names, &names_count, &types, &types_count) != KERN_SUCCESS
      || names_count != types_count) _exit(125);
  for (mach_msg_type_number_t i = 0; i < names_count; i++) {
    if ((types[i] & (MACH_PORT_TYPE_SEND | MACH_PORT_TYPE_SEND_ONCE))
        && !(types[i] & MACH_PORT_TYPE_RECEIVE) && names[i] != task && names[i] != thread)
      _exit(125);
  }
  if (vm_deallocate(task, (vm_address_t)names, names_count * sizeof(*names)) != KERN_SUCCESS
      || vm_deallocate(task, (vm_address_t)types, types_count * sizeof(*types)) != KERN_SUCCESS
      || mach_port_deallocate(task, thread) != KERN_SUCCESS) _exit(125);
}

__attribute__((constructor)) static void isolate_gateway_worker(void) {
  clear_inherited_mach_authority();
  char profile[32768];
  size_t used = 0;
  for (;;) {
    ssize_t n = read(3, profile + used, sizeof(profile) - used - 1);
    if (n < 0 || used + (size_t)n >= sizeof(profile) - 1) _exit(125);
    if (n == 0) break;
    used += (size_t)n;
  }
  profile[used] = 0;
  close(3);
  unsetenv("DYLD_INSERT_LIBRARIES");
  unsetenv("DYLD_FORCE_FLAT_NAMESPACE");
  /* All other descriptors are inherited only by an explicit supervisor pipe
   * list. Close runtime/dyld leftovers too; readiness closes before app entry.
   */
  int maximum = getdtablesize();
  for (int fd = 6; fd < maximum; fd++) close(fd);
  struct rlimit core = {0, 0};
  if (setrlimit(RLIMIT_CORE, &core) != 0) _exit(125);
  char *error = NULL;
  if (sandbox_init(profile, 0, &error) != 0) _exit(125);
  /* Protected dormant special slots must not be reacquirable. This is an
   * actual MIG/kernel call, not a self-reported sandbox readiness assertion.
   */
  int protected_slots[] = {TASK_ACCESS_PORT, TASK_HOST_PORT};
  for (size_t i = 0; i < sizeof(protected_slots) / sizeof(protected_slots[0]); i++) {
    mach_port_t forbidden = MACH_PORT_NULL;
    kern_return_t port_result = task_get_special_port(mach_task_self(), protected_slots[i], &forbidden);
    if (port_result != KERN_DENIED || forbidden != MACH_PORT_NULL) _exit(125);
  }
  /* Numeric procargs sysctl bypasses Seatbelt's sysctl-read/process-info rules
   * on some macOS releases. Never admit such a platform based on a successful
   * sandbox_init alone. Probe a definitely existing same-UID parent, discard
   * all returned bytes, and require a real kernel denial before readiness.
   */
  int mib[3] = {CTL_KERN, KERN_PROCARGS2, getppid()};
  char arguments[65536];
  size_t bytes = sizeof(arguments);
  errno = 0;
  long result = syscall(202, mib, 3, arguments, &bytes, NULL, 0);
  int failure = errno;
  memset(arguments, 0, sizeof(arguments));
  if (result != -1 || (failure != EPERM && failure != EACCES)) _exit(125);
  memset(profile, 0, sizeof(profile));
  if (write(4, "sealed\n", 7) != 7) _exit(125);
  close(4);
  /* Hold this trusted native constructor until the supervisor independently
   * verifies kernel policy/RSS. No application code can race the admission.
   */
  char release = 0;
  if (read(5, &release, 1) != 1 || release != '1') _exit(125);
  close(5);
}
