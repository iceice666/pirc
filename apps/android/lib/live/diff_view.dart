import '../l10n/app_i18n.dart';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'common.dart';
import 'web_controls.dart';

class DiffLine {
  const DiffLine(this.kind, this.text, {this.old, this.next});
  final String kind, text;
  final int? old, next;
}

List<DiffLine> parseUnifiedDiff(String text) {
  final lines = <DiffLine>[];
  var old = 0, next = 0, inHunk = false;
  for (final raw in text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      inHunk = false;
      lines.add(
        DiffLine(
          'file',
          RegExp(r' b/(.*)$').firstMatch(raw)?.group(1) ?? raw.substring(11),
        ),
      );
    } else if (raw.startsWith('@@')) {
      inHunk = true;
      final m = RegExp(r'^@@ -(\d+)(?:,\d+)? \+(\d+)').firstMatch(raw);
      old = int.parse(m?.group(1) ?? '0');
      next = int.parse(m?.group(2) ?? '0');
      lines.add(DiffLine('hunk', raw));
    } else if (!inHunk) {
      if (raw.isNotEmpty &&
          !raw.startsWith('index ') &&
          !raw.startsWith('--- ') &&
          !raw.startsWith('+++ ')) {
        lines.add(DiffLine('meta', raw));
      }
    } else if (raw.startsWith('+')) {
      lines.add(DiffLine('add', raw.substring(1), next: next++));
    } else if (raw.startsWith('-')) {
      lines.add(DiffLine('del', raw.substring(1), old: old++));
    } else if (raw.startsWith('\\')) {
      lines.add(DiffLine('meta', raw));
    } else {
      lines.add(
        DiffLine(
          'ctx',
          raw.isEmpty ? '' : raw.substring(1),
          old: old++,
          next: next++,
        ),
      );
    }
  }
  while (lines.isNotEmpty &&
      lines.last.kind == 'ctx' &&
      lines.last.text.isEmpty) {
    lines.removeLast();
  }
  return lines;
}

String diffNumber(int n) =>
    '$n'.replaceAllMapped(RegExp(r'(\d)(?=(\d{3})+(?!\d))'), (m) => '${m[1]},');

class NativeDiffView extends StatefulWidget {
  const NativeDiffView({super.key, required this.diff, this.truncated = false});
  final String diff;
  final bool truncated;
  @override
  State<NativeDiffView> createState() => _NativeDiffViewState();
}

class _NativeDiffViewState extends State<NativeDiffView> {
  final horizontal = ScrollController();
  late List<DiffLine> lines = parseUnifiedDiff(widget.diff);
  int limit = 2000;
  @override
  void didUpdateWidget(covariant NativeDiffView old) {
    super.didUpdateWidget(old);
    if (old.diff != widget.diff) {
      lines = parseUnifiedDiff(widget.diff);
      limit = 2000;
    }
  }

