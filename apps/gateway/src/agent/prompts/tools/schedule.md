Run a task later, or repeatedly, as a new agent session: the user's scheduled tasks (cron). Each run starts fresh in the chosen workspace with only the prompt, so write the prompt to stand on its own. Nobody watches a run live; the user reads its final message in the schedule's history.

Actions:

- list: the schedules you may manage, with ids and their last run.
- create: propose a schedule. It exists only once the user approves it in this chat. Give cron (5 fields: minute hour day-of-month month day-of-week, e.g. `0 9 * * 1-5`) for a repeating one, or at (e.g. "2026-10-01T09:00") for a single run.
- update: propose a change to one (id plus the fields to change); the user approves it too.
- pause / resume / delete: take effect at once (id).
- result: a run's final message (id of the run, like r1a2b3c4d), in 12000-character chunks; call again with offset set to the reported next offset until none is given.

Times are read in timezone (IANA, e.g. "Asia/Taipei"); it defaults to the gateway's. Today is {{today}}.
