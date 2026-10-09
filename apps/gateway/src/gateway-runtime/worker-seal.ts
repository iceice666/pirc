import { dlopen, FFIType, ptr } from 'bun:ffi';
import { workerExecSeccomp } from './seccomp.js';
import { MacosWorkerInspection, macosWorkerInspectionLibrary } from './macos-worker.js';

let sealed = false;
/** Initial exec is required by bwrap. Deny all subsequent exec/memfd before any IPC is read. */
export function sealGatewayWorker(): void {
  if (sealed) return;
  if (process.platform === 'darwin') {
    // The trusted native launch hook has already sealed before application entry.
    // This is a secondary assertion, not supervisor admission authority.
    const inspection = new MacosWorkerInspection(macosWorkerInspectionLibrary(process.execPath));
    try {
      inspection.verify(process.pid, process.execPath);
      sealed = true;
      return;
    } finally {
      inspection.close();
    }
  }
  if (process.platform !== 'linux') throw new Error('Unsupported gateway worker isolation');
  const filter = workerExecSeccomp(process.arch);
  const program = Buffer.alloc(16); // 64-bit Linux sock_fprog: unsigned short len; struct sock_filter *filter
  program.writeUInt16LE(filter.length / 8, 0);
  program.writeBigUInt64LE(BigInt(ptr(filter)), 8);
  const native = dlopen('libc.so.6', {
    syscall: { args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
  });
  try {
    // SECCOMP_SET_MODE_FILTER + TSYNC covers all already-created runtime threads.
    const result = native.symbols.syscall(process.arch === 'x64' ? 317 : 277, 1, 1, ptr(program));
    if (result !== 0) throw new Error('Gateway worker execution seal unavailable');
    sealed = true;
  } finally {
    native.close();
  }
}
