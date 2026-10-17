import 'keyboard_suggestions.dart';
import 'web_length_formatter.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter/rendering.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'common.dart';
import 'gateway.dart';
import 'schedules_state.dart';
import 'schedule_datetime_picker.dart';
import 'web_controls.dart';

TextStyle scheduleText(
  BuildContext context, {
  double size = 14,
  FontWeight weight = FontWeight.w400,
  String color = 'text.primary',
}) => webText(
  context,
  size: size,
  weight: weight,
  color: color,
).copyWith(height: 1.15);

class SchedulesPage extends StatefulWidget {
  const SchedulesPage({
    super.key,
    required this.controller,
    this.focusId,
    this.focusRevision = 0,
    this.onOpenChat,
    this.sidebarCollapsed = false,
    this.onExpand,
    this.now,
  });
  final LiveController controller;
  final String? focusId;
  final int focusRevision;
  final ValueChanged<String>? onOpenChat;
  final bool sidebarCollapsed;
  final VoidCallback? onExpand;
  final DateTime Function()? now;
  @override
  State<SchedulesPage> createState() => _SchedulesPageState();
}

class _SchedulesPageState extends State<SchedulesPage> {
  late SchedulesState state;
  String? editing;
  Json? existing;
  int editorKey = 0, epoch = 0;
  final prompts = <String>{};
  @override
  void initState() {
    super.initState();
    setup();
  }

  void setup() {
    state = SchedulesState(widget.controller, clock: widget.now)
      ..addListener(changed);
    final initial = state;
    state.initialize().then((_) {
      if (mounted && identical(initial, state) && widget.focusId != null) {
        state.focus(widget.focusId!);
      }
    });
  }

  void changed() {
    if (!mounted) return;
    setState(() {
      if (epoch != state.epoch) {
        epoch = state.epoch;
        editing = null;
        existing = null;
        prompts.clear();
        editorKey++;
      }
    });
  }

  @override
  void didUpdateWidget(covariant SchedulesPage old) {
    super.didUpdateWidget(old);
    if (old.controller != widget.controller) {
      state.removeListener(changed);
      state.dispose();
      editing = null;
      existing = null;
      epoch = 0;
      editorKey++;
      setup();
    } else if ((old.focusId != widget.focusId ||
            old.focusRevision != widget.focusRevision) &&
        widget.focusId != null) {
      state.focus(widget.focusId!);
    }
  }

  @override
  void dispose() {
    state.removeListener(changed);
    state.dispose();
    super.dispose();
  }

  void edit(Json? schedule) {
    setState(() {
      editing = schedule == null ? 'new' : '${schedule['id']}';
      existing = schedule;
      editorKey++;
    });
    state.loadModels();
  }

