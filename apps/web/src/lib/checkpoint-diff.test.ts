import { expect, it } from 'vitest';
import { boundCheckpointText, checkpointDiff, CHECKPOINT_PREVIEW_LIMIT } from './checkpoint-diff';

it('bounds private text previews and marks clipping', () => {
  const result = boundCheckpointText('x'.repeat(CHECKPOINT_PREVIEW_LIMIT + 1));
  expect(result.text).toHaveLength(CHECKPOINT_PREVIEW_LIMIT);
  expect(result.truncated).toBe(true);
  expect(boundCheckpointText('short').truncated).toBe(false);
});

it('builds a unified diff with context and separate nearby hunks', () => {
  const diff = checkpointDiff('alpha\nold\nomega\n', 'alpha\nnew\nomega\n', 'src/file.ts');
  expect(diff).toContain('diff --git a/src/file.ts b/src/file.ts');
  expect(diff).toContain('@@ -1,3 +1,3 @@');
  expect(diff).toContain(' alpha');
  expect(diff).toContain('-old');
  expect(diff).toContain('+new');
  expect(diff).toContain(' omega');
});

it('returns an empty diff for identical text and bounds generated work', () => {
  expect(checkpointDiff('same\n', 'same\n', 'file')).toBe('');
  const before = ['head', ...Array.from({ length: 300 }, (_, i) => `old-${i}`), 'tail'].join('\n');
  const after = ['head', ...Array.from({ length: 301 }, (_, i) => `new-${i}`), 'tail'].join('\n');
  const diff = checkpointDiff(before, after, 'large.txt');
  expect(diff).toContain('-old-0');
  expect(diff).toContain('+new-0');
  expect(diff).toContain(' tail');
});
