import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'common.dart';
import 'gateway.dart';
import 'timeline_models.dart' show instant;
import 'web_controls.dart';

/// A delegated session's confirm relayed to the chat that started it. The
/// gateway answers these without the chat's control lease.
bool isRelayedInteraction(Json? question) =>
    '${question?['id'] ?? ''}'.startsWith('relay.');

/// "From {sessionName} ({workspace})" for a relayed interaction, else null.
String? relayedFromLabel(Json question) {
  final relayed = obj(question['relayed']);
  if (relayed['sessionId'] is! String) return null;
  final name = '${relayed['sessionName'] ?? ''}'.trim();
  final workspace = '${relayed['workspace'] ?? ''}'.trim();
  return 'From ${name.isEmpty ? 'a delegated session' : name}'
      '${workspace.isEmpty ? '' : ' ($workspace)'}';
}

/// The web InteractionCard's presentation and local answer draft. No transport.
class NativeInteractionCard extends StatefulWidget {
  const NativeInteractionCard({
    super.key,
    required this.question,
    required this.onAnswer,
    this.disabled = false,
    this.models = const [],
    this.initialChoice,
    this.onOpenSession,
  });
  final Json question;
  final Future<void> Function(Json) onAnswer;

  /// Opens a relayed interaction's delegated session.
  final ValueChanged<String>? onOpenSession;
  final bool disabled;
  final List<Json> models;
  final String? initialChoice;
  @override
  State<NativeInteractionCard> createState() => _NativeInteractionCardState();
}

class _NativeInteractionCardState extends State<NativeInteractionCard> {
  final text = TextEditingController();
  final selected = <String>{};
  final nodes = <FocusNode>[];
  String model = '', thinking = '';
  Timer? timer;
  bool expired = false, sending = false, asUserRequest = false;
  Json get q => widget.question;
  @override
  void initState() {
    super.initState();
    reset();
  }

  void reset() {
    text.text = ['input', 'editor'].contains(q['kind'])
        ? '${q['initialValue'] ?? ''}'
        : '';
    selected.clear();
    if (widget.initialChoice != null &&
        rows(q['options']).any((o) => o['value'] == widget.initialChoice)) {
      selected.add(widget.initialChoice!);
    }
    final choice = obj(q['modelChoice']), suggestion = obj(choice['model']);
    model = suggestion['provider'] is String && suggestion['id'] is String
        ? jsonEncode([suggestion['provider'], suggestion['id']])
        : '';
    thinking = '${choice['thinking'] ?? ''}';
    asUserRequest =
        q['kind'] == 'confirm' &&
        obj(q['userRequestChoice'])['checked'] == true;
    for (final node in nodes) {
      node.dispose();
    }
    nodes.clear();
    nodes.addAll(rows(q['options']).map((_) => FocusNode()));
    armExpiry();
  }

  void armExpiry() {
    timer?.cancel();
    final at = instant(q['expiresAt']);
    expired = at != null && !at.isAfter(DateTime.now());
    if (at != null && !expired) {
      timer = Timer(at.difference(DateTime.now()), () {
        if (mounted) setState(() => expired = true);
      });
    }
  }

  @override
  void didUpdateWidget(covariant NativeInteractionCard old) {
    super.didUpdateWidget(old);
    if (old.question['id'] != q['id'] ||
        old.question['epoch'] != q['epoch'] ||
        old.question['kind'] != q['kind']) {
      reset();
    } else {
      if (jsonEncode(old.question['options']) != jsonEncode(q['options'])) {
        selected.retainAll(rows(q['options']).map((o) => '${o['value']}'));
        for (final node in nodes) {
          node.dispose();
        }
        nodes.clear();
        nodes.addAll(rows(q['options']).map((_) => FocusNode()));
      }
      if (jsonEncode(old.question['modelChoice']) !=
          jsonEncode(q['modelChoice'])) {
        final choice = obj(q['modelChoice']), suggestion = obj(choice['model']);
        model = suggestion['provider'] is String && suggestion['id'] is String
            ? jsonEncode([suggestion['provider'], suggestion['id']])
            : '';
        thinking = '${choice['thinking'] ?? ''}';
      }
      if (jsonEncode(old.question['userRequestChoice']) !=
          jsonEncode(q['userRequestChoice'])) {
        asUserRequest =
            q['kind'] == 'confirm' &&
            obj(q['userRequestChoice'])['checked'] == true;
      }
      if (old.question['expiresAt'] != q['expiresAt']) armExpiry();
    }
  }

