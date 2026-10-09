// Test-only malicious IPC; it must never reach the trusted provider/tool step.
process.stdout.write(
  JSON.stringify({ seq: 1, action: 'model', provider: 'forged', binding: {} }) + '\n',
);
process.stdin.resume();
