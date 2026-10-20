import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'common.dart';
import 'gateway.dart';
import 'jobs_state.dart';
import 'timeline_models.dart' show instant;
import 'web_controls.dart';

String jobDuration(Json task, DateTime now) {
  final start = instant(task['startedAt']);
  if (start == null) return '';
  final seconds = math.max(
    0,
    ((instant(task['endedAt']) ?? now).difference(start).inMilliseconds / 1000)
        .round(),
  );
  if (seconds < 60) return '${seconds}s';
  if (seconds < 3600) return '${seconds ~/ 60}m ${seconds % 60}s';
  return '${seconds ~/ 3600}h ${(seconds % 3600) ~/ 60}m';
}

class JobsMenu extends StatefulWidget {
  const JobsMenu({super.key, required this.controller});
  final LiveController controller;
  @override
  State<JobsMenu> createState() => _JobsMenuState();
}

class _JobsMenuState extends State<JobsMenu> {
  late JobsState jobs;
  final portal = OverlayPortalController();
  final anchor = GlobalKey();
  final trigger = FocusNode();
  final focus = FocusScopeNode();
  bool shown = false;
  @override
  void initState() {
    super.initState();
    jobs = JobsState(widget.controller)..addListener(update);
  }

  @override
  void didUpdateWidget(covariant JobsMenu old) {
    super.didUpdateWidget(old);
    if (old.controller != widget.controller) {
      jobs.removeListener(update);
      jobs.dispose();
      jobs = JobsState(widget.controller)..addListener(update);
    }
  }