  @override
  void dispose() {
    timer?.cancel();
    text.dispose();
    for (final node in nodes) {
      node.dispose();
    }
    super.dispose();
  }

  bool get locked => widget.disabled || expired || sending;
  void pick(String value) {
    if (locked) return;
    setState(() {
      if (q['multiple'] != true) {
        selected
          ..clear()
          ..add(value);
      } else if (!selected.add(value)) {
        selected.remove(value);
      }
    });
  }

  Future<void> answer(bool accept) async {
    if (locked || (accept && q['kind'] == 'select' && selected.isEmpty)) return;
    final Json payload;
    if (q['kind'] == 'confirm') {
      payload = {'confirmed': accept};
      if (accept &&
          asUserRequest &&
          obj(q['userRequestChoice'])['label'] is String) {
        payload['asUserRequest'] = true;
      }
      if (accept && q['modelChoice'] is Map) {
        final pair = model.isEmpty ? null : jsonDecode(model) as List;
        payload['model'] = pair == null
            ? null
            : {'provider': pair[0], 'id': pair[1]};
        payload['thinking'] = thinking.isEmpty ? null : thinking;
      }
    } else if (!accept) {
      payload = {'cancelled': true};
    } else if (q['kind'] == 'select') {
      payload = {'values': selected.toList()};
    } else {
      payload = {'value': text.text};
    }
    setState(() => sending = true);
    try {
      await widget.onAnswer(payload);
    } finally {
      if (mounted) setState(() => sending = false);
    }
  }

