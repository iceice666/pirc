import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { PathGuard } from '../src/agent/sandbox.js';
import { discoverSkills, parseSkillFile, skillReadPaths, skillRoots } from '../src/agent/skills.js';
import { settledAfter, startAgent, writeAgentConfig, type AgentProcess } from './agent-harness.js';
import { ptcCall } from './fixtures/fake-llm.js';

const agents: AgentProcess[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
});

function writeSkill(root: string, dir: string, frontMatter: string, body = 'Do the thing.') {
  mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(path.join(root, dir, 'SKILL.md'), `---\n${frontMatter}\n---\n\n${body}\n`);
}

/** A node config dir with a linked skill outside it, and a workspace with a project skill. */
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'pirc-skills-'));
  const configDir = path.join(root, 'config');
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  writeAgentConfig(configDir);
  // Linked in from elsewhere, the way a Nix store path or an npm package would be.
  const external = path.join(root, 'store');
  writeSkill(
    external,
    'moodle-cli',
    'name: moodle-cli\ndescription: Read Moodle units, deadlines and grades.',
    'Run `moodle due`. See [reference](references/commands.md).',
  );
  mkdirSync(path.join(external, 'moodle-cli', 'references'));
  writeFileSync(path.join(external, 'moodle-cli', 'references', 'commands.md'), 'moodle grades');
  mkdirSync(path.join(configDir, 'skills'), { recursive: true });
  symlinkSync(path.join(external, 'moodle-cli'), path.join(configDir, 'skills', 'moodle-cli'));
  writeSkill(path.join(configDir, 'skills'), 'pdf', 'name: pdf\ndescription: Global PDF skill.');
  writeSkill(path.join(configDir, 'skills'), 'broken', 'name: Broken Name\ndescription: x');
  writeSkill(
    path.join(workspace, '.pirc', 'skills'),
    'pdf',
    'name: pdf\ndescription: >\n  Extract text from PDFs,\n  fill forms and OCR scans.',
    'Use pdftotext -layout.',
  );
  // Cross-tool personal skills, shared with other agent harnesses (OpenClaw, Hermes).
  // Lowest precedence: overridden by both the node config and the workspace above.
  writeSkill(
    path.join(home, '.agents', 'skills'),
    'pdf',
    'name: pdf\ndescription: Personal PDF skill, should lose to node and workspace.',
  );
  writeSkill(
    path.join(home, '.agents', 'skills'),
    'gif-search',
    'name: gif-search\ndescription: Search and send a GIF.',
  );
  return { root, configDir, workspace, external, home };
}

async function start(env: ReturnType<typeof setup>) {
  const agent = await startAgent({
    workspace: env.workspace,
    env: { PIRC_CONFIG_DIR: env.configDir, HOME: env.home },
  });
  agents.push(agent);
  return agent;
}

const systemOf = (body: any) => body.messages.find((m: any) => m.role === 'system').content;

