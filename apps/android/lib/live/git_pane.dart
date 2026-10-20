import '../l10n/app_i18n.dart';
import 'dart:ui' show SemanticsRole;
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show OverflowBoxFit;
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'gateway.dart';
import 'common.dart';
import 'web_controls.dart';
import 'tasks_pane.dart' show PanelChip;
import 'git_state.dart';
import 'diff_view.dart';
import 'timeline_models.dart' show instant;

const gitLabels = {
  'M': 'Modified',
  'A': 'Added',
  'D': 'Deleted',
  'R': 'Renamed',
  'C': 'Copied',
  'U': 'Conflict',
  'T': 'Type changed',
  '?': 'Untracked',
};

double _measureGitText(BuildContext context, String value, TextStyle style) {
  if (value.isEmpty) return 0;
  final painter = TextPainter(
    text: TextSpan(text: value, style: style),
    textDirection: TextDirection.ltr,
    textScaler: MediaQuery.textScalerOf(context),
  )..layout();
  return painter.width;
}

class GitPane extends StatefulWidget {
  const GitPane({
    super.key,
    required this.controller,
    required this.onFile,
    this.clock,
  });
  final LiveController controller;
  final ValueChanged<String> onFile;
  final DateTime Function()? clock;
  @override
  State<GitPane> createState() => _GitPaneState();
}

