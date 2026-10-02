/**
 * `pirc-node ptc-worker <script>` — runs model-written code in a child process.
 * Tool calls are forwarded to the parent agent over Bun IPC; console output
 * goes to stdout/stderr, which the parent captures and caps.
 */
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };

/**
 * Remove the Function constructors (`f.constructor`, `Object.constructor`) so
 * a script cannot compile code from a computed string such as
 * `tools.call['constr' + 'uctor']('return Bun')()`. Auto mode lets scripts
 * without capability words run unprompted (`auto-mode/script.ts`); this keeps
 * that judgement honest. Not a sandbox: the OS sandbox is the boundary.
 */
export function tameFunctionConstructors(): void {
  const samples = [function () {}, async function () {}, function* () {}, async function* () {}];
  for (const sample of samples)
    Object.defineProperty(Object.getPrototypeOf(sample), 'constructor', {
      value: undefined,
      writable: false,
      configurable: false,
    });
}

export async function runPtcWorker(argv: string[]): Promise<void> {
  const file = argv[0];
  if (!file || typeof process.send !== 'function') {
    console.error('ptc-worker must be started by a pirc node/chat agent');
    process.exit(2);
  }
  const send = process.send.bind(process);
  const pending = new Map<number, Pending>();
  let counter = 0;
  process.on('message', (message: any) => {
    const waiter = pending.get(message?.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error));
    else waiter.resolve(message.result);
  });
  const call = (name: string, args: unknown = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = ++counter;
      pending.set(id, { resolve, reject });
      send({ type: 'call', id, name, args });
    });
  const textOf = (result: any) =>
    (result?.content ?? [])
      .filter((part: any) => part.type === 'text')
      .map((part: any) => part.text)
      .join('');
  /**
   * `tools.<name>(args)` resolves to the text output and throws on tool
   * errors; `tools.call(name, args)` returns the raw `{content, details, isError}`.
   */
  const tools = new Proxy(
    { call },
    {
      get(target, name) {
        if (name === 'call') return target.call;
        if (typeof name !== 'string' || name === 'then') return undefined;
        return async (args: unknown) => {
          const result = await call(name, args);
          if (result?.isError) throw new Error(textOf(result) || `${name} failed`);
          return textOf(result);
        };
      },
    },
  );
  let exitCode = 0;
  try {
    tameFunctionConstructors();
    const module = await import(file);
    if (typeof module.default !== 'function') throw new Error('Script has no default export');
    const value = await module.default({ tools });
    let serialized: string | undefined;
    try {
      serialized = value === undefined ? undefined : JSON.stringify(value);
    } catch {
      serialized = String(value);
    }
    send({ type: 'result', value: serialized });
  } catch (error) {
    exitCode = 1;
    const err = error as Error;
    send({ type: 'error', message: err?.stack ?? String(error) });
  }
  // Let IPC flush before exiting.
  await Bun.sleep(10);
  process.exit(exitCode);
}