  Widget button(
    String label,
    VoidCallback? onPressed, {
    bool primary = false,
    bool danger = false,
  }) => WebButton(
    label,
    onPressed: onPressed,
    primary: primary,
    danger: danger,
    height: 32,
    fontSize: 13,
    horizontalPadding: 12,
  );
  Widget text(
    String value, {
    bool small = false,
    String color = 'text.muted',
    FontWeight weight = FontWeight.w400,
  }) => Text(
    value,
    style: scheduleText(
      context,
      size: small ? 12 : 13,
      color: color,
      weight: weight,
    ),
  );
  Widget badge(String label, {bool attention = false}) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 6),
    decoration: BoxDecoration(
      color: palette(context)[attention ? 'accent.default' : 'web.bg-hover'],
      borderRadius: BorderRadius.circular(999),
    ),
    child: Text(
      label,
      style: scheduleText(
        context,
        size: 11,
        color: attention ? 'surface.page' : 'text.secondary',
      ),
    ),
  );
  @override
  Widget build(BuildContext context) {
    final phone = MediaQuery.sizeOf(context).width <= 650;
    return DefaultTextStyle(
      style: scheduleText(context, size: 13),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SafeArea(
            bottom: false,
            child: Padding(
              padding: EdgeInsets.only(left: phone ? 16 : 20, right: 20),
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 56),
                child: Row(
                  children: [
                    if (widget.sidebarCollapsed && !phone) ...[
                      WebIconButton(
                        LucideIcons.panelLeftOpen,
                        'Show sidebar',
                        onPressed: widget.onExpand,
                        iconSize: 19,
                      ),
                      const SizedBox(width: 10),
                    ],
                    Icon(
                      LucideIcons.calendarClock,
                      size: 18,
                      color: palette(context)['text.muted'],
                    ),
                    const SizedBox(width: 10),
                    Text(
                      'Schedules',
                      style: scheduleText(
                        context,
                        size: 15,
                        weight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          Expanded(
            child: SingleChildScrollView(
              child: Align(
                alignment: Alignment.topCenter,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 780),
                  child: Padding(
                    padding: EdgeInsets.fromLTRB(
                      phone ? 14 : 32,
                      phone ? 4 : 8,
                      phone ? 14 : 32,
                      phone ? 72 + MediaQuery.paddingOf(context).bottom : 48,
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Text(
                          'SCHEDULES',
                          style: scheduleText(
                            context,
                            size: 12,
                            weight: FontWeight.w600,
                            color: 'text.secondary',
                          ).copyWith(letterSpacing: .24),
                        ),
                        const SizedBox(height: 13),
                        text(scheduleExplanation),
                        if (state.loading)
                          const WebNotice('Loading schedules…')
                        else ...[
                          if (state.error != null && editing == null)
                            WebNotice(state.error!, error: true),
                          if (editing != null)
                            ScheduleForm(
                              key: ValueKey('$epoch:$editorKey'),
                              state: state,
                              existing: existing,
                              onCancel: () => setState(() => editing = null),
                              onSaved: () => setState(() => editing = null),
                            )
                          else
                            Padding(
                              padding: const EdgeInsets.symmetric(vertical: 12),
                              child: Align(
                                alignment: Alignment.centerRight,
                                child: button(
                                  'New schedule',
                                  state.busy == null ? () => edit(null) : null,
                                  primary: true,
                                ),
                              ),
                            ),
                          if (state.schedules.isEmpty && editing == null)
                            text(
                              'No schedules yet. Make one here, or ask your assistant: it asks you before it adds one.',
                            ),
                          for (final s in state.schedules)
                            Padding(
                              padding: const EdgeInsets.only(bottom: 6),
                              child: card(s),
                            ),
                        ],
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget row(Widget content, List<Widget> actions) => actions.isEmpty
      ? content
      : _ScheduleRow(
          children: [
            content,
            Wrap(spacing: 6, runSpacing: 6, children: actions),
          ],
        );
  Widget card(Json s) {
    final id = '${s['id']}',
        base = '/api/schedules/${enc(id)}',
        online = obj(s['workspace'])['online'] == true,
        ready = state.busy == null;
    final attention = (s['attention'] as num? ?? 0).toInt();
    return Container(
      key: ValueKey('schedule-$id'),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: palette(context)['surface.subtle'],
        borderRadius: BorderRadius.circular(6),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          row(
            Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              spacing: 2,
              children: [
                Wrap(
                  spacing: 6,
                  runSpacing: 2,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    text(
                      '${s['title']}',
                      color: s['status'] == 'active'
                          ? 'text.primary'
                          : 'text.muted',
                      weight: FontWeight.w700,
                    ),
                    if (s['status'] == 'paused') badge('Paused'),
                    if (s['status'] == 'done') badge('Done'),
                    if (attention > 0)
                      badge('$attention waiting for you', attention: true),
                  ],
                ),
                text(state.when(s), small: true),
                text(state.where(s), small: true),
                text(state.status(s), small: true),
              ],
            ),
            [
              Semantics(
                expanded: state.expanded == id,
                child: button('Runs', () => state.toggle(id)),
              ),
              Tooltip(
                message: online
                    ? ''
                    : '${obj(s['workspace'])['node']} is offline',
                child: button(
                  'Run now',
                  ready && online
                      ? () => state.mutate(id, '$base/run', body: {})
                      : null,
                ),
              ),
              if (s['status'] == 'active')
                button(
                  'Pause',
                  ready
                      ? () => state.mutate(
                          id,
                          base,
                          method: 'PATCH',
                          body: {'status': 'paused'},
                        )
                      : null,
                ),
              if (s['status'] == 'paused')
                button(
                  'Resume',
                  ready
                      ? () => state.mutate(
                          id,
                          base,
                          method: 'PATCH',
                          body: {'status': 'active'},
                        )
                      : null,
                ),
              button('Edit', ready ? () => edit(s) : null),
              if (state.confirming == id) ...[
                button(
                  'Delete for good',
                  ready ? () => state.mutate(id, base, method: 'DELETE') : null,
                  danger: true,
                ),
                button('Cancel', () => setState(() => state.confirming = null)),
              ] else
                button(
                  'Delete',
                  ready ? () => setState(() => state.confirming = id) : null,
                ),
            ],
          ),
          if (state.expanded == id) ...[
            const SizedBox(height: 8),
            Semantics(
              expanded: prompts.contains(id),
              child: InkWell(
                onTap: () => setState(
                  () => prompts.contains(id)
                      ? prompts.remove(id)
                      : prompts.add(id),
                ),
                child: Row(
                  children: [
                    Icon(
                      prompts.contains(id)
                          ? LucideIcons.chevronDown
                          : LucideIcons.chevronRight,
                      size: 13,
                      color: palette(context)['text.secondary'],
                    ),
                    const SizedBox(width: 4),
                    text('Prompt', color: 'text.secondary'),
                  ],
                ),
              ),
            ),
            if (prompts.contains(id))
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: SelectableText(
                  '${s['prompt']}',
                  style: scheduleText(
                    context,
                    size: 13,
                    color: 'text.secondary',
                  ),
                ),
              ),
            if (state.runsError != null)
              WebNotice(state.runsError!, error: true)
            else if (state.runsLoading && state.runs.isEmpty)
              const WebNotice('Loading runs…')
            else if (state.runs.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: text('No runs yet.', small: true),
              )
            else
              Container(
                margin: const EdgeInsets.only(top: 8),
                padding: const EdgeInsets.only(top: 8),
                decoration: BoxDecoration(
                  border: Border(
                    top: BorderSide(color: palette(context)['web.line']),
                  ),
                ),
                child: Column(
                  spacing: 6,
                  children: [for (final run in state.runs) runRow(s, run)],
                ),
              ),
          ],
        ],
      ),
    );
  }

  Widget runRow(Json s, Json run) {
    final id = '${s['id']}',
        base = '/api/schedules/${enc(id)}',
        ready = state.busy == null;
    final color = switch (run['status']) {
      'completed' => 'status.success',
      'failed' => 'status.danger',
      'missed' || 'waiting_input' => 'accent.default',
      'skipped' || 'dismissed' => 'text.muted',
      _ => 'text.primary',
    };
    return row(
      Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Wrap(
            spacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              text(
                scheduleRunLabels[run['status']] ?? '${run['status']}',
                color: color,
                weight: FontWeight.w600,
              ),
              text(
                'due ${state.wall(run['dueAt'], '${s['timezone']}')} · ${scheduleAgo((run['createdAt'] as num?) ?? 0, state.clock().millisecondsSinceEpoch)}',
                small: true,
              ),
            ],
          ),
          if (run['result'] != null && '${run['result']}'.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 160),
                child: SingleChildScrollView(
                  child: SelectableText(
                    '${run['result']}',
                    style: scheduleText(
                      context,
                      size: 13,
                      color: 'text.secondary',
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
      [
        if (run['status'] == 'missed') ...[
          button(
            'Allow and run now',
            ready && obj(s['workspace'])['online'] == true
                ? () => state.mutate(
                    '${run['id']}',
                    '$base/run',
                    body: {'runId': run['id']},
                  )
                : null,
            primary: true,
          ),
          button(
            'Dismiss',
            ready
                ? () => state.mutate(
                    '${run['id']}',
                    '$base/runs/${enc('${run['id']}')}/dismiss',
                  )
                : null,
          ),
        ],
        if (run['sessionId'] != null && run['session'] != null)
          button(
            'Open session',
            () => widget.onOpenChat?.call('${run['sessionId']}'),
          ),
      ],
    );
  }
}

class ScheduleForm extends StatefulWidget {
  const ScheduleForm({
    super.key,
    required this.state,
    required this.onCancel,
    required this.onSaved,
    this.existing,
  });
  final SchedulesState state;
  final Json? existing;
  final VoidCallback onCancel, onSaved;
  @override
  State<ScheduleForm> createState() => _ScheduleFormState();
}

class _ScheduleFormState extends State<ScheduleForm> {
  late final title = TextEditingController(
    text: '${widget.existing?['title'] ?? ''}',
  );
  late final prompt = TextEditingController(
    text: '${widget.existing?['prompt'] ?? ''}',
  );
  late final cron = TextEditingController(
    text: '${widget.existing?['cron'] ?? '0 9 * * *'}',
  );
  late final zone = TextEditingController(
    text: '${widget.existing?['timezone'] ?? s.deviceZone}',
  );
  final at = TextEditingController(),
      zoneFocus = FocusNode(),
      timeFocus = FocusNode();
  late bool once = widget.existing != null && widget.existing!['cron'] == null;
  late String workspace =
      '${widget.existing?['workspaceId'] ?? defaultWorkspace()}';
  late String model = obj(widget.existing?['model']).isEmpty
      ? ''
      : scheduleModelKey(obj(widget.existing?['model']));
  late String thinking = '${widget.existing?['thinking'] ?? ''}',
      notify = '${widget.existing?['notify'] ?? 'all'}';
  String? error;
  bool wallLoading = true, pickerOpen = false;
  SchedulesState get s => widget.state;
  String defaultWorkspace() {
    final active = obj(s.controller.state['session'])['workspaceId'];
    return '${s.workspaces.where((w) => w['id'] == active).firstOrNull?['id'] ?? s.workspaces.firstOrNull?['id'] ?? ''}';
  }

  @override
  void initState() {
    super.initState();
    initTime();
  }

  Future<void> initTime() async {
    try {
      final value = await s.gateway.call('wallInput', {
        'at':
            widget.existing?['runAt'] ??
            s.clock().millisecondsSinceEpoch + 3600000,
        'timezone': zone.text,
      });
      if (mounted && at.text.isEmpty && value is String) {
        setState(() => at.text = value);
      }
    } catch (e) {
      if (mounted) setState(() => error = LiveController.describe(e));
    } finally {
      if (mounted) setState(() => wallLoading = false);
    }
  }

  Future<void> chooseTime() async {
    if (pickerOpen || wallLoading) return;
    final origin = s.controller.origin, epoch = s.epoch;
    setState(() => pickerOpen = true);
    try {
      var initial = scheduleWallTime(at.text);
      initial ??=
          await s.gateway.call('wallInput', {
                'at': s.clock().millisecondsSinceEpoch,
                'timezone': s.deviceZone,
              })
              as String?;
      if (!mounted || origin != s.controller.origin || epoch != s.epoch) return;
      if (initial == null || scheduleWallTime(initial) == null) {
        setState(
          () => error = 'Unable to initialize the date and time picker.',
        );
        return;
      }
      FocusScope.of(context).unfocus();
      final result = await showScheduleDateTimePicker(context, initial);
      if (!mounted ||
          origin != s.controller.origin ||
          epoch != s.epoch ||
          result == null) {
        return;
      }
      setState(() {
        at.text = result;
        error = null;
      });
    } catch (e) {
      if (mounted && origin == s.controller.origin && epoch == s.epoch) {
        setState(() => error = LiveController.describe(e));
      }
    } finally {
      if (mounted) setState(() => pickerOpen = false);
    }
  }

  @override
  void dispose() {
    for (final c in [title, prompt, cron, zone, at]) {
      c.dispose();
    }
    zoneFocus.dispose();
    timeFocus.dispose();
    super.dispose();
  }

  Future<void> save() async {
    if (s.busy != null || once && wallLoading) return;
    if (workspace.isEmpty ||
        prompt.text.isEmpty ||
        zone.text.trim().isEmpty ||
        (once ? at.text : cron.text).isEmpty) {
      setState(
        () => error = 'Fill in the workspace, prompt, time and time zone.',
      );
      return;
    }
    final wallTime = once ? scheduleWallTime(at.text) : null;
    if (once && wallTime == null) {
      setState(() => error = 'Enter a valid date and time (YYYY-MM-DDTHH:mm).');
      timeFocus.requestFocus();
      final fieldContext = timeFocus.context;
      if (fieldContext != null) Scrollable.ensureVisible(fieldContext);
      return;
    }
    final chosen = s.models
        .where((m) => m['available'] == true && scheduleModelKey(m) == model)
        .firstOrNull;
    final body = <String, dynamic>{
      'workspaceId': workspace,
      'title': title.text.trim(),
      'prompt': prompt.text,
      'timezone': zone.text.trim(),
      'model': model.isEmpty
          ? null
          : chosen == null
          ? (widget.existing?['model'])
          : {'provider': chosen['provider'], 'id': chosen['id']},
      'thinking': thinking.isEmpty ? null : thinking,
      'notify': notify,
      if (once) 'at': wallTime else 'cron': cron.text.trim(),
    };
    setState(() => error = null);
    final ok = await s.mutate(
      'save',
      '/api/schedules${widget.existing == null ? '' : '/${enc('${widget.existing!['id']}')}'}',
      method: widget.existing == null ? 'POST' : 'PATCH',
      body: body,
    );
    if (!mounted) return;
    if (ok) {
      widget.onSaved();
    } else {
      setState(() => error = s.error);
    }
  }

  InputDecoration decoration({String? hint}) => InputDecoration(
    hintText: hint,
    hintStyle: scheduleText(context, size: 16, color: 'text.muted'),
    isDense: true,
    filled: true,
    fillColor: palette(context)['surface.subtle'],
    contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
    border: OutlineInputBorder(
      borderRadius: BorderRadius.circular(10),
      borderSide: BorderSide.none,
    ),
    enabledBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(10),
      borderSide: BorderSide.none,
    ),
    focusedBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(10),
      borderSide: BorderSide(color: palette(context)['accent.default']),
    ),
  );
  Widget label(String name, Widget child) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          name,
          style: scheduleText(
            context,
            size: 13,
            weight: FontWeight.w500,
            color: 'text.secondary',
          ),
        ),
        const SizedBox(height: 6),
        child,
      ],
    ),
  );
  Widget field(
    String name,
    TextEditingController c, {
    String? hint,
    int lines = 1,
    int? maxLength,
    bool mono = false,
  }) => label(
    name,
    Focus(
      canRequestFocus: false,
      onKeyEvent: (_, event) {
        if (lines != 1 ||
            event is! KeyDownEvent ||
            (event.logicalKey != LogicalKeyboardKey.enter &&
                event.logicalKey != LogicalKeyboardKey.numpadEnter) ||
            !c.value.composing.isCollapsed) {
          return KeyEventResult.ignored;
        }
        save();
        return KeyEventResult.handled;
      },
      child: TextField(
        key: ValueKey('schedule-field-$name'),
        controller: c,
        focusNode: c == at ? timeFocus : null,
        textInputAction: lines == 1
            ? TextInputAction.done
            : TextInputAction.newline,
        onSubmitted: lines == 1
            ? (_) {
                if (c.value.composing.isCollapsed) save();
              }
            : null,
        onChanged: c == cron ? (_) => setState(() {}) : null,
        minLines: lines,
        maxLines: lines == 1 ? 1 : null,
        inputFormatters: [if (maxLength != null) WebLengthFormatter(maxLength)],
        style: scheduleText(
          context,
          size: 16,
          color: 'text.secondary',
        ).copyWith(fontFamily: mono ? 'monospace' : null),
        decoration: decoration(hint: hint).copyWith(
          counterText: '',
          suffixIcon: c == at
              ? IconButton(
                  key: const ValueKey('schedule-open-time-picker'),
                  tooltip: 'Choose date and time',
                  onPressed: wallLoading || pickerOpen ? null : chooseTime,
                  icon: const Icon(LucideIcons.chevronDown, size: 18),
                )
              : null,
        ),
      ),
    ),
  );
  Widget select(
    String name,
    String value,
    Map<String, String> options,
    ValueChanged<String> changed,
  ) => label(
    name,
    InputDecorator(
      decoration: decoration().copyWith(
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      ),
      child: DropdownButtonHideUnderline(
        child: DropdownButton<String>(
          key: ValueKey('schedule-select-$name'),
          value: options.containsKey(value) ? value : null,
          isExpanded: true,
          isDense: true,
          style: scheduleText(context, size: 16, color: 'text.secondary'),
          borderRadius: BorderRadius.circular(10),
          items: [
            for (final e in options.entries)
              DropdownMenuItem(
                value: e.key,
                child: Text(e.value, overflow: TextOverflow.ellipsis),
              ),
          ],
          onChanged: (v) {
            if (v != null) setState(() => changed(v));
          },
        ),
      ),
    ),
  );
  Widget radio(String name, bool selected, VoidCallback choose) => Semantics(
    checked: selected,
    inMutuallyExclusiveGroup: true,
    child: InkWell(
      onTap: choose,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 16,
            height: 16,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Border.all(
                color: palette(
                  context,
                )[selected ? 'accent.default' : 'text.muted'],
                width: selected ? 4 : 1,
              ),
            ),
          ),
          const SizedBox(width: 6),
          Text(
            name,
            style: scheduleText(
              context,
              size: 13,
              weight: FontWeight.w500,
              color: 'text.secondary',
            ),
          ),
        ],
      ),
    ),
  );
  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.symmetric(vertical: 12),
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      border: Border.all(color: palette(context)['web.line']),
      borderRadius: BorderRadius.circular(6),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          widget.existing == null ? 'New schedule' : 'Edit schedule',
          style: scheduleText(context, size: 13, weight: FontWeight.w600),
        ),
        const SizedBox(height: 12),
        select('Workspace', workspace, {
          for (final w in s.workspaces)
            '${w['id']}': '${w['displayName']} · ${w['hostId']}',
        }, (v) => workspace = v),
        field(
          'Title',
          title,
          maxLength: 80,
          hint: 'Named after the first line of the prompt',
        ),
        field(
          'Prompt',
          prompt,
          lines: 5,
          hint:
              'What the agent should do. Each run starts fresh with only this.',
        ),
        label(
          'When',
          Wrap(
            spacing: 16,
            children: [
              radio('Repeat', !once, () => setState(() => once = false)),
              radio('Once', once, () => setState(() => once = true)),
            ],
          ),
        ),
        if (once)
          field('Time', at, hint: 'YYYY-MM-DDTHH:mm')
        else ...[
          field('Cron (minute hour day month weekday)', cron, mono: true),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (final e in schedulePresets.entries)
                Semantics(
                  selected: cron.text.trim() == e.key,
                  child: TextButton(
                    style: TextButton.styleFrom(
                      minimumSize: const Size(0, 32),
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      shape: const StadiumBorder(),
                      textStyle: scheduleText(
                        context,
                        size: 13,
                        weight: FontWeight.w500,
                      ),
                      foregroundColor:
                          palette(context)[cron.text.trim() == e.key
                              ? 'accent.default'
                              : 'text.primary'],
                    ),
                    onPressed: () => setState(() => cron.text = e.key),
                    child: Text(e.value),
                  ),
                ),
            ],
          ),
        ],
        if (!once) const SizedBox(height: 12),
        label(
          'Time zone',
          KeyboardSuggestions(
            controller: zone,
            focusNode: zoneFocus,
            options: s.zones,
            builder: (context, keyboardVisible) => RawAutocomplete<String>(
              textEditingController: zone,
              focusNode: zoneFocus,
              optionsBuilder: (v) => s.zones.where(
                (z) => z.toLowerCase().contains(v.text.toLowerCase()),
              ),
              fieldViewBuilder: (context, c, f, _) => Focus(
                canRequestFocus: false,
                onKeyEvent: (_, event) {
                  if (event is KeyDownEvent &&
                      (event.logicalKey == LogicalKeyboardKey.enter ||
                          event.logicalKey == LogicalKeyboardKey.numpadEnter) &&
                      c.value.composing.isCollapsed) {
                    save();
                    return KeyEventResult.handled;
                  }
                  return KeyEventResult.ignored;
                },
                child: TextField(
                  key: const ValueKey('schedule-field-Time zone'),
                  controller: c,
                  focusNode: f,
                  style: scheduleText(
                    context,
                    size: 16,
                    color: 'text.secondary',
                  ),
                  decoration: decoration(),
                  autocorrect: false,
                  spellCheckConfiguration:
                      const SpellCheckConfiguration.disabled(),
                  textInputAction: TextInputAction.done,
                  onSubmitted: (_) {
                    if (!c.value.composing.isCollapsed) return;
                    save();
                  },
                ),
              ),
              optionsViewBuilder: (context, onSelect, options) =>
                  keyboardVisible
                  ? const SizedBox.shrink()
                  : Align(
                      alignment: Alignment.topLeft,
                      child: Material(
                        color: palette(context)['surface.page'],
                        elevation: 4,
                        borderRadius: BorderRadius.circular(10),
                        child: SizedBox(
                          width: 260,
                          child: ConstrainedBox(
                            constraints: const BoxConstraints(maxHeight: 200),
                            child: ListView(
                              shrinkWrap: true,
                              padding: const EdgeInsets.all(4),
                              children: [
                                for (final option in options)
                                  InkWell(
                                    onTap: () => onSelect(option),
                                    child: Padding(
                                      padding: const EdgeInsets.all(8),
                                      child: Text(
                                        option,
                                        style: scheduleText(context, size: 14),
                                      ),
                                    ),
                                  ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
            ),
          ),
        ),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              flex: 2,
              child: select('Model', model, {
                '': 'Workspace default',
                for (final m in s.models.where((m) => m['available'] == true))
                  scheduleModelKey(
                    m,
                  ): '${m['displayName'] ?? m['name'] ?? m['id']} · ${m['provider']}',
                if (model.isNotEmpty &&
                    !s.models.any(
                      (m) =>
                          m['available'] == true &&
                          scheduleModelKey(m) == model,
                    ))
                  model:
                      '${obj(widget.existing?['model'])['provider']} / ${obj(widget.existing?['model'])['id']}',
              }, (v) => model = v),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: select('Thinking', thinking, {
                '': 'Default',
                for (final level in [
                  'off',
                  'minimal',
                  'low',
                  'medium',
                  'high',
                  'xhigh',
                  'max',
                ])
                  level: level,
              }, (v) => thinking = v),
            ),
          ],
        ),
        select(
          'Notifications',
          notify,
          scheduleNotifyLabels,
          (v) => notify = v,
        ),
        if (error != null) WebNotice(error!, error: true),
        Padding(
          padding: const EdgeInsets.only(top: 12),
          child: Wrap(
            spacing: 8,
            alignment: WrapAlignment.end,
            children: [
              WebButton(
                'Cancel',
                height: 32,
                fontSize: 13,
                horizontalPadding: 12,
                onPressed: widget.onCancel,
              ),
              WebButton(
                widget.existing == null ? 'Create' : 'Save',
                height: 32,
                fontSize: 13,
                horizontalPadding: 12,
                primary: true,
                onPressed:
                    s.busy == null &&
                        workspace.isNotEmpty &&
                        (!once || !wallLoading)
                    ? save
                    : null,
              ),
            ],
          ),
        ),
      ],
    ),
  );
}

