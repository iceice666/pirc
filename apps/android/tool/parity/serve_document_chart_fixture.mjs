import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.join(scriptDirectory, 'vendor/chart.js-4.5.1');
const libraryPath = path.join(packageDirectory, 'chart.umd.js');
const provenance = JSON.parse(readFileSync(path.join(packageDirectory, 'provenance.json'), 'utf8'));
const library = readFileSync(libraryPath);
const actualSha256 = createHash('sha256').update(library).digest('hex');
if (actualSha256 !== provenance.assetSha256) {
  throw new Error(`Chart.js checksum mismatch: expected ${provenance.assetSha256}, got ${actualSha256}`);
}
const reference = readFileSync(path.join(scriptDirectory, 'fixtures/document-chart-chromium153.json'));
const referenceSha256 = createHash('sha256').update(reference).digest('hex');
const interactions = readFileSync(path.join(scriptDirectory, 'fixtures/document-chart-interactions-chromium153.json'));
const interactionFixture = JSON.parse(interactions.toString('utf8'));
if (interactionFixture.chartJs?.sha256 !== actualSha256 || !Array.isArray(interactionFixture.cases)) {
  throw new Error('Chart interaction fixture does not match the pinned library');
}
const fixture = JSON.parse(reference.toString('utf8'));
if (fixture.chartJs?.sha256 !== actualSha256 || !Array.isArray(fixture.cases)) {
  throw new Error('Chart.js reference fixture does not match the pinned library or has no cases');
}

function configuredPort() {
  const argument = process.argv.slice(2).find((value) => value === '--port' || value.startsWith('--port='));
  const argumentIndex = process.argv.indexOf(argument);
  const cliValue = argument === '--port'
    ? process.argv[argumentIndex + 1]
    : argument?.slice('--port='.length);
  const value = cliValue ?? process.env.PIRC_DOCUMENT_CHART_PORT ?? '19261';
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

const requestedPort = configuredPort();
const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (request.method !== 'GET') {
    response.writeHead(405, {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    });
    response.end('Method not allowed');
    return;
  }
  if (pathname === '/chart.js') {
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-length': library.length,
      'content-type': 'text/javascript; charset=utf-8',
      'x-chartjs-version': provenance.version,
      'x-chartjs-sha256': actualSha256,
    });
    response.end(library);
    return;
  }
  if (pathname === '/interactions.json') {
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    });
    response.end(interactions);
    return;
  }
  if (pathname === '/reference.json') {
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-length': reference.length,
      'content-type': 'application/json; charset=utf-8',
      'x-chartjs-version': provenance.version,
      'x-reference-sha256': referenceSha256,
    });
    response.end(reference);
    return;
  }

  response.writeHead(404, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
  });
  response.end('Not found');
});

server.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
server.listen(requestedPort, '127.0.0.1', () => {
  const address = server.address();
  console.log(JSON.stringify({
    ready: true,
    host: '127.0.0.1',
    port: address.port,
    paths: ['/chart.js', '/reference.json'],
    url: `http://127.0.0.1:${address.port}/chart.js`,
    referenceUrl: `http://127.0.0.1:${address.port}/reference.json`,
    package: provenance.package,
    version: provenance.version,
    sha256: actualSha256,
    referenceSha256,
    caseCount: fixture.cases.length,
  }));
});

function closeServer() {
  server.close(() => process.exit(0));
}
process.once('SIGINT', closeServer);
process.once('SIGTERM', closeServer);
