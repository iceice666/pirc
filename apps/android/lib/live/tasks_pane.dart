import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'gateway.dart';
import 'common.dart';
import 'web_controls.dart';
import 'tasks_state.dart';
import 'jobs_menu.dart' show jobDuration;
import 'timeline_models.dart' show instant;

class PanelChip extends StatelessWidget {
  const PanelChip(this.label, {super.key, this.status, this.tooltip});
  final String label;
  final String? status, tooltip;
  @override
  Widget build(BuildContext context) {
    final p = palette(context);
    final active = [
          'running',
          'in_progress',
          'active',
          'busy',
        ].contains(status),
        done = ['completed', 'done', 'idle'].contains(status),
        failed = ['failed', 'timed_out', 'error'].contains(status);
    final child = Container(
      height: math.max(20, MediaQuery.textScalerOf(context).scale(11) + 6),
      padding: const EdgeInsets.symmetric(horizontal: 7),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(999),
        color: active
            ? p['accent.soft']
            : done
            ? p['status.success'].withValues(alpha: .12)
            : failed
            ? p['status.dangerSoft']
            : p['web.bg-hover'],
      ),
      child: Center(
        widthFactor: 1,
        child: Text(
          label,
          maxLines: 1,
          style: webText(
            context,
            size: 11,
            weight: FontWeight.w500,
            color: active
                ? 'accent.default'
                : done
                ? 'status.success'
                : failed
                ? 'status.danger'
                : 'text.secondary',
          ).copyWith(height: 13 / 11),
        ),
      ),
    );
    return tooltip == null ? child : Tooltip(message: tooltip!, child: child);
  }
}

class TasksPane extends StatefulWidget {
  const TasksPane({super.key, required this.controller, this.clock});
  final LiveController controller;
  final DateTime Function()? clock;
  @override
  State<TasksPane> createState() => _TasksPaneState();
}

class _TasksPaneState extends State<TasksPane> {
  late final state = TasksState(widget.controller);
  final outputScroll = ScrollController();
  int outputRevision = 0;
  @override
  void initState() {
    super.initState();
    state.addListener(changed);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    state.setActive(TickerMode.valuesOf(context).enabled);
  }