/// Legacy activity links open the same schedule page with its run history focused.
class ScheduleDetailPage extends StatelessWidget {
  const ScheduleDetailPage({
    super.key,
    required this.controller,
    required this.id,
  });
  final LiveController controller;
  final String id;
  @override
  Widget build(BuildContext context) => Scaffold(
    body: SchedulesPage(
      controller: controller,
      focusId: id,
      onOpenChat: (session) async {
        await controller.open(session);
        if (context.mounted) Navigator.of(context).popUntil((r) => r.isFirst);
      },
    ),
  );
}

// Mirrors .schedule-row flex wrapping: a 240px text basis, intrinsic action
// group, 12px horizontal gap and 8px gap when the group wraps below.
class _ScheduleRow extends MultiChildRenderObjectWidget {
  const _ScheduleRow({required super.children});
  @override
  RenderObject createRenderObject(BuildContext context) => _RenderScheduleRow();
}

class _ScheduleRowParentData extends ContainerBoxParentData<RenderBox> {}

class _RenderScheduleRow extends RenderBox
    with
        ContainerRenderObjectMixin<
          RenderBox,
          ContainerBoxParentData<RenderBox>
        >,
        RenderBoxContainerDefaultsMixin<
          RenderBox,
          ContainerBoxParentData<RenderBox>
        > {
  @override
  void setupParentData(RenderBox child) {
    if (child.parentData is! ContainerBoxParentData<RenderBox>) {
      child.parentData = _ScheduleRowParentData();
    }
  }

  ({Size text, Size actions, bool inline}) sizes(
    BoxConstraints c, {
    required bool dry,
  }) {
    final text = firstChild!, actions = lastChild!;
    final width = c.maxWidth;
    final spacing = actions is RenderWrap
        ? actions.spacing * (actions.childCount - 1)
        : 0.0;
    final actionWidth =
        (actions.getMaxIntrinsicWidth(double.infinity) + spacing).clamp(
          0.0,
          width,
        );
    final inline = 240 + 12 + actionWidth <= width;
    final tc = BoxConstraints.tightFor(
      width: inline ? width - actionWidth - 12 : width,
    );
    final ac = BoxConstraints(maxWidth: inline ? actionWidth : width);
    if (dry) {
      return (
        text: text.getDryLayout(tc),
        actions: actions.getDryLayout(ac),
        inline: inline,
      );
    }
    text.layout(tc, parentUsesSize: true);
    actions.layout(ac, parentUsesSize: true);
    return (text: text.size, actions: actions.size, inline: inline);
  }

  @override
  Size computeDryLayout(BoxConstraints c) {
    final s = sizes(c, dry: true);
    return c.constrain(
      Size(
        c.maxWidth,
        s.inline
            ? (s.text.height > s.actions.height
                  ? s.text.height
                  : s.actions.height)
            : s.text.height + 8 + s.actions.height,
      ),
    );
  }

  @override
  void performLayout() {
    final s = sizes(constraints, dry: false);
    size = constraints.constrain(
      Size(
        constraints.maxWidth,
        s.inline
            ? (s.text.height > s.actions.height
                  ? s.text.height
                  : s.actions.height)
            : s.text.height + 8 + s.actions.height,
      ),
    );
    (firstChild!.parentData! as ContainerBoxParentData<RenderBox>).offset =
        Offset.zero;
    (lastChild!.parentData! as ContainerBoxParentData<RenderBox>).offset =
        s.inline ? Offset(s.text.width + 12, 0) : Offset(0, s.text.height + 8);
  }

  @override
  void paint(PaintingContext context, Offset offset) =>
      defaultPaint(context, offset);
  @override
  bool hitTestChildren(BoxHitTestResult result, {required Offset position}) =>
      defaultHitTestChildren(result, position: position);
}