describe('skill discovery', () => {
  it('parses front matter, lets the project override the node and skips invalid skills', () => {
    const env = setup();
    const { skills, problems } = discoverSkills([
      path.join(env.configDir, 'skills'),
      path.join(env.workspace, '.pirc', 'skills'),
    ]);
    expect(skills.map((skill) => skill.name)).toEqual(['moodle-cli', 'pdf']);
    expect(skills[1]!.description).toBe('Extract text from PDFs, fill forms and OCR scans.');
    expect(skills[0]!.dir).toContain(path.join('store', 'moodle-cli'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('broken');
    expect(parseSkillFile('no front matter').body).toBe('no front matter');
  });

  it('puts the cross-tool ~/.agents/skills directory at the lowest precedence', () => {
    const env = setup();
    const { skills } = discoverSkills([
      path.join(env.home, '.agents', 'skills'),
      path.join(env.configDir, 'skills'),
      path.join(env.workspace, '.pirc', 'skills'),
    ]);
    expect(skills.map((skill) => skill.name)).toEqual(['gif-search', 'moodle-cli', 'pdf']);
    // The node and workspace `pdf` skills both win over the personal one.
    expect(skills.find((skill) => skill.name === 'pdf')!.description).toBe(
      'Extract text from PDFs, fill forms and OCR scans.',
    );
  });
});

describe('skillReadPaths', () => {
  it('allows the targets of files linked individually into a skill directory', () => {
    // Home Manager layout: a real skill directory whose files each link to their
    // own store path, so the path guard resolves reads outside the directory.
    const root = mkdtempSync(path.join(tmpdir(), 'pirc-skill-links-'));
    const store = path.join(root, 'store');
    mkdirSync(path.join(store, 'refs'), { recursive: true });
    writeFileSync(
      path.join(store, 'hm_SKILL.md'),
      '---\nname: commit\ndescription: Commit.\n---\n',
    );
    writeFileSync(path.join(store, 'hm_openai.yaml'), 'x: 1');
    writeFileSync(path.join(store, 'refs', 'guide.md'), 'guide');
    const skills = path.join(root, 'skills');
    mkdirSync(path.join(skills, 'commit', 'agents'), { recursive: true });
    symlinkSync(path.join(store, 'hm_SKILL.md'), path.join(skills, 'commit', 'SKILL.md'));
    symlinkSync(
      path.join(store, 'hm_openai.yaml'),
      path.join(skills, 'commit', 'agents', 'openai.yaml'),
    );
    symlinkSync(path.join(store, 'refs'), path.join(skills, 'commit', 'refs'));
    symlinkSync(path.join(store, 'missing'), path.join(skills, 'commit', 'dangling'));

    // Skills are configuration: readable, and protected wherever their links lead.
    const targets = skillReadPaths([skills]);
    const guard = new PathGuard(
      root,
      { denyRead: [], allowRead: [], allowWrite: [root], denyWrite: [] },
      targets,
    );
    for (const file of ['SKILL.md', 'agents/openai.yaml', 'refs/guide.md']) {
      const target = path.join(skills, 'commit', file);
      expect(() => guard.resolve(target, 'read')).not.toThrow();
      expect(() => guard.resolve(target, 'write')).toThrow(/protected/);
    }
    // Unrelated store paths are not skill configuration.
    writeFileSync(path.join(store, 'other.md'), 'notes');
    expect(() => guard.resolve(path.join(store, 'other.md'), 'write')).not.toThrow();
  });
});

describe('skillRoots', () => {
  it('orders ~/.agents/skills lowest, then the node config dir, then the workspace', () => {
    const roots = skillRoots('/config', '/workspace');
    expect(roots).toEqual([
      path.join(os.homedir(), '.agents', 'skills'),
      path.join('/config', 'skills'),
      path.join('/workspace', '.pirc', 'skills'),
    ]);
  });
});

describe('skills feature', () => {
  it('lists skills in the system prompt and lets the model read linked skill files', async () => {
    const env = setup();
    const agent = await start(env);
    const warning = await agent.waitFor(
      (e) =>
        e.type === 'extension_ui_request' &&
        e.method === 'notify' &&
        /Skill skipped/.test(e.message),
    );
    expect(warning.message).toContain('broken');
    const reference = path.join(env.configDir, 'skills', 'moodle-cli', 'references', 'commands.md');
    agent.llm.push(
      {
        tool: ptcCall('r1', 'read', { path: reference }),
        also: [
          ptcCall('w1', 'write', {
            path: path.join(env.external, 'moodle-cli', 'SKILL.md'),
            content: 'x',
          }),
        ],
      },
      { text: 'done' },
    );
    await agent.send({ type: 'prompt', message: 'what is due?' });
    await settledAfter(agent, 0);
    const system = systemOf(agent.llm.requests[0]!.body);
    expect(system).toContain('<available_skills>');
    expect(system).toContain('<name>moodle-cli</name>');
    expect(system).toContain('Extract text from PDFs');
    expect(system).not.toContain('Global PDF skill');
    // Personal ~/.agents/skills skill is discovered, at the lowest precedence.
    expect(system).toContain('<name>gif-search</name>');
    expect(system).not.toContain('Personal PDF skill');
    const results = ['r1', 'w1'].map(
      (id) =>
        agent.events.find(
          (e) => e.type === 'tool_execution_end' && !e.parentToolCallId && e.toolCallId === id,
        )!,
    );
    expect(results[0]!.isError).toBe(false);
    expect(results[0]!.result.content[0].text).toContain('moodle grades');
    expect(results[1]!.isError).toBe(true);
    expect(results[1]!.result.content[0].text).toContain('protected');
    expect(readFileSync(path.join(env.external, 'moodle-cli', 'SKILL.md'), 'utf8')).toContain(
      'name: moodle-cli',
    );
  });

  it('/skill:<name> loads the skill and sends the request', async () => {
    const env = setup();
    const agent = await start(env);
    const commands = await agent.send({ type: 'get_commands' });
    expect(commands.data.commands.map((c: any) => c.name)).toEqual(
      expect.arrayContaining(['skill', 'skill:moodle-cli', 'skill:pdf', 'skill:gif-search']),
    );
    agent.llm.push({ text: 'extracted' });
    await agent.send({ type: 'prompt', message: '/skill:pdf read notes.pdf' });
    await settledAfter(agent, 0);
    const messages = JSON.stringify(agent.llm.requests[0]!.body.messages);
    expect(messages).toContain('Use pdftotext -layout.');
    expect(messages).toContain('<skill name=\\"pdf\\"');
    expect(agent.llm.requests[0]!.body.messages.at(-1).content).toBe('read notes.pdf');
    const card = agent.events.find(
      (e) =>
        e.type === 'message_end' && e.message.role === 'custom' && e.message.customType === 'skill',
    );
    expect(card!.message.details.name).toBe('pdf');
  });

  it('/skill lists skills without calling the model, and can be disabled', async () => {
    const env = setup();
    const agent = await start(env);
    await agent.send({ type: 'prompt', message: '/skill' });
    const list = await agent.waitFor(
      (e) =>
        e.type === 'extension_ui_request' && e.method === 'notify' && /skill:pdf/.test(e.message),
    );
    expect(list.message).toContain('/skill:moodle-cli — Read Moodle');
    expect(agent.llm.requests).toHaveLength(0);

    writeAgentConfig(env.configDir, { features: { skills: { enabled: false } } });
    const off = await start(env);
    off.llm.push({ text: 'hi' });
    await off.send({ type: 'prompt', message: 'hello' });
    await settledAfter(off, 0);
    expect(systemOf(off.llm.requests[0]!.body)).not.toContain('available_skills');
  });
});