  void changed() {
    if (state.outputRevision == outputRevision) return;
    outputRevision = state.outputRevision;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && outputScroll.hasClients) {
        outputScroll.jumpTo(outputScroll.position.maxScrollExtent);
      }
    });
  }

  @override
  void dispose() {
    state.removeListener(changed);
    state.dispose();
    outputScroll.dispose();
    super.dispose();
  }

  TextStyle mono(
    double size, {
    String color = 'text.primary',
    FontWeight weight = FontWeight.w400,
    bool cssNormalLineHeight = false,
  }) => webText(context, size: size, color: color, weight: weight).copyWith(
    fontFamily: 'monospace',
    height: cssNormalLineHeight ? kTextHeightNone : 14 / 12,
  );
  Widget empty(String text) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 4),
    child: Text(
      text,
      style: webText(
        context,
        size: 13,
        color: 'text.muted',
      ).copyWith(height: 1.5),
    ),
  );
  Widget error(String text) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
    decoration: BoxDecoration(
      color: palette(context)['status.dangerSoft'],
      borderRadius: BorderRadius.circular(8),
    ),
    child: Text(
      text,
      style: webText(
        context,
        size: 12.5,
        color: 'status.danger',
      ).copyWith(height: 1.45),
    ),
  );
  Widget group(String name, [int? count]) {
    // panel.css uses .02em tracking; it follows the CSS-scaled font size.
    final tracking = MediaQuery.textScalerOf(context).scale(11.5) * .02;
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Row(
        children: [
          Expanded(
            child: Text(
              name.toUpperCase(),
              style: webText(
                context,
                size: 11.5,
                weight: FontWeight.w600,
                color: 'text.muted',
              ).copyWith(height: kTextHeightNone, letterSpacing: tracking),
            ),
          ),
          if (count != null)
            Text(
              '$count',
              style: webText(
                context,
                size: 11.5,
                weight: FontWeight.w500,
                color: 'text.muted',
              ).copyWith(height: kTextHeightNone, letterSpacing: tracking),
            ),
        ],
      ),
    );
  }

  String normalText(String text) =>
      text.replaceAll(RegExp(r'[ \t\r\n\f]+'), ' ').trim();

  Widget sub(String text, {bool danger = false, bool clamped = false}) => Text(
    normalText(text),
    maxLines: clamped ? 2 : null,
    overflow: clamped ? TextOverflow.ellipsis : null,
    style: webText(
      context,
      size: 11.5,
      color: danger ? 'status.danger' : 'text.muted',
    ).copyWith(height: kTextHeightNone),
  );
  Widget title(String text, [String? secondary]) => Text.rich(
    TextSpan(
      text: normalText(text),
      children: [
        if (secondary != null)
          TextSpan(
            text: secondary,
            style: mono(12, color: 'text.muted'),
          ),
      ],
    ),
    style: mono(12),
    maxLines: 1,
    overflow: TextOverflow.ellipsis,
  );
  double chipWidth(String label) {
    final p = TextPainter(
      text: TextSpan(
        text: label,
        style: webText(context, size: 11, weight: FontWeight.w500),
      ),
      textDirection: TextDirection.ltr,
      textScaler: MediaQuery.textScalerOf(context),
    )..layout();
    final w = p.width + 14;
    p.dispose();
    return w;
  }

  Widget row(
    IconData icon,
    List<Widget> lines,
    List<(String, String?, String?)> chips, {
    VoidCallback? onTap,
  }) {
    final badgeWidth = chips.fold(0.0, (a, c) => a + chipWidth(c.$1) + 8);
    return LayoutBuilder(
      builder: (context, b) {
        final minWidth = 16 + 15 + 8 + badgeWidth + 35;
        Widget content(double width) => SizedBox(
          width: width,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            child: Row(
              crossAxisAlignment: onTap == null
                  ? CrossAxisAlignment.start
                  : CrossAxisAlignment.center,
              children: [
                Icon(icon, size: 15, color: palette(context)['text.muted']),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      for (final (i, l) in lines.indexed) ...[
                        if (i > 0) const SizedBox(height: 2),
                        l,
                      ],
                    ],
                  ),
                ),
                for (final c in chips) ...[
                  const SizedBox(width: 8),
                  PanelChip(c.$1, status: c.$2, tooltip: c.$3),
                ],
              ],
            ),
          ),
        );
        final child = minWidth > b.maxWidth
            ? SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: content(minWidth),
              )
            : content(b.maxWidth);
        return onTap == null
            ? child
            : InkWell(
                onTap: onTap,
                borderRadius: BorderRadius.circular(8),
                hoverColor: palette(context)['web.bg-hover'],
                child: child,
              );
      },
    );
  }

  Widget list(List<Widget> children) => Column(
    children: [
      for (final (i, w) in children.indexed) ...[
        if (i > 0) const SizedBox(height: 1),
        w,
      ],
    ],
  );
  Widget agent(Json a, bool subagent) => row(
    subagent ? LucideIcons.bot : LucideIcons.users,
    [
      title(
        '${a['name']}',
        '${subagent ? ' · ${a['kind'] ?? 'general'}${a['background'] == true ? ' · background' : ''}' : ''}${a['model'] == null ? '' : ' · ${a['model']}'}',
      ),
      if (a['task'] != null && a['task'] != '')
        sub('${a['task']}', clamped: true),
      if (a['lastError'] != null && a['lastError'] != '')
        sub('${a['lastError']}', danger: true),
    ],
    [('${a['status'] ?? 'unknown'}', a['status'] as String?, null)],
  );
  Widget pre(String text, {bool output = false}) {
    final style = mono(12, color: 'code.text').copyWith(height: 1.5);
    Widget child = SelectableText(text, style: style);
    if (output) {
      final p = TextPainter(
        text: TextSpan(text: text, style: style),
        textDirection: TextDirection.ltr,
        textScaler: MediaQuery.textScalerOf(context),
      )..layout();
      final width = p.width;
      p.dispose();
      // CSS pre does not allocate an extra visible line for the final LF.
      // Keep the complete text in the selection/copy model.
      final lines = text.replaceFirst(RegExp(r'\n$'), '').split('\n').length;
      final height = lines * MediaQuery.textScalerOf(context).scale(12) * 1.5;
      child = LayoutBuilder(
        builder: (context, b) => SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: SizedBox(
            width: math.max(width + 1, b.maxWidth),
            height: height,
            child: ClipRect(
              child: OverflowBox(
                alignment: Alignment.topLeft,
                minHeight: 0,
                maxHeight: double.infinity,
                child: SelectableText(text, style: style),
              ),
            ),
          ),
        ),
      );
    }
    return Container(
      decoration: BoxDecoration(
        color: palette(context)['code.bg'],
        borderRadius: BorderRadius.circular(12),
        boxShadow: [
          BoxShadow(color: palette(context)['web.line'], spreadRadius: 1),
        ],
      ),
      clipBehavior: Clip.antiAlias,
      child: ConstrainedBox(
        constraints: output
            ? BoxConstraints(
                maxHeight: math.max(
                  40,
                  MediaQuery.sizeOf(context).height - 260,
                ),
              )
            : const BoxConstraints(),
        child: SingleChildScrollView(
          controller: output ? outputScroll : null,
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          child: child,
        ),
      ),
    );
  }

  String time(dynamic value) {
    final d = instant(value)?.toLocal();
    if (d == null) return '';
    return '${d.hour % 12 == 0 ? 12 : d.hour % 12}:${d.minute.toString().padLeft(2, '0')}:${d.second.toString().padLeft(2, '0')} ${d.hour < 12 ? 'AM' : 'PM'}';
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: state,
    builder: (context, _) {
      final selected = state.selected, data = state.data;
      final now = widget.clock?.call() ?? DateTime.now();
      final children = <Widget>[
        if (selected != null) ...[
          Row(
            children: [
              WebIconButton(
                LucideIcons.arrowLeft,
                'Back',
                iconSize: 16,
                onPressed: state.back,
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  '${selected['id']}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: mono(13, weight: FontWeight.w600),
                ),
              ),
              const SizedBox(width: 6),
              PanelChip(
                '${selected['status']}'.replaceFirst('_', ' '),
                status: selected['status'] as String?,
              ),
              const SizedBox(width: 6),
              WebIconButton(
                LucideIcons.refreshCw,
                'Refresh output',
                onPressed: state.outputLoading ? null : state.refreshOutput,
              ),
            ],
          ),
          pre('${selected['command']}'),
          if (state.outputError != null) error(state.outputError!),
          pre(
            state.output.isEmpty ? 'No output yet.' : state.output,
            output: true,
          ),
        ] else if (widget.controller.panelData.error != null && data == null)
          error(widget.controller.panelData.error!)
        else if (data == null)
          empty('Loading…')
        else if (data['agentRunning'] != true &&
            state.tasks.isEmpty &&
            state.agents.isEmpty)
          empty(
            'The agent is not running. Background tasks, subagents and teammates appear here while it is.',
          )
        else ...[
          group('Background tasks', state.tasks.length),
          if (state.tasks.isEmpty)
            empty('No background tasks.')
          else
            list([
              for (final task in state.tasks)
                row(
                  LucideIcons.squareTerminal,
                  [
                    title('${task['command']}'),
                    Wrap(
                      spacing: 4,
                      runSpacing: 4,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        Text(
                          '${task['id']}',
                          style: mono(
                            11.5,
                            color: 'text.muted',
                            cssNormalLineHeight: true,
                          ),
                        ),
                        Text(
                          '· ${jobDuration(task, now)}'
                          '${task['exitCode'] == null ? '' : ' · exit ${task['exitCode']}'}',
                          style: webText(
                            context,
                            size: 11.5,
                            color: 'text.muted',
                          ).copyWith(height: kTextHeightNone),
                        ),
                      ],
                    ),
                  ],
                  [
                    if (task['tty'] == true) ('tty', null, null),
                    if (task['notifyOn'] != null && task['notifyOn'] != '')
                      (
                        'watch ${task['matches'] ?? 0}',
                        null,
                        'notify_on /${task['notifyOn']}/',
                      ),
                    (
                      '${task['status']}'.replaceFirst('_', ' '),
                      task['status'] as String?,
                      null,
                    ),
                  ],
                  onTap: () => state.open(task),
                ),
            ]),
          if (state.subagents.isNotEmpty) ...[
            group('Subagents', state.subagents.length),
            list([for (final a in state.subagents) agent(a, true)]),
          ],
          if (state.board.isNotEmpty) ...[
            group('Task board', state.board.length),
            list([
              for (final task in state.board)
                row(
                  LucideIcons.listChecks,
                  [
                    title('#${task['id']} ${task['subject']}'),
                    sub(
                      '${task['owner'] == null || task['owner'] == '' ? 'unowned' : 'owner ${task['owner']}'}${(task['blockedBy'] as List? ?? []).isEmpty ? '' : ' · after ${(task['blockedBy'] as List).map((id) => '#$id').join(', ')}'}${task['blocked'] == true ? ' · blocked' : ''}',
                    ),
                  ],
                  [
                    (
                      '${task['status']}'.replaceFirst('_', ' '),
                      task['status'] as String?,
                      null,
                    ),
                  ],
                ),
            ]),
          ],
          group('Teammates', state.teammates.length),
          if (state.teammates.isEmpty)
            empty('No teammates spawned.')
          else
            list([for (final a in state.teammates) agent(a, false)]),
          if (state.activity.isNotEmpty) ...[
            group('Recent team activity'),
            list([
              for (final event in state.activity)
                Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 5,
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Wrap(
                        spacing: 8,
                        runSpacing: 4,
                        children: [
                          Text(
                            time(event['time']),
                            style: webText(
                              context,
                              size: 12,
                              color: 'text.muted',
                            ).copyWith(height: 14 / 12),
                          ),
                          Text(
                            '${event['kind']}',
                            style: webText(
                              context,
                              size: 12,
                              weight: FontWeight.w700,
                            ).copyWith(height: 14 / 12),
                          ),
                          if (event['from'] != null || event['to'] != null)
                            Text(
                              '${event['from'] ?? ''}${event['to'] == null ? '' : ' → ${event['to']}'}',
                              style: webText(
                                context,
                                size: 12,
                              ).copyWith(height: 14 / 12),
                            ),
                        ],
                      ),
                      if (event['body'] != null && event['body'] != '')
                        Padding(
                          padding: const EdgeInsets.only(top: 4),
                          child: Text(
                            normalText('${event['body']}'),
                            style: webText(
                              context,
                              size: 12,
                              color: 'text.secondary',
                            ).copyWith(height: 14 / 12),
                          ),
                        ),
                    ],
                  ),
                ),
            ]),
          ],
        ],
      ];
      return ListView(
        padding: const EdgeInsets.fromLTRB(12, 12, 12, 16),
        children: [
          for (final (i, w) in children.indexed) ...[
            if (i > 0) const SizedBox(height: 8),
            w,
          ],
        ],
      );
    },
  );
}
