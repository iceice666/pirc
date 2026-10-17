// Verify a frozen observation against the exact original source bytes while
// permitting only the explicit migration to an isolated test executable.
export function originalOracleRunnerBytes(bytes) {
  const source=bytes.toString('utf8');
  const header="import { requireTestBrowserExecutable } from './test_browser.mjs';\n";
  if(!source.startsWith(header)) throw new Error('Oracle runner must use the isolated browser selector.');
  const body=source.slice(header.length);
  const matches=body.match(/\brequireTestBrowserExecutable\(\)/g)??[];
  if(matches.length!==1) throw new Error('Only one browser-executable substitution is permitted in a frozen runner.');
  return Buffer.from(body.replace('requireTestBrowserExecutable()', "'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'"),'utf8');
}
