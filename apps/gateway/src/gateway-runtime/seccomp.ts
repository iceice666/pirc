/** Linux classic BPF. Bubblewrap installs it with no_new_privs before exec. */
export function workerSeccomp(arch: string): Buffer {
  const architectures: Record<string, { audit: number; deny: number[]; clone: number }> = {
    x64: {
      audit: 0xc000003e,
      deny: [
        41, 42, 43, 49, 50, 53, 57, 58, 101, 165, 166, 248, 249, 250, 272, 288, 298, 304, 308, 310,
        311, 321, 322, 425, 426, 427, 428, 429, 430, 431, 432, 435, 442,
      ],
      clone: 56,
    },
    arm64: {
      audit: 0xc00000b7,
      deny: [
        39, 40, 97, 117, 198, 199, 200, 201, 202, 203, 217, 218, 219, 241, 242, 265, 268, 270, 271,
        280, 281, 425, 426, 427, 428, 429, 430, 431, 432, 435, 442,
      ],
      clone: 220,
    },
  };
  const platform = architectures[arch];
  if (!platform) throw new Error('Unsupported gateway worker architecture');
  const instructions: Array<[number, number, number, number]> = [];
  const add = (code: number, jt: number, jf: number, k: number) =>
    instructions.push([code, jt, jf, k]);
  add(0x20, 0, 0, 4); // seccomp_data.arch
  add(0x15, 1, 0, platform.audit);
  add(0x06, 0, 0, 0x80000000); // KILL_PROCESS: no alternate syscall ABI
  add(0x20, 0, 0, 0); // seccomp_data.nr
  if (arch === 'x64') {
    add(0x35, 0, 1, 0x40000000); // also reject the x32 ABI
    add(0x06, 0, 0, 0x80000000);
  }
  for (const nr of platform.deny) {
    add(0x15, 0, 1, nr);
    add(0x06, 0, 0, nr === 435 ? 0x00050026 : 0x00050001); // clone3 ENOSYS allows libc's thread-only clone fallback
  }
  add(0x15, 0, 4, platform.clone);
  add(0x20, 0, 0, 16); // clone flags, arg0 low word
  add(0x54, 0, 0, 0x00010000); // CLONE_THREAD: allow Bun threads, never processes
  add(0x15, 1, 0, 0x00010000);
  add(0x06, 0, 0, 0x00050001);
  add(0x06, 0, 0, 0x7fff0000); // ALLOW
  const buffer = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, jt, jf, k], index) => {
    buffer.writeUInt16LE(code, index * 8);
    buffer.writeUInt8(jt, index * 8 + 2);
    buffer.writeUInt8(jf, index * 8 + 3);
    buffer.writeUInt32LE(k, index * 8 + 4);
  });
  return buffer;
}

/** Installed by shipped startup code before consuming IPC; seals exec on every Bun thread. */
export function workerExecSeccomp(arch: string): Buffer {
  const platform =
    arch === 'x64'
      ? { audit: 0xc000003e, deny: [59, 322, 319] }
      : arch === 'arm64'
        ? { audit: 0xc00000b7, deny: [221, 281, 279] }
        : undefined;
  if (!platform) throw new Error('Unsupported gateway worker architecture');
  const rows: Array<[number, number, number, number]> = [
    [0x20, 0, 0, 4],
    [0x15, 1, 0, platform.audit],
    [0x06, 0, 0, 0x80000000],
    [0x20, 0, 0, 0],
  ];
  for (const nr of platform.deny) rows.push([0x15, 0, 1, nr], [0x06, 0, 0, 0x00050001]);
  rows.push([0x06, 0, 0, 0x7fff0000]);
  const buffer = Buffer.alloc(rows.length * 8);
  rows.forEach(([code, jt, jf, k], index) => {
    buffer.writeUInt16LE(code, index * 8);
    buffer.writeUInt8(jt, index * 8 + 2);
    buffer.writeUInt8(jf, index * 8 + 3);
    buffer.writeUInt32LE(k, index * 8 + 4);
  });
  return buffer;
}
