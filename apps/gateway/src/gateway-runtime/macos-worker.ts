import { dlopen, FFIType, ptr } from 'bun:ffi';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

const quote = (value: string) => JSON.stringify(value);

/** Exact operator-installed code plus Apple runtime assets, never host home/state.
 * No writable paths, sockets, mach service lookups, process fork/exec or peers.
 * The native dyld hook installs this AFTER exec and BEFORE application entry.
 */
export function macosWorkerProfile(executable: string, inspection: string): string {
  // SBPL literals are not JSON strings: reject control characters instead of
  // allowing JSON's escapes to acquire Scheme semantics. Paths are trusted
  // deployment inputs, not worker arguments.
  if ([executable, inspection].some((value) => /[\x00-\x1f\x7f]/.test(value)))
    throw new Error('Invalid gateway worker asset path');
  return `(version 3)
(disable-syscall-inference)
(deny default)
; Some process-info operations are allowed by default even under deny-default.
(deny process-info* (target others))
(deny iokit* nvram*)
(deny mach-task-special-port-get mach-task-special-port-set)
; Special-port MAC policy is not sufficient on every macOS release. Reject the
; kernel MIG routines themselves; native post-seal calls must prove denial.
(allow syscall-mig
  (kernel-mig-routine mach_ports_lookup)
  (kernel-mig-routine task_get_exception_ports_from_user)
  (kernel-mig-routine thread_get_exception_ports_from_user)
  (kernel-mig-routine mach_port_names)
  (kernel-mig-routine mach_port_type))
(deny syscall-mig (kernel-mig-routine task_get_special_port_from_user)
  (kernel-mig-routine task_set_special_port) (with errno 1))
; Numeric SYS___sysctl is not mediated by sysctl-read for KERN_PROCARGS2.
; The native phase driver needs no sysctl metadata: named queries are denied too.
; Syscall layer permissions do not grant file/network/process/Mach service
; authority: those remain denied by the outer policy and capability checks.
(allow syscall-mach
  (machtrap-number 10) (machtrap-number 12) (machtrap-number 14) (machtrap-number 15)
  (machtrap-number 19) (machtrap-number 24) (machtrap-number 26) (machtrap-number 27)
  (machtrap-number 28) (machtrap-number 31) (machtrap-number 47))
; Do not acquire peer task/task-name ports even if higher-level checks vary.
(deny syscall-mach (machtrap-number 29) (machtrap-number 44) (machtrap-number 45) (with errno 1))
(allow syscall-unix
  (syscall-number SYS_exit) (syscall-number SYS_read) (syscall-number SYS_pread) (syscall-number SYS_write)
  (syscall-number SYS_read_nocancel) (syscall-number SYS_write_nocancel)
  (syscall-number SYS_close_nocancel) (syscall-number SYS_close) (syscall-number SYS_fstat64) (syscall-number SYS_lseek)
  (syscall-number SYS_fcntl) (syscall-number SYS_getpid) (syscall-number SYS_getppid)
  (syscall-number SYS_mmap) (syscall-number SYS_munmap) (syscall-number SYS_mprotect)
  (syscall-number SYS_madvise) (syscall-number SYS_getrlimit)
  (syscall-number SYS_getentropy) (syscall-number SYS_thread_selfid)
  (syscall-number SYS_ulock_wait) (syscall-number SYS_ulock_wake))
(deny syscall-unix
  (syscall-number 202) (syscall-number 538) (syscall-number 539)
  (syscall-number SYS_sysctlbyname) (syscall-number SYS_socket)
  (syscall-number SYS_fork) (syscall-number SYS_execve) (syscall-number SYS_posix_spawn)
  (syscall-number SYS_kill) (syscall-number SYS_proc_info)
  (syscall-number SYS_open) (syscall-number SYS_open_nocancel)
  (with errno 1))
(allow file-read* (literal ${quote(executable)}) (literal ${quote(inspection)})
  (literal "/usr/lib/libSystem.B.dylib")
  (literal "/usr/lib/libsandbox.dylib") (literal "/usr/lib/libproc.dylib"))
(allow file-test-existence (literal ${quote(executable)}) (literal ${quote(inspection)}))
(allow file-read-data (literal "/dev/urandom") (literal "/dev/random"))
(allow file-read-metadata (literal "/") (literal "/dev"))
(allow file-map-executable (literal ${quote(executable)}) (literal ${quote(inspection)})
  (literal "/usr/lib/libSystem.B.dylib")
  (literal "/usr/lib/libsandbox.dylib") (literal "/usr/lib/libproc.dylib"))
(allow process-info* (target self))
`;
}

