import { readFileSync, readlinkSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { dlopen, FFIType, read } from 'bun:ffi';
import { runGatewayWorker } from '../../src/gateway-runtime/worker.js';
import { sealGatewayWorker } from '../../src/gateway-runtime/worker-seal.js';

sealGatewayWorker();

const readable = (file: string) => {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
};
const networkError = await new Promise<string>((resolve) => {
  const socket = createConnection({ host: '127.0.0.1', port: 1 });
  socket.on('connect', () => {
    socket.destroy();
    resolve('connected');
  });
  socket.on('error', (error) => {
    socket.destroy();
    resolve((error as NodeJS.ErrnoException).code ?? '');
  });
});
const native = dlopen('libc.so.6', {
  socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  __errno_location: { args: [], returns: FFIType.ptr },
  syscall: { args: Array(7).fill(FFIType.i64), returns: FFIType.i64 },
});
const socketResult = native.symbols.socket(2, 1, 0);
const socketErrno = read.i32(native.symbols.__errno_location()!);
const syscallIds =
  process.arch === 'x64'
    ? { mount: 165, ptrace: 101, unshare: 272, execve: 59, memfd: 319 }
    : { mount: 40, ptrace: 117, unshare: 97, execve: 221, memfd: 279 };
const denied = Object.fromEntries(
  Object.entries(syscallIds).map(([name, id]) => {
    const result = native.symbols.syscall(id, 0, 0, 0, 0, 0, 0);
    return [name, { result: Number(result), errno: read.i32(native.symbols.__errno_location()!) }];
  }),
);
const child = spawnSync('/runtime/worker', [], { timeout: 1000, env: {} });
let writable = false;
try {
  writeFileSync('/runtime/worker', 'tamper');
  writable = true;
} catch {
  /* read-only runtime */
}
const descriptors = readdirSync('/proc/self/fd').flatMap((fd) => {
  try {
    return [readlinkSync(`/proc/self/fd/${fd}`)];
  } catch {
    return [];
  }
});
process.stderr.write(
  JSON.stringify({
    uid: process.getuid!(),
    status: readFileSync('/proc/self/status', 'utf8')
      .split('\n')
      .filter((line) => /^(NoNewPrivs|Seccomp|CapEff):/.test(line)),
    hostEtc: readable('/etc/passwd'),
    hostWorkspace: readable('/workspace/pirc/package.json'),
    hostHome: readable('/home/agent/.bashrc'),
    environment: Object.keys(process.env),
    networkError,
    socketResult,
    socketErrno,
    denied,
    subprocess: child.status === 0 || child.pid > 0,
    writable,
    descriptors,
    namespaces: Object.fromEntries(
      ['mnt', 'pid', 'net', 'user'].map((name) => [name, readlinkSync(`/proc/self/ns/${name}`)]),
    ),
  }) + '\n',
);
await runGatewayWorker();
