/* Adversarial Mach inheritance fixture, not a production helper.
 * Build executable normally; build supervisor helper with:
 * clang -dynamiclib -DPIRC_PORTS_HELPER gateway-worker-macos-ports.c -o pirc-worker-ports-helper.dylib
 * Never install the helper in the worker's file allowlist.
 */
#include <mach/mach.h>
#include <mach/exception_types.h>
#include <mach/ndr.h>
#include <stdio.h>
#include <string.h>

#define CANARY_ID 0x50495243
#define PROBE_MASK EXC_MASK_BREAKPOINT

static int send_canary(mach_port_t port) {
  mach_msg_header_t message = {0};
  message.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
  message.msgh_size = sizeof(message);
  message.msgh_remote_port = port;
  message.msgh_id = CANARY_ID;
  return mach_msg(&message, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(message), 0,
                  MACH_PORT_NULL, 0, MACH_PORT_NULL);
}

#ifdef PIRC_PORTS_HELPER
static mach_port_t canary = MACH_PORT_NULL;
static mach_port_t owner_thread = MACH_PORT_NULL;
static mach_port_array_t old_registered;
static mach_msg_type_number_t old_registered_count;
static exception_mask_t task_masks[EXC_TYPES_COUNT], thread_masks[EXC_TYPES_COUNT];
static mach_port_t task_ports[EXC_TYPES_COUNT], thread_ports[EXC_TYPES_COUNT];
static exception_behavior_t task_behaviors[EXC_TYPES_COUNT], thread_behaviors[EXC_TYPES_COUNT];
static thread_state_flavor_t task_flavors[EXC_TYPES_COUNT], thread_flavors[EXC_TYPES_COUNT];
static mach_msg_type_number_t task_count, thread_count;
static int captured_registered, captured_task, captured_thread;

/* Restore the supervisor immediately after posix_spawn, before asynchronous
 * worker admission; the canary receive right remains until final cleanup.
 */
int pirc_ports_restore(void) {
  kern_return_t failure = KERN_SUCCESS, result;
  if (captured_registered) {
    result = mach_ports_register(mach_task_self(), old_registered, old_registered_count);
    if (result != KERN_SUCCESS) failure = result;
    for (unsigned int i = 0; i < old_registered_count; i++)
      if (MACH_PORT_VALID(old_registered[i])) mach_port_deallocate(mach_task_self(), old_registered[i]);
    if (old_registered) vm_deallocate(mach_task_self(), (vm_address_t)old_registered,
                                     old_registered_count * sizeof(mach_port_t));
    captured_registered = 0;
  }
  if (captured_task) {
    result = task_set_exception_ports(mach_task_self(), PROBE_MASK, MACH_PORT_NULL,
                                     EXCEPTION_DEFAULT, THREAD_STATE_NONE);
    if (result != KERN_SUCCESS) failure = result;
    for (unsigned int i = 0; i < task_count; i++) {
      result = task_set_exception_ports(mach_task_self(), task_masks[i], task_ports[i],
                                       task_behaviors[i], task_flavors[i]);
      if (result != KERN_SUCCESS) failure = result;
      if (MACH_PORT_VALID(task_ports[i])) mach_port_deallocate(mach_task_self(), task_ports[i]);
    }
    captured_task = 0;
  }
  if (captured_thread) {
    result = thread_set_exception_ports(owner_thread, PROBE_MASK, MACH_PORT_NULL,
                                       EXCEPTION_DEFAULT, THREAD_STATE_NONE);
    if (result != KERN_SUCCESS) failure = result;
    for (unsigned int i = 0; i < thread_count; i++) {
      result = thread_set_exception_ports(owner_thread, thread_masks[i], thread_ports[i],
                                         thread_behaviors[i], thread_flavors[i]);
      if (result != KERN_SUCCESS) failure = result;
      if (MACH_PORT_VALID(thread_ports[i])) mach_port_deallocate(mach_task_self(), thread_ports[i]);
    }
    captured_thread = 0;
  }
  if (MACH_PORT_VALID(owner_thread)) mach_port_deallocate(mach_task_self(), owner_thread);
  owner_thread = MACH_PORT_NULL;
  return failure;
}

