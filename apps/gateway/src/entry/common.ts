import { version } from '../../../../package.json';

/** CLI parsing shared by the three role-specific entry points (no runtime imports). */
export function commandFor(name: string, internal: readonly string[]): string | undefined {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'version' || command === '--version') {
    console.log(version);
    process.exit(0);
  }
  const usage = `Usage: ${name} [--help | --version]

Starts the ${name} service with no arguments.
`;
  if (['help', '--help', '-h'].includes(command ?? '')) {
    process.stdout.write(usage);
    process.exit(0);
  }
  if (command !== undefined && !internal.includes(command)) {
    process.stderr.write(`Unknown command: ${command}\n\n${usage}`);
    process.exit(2);
  }
  process.argv.splice(2, process.argv.length - 2, ...args);
  return command;
}
