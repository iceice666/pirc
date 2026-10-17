import 'dart:async';
import 'dart:math' as math;
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'common.dart';
import 'gateway.dart';
import 'web_controls.dart';
import 'composer_select.dart';
import 'composer_dock.dart';
import 'composer_attachments.dart';
import 'composer_clipboard.dart';
import 'external_image_drop_target.dart';
import 'approval_mode_control.dart';

const thinkingChoices = [
  ComposerOption('off', 'No thinking'),
  ComposerOption('minimal', 'Minimal'),
  ComposerOption('low', 'Low'),
  ComposerOption('medium', 'Medium'),
  ComposerOption('high', 'High'),
  ComposerOption('xhigh', 'Extra high'),
];

class ConversationComposer extends StatefulWidget {
  const ConversationComposer({
    super.key,
    required this.controller,
    required this.text,
  });
  final LiveController controller;
  final TextEditingController text;
  @override
  State<ConversationComposer> createState() => _ConversationComposerState();
}

class _ConversationComposerState extends State<ConversationComposer> {
  final focus = FocusNode();
  @override
  void initState() {
    super.initState();
    focus.addListener(_focusChanged);
    widget.text.addListener(_focusChanged);
  }

  void _focusChanged() {
    if (mounted) setState(() {});
  }

  @override
  void didUpdateWidget(covariant ConversationComposer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.text != widget.text) {
      oldWidget.text.removeListener(_focusChanged);
      widget.text.addListener(_focusChanged);
    }
  }

  @override
  void dispose() {
    widget.text.removeListener(_focusChanged);
    focus.dispose();
    super.dispose();
  }

  KeyEventResult _composerKey(FocusNode node, KeyEvent event) {
    final enter =
        event.logicalKey == LogicalKeyboardKey.enter ||
        event.logicalKey == LogicalKeyboardKey.numpadEnter;
    if (!enter || (event is! KeyDownEvent && event is! KeyRepeatEvent)) {
      return KeyEventResult.ignored;
    }
    final platform = Theme.of(context).platform;
    final desktop =
        platform == TargetPlatform.linux ||
        platform == TargetPlatform.macOS ||
        platform == TargetPlatform.windows;
    final touch =
        !desktop && !RendererBinding.instance.mouseTracker.mouseIsConnected;
    final composing = widget.text.value.composing;
    if (touch ||
        HardwareKeyboard.instance.isShiftPressed ||
        (composing.isValid && !composing.isCollapsed)) {
      return KeyEventResult.ignored;
    }
    final c = widget.controller;
    if (c.canWrite &&
        widget.text.text.trim().isNotEmpty &&
        !c.uploading &&
        !c.unknownCommand) {
      unawaited(c.send(c.running ? 'steer' : 'prompt'));
    }
    // Desktop Enter is consumed even when submission is temporarily blocked.
    return KeyEventResult.handled;
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller,
        colors = palette(context),
        viewport = MediaQuery.sizeOf(context);
    final phone = viewport.width <= 650;
    final offline = c.connection == 'offline' || c.connection == 'stopped';
    final stopping = obj(c.state['run'])['status'] == 'stopping';
    final empty = widget.text.text.trim().isEmpty;
    final stopPrimary = c.running && empty && !c.busy;
    final placeholder = offline
        ? 'Offline draft — it will stay on this device'
        : c.control['held'] != true
        ? 'Take control to send a message'
        : c.running
        ? 'Steer the current run…'
        : 'Tell the agent what to work on…';
    final model = c.selectedModel;
    final options = c.models
        .where((m) => m['available'] != false)
        .map(
          (m) => ComposerOption(
            '${m['provider']}/${m['id']}',
            '${m['displayName'] ?? m['name'] ?? m['id']}',
            '${m['provider']}',
          ),
        )
        .toList();
    Widget action(
      IconData icon,
      String label,
      VoidCallback? run, {
      bool primary = false,
      bool stop = false,
    }) {
      final iconSize = stop ? (primary ? 13.0 : 11.0) : 19.0;
      final glyph = stop
          ? SizedBox.square(
              dimension: iconSize * 20 / 24,
              child: DecoratedBox(
                key: ValueKey(
                  'composer-stop-glyph-${primary ? 'primary' : 'secondary'}',
                ),
                decoration: BoxDecoration(
                  color: primary
                      ? colors['surface.page']
                      : run == null
                      ? colors['text.faint']
                      : colors['text.secondary'],
                  borderRadius: BorderRadius.circular(iconSize / 8),
                ),
              ),
            )
          : Icon(icon, size: iconSize);
      return Tooltip(
        message: label,
        child: Semantics(
          label: label,
          button: true,
          enabled: run != null,
          child: SizedBox(
            width: 34,
            height: 34,
            child: IconButton(
              onPressed: run,
              icon: glyph,
              style: IconButton.styleFrom(
                minimumSize: const Size(34, 34),
                maximumSize: const Size(34, 34),
                padding: EdgeInsets.zero,
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                shape: const CircleBorder(),
                backgroundColor: primary
                    ? colors[stop ? 'text.primary' : 'accent.default']
                    : Colors.transparent,
                disabledBackgroundColor: primary
                    ? colors[stop ? 'text.primary' : 'text.faint']
                    : Colors.transparent,
                foregroundColor: primary
                    ? colors[stop ? 'surface.page' : 'accent.on']
                    : colors['text.secondary'],
                disabledForegroundColor: primary
                    ? colors['surface.page']
                    : colors['text.faint'],
                side: primary
                    ? BorderSide.none
                    : BorderSide(color: colors['web.line-dark']),
              ),
            ),
          ),
        ),
      );
    }

    final status = <String>[
      for (final e in obj(c.state['widgets']).entries)
        if (!['goal', 'local-todo'].contains(e.key) &&
            e.value is List &&
            (e.value as List).isNotEmpty)
          '${(e.value as List).first}',
      for (final e in obj(c.state['statuses']).entries)
        if (!['background-task', 'agent-team'].contains(e.key) &&
            e.value != null &&
            '${e.value}'.isNotEmpty)
          '${e.value}',
    ];
    return Padding(
      padding: EdgeInsets.fromLTRB(
        phone
            ? 8
            : viewport.width <= 1100
            ? 24
            : 32,
        0,
        phone
            ? 8
            : viewport.width <= 1100
            ? 24
            : 32,
        phone ? 8 : 16,
      ),
      child: Align(
        alignment: Alignment.bottomCenter,
        heightFactor: 1,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 796),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Flexible(
                fit: FlexFit.loose,
                child: ComposerDockOverlap(
                  key: const Key('composer-dock-negative-bottom-margin'),
                  child: SingleChildScrollView(
                    child: ComposerDock(controller: c),
                  ),
                ),
              ),
              if (c.actionError != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: WebNotice(c.actionError!, error: true),
                ),
              if (c.unknownCommand)
                Wrap(
                  children: [
                    WebButton(
                      'Check latest state',
                      onPressed: c.refreshSession,
                    ),
                    WebButton(
                      'I checked; continue…',
                      onPressed: () async {
                        await c.refreshSession();
                        if (!context.mounted) return;
                        if (await confirm(
                          context,
                          'Continue after checking?',
                          'Check whether the previous message arrived. Continuing unlocks sending and does not resend that operation.',
                          action: 'Continue',
                          cancelLabel: 'Cancel',
                        )) {
                          await c.acknowledgeCommand();
                        }
                      },
                    ),
                  ],
                ),
              Container(
                decoration: BoxDecoration(
                  color: colors['surface.input'],
                  borderRadius: BorderRadius.circular(phone ? 20 : 28),
                  boxShadow: [
                    BoxShadow(
                      color:
                          colors[offline
                              ? 'status.danger'
                              : focus.hasFocus
                              ? 'line.strong'
                              : 'web.line-dark'],
                      spreadRadius: 1,
                    ),
                    BoxShadow(
                      color: Theme.of(context).brightness == Brightness.dark
                          ? Colors.black.withValues(alpha: .30)
                          : const Color(0xff0f1115).withValues(alpha: .06),
                      blurRadius: 20,
                      offset: const Offset(0, 4),
                    ),
                  ],
                ),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(phone ? 20 : 28),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (c.approvalMode == 'full-access')
                        Semantics(
                          liveRegion: true,
                          child: Container(
                            key: const ValueKey('composer-full-access-notice'),
                            color: colors['status.warningSoft'],
                            padding: const EdgeInsets.symmetric(
                              horizontal: 20,
                              vertical: 8,
                            ),
                            child: Text(
                              'Full access: the agent runs commands and changes files without asking. Only your deny-list still asks.',
                              style: webText(
                                context,
                                size: 12,
                                weight: FontWeight.w600,
                                color: 'status.warning',
                              ),
                            ),
                          ),
                        ),
                      if (offline)
                        Container(
                          color: colors['status.dangerSoft'],
                          padding: const EdgeInsets.symmetric(
                            horizontal: 20,
                            vertical: 8,
                          ),
                          child: Text(
                            'You’re offline. This draft is saved locally and will never be sent automatically.',
                            style: webText(
                              context,
                              size: 12,
                              color: 'status.danger',
                            ).copyWith(height: kTextHeightNone),
                          ),
                        ),
                      if (c.attachments.isNotEmpty)
                        ComposerAttachmentStrip(
                          attachments: c.attachments,
                          onRemove: (attachment) {
                            c.attachments.remove(attachment);
                            c.changed();
                          },
                        ),
                      ExternalImageDropTarget(
                        controller: c,
                        child: ConstrainedBox(
                          constraints: BoxConstraints(
                            minHeight: phone ? 44 : 56,
                            maxHeight: phone ? 160 : 240,
                          ),
                          child: Actions(
                            actions: {
                              PasteTextIntent: CallbackAction<PasteTextIntent>(
                                onInvoke: (_) {
                                  pasteComposerClipboard(c, widget.text);
                                  return null;
                                },
                              ),
                            },
                            child: Focus(
                              canRequestFocus: false,
                              onKeyEvent: _composerKey,
                              child: TextField(
                                contextMenuBuilder: (context, editable) =>
                                    ComposerClipboardMenu(
                                      controller: c,
                                      text: widget.text,
                                      editable: editable,
                                    ),
                                key: const Key('live-draft'),
                                controller: widget.text,
                                focusNode: focus,
                                minLines: 1,
                                maxLines: null,
                                keyboardType: TextInputType.multiline,
                                contentInsertionConfiguration:
                                    ContentInsertionConfiguration(
                                      allowedMimeTypes: const [
                                        ...kDefaultContentInsertionMimeTypes,
                                        'image/svg+xml',
                                        'image/avif',
                                        'image/heic',
                                        'image/heif',
                                      ],
                                      onContentInserted: c.insertImage,
                                    ),
                                textInputAction: TextInputAction.newline,
                                style: webText(
                                  context,
                                  size: 16,
                                ).copyWith(height: (phone ? 22 : 24) / 16),
                                decoration: InputDecoration(
                                  hintText: placeholder,
                                  hintStyle: webText(
                                    context,
                                    size: 16,
                                    color: 'text.faint',
                                  ).copyWith(height: (phone ? 22 : 24) / 16),
                                  isDense: true,
                                  filled: false,
                                  border: InputBorder.none,
                                  enabledBorder: InputBorder.none,
                                  focusedBorder: InputBorder.none,
                                  contentPadding: EdgeInsets.fromLTRB(
                                    phone ? 14 : 20,
                                    phone ? 10 : 14,
                                    phone ? 14 : 20,
                                    phone ? 0 : 4,
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                      Container(
                        constraints: BoxConstraints(minHeight: phone ? 46 : 52),
                        padding: phone
                            ? const EdgeInsets.fromLTRB(8, 4, 6, 6)
                            : const EdgeInsets.fromLTRB(12, 8, 10, 10),
                        child: LayoutBuilder(
                          builder: (context, constraints) {
                            final available = math.max(
                              0.0,
                              constraints.maxWidth -
                                  34 -
                                  34 -
                                  (c.running && !stopPrimary ? 40 : 0) -
                                  16,
                            );
                            final small = viewport.width <= 640;
                            double labelWidth(String label) {
                              final painter = TextPainter(
                                text: TextSpan(
                                  text: label,
                                  style: webText(
                                    context,
                                    size: small ? 12 : 13,
                                  ),
                                ),
                                textDirection: TextDirection.ltr,
                                textScaler: MediaQuery.textScalerOf(context),
                              )..layout();
                              final width =
                                  painter.width + (small ? 10 : 16) + 19;
                              painter.dispose();
                              return width;
                            }

                            final thinkingLabel = thinkingChoices
                                .where((o) => o.value == c.selectedThinking)
                                .first
                                .label;
                            final approvalWidth = c.approvalMode == null
                                ? 0.0
                                : math.min(
                                    labelWidth(
                                      approvalModeLabels[c.approvalMode]!,
                                    ),
                                    available * .4,
                                  );
                            final selectorsAvailable = math.max(
                              0.0,
                              available -
                                  (c.approvalMode == null
                                      ? 0
                                      : approvalWidth + 4),
                            );
                            final thinkingWidth = math.min(
                              labelWidth(thinkingLabel),
                              selectorsAvailable * .75,
                            );
                            final modelWidth = math.min(
                              phone ? 112.0 : 220.0,
                              math.max(0.0, selectorsAvailable - thinkingWidth),
                            );
                            return Row(
                              children: [
                                action(
                                  LucideIcons.paperclip,
                                  'Attach files',
                                  c.uploading
                                      ? null
                                      : () async {
                                          try {
                                            await c.attach();
                                          } catch (e) {
                                            c.actionError =
                                                LiveController.describe(e);
                                            c.changed();
                                          }
                                        },
                                ),
                                const SizedBox(width: 4),
                                ConstrainedBox(
                                  constraints: BoxConstraints(
                                    maxWidth: modelWidth,
                                  ),
                                  child: ComposerSelect(
                                    label: 'Model',
                                    value: model == null
                                        ? ''
                                        : '${model['provider']}/${model['id']}',
                                    options: options,
                                    disabled: c.running,
                                    onSelect: (key) {
                                      final selected = c.models.firstWhere(
                                        (m) =>
                                            '${m['provider']}/${m['id']}' ==
                                            key,
                                      );
                                      c.changeModel(selected);
                                    },
                                  ),
                                ),
                                const SizedBox(width: 4),
                                ConstrainedBox(
                                  constraints: BoxConstraints(
                                    maxWidth: thinkingWidth,
                                  ),
                                  child: ComposerSelect(
                                    label: 'Reasoning effort',
                                    value: c.selectedThinking,
                                    options: thinkingChoices,
                                    onSelect: c.changeThinking,
                                  ),
                                ),
                                if (c.approvalMode != null) ...[
                                  const SizedBox(width: 4),
                                  ConstrainedBox(
                                    constraints: BoxConstraints(
                                      maxWidth: approvalWidth,
                                    ),
                                    child: ApprovalModeControl(controller: c),
                                  ),
                                ],
                                const Spacer(),
                                if (c.running && !stopPrimary) ...[
                                  action(
                                    LucideIcons.square,
                                    'Stop run',
                                    c.canControl && !stopping
                                        ? () => c.sendCommand({'type': 'stop'})
                                        : null,
                                    stop: true,
                                  ),
                                  const SizedBox(width: 6),
                                ],
                                const SizedBox(width: 4),
                                if (c.busy || (stopPrimary && stopping))
                                  SizedBox(
                                    width: 34,
                                    height: 34,
                                    child: Padding(
                                      padding: const EdgeInsets.all(8),
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                        color: colors['text.secondary'],
                                      ),
                                    ),
                                  )
                                else
                                  action(
                                    stopPrimary
                                        ? LucideIcons.square
                                        : LucideIcons.arrowUp,
                                    stopPrimary ? 'Stop run' : 'Send message',
                                    c.canWrite &&
                                            (stopPrimary
                                                ? !stopping
                                                : !empty &&
                                                      !c.uploading &&
                                                      !c.unknownCommand)
                                        ? () => stopPrimary
                                              ? c.sendCommand({'type': 'stop'})
                                              : c.send(
                                                  c.running
                                                      ? 'steer'
                                                      : 'prompt',
                                                )
                                        : null,
                                    primary: true,
                                    stop: stopPrimary,
                                  ),
                              ],
                            );
                          },
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              if (status.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.fromLTRB(14, 6, 14, 0),
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      status.join(' · '),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: webText(
                        context,
                        size: 12,
                        color: 'text.muted',
                      ).copyWith(height: 14 / 12),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
