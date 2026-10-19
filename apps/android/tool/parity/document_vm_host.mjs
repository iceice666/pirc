// Test-only protocol peer. Evaluates synthetic fixtures with the production
// runtime; Dart owns the real task/layout/resource host protocol. Node's VM is
// not an Android security sandbox and this runner must not open external pages.
import vm from 'node:vm';
import readline from 'node:readline';
const realms = new Map();
let nextId = 0;
for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let request;
  try {
    request = JSON.parse(line);
    const args = request.args || {};
    let result;
    if (request.method === 'open') {
      const id = ++nextId;
      realms.set(id, {
        owner: args.owner,
        context: vm.createContext({}, { microtaskMode: 'afterEvaluate' }),
      });
      result = { id };
    } else {
      const realm = realms.get(args.id);
      if (!realm || realm.owner !== args.owner) throw new Error('Unknown script owner');
      if (request.method === 'close') {
        realms.delete(args.id);
        result = null;
      } else if (request.method === 'evaluate') {
        const value = new vm.Script(args.source, {
          filename: 'synthetic-document.js',
        }).runInContext(realm.context, { timeout: 3000 });
        result = { value: value == null ? '' : String(value) };
      } else throw new Error('Unknown protocol operation');
    }
    process.stdout.write(JSON.stringify({ sequence: request.sequence, result }) + '\n');
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        sequence: request?.sequence,
        error: String(error.stack || error).slice(0, 4096),
      }) + '\n',
    );
  }
}