  void update() {
    if (!mounted) return;
    setState(() {});
    // Controller notifications can arrive while the header is rebuilding.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (jobs.open && jobs.visible) {
        portal.show();
        if (!shown) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (mounted && jobs.open) focus.nextFocus();
          });
        }
        shown = true;
      } else {
        portal.hide();
        shown = false;
      }
    });
  }

  @override
  void dispose() {
    jobs.removeListener(update);
    jobs.dispose();
    trigger.dispose();
    focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final phone = MediaQuery.sizeOf(context).width <= 650;
    return OverlayPortal(
      controller: portal,
      overlayChildBuilder: (context) {
        final size = MediaQuery.sizeOf(context),
            safe = MediaQuery.paddingOf(context);
        final box = anchor.currentContext?.findRenderObject() as RenderBox?;
        final pos = box?.localToGlobal(Offset.zero) ?? Offset.zero;
        final width = math.min(480.0, size.width - 24);
        final top = phone
            ? safe.top + 60
            : pos.dy + (box?.size.height ?? 28.0) + 6.0;
        final left = phone
            ? 12.0
            : (pos.dx + (box?.size.width ?? 0) - width).clamp(
                12.0,
                math.max(12.0, size.width - width - 12),
              );
        return Positioned(
          top: top,
          left: left.toDouble(),
          width: phone ? size.width - 24 : width,
          child: TapRegion(
            groupId: this,
            onTapOutside: (_) => jobs.setOpen(false),
            child: FocusScope(
              node: focus,
              onFocusChange: (hasFocus) {
                if (!hasFocus && jobs.open) jobs.setOpen(false);
              },
              onKeyEvent: (_, event) {
                if (event is! KeyDownEvent) return KeyEventResult.ignored;
                if (event.logicalKey == LogicalKeyboardKey.escape) {
                  jobs.setOpen(false);
                  trigger.requestFocus();
                  return KeyEventResult.handled;
                }
                if ([
                  LogicalKeyboardKey.arrowDown,
                  LogicalKeyboardKey.arrowUp,
                  LogicalKeyboardKey.home,
                  LogicalKeyboardKey.end,
                ].contains(event.logicalKey)) {
                  final nodes = focus.traversalDescendants
                      .where((n) => n.canRequestFocus && !n.skipTraversal)
                      .toList();
                  if (nodes.isNotEmpty) {
                    final at = nodes.indexWhere((n) => n.hasPrimaryFocus);
                    final index = event.logicalKey == LogicalKeyboardKey.home
                        ? 0
                        : event.logicalKey == LogicalKeyboardKey.end
                        ? nodes.length - 1
                        : (at +
                                  (event.logicalKey ==
                                          LogicalKeyboardKey.arrowDown
                                      ? 1
                                      : -1))
                              .clamp(0, nodes.length - 1);
                    nodes[index].requestFocus();
                  }
                  return KeyEventResult.handled;
                }
                return KeyEventResult.ignored;
              },
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  maxHeight: math.max(
                    0,
                    math.min(480, size.height - top - 60 - safe.bottom),
                  ),
                ),
                child: JobsList(jobs: jobs),
              ),
            ),
          ),
        );
      },
      child: jobs.visible
          ? TapRegion(
              groupId: this,
              child: Tooltip(
                message: 'Background jobs',
                child: TextButton(
                  key: anchor,
                  focusNode: trigger,
                  onPressed: () => jobs.setOpen(!jobs.open),
                  style: TextButton.styleFrom(
                    minimumSize: Size(0, phone ? 32 : 28),
                    padding: EdgeInsets.symmetric(horizontal: phone ? 8 : 10),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    backgroundColor: jobs.open
                        ? palette(context)['web.bg-hover']
                        : Colors.transparent,
                    shape: const StadiumBorder(),
                    foregroundColor: palette(
                      context,
                    )[jobs.count > 0 ? 'text.secondary' : 'text.muted'],
                  ),
                  child: Semantics(
                    label:
                        '${jobs.count > 0 ? '${jobs.count} running' : '${jobs.finished.length} background tasks'}. Show background jobs',
                    expanded: jobs.open,
                    child: ExcludeSemantics(
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          if (jobs.count > 0) ...[
                            _JobDot(color: palette(context)['accent.default']),
                            const SizedBox(width: 5),
                          ],
                          Text(
                            '${jobs.count > 0 ? jobs.count : jobs.finished.length}',
                            style: webText(
                              context,
                              size: 12,
                              weight: FontWeight.w500,
                              color: 'text.secondary',
                            ),
                          ),
                          if (!phone) ...[
                            const SizedBox(width: 5),
                            Text(
                              jobs.count > 0 ? 'running' : 'finished',
                              style: webText(
                                context,
                                size: 12,
                                color: 'text.muted',
                              ),
                            ),
                          ],
                          const SizedBox(width: 5),
                          Icon(
                            jobs.open
                                ? LucideIcons.chevronUp
                                : LucideIcons.chevronDown,
                            size: 12,
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            )
          : const SizedBox.shrink(),
    );
  }
}

class JobsList extends StatelessWidget {
  const JobsList({super.key, required this.jobs});
  final JobsState jobs;
  @override
  Widget build(BuildContext context) {
    final colors = palette(context);
    Widget smallButton(String text, VoidCallback action, {IconData? icon}) =>
        TextButton(
          onPressed: action,
          style: TextButton.styleFrom(
            textStyle: webText(context, size: 11),
            minimumSize: const Size(0, 20),
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (icon != null) ...[
                Icon(icon, size: 12, color: colors['text.muted']),
                const SizedBox(width: 3),
              ],
              Flexible(
                child: Text(
                  text,
                  style: webText(context, size: 11, color: 'text.muted'),
                ),
              ),
            ],
          ),
        );
    return Semantics(
      label: 'Background jobs',
      scopesRoute: true,
      explicitChildNodes: true,
      child: DecoratedBox(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(16),
          boxShadow: pircShadow(context),
        ),
        child: Material(
          color: colors['surface.layer'],
          borderRadius: BorderRadius.circular(16),
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(4),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (jobs.count > 0)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(6, 4, 6, 2),
                    child: Text(
                      'Running',
                      style: webText(
                        context,
                        size: 11,
                        color: 'text.muted',
                      ).copyWith(height: 18 / 11),
                    ),
                  ),
                for (final task in jobs.live) _task(context, task),
                for (final agent in jobs.agents)
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 5,
                    ),
                    child: Row(
                      children: [
                        _JobDot(color: colors['accent.default']),
                        const SizedBox(width: 8),
                        Icon(
                          agent['mode'] == 'subagent'
                              ? LucideIcons.bot
                              : LucideIcons.users,
                          size: 13,
                          color: colors['text.muted'],
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                '${agent['name']}',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: webText(context, size: 12.5),
                              ),
                              if ('${agent['task'] ?? ''}'.trim().isNotEmpty)
                                Text(
                                  '${agent['task']}'.trim(),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: webText(
                                    context,
                                    size: 11.5,
                                    color: 'text.muted',
                                  ),
                                ),
                            ],
                          ),
                        ),
                        const SizedBox(width: 8),
                        Text(
                          '${agent['status']}',
                          style: webText(
                            context,
                            size: 11,
                            color: 'text.muted',
                          ),
                        ),
                      ],
                    ),
                  ),
                if (jobs.stopError != null) _error(context, jobs.stopError!),
                if (jobs.finished.isNotEmpty) ...[
                  Container(
                    margin: EdgeInsets.fromLTRB(
                      6,
                      jobs.count > 0 ? 4 : 0,
                      6,
                      2,
                    ),
                    padding: const EdgeInsets.only(top: 4),
                    decoration: jobs.count > 0
                        ? BoxDecoration(
                            border: Border(
                              top: BorderSide(color: colors['web.line']),
                            ),
                          )
                        : null,
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Flexible(
                          child: smallButton(
                            'Finished ${jobs.finished.length}',
                            jobs.toggleFinished,
                            icon: jobs.finishedOpen || jobs.count == 0
                                ? LucideIcons.chevronDown
                                : LucideIcons.chevronRight,
                          ),
                        ),
                        smallButton('Clear', jobs.clearFinished),
                      ],
                    ),
                  ),
                  if (jobs.finishedOpen || jobs.count == 0)
                    for (final task in jobs.finished) _task(context, task),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _error(BuildContext context, String text) => Padding(
    padding: const EdgeInsets.fromLTRB(8, 2, 8, 4),
    child: Text(
      text,
      style: webText(context, size: 12, color: 'status.danger'),
    ),
  );
  Widget _task(BuildContext context, Json task) {
    final colors = palette(context),
        live = liveJob(task),
        expanded = jobs.expanded == task['id'];
    final armed = jobs.armed == task['id'];
    final color = live
        ? 'accent.default'
        : task['status'] == 'completed' &&
              (task['exitCode'] == null || task['exitCode'] == 0)
        ? 'status.success'
        : task['status'] == 'stopped'
        ? 'text.faint'
        : 'status.danger';
    return Padding(
      padding: const EdgeInsets.only(bottom: 1),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          DecoratedBox(
            decoration: BoxDecoration(
              color: live ? colors['web.bg-hover'] : Colors.transparent,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Semantics(
                    expanded: expanded,
                    child: TextButton(
                      onPressed: () => jobs.toggleTask(task),
                      style: TextButton.styleFrom(
                        textStyle: webText(
                          context,
                          size: 12,
                        ).copyWith(height: 1.5),
                        minimumSize: const Size(0, 32),
                        padding: const EdgeInsets.symmetric(
                          horizontal: 8,
                          vertical: 5,
                        ),
                        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(9),
                        ),
                      ),
                      child: LayoutBuilder(
                        builder: (context, bounds) => Row(
                          children: [
                            _JobDot(color: colors[color]),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Tooltip(
                                message: '${task['command']}',
                                child: Text(
                                  '${task['command']}',
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style:
                                      webText(
                                        context,
                                        size: 12,
                                        color: live
                                            ? 'text.primary'
                                            : 'text.secondary',
                                      ).copyWith(
                                        fontFamily: 'monospace',
                                        height: 1.5,
                                      ),
                                ),
                              ),
                            ),
                            if (jobDetail(task).isNotEmpty) ...[
                              const SizedBox(width: 8),
                              ConstrainedBox(
                                constraints: BoxConstraints(
                                  maxWidth: bounds.maxWidth * .4,
                                ),
                                child: Text(
                                  jobDetail(task),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: webText(
                                    context,
                                    size: 11,
                                    color: 'text.muted',
                                  ),
                                ),
                              ),
                            ],
                            const SizedBox(width: 8),
                            ConstrainedBox(
                              constraints: BoxConstraints(
                                maxWidth: bounds.maxWidth * .25,
                              ),
                              child: Text(
                                jobDuration(task, jobs.now),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: webText(
                                  context,
                                  size: 11,
                                  color: 'text.muted',
                                ),
                              ),
                            ),
                            const SizedBox(width: 8),
                            Icon(
                              expanded
                                  ? LucideIcons.chevronDown
                                  : LucideIcons.chevronRight,
                              size: 13,
                              color: colors['text.faint'],
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
                if (task['status'] == 'running' &&
                    jobs.controller.control['held'] == true)
                  Padding(
                    padding: const EdgeInsets.only(right: 5),
                    child: Tooltip(
                      message: armed ? 'Click again to stop' : 'Stop task',
                      child: Semantics(
                        label: armed ? 'Confirm stop' : 'Stop ${task['id']}',
                        child: TextButton(
                          onPressed:
                              jobs.controller.canWrite && jobs.stopping == null
                              ? () => jobs.pressStop(task)
                              : null,
                          style: TextButton.styleFrom(
                            minimumSize: const Size(22, 22),
                            padding: EdgeInsets.symmetric(
                              horizontal: armed ? 8 : 0,
                            ),
                            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            backgroundColor:
                                colors[armed
                                    ? 'status.dangerSoft'
                                    : 'surface.layer'],
                            side: BorderSide(
                              color:
                                  colors[armed
                                      ? 'status.danger'
                                      : 'web.line-dark'],
                            ),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(6),
                            ),
                          ),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(
                                Icons.square,
                                size: 9,
                                color:
                                    colors[armed
                                        ? 'status.danger'
                                        : 'text.secondary'],
                              ),
                              if (armed) ...[
                                const SizedBox(width: 4),
                                Text(
                                  'Stop',
                                  style: webText(
                                    context,
                                    size: 11,
                                    color: 'status.danger',
                                  ),
                                ),
                              ],
                            ],
                          ),
                        ),
                      ),
                    ),
                  )
                else if (task['status'] == 'stopping')
                  Padding(
                    padding: const EdgeInsets.only(right: 10),
                    child: Semantics(
                      label: 'Stopping',
                      child: Icon(
                        LucideIcons.loaderCircle,
                        size: 12,
                        color: colors['text.muted'],
                      ),
                    ),
                  ),
              ],
            ),
          ),
          if (expanded) ...[
            if (jobs.outputError != null) _error(context, jobs.outputError!),
            _JobOutput(key: ValueKey(task['id']), text: jobs.output),
          ],
        ],
      ),
    );
  }
}

