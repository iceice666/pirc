import '../l10n/app_i18n.dart';
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'attention.dart';
import 'gateway.dart';
import 'common.dart';
import 'web_controls.dart';

class MemorySettings extends StatefulWidget {
  const MemorySettings({
    super.key,
    required this.controller,
    this.onOpenChat,
    this.clock,
  });
  final LiveController controller;
  final ValueChanged<String>? onOpenChat;
  final DateTime Function()? clock;
  @override
  State<MemorySettings> createState() => _MemorySettingsState();
}

class _MemorySettingsState extends State<MemorySettings> {
  AttentionState get a => widget.controller.attention;
  String? confirming, historyFor, historyError;
  List<Json> versions = [];
  bool removedOpen = false, historyLoading = false;
  int _revision = -1, _historyRequest = 0;
  @override
  void initState() {
    super.initState();
    a.addListener(_update);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(a.refreshMemory());
    });
  }

  @override
  void dispose() {
    a.removeListener(_update);
    ++_historyRequest;
    super.dispose();
  }

  void _update() {
    if (!mounted) return;
    if (_revision != a.memoryRevision) {
      _revision = a.memoryRevision;
      confirming = null;
      final entries = [
        ...rows(a.memory?['user']),
        ...rows(a.memory?['notes']),
        ...rows(a.memory?['removed']),
      ];
      if (historyFor != null && !entries.any((e) => e['id'] == historyFor)) {
        historyFor = null;
        ++_historyRequest;
      } else if (historyFor != null) {
        unawaited(loadHistory(historyFor!));
      }
    }
    setState(() {});
  }

  Future<void> loadHistory(String id) async {
    final request = ++_historyRequest;
    setState(() {
      historyLoading = true;
      historyError = null;
    });
    try {
      final response = await a.history(id);
      if (mounted && request == _historyRequest && historyFor == id) {
        setState(() => versions = response);
      }
    } catch (e) {
      if (mounted && request == _historyRequest) {
        setState(() => historyError = attentionRequestError(e));
      }
    } finally {
      if (mounted && request == _historyRequest) {
        setState(() => historyLoading = false);
      }
    }
  }

  String ago(dynamic time) {
    final at = time is num
        ? DateTime.fromMillisecondsSinceEpoch(time.toInt())
        : DateTime.tryParse('$time');
    if (at == null) return '';
    final seconds = (widget.clock?.call() ?? DateTime.now())
        .difference(at)
        .inSeconds;
    if (seconds < 60) return tr("just now");
    if (seconds < 3600) return tr("{0}m ago", [seconds ~/ 60]);
    if (seconds < 86400) return tr("{0}h ago", [seconds ~/ 3600]);
    if (seconds < 2592000) return tr("{0}d ago", [seconds ~/ 86400]);
    return MaterialLocalizations.of(context).formatCompactDate(at);
  }

  Widget paragraph(String text, {bool small = false}) => Padding(
    padding: EdgeInsets.only(bottom: small ? 0 : 8),
    child: Text(
      text,
      style: webText(
        context,
        size: 13,
        color: 'text.muted',
      ).copyWith(height: 1.55),
    ),
  );
  Widget heading(String text) => Padding(
    padding: const EdgeInsets.only(top: 16, bottom: 6),
    child: Text(
      text,
      style: webText(
        context,
        size: 13,
        weight: FontWeight.w600,
      ).copyWith(height: 15 / 13),
    ),
  );
  Widget small(String text) => Text(
    text,
    style: webText(
      context,
      size: 12,
      color: 'text.muted',
    ).copyWith(height: 14 / 12),
  );
  Widget chat(String? id) {
    final name = obj(a.memory?['sessions'])[id];
    if (id == null || name == null) return small(tr("a chat that is gone"));
    return InkWell(
      onTap: () {
        if (widget.onOpenChat != null) {
          widget.onOpenChat!(id);
        } else {
          unawaited(widget.controller.open(id));
          if (Navigator.canPop(context)) Navigator.pop(context);
        }
      },
      child: Text(
        '$name',
        style: webText(
          context,
          size: 12,
          color: 'accent.default',
        ).copyWith(decoration: TextDecoration.underline, height: 14 / 12),
      ),
    );
  }

  Widget sourceLine(String prefix, String? id, String suffix) => Text.rich(
    TextSpan(
      children: [
        TextSpan(text: prefix),
        WidgetSpan(
          alignment: PlaceholderAlignment.baseline,
          baseline: TextBaseline.alphabetic,
          // WidgetSpan scales its child with the surrounding text. Apply the
          // user scale once, rather than again inside the link Text.
          child: MediaQuery.withNoTextScaling(child: chat(id)),
        ),
        TextSpan(text: suffix),
      ],
    ),
    style: webText(
      context,
      size: 12,
      color: 'text.muted',
    ).copyWith(height: 14 / 12),
  );
  Widget action(
    String label,
    VoidCallback run, {
    bool primary = false,
    bool danger = false,
    bool allowBusy = false,
  }) => WebButton(
    label,
    height: 32,
    fontSize: 13,
    horizontalPadding: 12,
    primary: primary,
    danger: danger,
    onPressed: a.memoryBusy != null && !allowBusy ? null : run,
  );
  Widget card(
    List<Widget> content,
    List<Widget> actions, {
    bool proposal = false,
    List<Widget> history = const [],
  }) => Container(
    margin: EdgeInsets.zero,
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
    decoration: BoxDecoration(
      color: proposal ? Colors.transparent : palette(context)['surface.subtle'],
      border: proposal ? Border.all(color: palette(context)['web.line']) : null,
      borderRadius: BorderRadius.circular(8),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        LayoutBuilder(
          builder: (context, constraints) {
            final text = Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: content,
            );
            final buttons = Wrap(spacing: 6, runSpacing: 6, children: actions);
            // The source uses a fixed 240px text flex-basis. Only the action
            // text grows with the user's font scale, not that CSS basis.
            var actionsWidth = actions.isEmpty
                ? 0.0
                : 6.0 * (actions.length - 1);
            for (final action in actions) {
              if (action is! WebButton) {
                actionsWidth = constraints.maxWidth;
                break;
              }
              final painter = TextPainter(
                text: TextSpan(
                  text: action.label,
                  style: webText(
                    context,
                    size: action.fontSize,
                    weight: FontWeight.w500,
                  ),
                ),
                textDirection: Directionality.of(context),
                textScaler: MediaQuery.textScalerOf(context),
              )..layout();
              actionsWidth += painter.width + 2 * action.horizontalPadding;
              painter.dispose();
            }
            if (constraints.maxWidth >= 240 + 12 + actionsWidth) {
              return Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(child: text),
                  const SizedBox(width: 12),
                  buttons,
                ],
              );
            }
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [text, const SizedBox(height: 8), buttons],
            );
          },
        ),
        ...history,
      ],
    ),
  );
  Widget proposal(Json p) => card(
    [
      Text.rich(
        TextSpan(
          children: [
            TextSpan(
              text:
                  '${const {'add': 'Remember', 'replace': 'Change', 'remove': 'Forget'}[p['action']]}: ',
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
            TextSpan(
              text: '${p['content'] ?? obj(p['target'])['content'] ?? ''}',
            ),
          ],
        ),
        style: webText(context, size: 13).copyWith(height: 15 / 13),
      ),
      if (p['action'] == 'replace' && p['target'] != null) ...[
        const SizedBox(height: 2),
        small('Now: ${obj(p['target'])['content']}'),
      ],
      const SizedBox(height: 2),
      sourceLine(
        tr("You said “{0}” · ", [p['quote']]),
        p['sessionId'] as String?,
        ' · ${ago(p['createdAt'])}',
      ),
    ],
    [
      action(tr("Approve"), () => a.decideProposal(p, true), primary: true),
      action(tr("Reject"), () => a.decideProposal(p, false)),
    ],
    proposal: true,
  );
  Widget entry(Json e) {
    final id = '${e['id']}', source = obj(e['sources']);
    return card(
      [
        Text(
          '${e['content']}',
          style: webText(context, size: 13).copyWith(height: 15 / 13),
        ),
        const SizedBox(height: 2),
        sourceLine(
          '${describeOrigins(e['origins'])}${source['quote'] != null ? ' — you said “${source['quote']}”' : ''} · ',
          source['sessionId'] as String?,
          ' · ${ago(e['updatedAt'])}',
        ),
      ],
      [
        if (e['status'] == 'removed')
          action(tr("Restore"), () => a.restore(id))
        else
          action(tr("History"), () {
            setState(() {
              if (historyFor == id) {
                historyFor = null;
                ++_historyRequest;
              } else {
                historyFor = id;
                versions = [];
                unawaited(loadHistory(id));
              }
            });
          }, allowBusy: true),
        if (confirming == id) ...[
          action(tr("Forget for good"), () => a.forget(id), danger: true),
          action(
            tr("Cancel"),
            () => setState(() => confirming = null),
            allowBusy: true,
          ),
        ] else
          action(tr("Forget"), () => setState(() => confirming = id)),
      ],
      history: [
        if (historyFor == id)
          Container(
            margin: const EdgeInsets.only(top: 8),
            padding: const EdgeInsets.only(top: 8, left: 12),
            decoration: BoxDecoration(
              border: Border(
                top: BorderSide(color: palette(context)['web.line']),
              ),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (historyLoading && versions.isEmpty)
                  WebNotice(tr("Loading history…")),
                if (historyError != null) WebNotice(historyError!, error: true),
                for (final v in versions)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 6),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        small(
                          '${describeVersion(v, obj(a.memory?['sessions']))} · ${ago(v['at'])}',
                        ),
                        if (v['content'] != null)
                          Text(
                            '${v['content']}',
                            style: webText(
                              context,
                              size: 13,
                            ).copyWith(height: 15 / 13),
                          ),
                        if (v['content'] != null &&
                            v['content'] != e['content'])
                          action(
                            tr("Restore this"),
                            () => a.restore(
                              id,
                              revision: (v['revision'] as num).toInt(),
                            ),
                          ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    final view = a.memory;
    final usage = obj(view?['usage']);
    String number(dynamic n) => MaterialLocalizations.of(
      context,
    ).formatDecimal((n as num? ?? 0).toInt());
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'MEMORY',
          style: webText(
            context,
            size: 12,
            weight: FontWeight.w600,
            color: 'text.secondary',
          ).copyWith(height: 14 / 12, letterSpacing: .24),
        ),
        const SizedBox(height: 8),
        Text.rich(
          TextSpan(
            children: [
              TextSpan(
                text: tr("What your assistant remembers across chats. "),
              ),
              TextSpan(
                text: 'USER',
                style: TextStyle(fontWeight: FontWeight.w600),
              ),
              TextSpan(
                text: tr(
                  " is what you told it about yourself and changes only when you approve. ",
                ),
              ),
              TextSpan(
                text: 'MEMORY',
                style: TextStyle(fontWeight: FontWeight.w600),
              ),
              TextSpan(
                text: tr(
                  " holds the assistant's own notes. New chats start with both; open chats keep what they started with.",
                ),
              ),
            ],
          ),
          style: webText(
            context,
            size: 13,
            color: 'text.muted',
          ).copyWith(height: 1.55),
        ),
        const SizedBox(height: 8),
        if (a.memoryLoading && view == null) WebNotice(tr("Loading memory…")),
        if (a.memoryError != null) ...[
          WebNotice(a.memoryError!, error: true),
          if (view == null)
            Align(
              alignment: Alignment.centerLeft,
              child: WebButton(
                tr("Retry"),
                onPressed: a.memoryLoading ? null : a.refreshMemory,
              ),
            ),
        ],
        if (view != null) ...[
          paragraph(
            tr("USER {0}/{1} characters · MEMORY {2}/{3} characters", [
              number(obj(usage['user'])['used']),
              number(obj(usage['user'])['max']),
              number(obj(usage['note'])['used']),
              number(obj(usage['note'])['max']),
            ]),
            small: true,
          ),
          if (a.proposals.isNotEmpty) ...[
            heading(tr("Waiting for you")),
            for (final (index, p) in a.proposals.indexed) ...[
              if (index > 0) const SizedBox(height: 6),
              proposal(p),
            ],
          ],
          heading(tr("About you · USER")),
          if (rows(view['user']).isEmpty)
            paragraph(
              tr(
                "Nothing yet. When you tell the assistant about yourself, it asks you here first.",
              ),
            )
          else
            for (final (index, e) in rows(view['user']).indexed) ...[
              if (index > 0) const SizedBox(height: 6),
              entry(e),
            ],
          heading(tr("The assistant's notes · MEMORY")),
          if (rows(view['notes']).isEmpty)
            paragraph(tr("No notes yet."))
          else
            for (final (index, e) in rows(view['notes']).indexed) ...[
              if (index > 0) const SizedBox(height: 6),
              entry(e),
            ],
          if (rows(view['removed']).isNotEmpty) ...[
            const SizedBox(height: 12),
            Semantics(
              expanded: removedOpen,
              child: InkWell(
                onTap: () => setState(() => removedOpen = !removedOpen),
                child: Row(
                  children: [
                    Icon(
                      removedOpen
                          ? LucideIcons.chevronDown
                          : LucideIcons.chevronRight,
                      size: 13,
                    ),
                    const SizedBox(width: 6),
                    Text(
                      'Removed · ${rows(view['removed']).length}',
                      style: webText(
                        context,
                        size: 13,
                        color: 'text.secondary',
                      ),
                    ),
                  ],
                ),
              ),
            ),
            if (removedOpen) ...[
              const SizedBox(height: 6),
              for (final (index, e) in rows(view['removed']).indexed) ...[
                if (index > 0) const SizedBox(height: 6),
                entry(e),
              ],
            ],
          ],
          const SizedBox(height: 12),
          paragraph(
            tr(
              "Forget erases an entry with all its versions and keeps the same text from being saved again; rewordings are not caught. The chats it came from stay on the chat node, and repositories keep their own workspace memory.",
            ),
            small: true,
          ),
        ],
      ],
    );
  }
}