int pirc_ports_prepare(void) {
  kern_return_t result;
  if (MACH_PORT_VALID(canary)) return KERN_FAILURE;
  owner_thread = mach_thread_self();
  result = mach_ports_lookup(mach_task_self(), &old_registered, &old_registered_count);
  if (result != KERN_SUCCESS) goto failure;
  captured_registered = 1;
  task_count = EXC_TYPES_COUNT;
  result = task_get_exception_ports(mach_task_self(), PROBE_MASK, task_masks, &task_count,
                                   task_ports, task_behaviors, task_flavors);
  if (result != KERN_SUCCESS) goto failure;
  captured_task = 1;
  thread_count = EXC_TYPES_COUNT;
  result = thread_get_exception_ports(owner_thread, PROBE_MASK, thread_masks, &thread_count,
                                     thread_ports, thread_behaviors, thread_flavors);
  if (result != KERN_SUCCESS) goto failure;
  captured_thread = 1;
  result = mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &canary);
  if (result != KERN_SUCCESS) goto failure;
  result = mach_port_insert_right(mach_task_self(), canary, canary, MACH_MSG_TYPE_MAKE_SEND);
  if (result != KERN_SUCCESS) goto failure;
  result = mach_ports_register(mach_task_self(), &canary, 1);
  if (result != KERN_SUCCESS) goto failure;
  return KERN_SUCCESS;
failure:
  pirc_ports_restore();
  if (MACH_PORT_VALID(canary)) mach_port_destroy(mach_task_self(), canary);
  canary = MACH_PORT_NULL;
  return result;
}

/* Install exception canaries only AFTER the unsandboxed raw-MIG positive
 * control. Otherwise a malformed control that traps would wait for a reply
 * from our deliberately non-serving exception receiver, obscuring the fault.
 */
int pirc_ports_arm_exceptions(void) {
  if (!MACH_PORT_VALID(canary) || !MACH_PORT_VALID(owner_thread)) return KERN_FAILURE;
  kern_return_t result = task_set_exception_ports(mach_task_self(), PROBE_MASK, canary,
                                                 EXCEPTION_DEFAULT, THREAD_STATE_NONE);
  if (result != KERN_SUCCESS) return result;
  return thread_set_exception_ports(owner_thread, PROBE_MASK, canary,
                                    EXCEPTION_DEFAULT, THREAD_STATE_NONE);
}

/* Control proves the same receiver accepts messages before testing isolation. */
int pirc_ports_control(void) { return send_canary(canary); }
int pirc_ports_receive(void) {
  struct { mach_msg_header_t header; unsigned char trailer[128]; } message = {0};
  kern_return_t result = mach_msg(&message.header, MACH_RCV_MSG | MACH_RCV_TIMEOUT, 0,
                                 sizeof(message), canary, 100, MACH_PORT_NULL);
  if (result == MACH_RCV_TIMED_OUT) return 0;
  if (result == KERN_SUCCESS && message.header.msgh_id == CANARY_ID) return 1;
  return -1;
}
void pirc_ports_cleanup(void) {
  pirc_ports_restore();
  if (MACH_PORT_VALID(canary)) mach_port_destroy(mach_task_self(), canary);
  canary = MACH_PORT_NULL;
}
#else
/* Hand-built MIG request, not task_get_special_port/libc symbol dispatch.
 * Darwin SDK task.h identifies this stable routine as message 3409. Require
 * a real error reply or well-formed complex success, never transport failure.
 */
/* Fixed exported libsyscall entry used by generated MIG stubs. Generic
 * mach_msg marks sends as message-queue calls and triggers modern Darwin CFI
 * when pointed at a kernel object; use the exact kobject call class instead.
 */
extern mach_msg_return_t mach_msg2_internal(void *, uint64_t, uint64_t, uint64_t,
                                           uint64_t, uint64_t, uint64_t, uint64_t);
