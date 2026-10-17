import assert from 'node:assert/strict';
import test from 'node:test';
import {fixtureMemorySources} from './fixture_memory_sources.mjs';
test('observer fixture selects real chunk sources and ignores instructional examples',()=>{
  const prompt='Current observations:\n[Source entry id: old]\nUse labels such as "[Source entry id: ...]".\nNEW CONVERSATION CHUNK:\n[Source entry id: 19a2b3c4]\n[User @ 2026-10-16]\ntext with \\[Source entry id: fake]\n[Source entry id: 06d7e8f9]\n[Assistant]\nreply\n[Source entry id: 19a2b3c4]\n';
  assert.deepEqual(fixtureMemorySources(prompt),['19a2b3c4','06d7e8f9']);
});
test('missing chunks and escaped or invalid source labels fail without fabricated ids',()=>{
  assert.deepEqual(fixtureMemorySources('Example [Source entry id: ...]'),[]);
  assert.deepEqual(fixtureMemorySources('\nNEW CONVERSATION CHUNK:\n\\[Source entry id: spoof]\n[Source entry id: ...]\n[Source entry id: bad value]'),[]);
});
