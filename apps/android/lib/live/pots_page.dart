import 'dart:async';

import 'package:flutter/material.dart';

import '../l10n/app_i18n.dart';
import 'gateway.dart';
import 'pots_state.dart';

/// Native checkpoint UI; reading/opening never accepts or starts work.
class PotsPage extends StatefulWidget {
  const PotsPage({
    super.key,
    required this.controller,
    required this.onOpenChat,
    this.sidebarCollapsed = false,
    this.onExpand,
  });
  final LiveController controller;
  final ValueChanged<String> onOpenChat;
  final bool sidebarCollapsed;
  final VoidCallback? onExpand;
  @override
  State<PotsPage> createState() => _PotsPageState();
}

class _PotsPageState extends State<PotsPage> with WidgetsBindingObserver {
  late PotsState state;
  final purpose = TextEditingController();
  final observations = TextEditingController();
  final dispatches = TextEditingController();
  final concurrency = TextEditingController();
  final selected = <String>{};
  final instructions = <String, TextEditingController>{};
  int _draftEpoch = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    state = PotsState(widget.controller)..addListener(_changed);
    unawaited(state.load());
  }

  void _clearDraft() {
    purpose.clear();
    observations.clear();
    dispatches.clear();
    concurrency.clear();
    selected.clear();
    for (final c in instructions.values) {
      c.dispose();
    }
    instructions.clear();
  }

  void _changed() {
    if (!mounted) return;
    if (_draftEpoch != state.epoch) {
      _draftEpoch = state.epoch;
      _clearDraft();
    }
    setState(() {});
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState value) {
    if (value == AppLifecycleState.resumed) unawaited(state.load());
  }

  @override
  void didUpdateWidget(covariant PotsPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller == widget.controller) return;
    state.removeListener(_changed);
    state.dispose();
    _clearDraft();
    _draftEpoch = 0;
    state = PotsState(widget.controller)..addListener(_changed);
    unawaited(state.load());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    state.removeListener(_changed);
    state.dispose();
    for (final c in [
      purpose,
      observations,
      dispatches,
      concurrency,
      ...instructions.values,
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _create() async {
    final o = int.tryParse(observations.text),
        d = int.tryParse(dispatches.text),
        c = int.tryParse(concurrency.text);
    if (o == null || d == null || c == null) return;
    if (await state.create(
      purpose: purpose.text,
      scopes: selected.toList(),
      observations: o,
      dispatches: d,
      concurrency: c,
    )) {
      if (mounted) setState(_clearDraft);
    }
  }

  bool get valid {
    final o = int.tryParse(observations.text),
        d = int.tryParse(dispatches.text),
        c = int.tryParse(concurrency.text);
    return purpose.text.trim().isNotEmpty &&
        selected.isNotEmpty &&
        selected.length <= 32 &&
        o != null &&
        o >= 1 &&
        o <= 1000000 &&
        d != null &&
        d >= 0 &&
        d <= 1000000 &&
        c != null &&
        c >= 1 &&
        c <= 32;
  }

  Widget heading(String source) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 12),
    child: Text(tr(source), style: Theme.of(context).textTheme.titleLarge),
  );
  Widget card(List<Widget> children) => Card(
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: children,
      ),
    ),
  );
  Widget button(String source, VoidCallback? action) => OutlinedButton(
    onPressed: state.ready ? action : null,
    child: Text(tr(source)),
  );
  Widget actions(List<Widget> children) => Padding(
    padding: const EdgeInsets.only(top: 8),
    child: Wrap(spacing: 8, runSpacing: 8, children: children),
  );
  Widget number(String label, TextEditingController controller) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 6),
    child: TextField(
      controller: controller,
      enabled: state.ready,
      keyboardType: TextInputType.number,
      decoration: InputDecoration(labelText: tr(label)),
      onChanged: (_) => setState(() {}),
    ),
  );
  Widget responsibility(Json r) {
    final budgets = obj(r['budgets']);
    return card([
      Text('${r['purpose']}', style: Theme.of(context).textTheme.titleMedium),
      Text(tr(r['enabled'] == true ? 'Enabled' : 'Disabled')),
      Text(
        tr(
          r['observationPaused'] == true
              ? 'Observation paused'
              : 'Observation unpaused',
        ),
      ),
      Text(
        tr(
          r['coordinationPaused'] == true
              ? 'Coordination paused'
              : 'Coordination unpaused',
        ),
      ),
      Text(rows(r['scopes']).map((s) => '${s['workspaceId']}').join(', ')),
      Text(
        tr('Observed {0}/{1} · dispatched {2}/{3} · concurrency {4}', [
          r['observationsUsed'],
          budgets['observations'],
          r['dispatchesUsed'],
          budgets['dispatches'],
          budgets['concurrency'],
        ]),
      ),
      actions([
        button(
          r['enabled'] == true ? 'Disable' : 'Activate observation',
          () => unawaited(
            state.responsibility(
              r,
              r['enabled'] == true ? 'disable' : 'activate',
            ),
          ),
        ),
        button(
          r['observationPaused'] == true
              ? 'Resume observation'
              : 'Pause observation',
          r['enabled'] != true
              ? null
              : () => unawaited(
                  state.responsibility(
                    r,
                    r['observationPaused'] == true
                        ? 'resume_observation'
                        : 'pause_observation',
                  ),
                ),
        ),
        button(
          r['coordinationPaused'] == true
              ? 'Resume coordination'
              : 'Pause coordination',
          r['enabled'] != true
              ? null
              : () => unawaited(
                  state.responsibility(
                    r,
                    r['coordinationPaused'] == true
                        ? 'resume_coordination'
                        : 'pause_coordination',
                  ),
                ),
        ),
      ]),
    ]);
  }

  Widget suggestion(Json s) {
    final evidence = obj(s['evidence']);
    final expires = evidence['expiresAt'];
    final outdated =
        !const [
          'pending',
          'snoozed',
          'linked',
          'dismissed',
        ].contains(s['disposition']) ||
        expires is! num ||
        expires <= state.clock().millisecondsSinceEpoch;
    final disposition = switch (s['disposition']) {
      'pending' => 'Pending',
      'snoozed' => 'Snoozed',
      'dismissed' => 'Dismissed',
      'linked' => 'Linked',
      'superseded' => 'Superseded',
      _ => 'Needs refresh',
    };
    return card([
      Text(
        tr(
          outdated
              ? 'Previous input request — recheck source'
              : 'Session input request',
        ),
        style: Theme.of(context).textTheme.titleMedium,
      ),
      Text("${tr('From pots')} · ${tr(disposition)}"),
      Text(
        tr('Evidence: workspace {0} · session {1} · epoch {2}', [
          evidence['workspaceId'],
          evidence['sessionId'],
          evidence['runnerEpoch'],
        ]),
      ),
      Text(tr('Interaction: {0}', [evidence['interactionId']])),
      if (outdated)
        Text(
          tr(
            'Outdated evidence. Refresh and review the source; no work is authorized.',
          ),
        ),
      if (expires is num)
        Text(
          tr('Evidence expires: {0}', [
            DateTime.fromMillisecondsSinceEpoch(
              expires.toInt(),
            ).toLocal().toString(),
          ]),
        ),
      if (s['snoozedUntil'] is num)
        Text(
          tr('Snoozed until {0}', [
            DateTime.fromMillisecondsSinceEpoch(
              (s['snoozedUntil'] as num).toInt(),
            ).toLocal().toString(),
          ]),
        ),
      if (s['taskId'] != null) Text(tr('Linked task: {0}', [s['taskId']])),
      actions([
        button(
          'Review source conversation',
          () => widget.onOpenChat('${s['targetSessionId']}'),
        ),
        if (!outdated &&
            const ['pending', 'snoozed'].contains(s['disposition'])) ...[
          button(
            'Track only',
            state.actionable(s) ? () => unawaited(state.track(s)) : null,
          ),
          button(
            'Snooze 1 hour',
            () => unawaited(state.suggestion(s, 'snooze')),
          ),
          button('Dismiss', () => unawaited(state.suggestion(s, 'dismiss'))),
        ],
      ]),
    ]);
  }

  Widget task(Json t) {
    final stopped = const [
      'completed',
      'failed',
      'interrupted',
      'stopped',
      'stopping',
    ].contains(t['status']);
    final takeover = t['takenOver'] == true;
    final execution = t['execution'] != null || t['executionSessionId'] != null;
    final instruction = instructions.putIfAbsent(
      '${t['id']}',
      TextEditingController.new,
    );
    const labels = {
      'tracked': 'Tracked',
      'starting': 'Starting',
      'queued': 'Queued',
      'running': 'Running',
      'waiting_input': 'Waiting for input',
      'completed': 'Completed',
      'failed': 'Failed',
      'interrupted': 'Interrupted',
      'stopping': 'Stopping',
      'stopped': 'Stopped',
    };
    return card([
      Text(
        tr('Review session input'),
        style: Theme.of(context).textTheme.titleMedium,
      ),
      Text("${tr(labels[t['status']] ?? '${t['status']}')} · ${t['id']}"),
      Text(
        tr(
          takeover
              ? 'Taken over by you; pots coordination is fenced. Already-running execution continues.'
              : t['coordinationPaused'] == true
              ? 'Coordination paused'
              : 'Coordination unpaused',
        ),
      ),
      Text(tr('Origin suggestion: {0}', [t['originSuggestionId']])),
      Text(tr('Target session: {0}', [t['targetSessionId']])),
      Text(
        t['executionSessionId'] == null
            ? t['status'] == 'tracked' ||
                      (t['status'] == 'stopped' && !execution)
                  ? tr('No execution session. Tracking is not running.')
                  : tr(
                      'Execution session not yet confirmed. Refresh to check current state; do not assume it is stopped.',
                    )
            : tr('Execution session: {0}', [t['executionSessionId']]),
      ),
      if (t['outcome'] != null) Text(tr('Outcome: {0}', [t['outcome']])),
      if (t['failure'] != null) Text(tr('Failure: {0}', [t['failure']])),
      if (t['execution'] != null)
        Text(
          tr('Authorized instruction: {0}', [
            obj(t['execution'])['instruction'],
          ]),
        )
      else if (t['status'] == 'tracked') ...[
        Text(
          tr(
            'Start authorizes one execution in a new session in the same workspace, using only your instruction. No source transcript or approval is copied or answered. The instruction cannot be changed after Start.',
          ),
        ),
        TextField(
          key: ValueKey('instruction-${t['id']}'),
          controller: instruction,
          enabled: state.canStart(t),
          minLines: 3,
          maxLines: 8,
          decoration: InputDecoration(labelText: tr('Execution instruction')),
          onChanged: (_) => setState(() {}),
        ),
        Text(tr('Instruction must be 1–20000 UTF-8 bytes.')),
        Text(
          tr(
            'Start requires an enabled responsibility with coordination unpaused, dispatch budget remaining and a concurrency slot. Pausing coordination does not stop already-running execution.',
          ),
        ),
        button(
          state.snapshot?['executionAvailable'] == true
              ? 'Start'
              : 'Start unavailable',
          state.canStart(t) && PotsState.validInstruction(instruction.text)
              ? () => unawaited(state.start(t, instruction.text))
              : null,
        ),
      ],
      actions([
        button(
          'Take over',
          stopped || takeover
              ? null
              : () => unawaited(state.task(t, 'take_over')),
        ),
        button(
          t['coordinationPaused'] == true
              ? 'Resume coordination'
              : 'Pause coordination',
          stopped || takeover
              ? null
              : () => unawaited(
                  state.task(
                    t,
                    t['coordinationPaused'] == true
                        ? 'resume_coordination'
                        : 'pause_coordination',
                  ),
                ),
        ),
        button(
          execution ? 'Stop execution' : 'Stop tracking',
          stopped ? null : () => unawaited(state.task(t, 'stop')),
        ),
        if (t['executionSessionId'] != null)
          button(
            'Open execution session',
            () => widget.onOpenChat('${t['executionSessionId']}'),
          ),
      ]),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return SafeArea(
      child: Column(
        children: [
          Row(
            children: [
              if (widget.sidebarCollapsed)
                IconButton(
                  onPressed: widget.onExpand,
                  tooltip: tr('Show sidebar'),
                  icon: const Icon(Icons.menu),
                ),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Text(
                    'pots',
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                ),
              ),
              IconButton(
                onPressed: state.busy ? null : () => unawaited(state.load()),
                tooltip: tr('Refresh'),
                icon: const Icon(Icons.refresh),
              ),
            ],
          ),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.all(16),
              children: [
                Text(
                  tr(
                    'Your personal coordinator. Suggestions are not instructions or permission to act.',
                  ),
                ),
                Text(
                  tr(
                    'Progress events only: no transcript reading. Execution requires your explicit instruction and Start.',
                  ),
                ),
                Text(
                  tr(
                    'Tracking controls do not stop tools running in the source conversation.',
                  ),
                ),
                if (state.error != null)
                  Semantics(liveRegion: true, child: Text(state.error!)),
                if (state.loading)
                  const Center(child: CircularProgressIndicator()),
                if (!state.paired) Text(tr('Pair this device to use pots.')),
                if (state.snapshot != null) ...[
                  heading('Responsibilities'),
                  Text(
                    tr(
                      'Saving does not activate observation. Activate explicitly after reviewing scopes and budgets.',
                    ),
                  ),
                  TextField(
                    controller: purpose,
                    enabled: state.ready,
                    maxLength: 2000,
                    decoration: InputDecoration(labelText: tr('Purpose')),
                    onChanged: (_) => setState(() {}),
                  ),
                  Text(tr('Selected workspaces — progress only')),
                  for (final w in state.workspaces)
                    CheckboxListTile(
                      title: Text('${w['name']}'),
                      subtitle: Text('${w['id']}'),
                      value: selected.contains(w['id']),
                      onChanged: !state.ready
                          ? null
                          : (value) => setState(() {
                              if (value == true) {
                                selected.add('${w['id']}');
                              } else {
                                selected.remove(w['id']);
                              }
                            }),
                    ),
                  number('Observation budget', observations),
                  number('Dispatch budget (0 disables dispatch)', dispatches),
                  number('Concurrency limit', concurrency),
                  button(
                    'Save disabled responsibility',
                    valid ? () => unawaited(_create()) : null,
                  ),
                  for (final r in state.responsibilities) responsibility(r),
                  if (state.responsibilities.isEmpty)
                    Text(
                      tr(
                        'No responsibilities. Nothing is observed until you explicitly configure and activate one.',
                      ),
                    ),
                  heading('Suggestions from pots'),
                  Text(
                    tr(
                      'Reading a suggestion never accepts it. Track only creates a task, not an execution session.',
                    ),
                  ),
                  for (final s in state.suggestions) suggestion(s),
                  if (state.suggestions.isEmpty) Text(tr('No suggestions.')),
                  heading('Tracked tasks'),
                  for (final t in state.tasks) task(t),
                  if (state.tasks.isEmpty) Text(tr('No tracked tasks.')),
                  Text(
                    tr(
                      'Lists show at most 100 records per category. Refresh to see current state.',
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}
