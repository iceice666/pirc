/**
 * Tool descriptions, kept as markdown in ./tools/<tool name>.md so they can be
 * read and reviewed as prompts rather than string literals. Bun bundles them
 * into the executable (text imports); nothing reads them at run time, and the
 * user cannot override them: their safety rules are part of the agent.
 *
 * Placeholders: `{{name}}` takes a value, and `{{#flag}}…{{/flag}}` keeps
 * its text only when the flag is true. A missing value is an error, so a
 * prompt and its caller cannot drift apart silently. Parameter descriptions
 * stay next to their schemas in the code.
 */
import agent_ask from './tools/agent_ask.md' with { type: 'text' };
import agent_inbox from './tools/agent_inbox.md' with { type: 'text' };
import agent_list from './tools/agent_list.md' with { type: 'text' };
import agent_reply from './tools/agent_reply.md' with { type: 'text' };
import agent_send from './tools/agent_send.md' with { type: 'text' };
import agent_spawn from './tools/agent_spawn.md' with { type: 'text' };
import agent_stop from './tools/agent_stop.md' with { type: 'text' };
import agent_wait from './tools/agent_wait.md' with { type: 'text' };
import ask_user_question from './tools/ask_user_question.md' with { type: 'text' };
import background_task from './tools/background_task.md' with { type: 'text' };
import bash from './tools/bash.md' with { type: 'text' };
import board_post from './tools/board_post.md' with { type: 'text' };
import board_read from './tools/board_read.md' with { type: 'text' };
import browser_click from './tools/browser_click.md' with { type: 'text' };
import browser_handoff from './tools/browser_handoff.md' with { type: 'text' };
import browser_navigate from './tools/browser_navigate.md' with { type: 'text' };
import browser_press from './tools/browser_press.md' with { type: 'text' };
import browser_record from './tools/browser_record.md' with { type: 'text' };
import browser_screenshot from './tools/browser_screenshot.md' with { type: 'text' };
import browser_select from './tools/browser_select.md' with { type: 'text' };
import browser_snapshot from './tools/browser_snapshot.md' with { type: 'text' };
import browser_tabs from './tools/browser_tabs.md' with { type: 'text' };
import browser_type from './tools/browser_type.md' with { type: 'text' };
import browser_wait_for from './tools/browser_wait_for.md' with { type: 'text' };
import code from './tools/code.md' with { type: 'text' };
import create_goal from './tools/create_goal.md' with { type: 'text' };
import delegate from './tools/delegate.md' with { type: 'text' };
import delegation_status from './tools/delegation_status.md' with { type: 'text' };
import edit from './tools/edit.md' with { type: 'text' };
import find from './tools/find.md' with { type: 'text' };
import get_goal from './tools/get_goal.md' with { type: 'text' };
import grep from './tools/grep.md' with { type: 'text' };
import ls from './tools/ls.md' with { type: 'text' };
import memory_note from './tools/memory_note.md' with { type: 'text' };
import memory_propose_user from './tools/memory_propose_user.md' with { type: 'text' };
import memory_search from './tools/memory_search.md' with { type: 'text' };
import read from './tools/read.md' with { type: 'text' };
import recall from './tools/recall.md' with { type: 'text' };
import sandbox_allow_domains from './tools/sandbox_allow_domains.md' with { type: 'text' };
import schedule from './tools/schedule.md' with { type: 'text' };
import subagent from './tools/subagent.md' with { type: 'text' };
import task_create from './tools/task_create.md' with { type: 'text' };
import task_get from './tools/task_get.md' with { type: 'text' };
import task_list from './tools/task_list.md' with { type: 'text' };
import task_update from './tools/task_update.md' with { type: 'text' };
import todo from './tools/todo.md' with { type: 'text' };
import unsandboxed_bash from './tools/unsandboxed_bash.md' with { type: 'text' };
import update_goal from './tools/update_goal.md' with { type: 'text' };
import web_fetch from './tools/web_fetch.md' with { type: 'text' };
import web_search from './tools/web_search.md' with { type: 'text' };
import write from './tools/write.md' with { type: 'text' };

const PROMPTS: Record<string, string> = {
  agent_ask,
  agent_inbox,
  agent_list,
  agent_reply,
  agent_send,
  agent_spawn,
  agent_stop,
  agent_wait,
  ask_user_question,
  background_task,
  bash,
  board_post,
  board_read,
  browser_click,
  browser_handoff,
  browser_navigate,
  browser_press,
  browser_record,
  browser_screenshot,
  browser_select,
  browser_snapshot,
  browser_tabs,
  browser_type,
  browser_wait_for,
  code,
  create_goal,
  delegate,
  delegation_status,
  edit,
  find,
  get_goal,
  grep,
  ls,
  memory_note,
  memory_propose_user,
  memory_search,
  read,
  recall,
  sandbox_allow_domains,
  schedule,
  subagent,
  task_create,
  task_get,
  task_list,
  task_update,
  todo,
  unsandboxed_bash,
  update_goal,
  web_fetch,
  web_search,
  write,
};

export type PromptVars = Record<string, string | boolean>;

/** The tools that have a description file (for tests). */
export const TOOL_PROMPT_NAMES = Object.keys(PROMPTS);

export function toolPrompt(name: string, vars: PromptVars = {}): string {
  const text = PROMPTS[name];
  if (text === undefined)
    throw new Error(`No description for tool ${name} (prompts/tools/${name}.md)`);
  const value = (key: string) => {
    if (!(key in vars)) throw new Error(`Tool description ${name}: no value for {{${key}}}`);
    return vars[key]!;
  };
  return text
    .trimEnd()
    .replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key: string, body: string) =>
      value(key) ? body : '',
    )
    .replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      const result = value(key);
      if (typeof result !== 'string')
        throw new Error(`Tool description ${name}: {{${key}}} needs text, not a flag`);
      return result;
    });
}