  @override
  void dispose() {
    horizontal.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    final p = palette(context),
        scaler = MediaQuery.textScalerOf(context),
        font = scaler.scale(12);
    final style = TextStyle(
      fontFamily: 'monospace',
      fontSize: 12,
      height: 1.55,
      letterSpacing: 0,
      color: p['code.text'],
    );
    if (widget.diff.trim().isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 4),
        child: Text(
          tr("No changes."),
          style: webText(
            context,
            size: 13,
            color: 'text.muted',
          ).copyWith(height: 1.5),
        ),
      );
    }
    final shown = lines.take(limit).toList();
    double width = 0;
    for (final line in shown.where(
      (l) => ['ctx', 'add', 'del'].contains(l.kind),
    )) {
      final t = TextPainter(
        text: TextSpan(text: line.text, style: style),
        textDirection: TextDirection.ltr,
        textScaler: scaler,
      )..layout();
      width = math.max(width, t.width);
      t.dispose();
    }
    Widget gutter(int? n) => SelectionContainer.disabled(
      child: ExcludeSemantics(
        child: SizedBox(
          width: font * 3.2,
          child: Padding(
            padding: const EdgeInsets.only(right: 6),
            child: Text(
              n == null ? '' : '$n',
              textAlign: TextAlign.right,
              style: style.copyWith(color: p['text.faint']),
            ),
          ),
        ),
      ),
    );
    return LayoutBuilder(
      builder: (context, b) {
        final total = math.max(b.maxWidth, width + font * 7.6 + 13);
        Widget sticky(Widget child) => AnimatedBuilder(
          animation: horizontal,
          builder: (context, _) => Transform.translate(
            offset: Offset(horizontal.hasClients ? horizontal.offset : 0, 0),
            child: SizedBox(width: b.maxWidth, child: child),
          ),
        );
        Widget meta(String value) => Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
          child: Text(
            value.replaceAll(RegExp(r'[ \t\r\n\f]+'), ' '),
            style: style.copyWith(color: p['text.muted']),
          ),
        );
        return Semantics(
          label: tr("Diff"),
          container: true,
          child: Focus(
            onKeyEvent: (node, event) {
              if (event is! KeyDownEvent || !horizontal.hasClients) {
                return KeyEventResult.ignored;
              }
              final key = event.logicalKey;
              if (key != LogicalKeyboardKey.arrowLeft &&
                  key != LogicalKeyboardKey.arrowRight) {
                return KeyEventResult.ignored;
              }
              horizontal.jumpTo(
                (horizontal.offset +
                        (key == LogicalKeyboardKey.arrowLeft ? -40 : 40))
                    .clamp(0, horizontal.position.maxScrollExtent),
              );
              return KeyEventResult.handled;
            },
            child: Container(
              decoration: BoxDecoration(
                color: p['code.bg'],
                borderRadius: BorderRadius.circular(12),
                boxShadow: [BoxShadow(color: p['web.line'], spreadRadius: 1)],
              ),
              clipBehavior: Clip.antiAlias,
              child: SelectionArea(
                child: SingleChildScrollView(
                  controller: horizontal,
                  scrollDirection: Axis.horizontal,
                  child: SizedBox(
                    width: total,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        for (final (i, line) in shown.indexed)
                          if (line.kind == 'file')
                            sticky(
                              Container(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 10,
                                  vertical: 6,
                                ),
                                decoration: BoxDecoration(
                                  color: p['web.bg-subtle'],
                                  border: i == 0
                                      ? null
                                      : Border(
                                          top: BorderSide(color: p['web.line']),
                                        ),
                                ),
                                child: Text(
                                  line.text,
                                  style: style.copyWith(
                                    color: p['text.primary'],
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                              ),
                            )
                          else if (line.kind == 'meta')
                            SizedBox(width: b.maxWidth, child: meta(line.text))
                          else if (line.kind == 'hunk')
                            Container(
                              width: b.maxWidth,
                              padding: const EdgeInsets.symmetric(
                                horizontal: 10,
                                vertical: 2,
                              ),
                              color: p['accent.soft'],
                              child: Text(
                                line.text,
                                style: style.copyWith(
                                  color: p['web.accent-ink'],
                                ),
                              ),
                            )
                          else
                            Container(
                              width: total,
                              color: line.kind == 'add'
                                  ? p['status.success'].withValues(alpha: .13)
                                  : line.kind == 'del'
                                  ? p['status.danger'].withValues(alpha: .12)
                                  : null,
                              child: Row(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  gutter(line.old),
                                  gutter(line.next),
                                  SelectionContainer.disabled(
                                    child: ExcludeSemantics(
                                      child: SizedBox(
                                        width: font * 1.2,
                                        child: Text(
                                          line.kind == 'add'
                                              ? '+'
                                              : line.kind == 'del'
                                              ? '−'
                                              : '',
                                          style: style.copyWith(
                                            color:
                                                p[line.kind == 'add'
                                                    ? 'status.success'
                                                    : line.kind == 'del'
                                                    ? 'status.danger'
                                                    : 'text.muted'],
                                          ),
                                        ),
                                      ),
                                    ),
                                  ),
                                  Semantics(
                                    label: line.kind == 'add'
                                        ? 'Added: ${line.text}'
                                        : line.kind == 'del'
                                        ? 'Removed: ${line.text}'
                                        : null,
                                    excludeSemantics:
                                        line.kind == 'add' ||
                                        line.kind == 'del',
                                    child: Text(
                                      line.text,
                                      style: style,
                                      softWrap: false,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                        if (shown.length < lines.length)
                          sticky(
                            SelectionContainer.disabled(
                              child: InkWell(
                                onTap: () => setState(() => limit += 4000),
                                splashFactory: NoSplash.splashFactory,
                                child: Container(
                                  width: b.maxWidth,
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 10,
                                    vertical: 6,
                                  ),
                                  decoration: BoxDecoration(
                                    color: p['web.bg-subtle'],
                                    border: Border(
                                      top: BorderSide(color: p['web.line']),
                                    ),
                                  ),
                                  child: Text(
                                    tr("Show {0} more lines ({1} hidden)", [
                                      diffNumber(
                                        math.min(
                                          4000,
                                          lines.length - shown.length,
                                        ),
                                      ),
                                      diffNumber(lines.length - shown.length),
                                    ]),
                                    style: style.copyWith(
                                      color: p['web.accent-ink'],
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          )
                        else if (widget.truncated)
                          SizedBox(
                            width: b.maxWidth,
                            child: meta(tr("Diff truncated at 1 MB.")),
                          ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}