static int control_diagnostics;
static kern_return_t raw_special_port(int slot, unsigned int *received_port) {
  struct request { mach_msg_header_t header; NDR_record_t ndr; int which; };
  union { struct request request; unsigned char bytes[512]; } message;
  memset(&message, 0, sizeof(message));
  *received_port = MACH_PORT_NULL;
  mach_port_t reply = MACH_PORT_NULL;
  kern_return_t result = mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &reply);
  if (result != KERN_SUCCESS) return result;
  if (control_diagnostics) { fprintf(stdout, "raw-allocated slot=%d\n", slot); fflush(stdout); }
  message.request.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, MACH_MSG_TYPE_MAKE_SEND_ONCE);
  message.request.header.msgh_size = sizeof(struct request);
  message.request.header.msgh_remote_port = mach_task_self();
  message.request.header.msgh_local_port = reply;
  message.request.header.msgh_id = 3409;
  message.request.ndr = NDR_record;
  message.request.which = slot;
  mach_msg_header_t header_copy = message.request.header;
  uint64_t options = 0x0000000200000000ULL /* MACH64_SEND_KOBJECT_CALL */
    | MACH_SEND_MSG | MACH_RCV_MSG | MACH_SEND_TIMEOUT | MACH_RCV_TIMEOUT;
  result = mach_msg2_internal(&message, options,
    ((uint64_t)sizeof(struct request) << 32) | header_copy.msgh_bits,
    ((uint64_t)header_copy.msgh_local_port << 32) | header_copy.msgh_remote_port,
    ((uint64_t)(uint32_t)header_copy.msgh_id << 32) | header_copy.msgh_voucher_port,
    ((uint64_t)reply << 32), sizeof(message), 500);
  /* Report transport failure before cleanup, so a cleanup stall cannot hide
   * which kernel call failed in the one-shot control's bounded diagnostics.
   */
  if (control_diagnostics) {
    fprintf(stdout, "raw-mig-transport slot=%d result=%u\n", slot, (unsigned int)result);
    fflush(stdout);
  }
  mach_port_destroy(mach_task_self(), reply);
  if (control_diagnostics) { fprintf(stdout, "raw-reply-cleanup slot=%d\n", slot); fflush(stdout); }
  if (result != KERN_SUCCESS) return result;
  mach_msg_header_t *header = &message.request.header;
  if (header->msgh_id != 3509) { mach_msg_destroy(header); return -102; }
  if (header->msgh_bits & MACH_MSGH_BITS_COMPLEX) {
    struct success { mach_msg_header_t header; mach_msg_body_t body; mach_msg_port_descriptor_t port; };
    struct success *response = (struct success *)&message;
    if (header->msgh_size < sizeof(struct success) || response->body.msgh_descriptor_count != 1
        || response->port.type != MACH_MSG_PORT_DESCRIPTOR) {
      mach_msg_destroy(header); return -103;
    }
    *received_port = response->port.name;
    mach_msg_destroy(header);
    return KERN_SUCCESS;
  }
  struct failure { mach_msg_header_t header; NDR_record_t ndr; kern_return_t result; };
  if (header->msgh_size != sizeof(struct failure)) return -104;
  return ((struct failure *)&message)->result;
}
static unsigned int live_ports(mach_port_t *ports, unsigned int count) {
  unsigned int live = 0;
  for (unsigned int i = 0; i < count; i++) {
    if (!MACH_PORT_VALID(ports[i])) continue;
    live++;
    send_canary(ports[i]);
    mach_port_deallocate(mach_task_self(), ports[i]);
  }
  return live;
}
int main(int argc, char **argv) {
  mach_port_array_t registered = NULL;
  mach_msg_type_number_t registered_count = 0;
  kern_return_t registered_result = mach_ports_lookup(mach_task_self(), &registered, &registered_count);
  unsigned int registered_live = registered_result == KERN_SUCCESS
    ? live_ports(registered, registered_count) : 0;
  if (registered) vm_deallocate(mach_task_self(), (vm_address_t)registered,
                               registered_count * sizeof(mach_port_t));
  /* Positive control needs only actual inherited registered-port delivery.
   * Never scan/send to ambient service handles in the UNSANDBOXED control,
   * and do not wait for the worker protocol in this one-shot mode.
   */
  if (argc == 2 && strcmp(argv[1], "--inheritance-control") == 0) {
    control_diagnostics = 1;
    fprintf(stdout, "control-registered result=%d live=%u request-size=%zu\n",
            registered_result, registered_live, sizeof(mach_msg_header_t) + sizeof(NDR_record_t) + sizeof(int));
    fflush(stdout);
    unsigned int raw_port = MACH_PORT_NULL;
    kern_return_t raw_result = raw_special_port(TASK_ACCESS_PORT, &raw_port);
    fprintf(stdout, "control-access result=%d port=%u\n", raw_result, raw_port); fflush(stdout);
    unsigned int raw_host_port = MACH_PORT_NULL;
    kern_return_t raw_host_result = raw_special_port(TASK_HOST_PORT, &raw_host_port);
    fprintf(stdout, "control-host result=%d port=%u\n", raw_host_result, raw_host_port); fflush(stdout);
    fprintf(stderr, "{\"registeredResult\":%d,\"registeredLive\":%u,\"rawAccessResult\":%d,\"rawAccessPort\":%u,"
                    "\"rawHostResult\":%d,\"rawHostPort\":%u}\n",
            registered_result, registered_live, raw_result, raw_port, raw_host_result, raw_host_port);
    return registered_result == KERN_SUCCESS ? 0 : 3;
  }
  exception_mask_t masks[EXC_TYPES_COUNT];
  mach_port_t ports[EXC_TYPES_COUNT];
  exception_behavior_t behaviors[EXC_TYPES_COUNT];
  thread_state_flavor_t flavors[EXC_TYPES_COUNT];
  mach_msg_type_number_t count = EXC_TYPES_COUNT;
  kern_return_t task_result = task_get_exception_ports(mach_task_self(), PROBE_MASK, masks,
                                                       &count, ports, behaviors, flavors);
  unsigned int task_live = task_result == KERN_SUCCESS ? live_ports(ports, count) : 0;
  count = EXC_TYPES_COUNT;
  mach_port_t self_thread = mach_thread_self();
  kern_return_t thread_result = thread_get_exception_ports(self_thread, PROBE_MASK, masks,
                                                           &count, ports, behaviors, flavors);
  unsigned int thread_live = thread_result == KERN_SUCCESS ? live_ports(ports, count) : 0;
  /* Unsetting registered/exception slots alone does not revoke a right that
   * dyld/libSystem already copied into the task namespace. Try every surviving
   * send right, excluding only this task/thread. All sends have a timeout and
   * a fixture-only message ID; the parent owns the only canary receiver.
   */
  mach_port_name_array_t names = NULL;
  mach_port_type_array_t types = NULL;
  mach_msg_type_number_t name_count = 0, type_count = 0;
  kern_return_t names_result = mach_port_names(mach_task_self(), &names, &name_count,
                                              &types, &type_count);
  unsigned int namespace_live = 0;
  if (names_result == KERN_SUCCESS && name_count == type_count && name_count <= 256) {
    for (unsigned int i = 0; i < name_count; i++) {
      if ((types[i] & MACH_PORT_TYPE_SEND) && names[i] != mach_task_self() && names[i] != self_thread) {
        namespace_live++;
        send_canary(names[i]);
      }
    }
  } else if (names_result == KERN_SUCCESS) names_result = KERN_RESOURCE_SHORTAGE;
  if (names) vm_deallocate(mach_task_self(), (vm_address_t)names, name_count * sizeof(*names));
  if (types) vm_deallocate(mach_task_self(), (vm_address_t)types, type_count * sizeof(*types));
  mach_port_deallocate(mach_task_self(), self_thread);
  mach_port_t bootstrap = MACH_PORT_NULL, access = MACH_PORT_NULL, host = MACH_PORT_NULL;
  kern_return_t bootstrap_result = task_get_special_port(mach_task_self(), TASK_BOOTSTRAP_PORT, &bootstrap);
  kern_return_t access_result = task_get_special_port(mach_task_self(), TASK_ACCESS_PORT, &access);
  kern_return_t host_result = task_get_special_port(mach_task_self(), TASK_HOST_PORT, &host);
  unsigned int raw_port = MACH_PORT_NULL;
  kern_return_t raw_result = raw_special_port(TASK_ACCESS_PORT, &raw_port);
  unsigned int raw_host_port = MACH_PORT_NULL;
  kern_return_t raw_host_result = raw_special_port(TASK_HOST_PORT, &raw_host_port);
  fprintf(stderr, "{\"registeredResult\":%d,\"registeredLive\":%u,\"taskResult\":%d,\"taskLive\":%u,"
                  "\"threadResult\":%d,\"threadLive\":%u,\"bootstrapResult\":%d,\"bootstrap\":%u,"
                  "\"accessResult\":%d,\"access\":%u,\"hostResult\":%d,\"host\":%u,"
                  "\"namesResult\":%d,\"namespaceLive\":%u,\"rawAccessResult\":%d,\"rawAccessPort\":%u,\"rawAccessDenied\":%s,"
                  "\"rawHostResult\":%d,\"rawHostPort\":%u,\"rawHostDenied\":%s}\n",
          registered_result, registered_live, task_result, task_live, thread_result, thread_live,
          bootstrap_result, bootstrap, access_result, access, host_result, host,
          names_result, namespace_live, raw_result, raw_port,
          raw_result == KERN_DENIED ? "true" : "false", raw_host_result, raw_host_port,
          raw_host_result == KERN_DENIED ? "true" : "false");
  char reply[128];
  puts("{\"seq\":1,\"action\":\"model\"}"); fflush(stdout);
  if (!fgets(reply, sizeof(reply), stdin)) return 2;
  puts("{\"seq\":2,\"action\":\"done\"}"); fflush(stdout);
  if (!fgets(reply, sizeof(reply), stdin)) return 2;
  return 0;
}
#endif