export function macosWorkerBootstrap(executable: string, configured?: string): string {
  const candidate =
    configured ?? path.join(path.dirname(executable), 'pirc-worker-bootstrap.dylib');
  if (!existsSync(candidate)) throw new Error('Gateway worker sandbox bootstrap unavailable');
  return realpathSync(candidate);
}

export function macosWorkerWatchdog(executable: string): string {
  const candidate = path.join(path.dirname(executable), 'pirc-worker-watchdog');
  if (!existsSync(candidate)) throw new Error('Gateway worker lifecycle watchdog unavailable');
  return realpathSync(candidate);
}

export function macosWorkerInspectionLibrary(executable: string): string {
  const candidate = path.join(path.dirname(executable), 'pirc-worker-inspection.dylib');
  if (!existsSync(candidate)) throw new Error('Gateway worker sandbox inspection unavailable');
  return realpathSync(candidate);
}

/** Trusted supervisor queries kernel state and RSS for its own spawn PID.
 * Readiness on the native-only pipe is necessary, never sufficient admission.
 */
export class MacosWorkerInspection {
  private readonly sandbox;
  private readonly proc;
  constructor(inspection: string) {
    this.sandbox = dlopen(inspection, {
      pirc_worker_denied: {
        args: [FFIType.i32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
    });
    try {
      this.proc = dlopen('/usr/lib/libproc.dylib', {
        proc_pidinfo: {
          args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
          returns: FFIType.i32,
        },
      });
    } catch (error) {
      this.sandbox.close();
      throw error;
    }
  }

  verify(pid: number, executable: string): void {
    const denied = (operation: string, file?: string) => {
      const op = Buffer.from(operation + '\0');
      const arg = Buffer.from((file ?? '') + '\0');
      // The native fixed-signature wrapper handles Darwin's variadic ABI.
      // Exactly 1 means denied; API errors must never count as proof.
      return this.sandbox.symbols.pirc_worker_denied(pid, ptr(op), file ? ptr(arg) : null) === 1;
    };
    // process-exec itself is not queryable on current macOS (-1), while the
    // process-exec* operation family is. API errors never count as denials.
    for (const [operation, file] of [
      ['process-exec*'],
      ['process-fork'],
      ['network-outbound'],
      ['network-inbound'],
      ['mach-task-special-port-get'],
      ['mach-task-special-port-set'],
      ['file-read-data', '/etc/passwd'],
      ['file-read-data', '/private/etc/passwd'],
      ['file-write-data', '/private/tmp/pirc-worker-write-probe'],
      ['file-write-data', executable],
    ]) {
      if (!denied(operation!, file))
        throw new Error(`Gateway worker kernel isolation verification failed: ${operation}`);
    }
  }

  rss(pid: number): number {
    // Darwin proc_taskinfo: resident_size is the second uint64_t; size 96.
    const info = Buffer.alloc(96);
    if (this.proc.symbols.proc_pidinfo(pid, 4, 0, ptr(info), info.length) !== info.length)
      throw new Error('Gateway worker resource supervision unavailable');
    const rss = Number(info.readBigUInt64LE(8));
    if (!Number.isSafeInteger(rss) || rss <= 0)
      throw new Error('Gateway worker resource supervision unavailable');
    return rss;
  }

  close(): void {
    this.sandbox.close();
    this.proc.close();
  }
}