  Widget action(String label, bool accept) => Opacity(
    opacity: locked || (accept && q['kind'] == 'select' && selected.isEmpty)
        ? .45
        : 1,
    child: SizedBox(
      height: 32,
      child: TextButton(
        onPressed:
            locked || (accept && q['kind'] == 'select' && selected.isEmpty)
            ? null
            : () => answer(accept),
        style: TextButton.styleFrom(
          minimumSize: const Size(0, 32),
          padding: const EdgeInsets.symmetric(horizontal: 12),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          shape: const StadiumBorder(),
          backgroundColor: accept
              ? palette(context)['text.primary']
              : Colors.transparent,
          foregroundColor: palette(
            context,
          )[accept ? 'surface.page' : 'text.primary'],
          disabledForegroundColor: palette(
            context,
          )[accept ? 'surface.page' : 'text.primary'],
          textStyle: webText(
            context,
            size: 13,
            weight: FontWeight.w500,
          ).copyWith(height: kTextHeightNone),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (!accept) ...[
              const Icon(LucideIcons.x, size: 15),
              const SizedBox(width: 6),
            ],
            Flexible(child: Text(label)),
            if (accept) ...[
              const SizedBox(width: 6),
              const Icon(LucideIcons.arrowRight, size: 15),
            ],
          ],
        ),
      ),
    ),
  );
  Widget option(Json o, int index) {
    final value = '${o['value']}',
        chosen = selected.contains(value),
        multiple = q['multiple'] == true;
    final node = nodes[index];
    node.skipTraversal =
        !multiple && (selected.isEmpty ? index != 0 : selected.first != value);
    node.canRequestFocus = !locked;
    return Semantics(
      label:
          '${o['label']}${o['description'] == null ? '' : '. ${o['description']}'}',
      excludeSemantics: true,
      onTap: locked ? null : () => pick(value),
      checked: chosen,
      inMutuallyExclusiveGroup: !multiple,
      enabled: !locked,
      child: Focus(
        focusNode: node,
        onFocusChange: (_) => setState(() {}),
        onKeyEvent: (_, event) {
          if (locked || event is! KeyDownEvent) return KeyEventResult.ignored;
          final key = event.logicalKey;
          if (key == LogicalKeyboardKey.enter ||
              key == LogicalKeyboardKey.space) {
            pick(value);
            return KeyEventResult.handled;
          }
          if (!multiple &&
              [
                LogicalKeyboardKey.arrowDown,
                LogicalKeyboardKey.arrowRight,
                LogicalKeyboardKey.arrowUp,
                LogicalKeyboardKey.arrowLeft,
                LogicalKeyboardKey.home,
                LogicalKeyboardKey.end,
              ].contains(key)) {
            final next = key == LogicalKeyboardKey.home
                ? 0
                : key == LogicalKeyboardKey.end
                ? nodes.length - 1
                : (index +
                          ([
                                LogicalKeyboardKey.arrowDown,
                                LogicalKeyboardKey.arrowRight,
                              ].contains(key)
                              ? 1
                              : -1) +
                          nodes.length) %
                      nodes.length;
            pick('${rows(q['options'])[next]['value']}');
            nodes[next].requestFocus();
            return KeyEventResult.handled;
          }
          return KeyEventResult.ignored;
        },
        child: Opacity(
          opacity: locked ? .45 : 1,
          child: Material(
            color: palette(context)[chosen ? 'accent.soft' : 'web.bg-hover'],
            borderRadius: BorderRadius.circular(12),
            child: InkWell(
              canRequestFocus: false,
              onTap: locked ? null : () => pick(value),
              borderRadius: BorderRadius.circular(12),
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 10,
                ),
                // Web selection uses an inset shadow, so choosing/focusing an
                // option must not add layout padding or move its text.
                foregroundDecoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(12),
                  border: chosen || node.hasFocus
                      ? Border.all(
                          color: palette(context)['accent.default'],
                          width: node.hasFocus ? 2 : 1,
                        )
                      : null,
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Container(
                      width: 16,
                      height: 16,
                      margin: const EdgeInsets.only(top: 2),
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        border: Border.all(
                          color: palette(
                            context,
                          )[chosen ? 'accent.default' : 'line.strong'],
                          width: chosen ? 5 : 1.5,
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            '${o['label']}',
                            style: webText(
                              context,
                              size: 14,
                              weight: FontWeight.w500,
                            ).copyWith(height: 1.15),
                          ),
                          if (o['description'] != null) ...[
                            const SizedBox(height: 2),
                            Text(
                              '${o['description']}',
                              style: webText(
                                context,
                                size: 12,
                                color: 'text.muted',
                              ).copyWith(height: 1.45),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget picker(
    String label,
    String selectedValue,
    List<(String, String)> choices,
    ValueChanged<String> change,
  ) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8),
    decoration: BoxDecoration(
      color: palette(context)['web.bg-subtle'],
      borderRadius: BorderRadius.circular(12),
    ),
    child: DropdownButtonHideUnderline(
      child: DropdownButton<String>(
        value: selectedValue,
        isExpanded: true,
        isDense: true,
        padding: const EdgeInsets.symmetric(vertical: 3),
        borderRadius: BorderRadius.circular(12),
        dropdownColor: palette(context)['surface.layer'],
        style: webText(context, size: 16).copyWith(height: 1.15),
        hint: Text(label),
        icon: Icon(
          LucideIcons.chevronDown,
          size: 14,
          color: palette(context)['text.muted'],
        ),
        items: [
          for (final choice in choices)
            DropdownMenuItem(
              value: choice.$1,
              child: Text(
                choice.$2,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
        ],
        onChanged: locked
            ? null
            : (v) {
                if (v != null) setState(() => change(v));
              },
      ),
    ),
  );
  @override
  Widget build(BuildContext context) {
    final p = palette(context), phone = MediaQuery.sizeOf(context).width <= 650;
    final at = instant(q['expiresAt']);
    final modelOptions = <String, String>{
      '': 'Default model',
      for (final m in widget.models.where((m) => m['available'] == true))
        jsonEncode([m['provider'], m['id']]):
            '${m['displayName']} · ${m['provider']}',
    };
    if (model.isNotEmpty && !modelOptions.containsKey(model)) {
      modelOptions[model] = (jsonDecode(model) as List).join(' / ');
    }
    final levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    final modelPickers = Row(
      children: [
        Expanded(
          flex: 2,
          child: picker(
            'Model',
            model,
            modelOptions.entries.map((e) => (e.key, e.value)).toList(),
            (v) => model = v,
          ),
        ),
        const SizedBox(width: 6),
        Expanded(
          child: picker('Thinking', thinking, [
            ('', 'Default thinking'),
            for (final level in levels) (level, 'Thinking: $level'),
            if (thinking.isNotEmpty && !levels.contains(thinking))
              (thinking, 'Thinking: $thinking'),
          ], (v) => thinking = v),
        ),
      ],
    );
    final actions = Wrap(
      spacing: 6,
      runSpacing: 6,
      alignment: WrapAlignment.end,
      children: [
        action(
          q['kind'] == 'confirm' ? '${q['cancelLabel'] ?? 'No'}' : 'Cancel',
          false,
        ),
        action(
          q['kind'] == 'confirm'
              ? '${q['confirmLabel'] ?? 'Yes, continue'}'
              : 'Submit',
          true,
        ),
      ],
    );
    final clock = at == null
        ? const SizedBox.shrink()
        : Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(LucideIcons.clock3, size: 14, color: p['text.muted']),
              const SizedBox(width: 5),
              Flexible(
                child: Text(
                  '${expired ? 'Expired' : 'Expires'} ${MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(at))}',
                  style: webText(context, size: 12, color: 'text.muted'),
                ),
              ),
            ],
          );
    return Opacity(
      opacity: expired ? .65 : 1,
      child: Container(
        margin: const EdgeInsets.only(top: 4, bottom: 24),
        padding: EdgeInsets.all(phone ? 14 : 16),
        decoration: BoxDecoration(
          color: p['surface.layer'],
          borderRadius: BorderRadius.circular(16),
          boxShadow: pircShadow(context, card: true),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 32,
                  height: 32,
                  decoration: BoxDecoration(
                    color: p['accent.soft'],
                    shape: BoxShape.circle,
                  ),
                  child: Icon(
                    LucideIcons.circleHelp,
                    size: 18,
                    color: p['accent.default'],
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Your input is needed',
                        style: webText(
                          context,
                          size: 12,
                          weight: FontWeight.w500,
                          color: 'accent.default',
                        ).copyWith(height: 18 / 12),
                      ),
                      Padding(
                        padding: const EdgeInsets.only(top: 2, bottom: 4),
                        child: Text(
                          '${q['title']}',
                          style: webText(
                            context,
                            size: 15,
                            weight: FontWeight.w600,
                          ).copyWith(height: 18 / 15),
                        ),
                      ),
                      if (relayedFromLabel(q) case final from?)
                        Padding(
                          key: const ValueKey('interaction-relayed-from'),
                          padding: const EdgeInsets.only(bottom: 4),
                          child: Wrap(
                            crossAxisAlignment: WrapCrossAlignment.center,
                            spacing: 8,
                            children: [
                              Text(
                                from,
                                style: webText(
                                  context,
                                  size: 12,
                                  color: 'text.muted',
                                ).copyWith(height: 18 / 12),
                              ),
                              if (widget.onOpenSession != null)
                                Semantics(
                                  link: true,
                                  child: GestureDetector(
                                    key: const ValueKey(
                                      'interaction-relayed-open',
                                    ),
                                    behavior: HitTestBehavior.opaque,
                                    onTap: () => widget.onOpenSession!(
                                      '${obj(q['relayed'])['sessionId']}',
                                    ),
                                    child: Text(
                                      'Open',
                                      style: webText(
                                        context,
                                        size: 12,
                                        weight: FontWeight.w500,
                                        color: 'accent.default',
                                      ).copyWith(height: 18 / 12),
                                    ),
                                  ),
                                ),
                            ],
                          ),
                        ),
                      if (q['description'] != null)
                        SelectionArea(
                          child: Text(
                            '${q['description']}',
                            style: webText(
                              context,
                              size: 13,
                              color: 'text.secondary',
                            ).copyWith(height: 1.55),
                          ),
                        ),
                    ],
                  ),
                ),
              ],
            ),
            if (q['kind'] == 'select')
              Padding(
                padding: const EdgeInsets.only(top: 14),
                child: Column(
                  children: [
                    for (final (i, o) in rows(q['options']).indexed) ...[
                      if (i > 0) const SizedBox(height: 6),
                      option(o, i),
                    ],
                  ],
                ),
              ),
            if (['input', 'editor'].contains(q['kind'])) ...[
              if (q['kind'] == 'editor')
                Padding(
                  padding: const EdgeInsets.only(top: 14, bottom: 6),
                  child: Text(
                    'Response ${q['language'] == null ? '' : '· ${q['language']}'}',
                    style: webText(context, size: 12, color: 'text.muted'),
                  ),
                )
              else
                const SizedBox(height: 14),
              Semantics(
                label: q['kind'] == 'editor' ? 'Response' : 'Your answer',
                child: TextField(
                  controller: text,
                  enabled: !locked,
                  minLines: q['kind'] == 'editor' ? 8 : 1,
                  maxLines: q['kind'] == 'editor' ? 8 : 1,
                  style: webText(context, size: 16).copyWith(
                    fontFamily: q['kind'] == 'editor' ? 'monospace' : null,
                    height: q['kind'] == 'editor' ? 1.5 : 1.15,
                  ),
                  decoration: InputDecoration(
                    hintText: q['kind'] == 'input'
                        ? '${q['placeholder'] ?? 'Type your answer…'}'
                        : null,
                    filled: true,
                    fillColor: p['web.bg-subtle'],
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 10,
                    ),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                      borderSide: BorderSide.none,
                    ),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                      borderSide: BorderSide.none,
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                      borderSide: BorderSide(color: p['accent.default']),
                    ),
                  ),
                ),
              ),
            ],
            if (q['kind'] == 'confirm' &&
                q['modelChoice'] == null &&
                !'${q['id']}'.startsWith('memory:'))
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(
                  'Choose whether the agent should continue with this action.',
                  style: webText(
                    context,
                    size: 13,
                    color: 'text.secondary',
                  ).copyWith(height: 1.55),
                ),
              ),
            if (q['kind'] == 'confirm' &&
                obj(q['userRequestChoice'])['label'] is String)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Material(
                  type: MaterialType.transparency,
                  child: CheckboxListTile(
                    contentPadding: EdgeInsets.zero,
                    controlAffinity: ListTileControlAffinity.leading,
                    dense: true,
                    value: asUserRequest,
                    onChanged: locked
                        ? null
                        : (value) =>
                              setState(() => asUserRequest = value == true),
                    title: Text(
                      '${obj(q['userRequestChoice'])['label']}',
                      style: webText(context, size: 13),
                    ),
                    subtitle: Text(
                      'Auto mode then reads the task as if you had typed it in that session, so an operation the task names exactly is not stopped as dangerous. Only for the run the task starts.',
                      style: webText(
                        context,
                        size: 12,
                        color: 'text.secondary',
                      ),
                    ),
                  ),
                ),
              ),
            const SizedBox(height: 16),
            LayoutBuilder(
              builder: (context, bounds) {
                double measure(String label, double size, FontWeight weight) {
                  final painter = TextPainter(
                    text: TextSpan(
                      text: label,
                      style: webText(context, size: size, weight: weight),
                    ),
                    textDirection: Directionality.of(context),
                    textScaler: MediaQuery.textScalerOf(context),
                  )..layout();
                  final width = painter.width;
                  painter.dispose();
                  return width;
                }

                final labels = q['kind'] == 'confirm'
                    ? [
                        '${q['cancelLabel'] ?? 'No'}',
                        '${q['confirmLabel'] ?? 'Yes, continue'}',
                      ]
                    : ['Cancel', 'Submit'];
                final actionWidth = labels.fold<double>(
                  6,
                  (sum, label) =>
                      sum + measure(label, 13, FontWeight.w500) + 45,
                );
                final clockWidth = at == null
                    ? 0
                    : measure(
                            '${expired ? 'Expired' : 'Expires'} ${MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(at))}',
                            12,
                            FontWeight.w400,
                          ) +
                          19;
                if (q['modelChoice'] is Map &&
                    bounds.maxWidth > 600 &&
                    MediaQuery.textScalerOf(context).scale(13) <= 18) {
                  return Row(
                    children: [
                      if (at != null) ...[clock, const SizedBox(width: 12)],
                      Expanded(child: modelPickers),
                      const SizedBox(width: 12),
                      ConstrainedBox(
                        constraints: BoxConstraints(maxWidth: actionWidth),
                        child: actions,
                      ),
                    ],
                  );
                }
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (q['modelChoice'] is Map) ...[
                      modelPickers,
                      const SizedBox(height: 12),
                    ],
                    if (at != null &&
                        clockWidth + 12 + actionWidth > bounds.maxWidth) ...[
                      clock,
                      const SizedBox(height: 12),
                      Align(alignment: Alignment.centerRight, child: actions),
                    ] else
                      Row(
                        children: [
                          if (at != null) ...[clock, const SizedBox(width: 12)],
                          Expanded(
                            child: Align(
                              alignment: Alignment.centerRight,
                              child: actions,
                            ),
                          ),
                        ],
                      ),
                  ],
                );
              },
            ),
          ],
        ),
      ),
    );
  }
}