class _JobDot extends StatelessWidget {
  const _JobDot({required this.color});
  final Color color;
  @override
  Widget build(BuildContext context) => Container(
    width: 7,
    height: 7,
    decoration: BoxDecoration(color: color, shape: BoxShape.circle),
  );
}

class _JobOutput extends StatefulWidget {
  const _JobOutput({super.key, required this.text});
  final String text;
  @override
  State<_JobOutput> createState() => _JobOutputState();
}

class _JobOutputState extends State<_JobOutput> {
  final scroll = ScrollController();
  @override
  void didUpdateWidget(covariant _JobOutput old) {
    super.didUpdateWidget(old);
    if (old.text != widget.text &&
        (!scroll.hasClients || scroll.position.extentAfter < 24)) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && scroll.hasClients) {
          scroll.jumpTo(scroll.position.maxScrollExtent);
        }
      });
    }
  }

  @override
  void dispose() {
    scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Container(
    constraints: const BoxConstraints(maxHeight: 240),
    margin: const EdgeInsets.fromLTRB(4, 4, 4, 6),
    decoration: BoxDecoration(
      color: palette(context)['code.bg'],
      border: Border.all(color: palette(context)['web.line']),
      borderRadius: BorderRadius.circular(8),
    ),
    child: SingleChildScrollView(
      controller: scroll,
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      child: SelectableText(
        widget.text.isEmpty ? 'No output yet.' : widget.text,
        style: webText(context, size: 11.5).copyWith(
          color: palette(context)['code.text'],
          fontFamily: 'monospace',
          height: 1.5,
        ),
      ),
    ),
  );
}
