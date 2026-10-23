// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it } from 'vitest';
import { app } from '../../app.svelte';
import { i18n } from '../../i18n.svelte';
import type { PanelState } from '../../panel-api';
import MemoryTab from './MemoryTab.svelte';

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
afterEach(async () => {
  if (component) await unmount(component);
  target?.remove();
  app.panel.value = undefined;
  i18n.setLanguage('en');
});
for (const language of ['en', 'zh-TW']) {
  it(`shows handoff diagnostics and legacy archives in ${language}`, () => {
    i18n.setLanguage(language);
    const meter = { value: 0, max: 100, ratio: 0 };
    app.panel.value = {
      agentRunning: false,
      memoryRuntime: null,
      workspaceMemory: { pendingMutations: 1, errors: { extract: 'Source revoked' } },
      memory: {
        enabled: true,
        architecture: 'handoff',
        handoff: { snapshots: 2, legacyAncestry: 'old' },
        thresholds: { compaction: meter, observation: meter, reflection: meter, activePool: meter },
        counts: { reflections: 0, active: 0, dropped: 0, compactions: 2 },
        observations: [],
        reflections: [],
      },
    } as unknown as PanelState;
    target = document.createElement('div');
    document.body.append(target);
    component = mount(MemoryTab, { target, props: { active: false } });
    flushSync();
    expect(target.textContent).toContain('extract: Source revoked');
    expect(target.textContent).toContain(
      language === 'en' ? 'Session handoffs: 2.' : '對話交接摘要：2 份',
    );
    expect(target.textContent).toContain(
      language === 'en' ? 'awaiting confirmation' : '正在等待確認',
    );
    expect(target.textContent).toContain(
      language === 'en' ? 'Legacy memory archive' : '舊版記憶封存',
    );
    expect(target.textContent).toContain(language === 'en' ? 'Next compaction' : '下次整理');
    expect(target.textContent).not.toContain('Next observation');
    // Repository memory can be explicitly enabled while legacy OM is off.
    app.panel.value = {
      ...app.panel.value!,
      memory: { ...app.panel.value!.memory!, enabled: false },
    };
    flushSync();
    expect(target.textContent).toContain('extract: Source revoked');
    expect(target.textContent).toContain(
      language === 'en' ? 'awaiting confirmation' : '正在等待確認',
    );
  });
}
