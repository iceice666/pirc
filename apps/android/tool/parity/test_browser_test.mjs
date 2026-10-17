import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {requireTestBrowserExecutable,validateTestBrowserExecutable} from './test_browser.mjs';

test('automation resolves a dedicated executable and refuses everyday Chrome',()=>{
 const executable=requireTestBrowserExecutable();
 assert.ok(executable.endsWith('/chrome-headless-shell') || executable.endsWith('/headless_shell') || executable.endsWith('headless_shell.exe'));
 const daily='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 if(existsSync(daily)) {assert.throws(()=>validateTestBrowserExecutable(daily),/Refusing an everyday/);assert.throws(()=>requireTestBrowserExecutable(daily),/Refusing an everyday/);}
});
test('an explicit everyday-browser override fails before browser launch',()=>{
 const daily='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 if(!existsSync(daily)) return;
 const result=spawnSync(process.execPath,['--input-type=module','-e',`import {requireTestBrowserExecutable} from ${JSON.stringify(new URL('./test_browser.mjs',import.meta.url).href)};requireTestBrowserExecutable();`],{env:{...process.env,PIRC_TEST_BROWSER:daily},encoding:'utf8'});
 assert.notEqual(result.status,0);assert.match(result.stderr,/Refusing an everyday/);
});

// Old capture tools are still runnable: keep their executable choice isolated too.
test('capture tools cannot launch the installed everyday Chrome directly',()=>{
 const directories=[new URL('./',import.meta.url),new URL('../',import.meta.url),new URL('../../../web/tool/parity/',import.meta.url)];
 for(const directory of directories) {
  for(const name of readdirSync(directory)) {
   if(!/\.(?:mjs|cjs)$/.test(name)) continue;
   const source=readFileSync(new URL(name,directory),'utf8');
   assert.doesNotMatch(source,/executablePath\s*:\s*['"]\/Applications\/Google Chrome\.app\//,name);
   assert.doesNotMatch(source,/executablePath\s*:\s*process\.env\./,name);
  }
 }
});