class _GitPaneState extends State<GitPane> {
  late final state = GitState(widget.controller);
  final tabs = [FocusNode(), FocusNode()];
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    state.setActive(TickerMode.valuesOf(context).enabled);
  }

  @override
  void dispose() {
    state.dispose();
    for (final f in tabs) {
      f.dispose();
    }
    super.dispose();
  }

  TextStyle text(
    double size, {
    String color = 'text.primary',
    FontWeight weight = FontWeight.w400,
    double height = 1.15,
  }) => webText(
    context,
    size: size,
    color: color,
    weight: weight,
  ).copyWith(height: height);
  String normal(String s) => s.replaceAll(RegExp(r'[ \t\r\n\f]+'), ' ').trim();
  Widget empty(String s) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 4),
    child: Text(s, style: text(13, color: 'text.muted', height: 1.5)),
  );
  Widget error(String s) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
    decoration: BoxDecoration(
      color: palette(context)['status.dangerSoft'],
      borderRadius: BorderRadius.circular(8),
    ),
    child: Text(s, style: text(12.5, color: 'status.danger', height: 1.45)),
  );
  Widget group(String name, int count) => Padding(
    padding: const EdgeInsets.only(top: 6),
    child: Row(
      children: [
        Expanded(
          child: Text(
            name.toUpperCase(),
            style: text(
              11.5,
              color: 'text.muted',
              weight: FontWeight.w600,
              height: 12 / 11.5,
            ).copyWith(letterSpacing: .23),
          ),
        ),
        Text(
          '$count',
          style: text(11.5, color: 'text.muted', weight: FontWeight.w500),
        ),
      ],
    ),
  );
  Widget sequence(List<Widget> children, {double gap = 8}) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      for (final (i, w) in children.indexed) ...[
        if (i > 0) SizedBox(height: gap),
        w,
      ],
    ],
  );
  Widget toolbar() => Row(
    children: [
      Expanded(
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Semantics(
            role: SemanticsRole.tabBar,
            label: tr("Git view"),
            child: Container(
              padding: const EdgeInsets.all(2),
              decoration: BoxDecoration(
                color: palette(context)['web.bg-hover'],
                borderRadius: BorderRadius.circular(999),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (final (i, view) in ['changes', 'history'].indexed) ...[
                    if (i > 0) const SizedBox(width: 2),
                    Focus(
                      onKeyEvent: (node, event) {
                        if (event is! KeyDownEvent) {
                          return KeyEventResult.ignored;
                        }
                        final key = event.logicalKey;
                        int? next;
                        if (key == LogicalKeyboardKey.arrowLeft ||
                            key == LogicalKeyboardKey.arrowRight) {
                          next = 1 - i;
                        }
                        if (key == LogicalKeyboardKey.home) next = 0;
                        if (key == LogicalKeyboardKey.end) next = 1;
                        if (next == null) return KeyEventResult.ignored;
                        state.switchView(['changes', 'history'][next]);
                        final target = next;
                        WidgetsBinding.instance.addPostFrameCallback((_) {
                          if (mounted) tabs[target].requestFocus();
                        });
                        return KeyEventResult.handled;
                      },
                      child: Semantics(
                        role: SemanticsRole.tab,
                        selected: state.view == view,
                        label: i == 0
                            ? tr("Changes{0}", [
                                state.files.isEmpty
                                    ? ''
                                    : ' ${state.files.length}',
                              ])
                            : tr("History"),
                        onTap: () => state.switchView(view),
                        excludeSemantics: true,
                        child: InkWell(
                          key: ValueKey('git-view-$view'),
                          focusNode: tabs[i],
                          canRequestFocus: state.view == view,
                          onTap: () => state.switchView(view),
                          splashFactory: NoSplash.splashFactory,
                          borderRadius: BorderRadius.circular(999),
                          child: Container(
                            decoration: state.view == view
                                ? BoxDecoration(
                                    color: palette(context)['web.bg-layer'],
                                    borderRadius: BorderRadius.circular(999),
                                    boxShadow: [
                                      BoxShadow(
                                        color: palette(context)['web.line'],
                                        spreadRadius: 1,
                                      ),
                                      const BoxShadow(
                                        color: Color(0x0f000000),
                                        offset: Offset(0, 1),
                                        blurRadius: 2,
                                      ),
                                    ],
                                  )
                                : null,
                            child: SizedBox(
                              height: 26,
                              child: Padding(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 12,
                                ),
                                child: Center(
                                  child: Row(
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      Text(
                                        i == 0 ? tr("Changes") : tr("History"),
                                        style: text(
                                          12.5,
                                          color: state.view == view
                                              ? 'text.primary'
                                              : 'text.secondary',
                                          weight: FontWeight.w500,
                                        ),
                                      ),
                                      if (i == 0 && state.files.isNotEmpty) ...[
                                        const SizedBox(width: 6),
                                        Text(
                                          '${state.files.length}',
                                          style: text(11, color: 'text.muted'),
                                        ),
                                      ],
                                    ],
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
      const SizedBox(width: 8),
      WebIconButton(
        LucideIcons.refreshCw,
        tr("Refresh"),
        onPressed: state.statusRead.loading ? null : state.load,
      ),
    ],
  );
  Widget branchChip(String label) => Container(
    height: 20,
    padding: const EdgeInsets.symmetric(horizontal: 7),
    decoration: BoxDecoration(
      color: palette(context)['web.bg-hover'],
      borderRadius: BorderRadius.circular(999),
    ),
    child: Center(
      widthFactor: 1,
      child: Text(
        label,
        maxLines: 1,
        softWrap: false,
        style: text(
          11,
          color: 'text.secondary',
          weight: FontWeight.w500,
        ).copyWith(height: 13 / 11),
      ),
    ),
  );

  Widget branch(double rowWidth) {
    final s = state.status!;
    final branchName = '${s['branch'] ?? 'detached'}';
    final upstream = s['upstream'] == null ? null : '→ ${s['upstream']}';
    final ahead = (s['ahead'] as num? ?? 0) > 0 ? '↑${s['ahead']}' : null;
    final behind = (s['behind'] as num? ?? 0) > 0 ? '↓${s['behind']}' : null;
    final itemCount =
        2 +
        (upstream == null ? 0 : 1) +
        (ahead == null ? 0 : 1) +
        (behind == null ? 0 : 1);
    final gaps = (itemCount - 1) * 6.0;
    final branchStyle = text(13, weight: FontWeight.w600);
    final mutedStyle = text(13, color: 'text.muted');
    final branchNaturalWidth = _measureGitText(
      context,
      branchName,
      branchStyle,
    );
    // A normal white-space span can break before the upstream name, while its
    // slash-separated name remains a min-content word (source CSS flex rule).
    final upstreamMinWidth = upstream == null
        ? 0.0
        : _measureGitText(context, upstream.split(' ').last, mutedStyle);
    final aheadWidth = ahead == null
        ? 0.0
        : _measureGitText(
                context,
                ahead,
                text(11, color: 'text.secondary', weight: FontWeight.w500),
              ) +
              14;
    final behindWidth = behind == null
        ? 0.0
        : _measureGitText(
                context,
                behind,
                text(11, color: 'text.secondary', weight: FontWeight.w500),
              ) +
              14;
    final branchWidth = math.max(
      0.0,
      rowWidth - 14 - gaps - upstreamMinWidth - aheadWidth - behindWidth,
    );
    return SizedBox(
      width: rowWidth,
      child: Row(
        children: [
          Icon(
            LucideIcons.gitBranch,
            size: 14,
            color: palette(context)['text.secondary'],
          ),
          const SizedBox(width: 6),
          SizedBox(
            width: math.min(branchWidth, branchNaturalWidth),
            child: Text(
              branchName,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: branchStyle,
            ),
          ),
          if (upstream != null) ...[
            const SizedBox(width: 6),
            SizedBox(
              width: upstreamMinWidth,
              child: Text(upstream, style: mutedStyle),
            ),
          ],
          if (ahead != null) ...[const SizedBox(width: 6), branchChip(ahead)],
          if (behind != null) ...[const SizedBox(width: 6), branchChip(behind)],
        ],
      ),
    );
  }

  double _contentWidth(double availableWidth) {
    var width = availableWidth;
    final nameStyle = text(13, height: 15 / 13);
    final pathStyle = text(12, color: 'text.muted');
    for (final file in state.files) {
      final path = '${file['path']}';
      final name = path.split('/').last;
      final dir = path.contains('/')
          ? path.substring(0, path.lastIndexOf('/'))
          : '';
      final display = file['origPath'] == null ? dir : '${file['origPath']} →';
      // Status code, two flex gaps, and the row's horizontal padding are
      // fixed-width Web flex items; name and path contribute max-content.
      width = math.max(
        width,
        16 +
            16 +
            16 +
            _measureGitText(context, name, nameStyle) +
            _measureGitText(context, display, pathStyle),
      );
    }
    return width;
  }

  Widget file(Json f, bool staged, double rowWidth) {
    final path = '${f['path']}',
        name = path.split('/').last,
        dir = path.contains('/')
            ? path.substring(0, path.lastIndexOf('/'))
            : '';
    final code = '${staged ? f['index'] : f['worktree']}',
        display = code == '?' ? 'U' : code;
    final color = switch (display) {
      'M' || 'T' => 'text.warning',
      'A' || 'U' => 'status.success',
      'D' => 'status.danger',
      'R' || 'C' => 'accent.default',
      _ => 'text.muted',
    };
    return OverflowBox(
      alignment: Alignment.centerLeft,
      fit: OverflowBoxFit.deferToChild,
      minWidth: rowWidth,
      maxWidth: rowWidth,
      child: SizedBox(
        width: rowWidth,
        child: InkWell(
          key: ValueKey('git-file-$path-$staged'),
          onTap: () => state.openDiff(f, staged),
          borderRadius: BorderRadius.circular(8),
          hoverColor: palette(context)['web.bg-hover'],
          splashFactory: NoSplash.splashFactory,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            child: LayoutBuilder(
              builder: (context, b) => Row(
                children: [
                  Tooltip(
                    message: tr(gitLabels[code] ?? ''),
                    child: SizedBox(
                      width: 16,
                      child: Text(
                        display,
                        textAlign: TextAlign.center,
                        style: text(
                          11.5,
                          color: color,
                          weight: FontWeight.w600,
                        ).copyWith(fontFamily: 'monospace'),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  ConstrainedBox(
                    constraints: BoxConstraints(maxWidth: b.maxWidth * .7),
                    child: Text(
                      name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: text(13, height: 15 / 13),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      f['origPath'] == null ? dir : '${f['origPath']} →',
                      textAlign: TextAlign.right,
                      textDirection: TextDirection.rtl,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: text(12, color: 'text.muted'),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  String ago(dynamic time) {
    final d = instant(time);
    if (d == null) return '';
    final delta = (widget.clock?.call() ?? DateTime.now())
        .difference(d)
        .inSeconds;
    if (delta < 60) return tr("just now");
    if (delta < 3600) return tr("{0}m ago", [delta ~/ 60]);
    if (delta < 86400) return tr("{0}h ago", [delta ~/ 3600]);
    if (delta < 30 * 86400) return tr("{0}d ago", [delta ~/ 86400]);
    final local = d.toLocal();
    return '${local.month}/${local.day}/${local.year}';
  }

  String date(dynamic time) {
    final d = instant(time)?.toLocal();
    if (d == null) return '';
    return '${d.month}/${d.day}/${d.year}, ${d.hour % 12 == 0 ? 12 : d.hour % 12}:${d.minute.toString().padLeft(2, '0')}:${d.second.toString().padLeft(2, '0')} ${d.hour < 12 ? 'AM' : 'PM'}';
  }

  Widget commitRow(Json item) => InkWell(
    key: ValueKey('git-commit-${item['sha']}'),
    onTap: () => state.openCommit(item),
    borderRadius: BorderRadius.circular(8),
    hoverColor: palette(context)['web.bg-hover'],
    splashFactory: NoSplash.splashFactory,
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Icon(
              LucideIcons.gitCommitHorizontal,
              size: 15,
              color: palette(context)['text.muted'],
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  normal('${item['subject']}'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: text(13, height: 15 / 13),
                ),
                const SizedBox(height: 2),
                Wrap(
                  spacing: 4,
                  runSpacing: 4,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Text(
                      '${item['short']}',
                      style: text(
                        11.5,
                        color: 'text.muted',
                      ).copyWith(fontFamily: 'monospace'),
                    ),
                    Text(
                      '· ${normal('${item['author']}')} · ${ago(item['time'])}',
                      style: text(11.5, color: 'text.muted'),
                    ),
                    for (final ref in (item['refs'] as List? ?? []).take(2))
                      PanelChip('$ref'.replaceFirst('HEAD -> ', '')),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    ),
  );
  Widget commitCard(Json c) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
    decoration: BoxDecoration(
      color: palette(context)['web.bg-layer'],
      borderRadius: BorderRadius.circular(12),
      boxShadow: [
        BoxShadow(color: palette(context)['web.line'], spreadRadius: 1),
      ],
    ),
    child: sequence([
      SelectableText(
        '${c['message']}',
        style: text(13, weight: FontWeight.w500, height: 1.5),
      ),
      Text(
        '${c['author']} · ${date(c['time'])}',
        style: text(12, color: 'text.muted'),
      ),
      if ((c['refs'] as List? ?? []).isNotEmpty)
        Padding(
          padding: const EdgeInsets.only(top: 2),
          child: Wrap(
            spacing: 4,
            runSpacing: 4,
            children: [for (final ref in c['refs']) PanelChip('$ref')],
          ),
        ),
    ], gap: 4),
  );
  Widget drill(Widget title, {Widget? trailing}) => Row(
    children: [
      WebIconButton(
        LucideIcons.arrowLeft,
        tr("Back"),
        iconSize: 16,
        onPressed: state.back,
      ),
      const SizedBox(width: 6),
      Expanded(child: title),
      if (trailing != null) ...[const SizedBox(width: 6), trailing],
    ],
  );
  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return AnimatedBuilder(
      animation: state,
      builder: (context, _) {
        final selected = state.selected, commit = state.commit;
        final children = <Widget>[
          if (selected != null) ...[
            drill(
              Tooltip(
                message: tr("Open file"),
                child: InkWell(
                  onTap: () => widget.onFile('${selected['path']}'),
                  splashFactory: NoSplash.splashFactory,
                  child: Text(
                    '${selected['path']}',
                    textDirection: TextDirection.rtl,
                    textAlign: TextAlign.left,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: text(13, weight: FontWeight.w600),
                  ),
                ),
              ),
              trailing: PanelChip(
                state.selectedStaged
                    ? tr("Staged")
                    : tr(gitLabels[selected['worktree']] ?? "Changed"),
              ),
            ),
            if (state.diffRead.error != null)
              error(state.diffRead.error!)
            else if (state.diff != null)
              NativeDiffView(
                diff: '${state.diff!['diff']}',
                truncated: state.diff!['truncated'] == true,
              )
            else
              empty(tr("Loading diff…")),
          ] else if (commit != null) ...[
            drill(
              Text(
                '${commit['sha']}'.substring(
                  0,
                  '${commit['sha']}'.length.clamp(0, 10),
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: text(
                  13,
                  weight: FontWeight.w600,
                ).copyWith(fontFamily: 'monospace'),
              ),
            ),
            commitCard(commit),
            NativeDiffView(
              diff: '${commit['diff']}',
              truncated: commit['truncated'] == true,
            ),
          ] else ...[
            toolbar(),
            LayoutBuilder(
              builder: (context, constraints) {
                final rowWidth = _contentWidth(constraints.maxWidth);
                return OverflowBox(
                  alignment: Alignment.topLeft,
                  fit: OverflowBoxFit.deferToChild,
                  minWidth: rowWidth,
                  maxWidth: rowWidth,
                  child: SizedBox(
                    width: rowWidth,
                    child: Semantics(
                      role: SemanticsRole.tabPanel,
                      label: state.view == 'changes'
                          ? tr("Changes")
                          : tr("History"),
                      child: sequence([
                        if (state.listError != null) error(state.listError!),
                        if (state.status != null &&
                            state.status?['repo'] != true)
                          empty(tr("This workspace is not a Git repository."))
                        else if (state.status?['repo'] == true) ...[
                          branch(rowWidth),
                          if (state.view == 'changes') ...[
                            if (state.files.isEmpty)
                              empty(tr("Working tree clean."))
                            else ...[
                              if (state.staged.isNotEmpty) ...[
                                group(tr("Staged"), state.staged.length),
                                sequence([
                                  for (final f in state.staged)
                                    file(f, true, rowWidth),
                                ], gap: 1),
                              ],
                              if (state.unstaged.isNotEmpty) ...[
                                group(tr("Changes"), state.unstaged.length),
                                sequence([
                                  for (final f in state.unstaged)
                                    file(f, false, rowWidth),
                                ], gap: 1),
                              ],
                              if (state.status?['truncated'] == true)
                                empty(tr("Showing the first 5,000 files.")),
                            ],
                          ] else if (state.commits.isEmpty)
                            empty(tr("No commits yet."))
                          else ...[
                            sequence([
                              for (final c in state.commits) commitRow(c),
                            ], gap: 1),
                            if (state.more)
                              Align(
                                alignment: Alignment.center,
                                child: TextButton(
                                  onPressed: state.historyRead.loading
                                      ? null
                                      : () => state.loadHistory(),
                                  style: TextButton.styleFrom(
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 12,
                                      vertical: 6,
                                    ),
                                    minimumSize: Size.zero,
                                    tapTargetSize:
                                        MaterialTapTargetSize.shrinkWrap,
                                    foregroundColor: palette(
                                      context,
                                    )['accent.default'],
                                    textStyle: text(12.5),
                                  ),
                                  child: Text(tr("Load more")),
                                ),
                              ),
                          ],
                        ] else if (state.statusRead.loading)
                          empty(tr("Loading…")),
                      ]),
                    ),
                  ),
                );
              },
            ),
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
}
