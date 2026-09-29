import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Agent } from '../agent.js';
import type { Feature } from '../feature.js';
import { discoverSkills, parseSkillFile, skillRoots, type Skill } from '../skills.js';

export const SKILL_MESSAGE = 'skill';

const escape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The system-prompt section listing skills; empty when there are none. */
export function skillsPrompt(skills: Skill[]): string {
  if (!skills.length) return '';
  const list = skills
    .map(
      (skill) =>
        `  <skill>\n    <name>${escape(skill.name)}</name>\n    <description>${escape(skill.description)}</description>\n    <location>${escape(skill.file)}</location>\n  </skill>`,
    )
    .join('\n');
  return `## Skills

Skills are instructions for specialized tasks, installed by the user. When a task matches a skill's description, read its SKILL.md with the read tool before acting and follow it. Relative paths in a skill are relative to its directory; read referenced files only when needed.

<available_skills>
${list}
</available_skills>`;
}

/** The hidden-context body for an explicitly invoked skill. */
export function skillContent(skill: Skill): string {
  const { body } = parseSkillFile(readFileSync(skill.file, 'utf8'));
  return `<skill name="${escape(skill.name)}" location="${escape(skill.file)}">
Relative paths in this skill are relative to ${path.dirname(skill.file)}.

${body}
</skill>`;
}

function enabled(agent: Agent): boolean {
  const config = agent.config.features.skills as { enabled?: unknown } | undefined;
  return config?.enabled !== false;
}

/**
 * Agent Skills from `$PIRC_CONFIG_DIR/skills/` and `<workspace>/.pirc/skills/`
 * (see `skills.ts`). Rescanned before every run and command, so a new skill is
 * listed without restarting; the file tools can read skill directories that
 * existed when the agent started. `/skill:<name> [request]` loads one
 * explicitly, `/skill` lists them.
 */
export function skillsFeature(): Feature {
  let current: Agent | null = null;
  const scan = () =>
    current && enabled(current)
      ? discoverSkills(skillRoots(current.config.configDir, current.config.workspace))
      : { skills: [], problems: [] };

  const invoke = (agent: Agent, skill: Skill, args: string) => {
    agent.deliver({
      customType: SKILL_MESSAGE,
      content: skillContent(skill),
      display: true,
      details: { name: skill.name, file: skill.file },
    });
    agent.steer(args || `Use the ${skill.name} skill.`);
  };

  return {
    name: 'skills',
    init(agent) {
      current = agent;
      for (const problem of scan().problems)
        agent.ui.notify(`Skill skipped: ${problem}`, 'warning');
    },
    get commands() {
      const { skills } = scan();
      if (!current || !enabled(current)) return {};
      const commands: NonNullable<Feature['commands']> = {
        skill: {
          description: 'List skills (/skill), or load one with /skill:<name> [request]',
          async run(agent, args) {
            const skill = args ? skills.find((item) => item.name === args.split(/\s/, 1)[0]) : null;
            if (skill) return invoke(agent, skill, args.slice(skill.name.length).trim());
            agent.ui.notify(
              skills.length
                ? skills.map((item) => `/skill:${item.name} — ${item.description}`).join('\n')
                : 'No skills installed.',
              'info',
            );
          },
        },
      };
      for (const skill of skills)
        commands[`skill:${skill.name}`] = {
          description: skill.description,
          async run(agent, args) {
            invoke(agent, skill, args);
          },
        };
      return commands;
    },
    async beforeAgentStart() {
      const systemPrompt = skillsPrompt(scan().skills);
      return systemPrompt ? { systemPrompt } : undefined;
    },
  };
}
