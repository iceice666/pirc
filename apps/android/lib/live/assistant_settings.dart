import '../l10n/app_i18n.dart';
import 'dart:math' as math;
import 'package:flutter/rendering.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'gateway.dart';
import 'common.dart';
import 'web_controls.dart';

const assistantExplanation =
    "Soul defines the assistant's persona; Chat rules apply to all chats. Files stay on the chat node. Changes apply at the next agent start (new chats or restarted agents), not to an already running agent. Empty Soul restores the built-in identity.";

class AssistantSettings extends StatefulWidget {
  const AssistantSettings({super.key, required this.controller});
  final LiveController controller;
  @override
  State<AssistantSettings> createState() => _AssistantSettingsState();
}

class _AssistantSettingsState extends State<AssistantSettings> {
  Json binding = {};
  Json? prompts;
  bool loading = true, confirming = false;
  String? error;
  int request = 0, snapshot = 0;
  LiveController get c => widget.controller;
  String? origin, client;
  @override
  void initState() {
    super.initState();
    origin = c.origin;
    client = c.clientId;
    c.addListener(accountChanged);
    load();
  }

  @override
  void didUpdateWidget(covariant AssistantSettings old) {
    super.didUpdateWidget(old);
    if (old.controller != c) {
      old.controller.removeListener(accountChanged);
      c.addListener(accountChanged);
      accountChanged(force: true);
    }
  }

  void accountChanged({bool force = false}) {
    if (!force && origin == c.origin && client == c.clientId) return;
    origin = c.origin;
    client = c.clientId;
    binding = {};
    confirming = false;
    load();
  }

  @override
  void dispose() {
    c.removeListener(accountChanged);
    super.dispose();
  }

  Future<void> load() async {
    final token = ++request, origin = c.origin;
    setState(() {
      loading = true;
      error = null;
      prompts = null;
    });
    try {
      final next = await c.gateway.request('/api/assistant/node');
      if (!mounted || token != request || origin != c.origin) return;
      setState(() => binding = next);
      if (next['online'] == true) {
        final result = await c.gateway.request('/api/assistant/prompts');
        if (!mounted || token != request || origin != c.origin) return;
        setState(() {
          prompts = result;
          snapshot++;
        });
      }
    } catch (e) {
      if (mounted && token == request && origin == c.origin) {
        setState(() => error = LiveController.describe(e));
      }
    } finally {
      if (mounted && token == request && origin == c.origin) {
        setState(() => loading = false);
      }
    }
  }

  Future<void> release() async {
    final node = binding['nodeId'];
    if (node == null || loading) return;
    final token = ++request, origin = c.origin;
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final result = await c.gateway.request(
        '/api/assistant/node/release',
        method: 'POST',
        body: {'nodeId': node},
      );
      if (!mounted || token != request || origin != c.origin) return;
      setState(() {
        binding = result;
        prompts = null;
        confirming = false;
      });
    } catch (e) {
      if (mounted && token == request && origin == c.origin) {
        setState(() => error = LiveController.describe(e));
      }
    } finally {
      if (mounted && token == request && origin == c.origin) {
        setState(() => loading = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        AssistantSection(
          title: tr("Assistant"),
          children: [
            AssistantParagraph(tr(assistantExplanation)),
            AssistantParagraph(
              tr(
                "Chats no longer read AGENTS.md: move chat-relevant rules into CHAT.md.",
              ),
            ),
            if (binding['nodeId'] != null) ...[
              AssistantParagraph(
                tr("Chat node: {0} — {1}", [
                  binding['nodeId'],
                  binding['online'] == true ? 'online' : 'offline',
                ]),
                inlineCode: '${binding['nodeId']}',
                inlineCodeStart: tr("Chat node: ").length,
              ),
            ],
            if (binding['nodeId'] == null && !loading)
              AssistantParagraph(
                tr("No chat node is bound. Start a chat node to register it."),
              ),
            if (confirming && binding['nodeId'] != null)
              AssistantParagraph(
                tr(
                  "Stop the old chat node before releasing it, or it may reconnect and claim the binding again. Releasing disconnects it; the next chat node to register will be bound.",
                ),
              ),
            Wrap(
              spacing: 4,
              runSpacing: 2,
              children: [
                if (binding['nodeId'] != null)
                  if (confirming) ...[
                    AssistantButton(
                      tr("Confirm release"),
                      filled: true,
                      onPressed: loading ? null : release,
                    ),
                    AssistantButton(
                      tr("Cancel"),
                      onPressed: loading
                          ? null
                          : () => setState(() => confirming = false),
                    ),
                  ] else
                    AssistantButton(
                      tr("Release chat node binding"),
                      onPressed: loading
                          ? null
                          : () => setState(() => confirming = true),
                    ),
                AssistantButton(
                  tr("Refresh"),
                  onPressed: loading ? null : load,
                ),
              ],
            ),
            if (loading) AssistantParagraph(tr("Loading…"), live: true),
            if (error != null)
              AssistantParagraph(error!, error: true, live: true),
          ],
        ),
        if (prompts != null)
          for (final name in ['soul', 'chat'])
            AssistantPromptEditor(
              key: ValueKey('$snapshot:$name'),
              controller: c,
              name: name,
              nodeId: '${prompts!['nodeId']}',
              prompt: obj(prompts![name]),
            ),
      ],
    );
  }
}

class AssistantSection extends StatelessWidget {
  const AssistantSection({
    super.key,
    required this.title,
    required this.children,
    this.divider = false,
  });
  final String title;
  final List<Widget> children;
  final bool divider;
  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return Container(
      margin: EdgeInsets.only(top: divider ? 18 : 0),
      padding: EdgeInsets.only(top: divider ? 16 : 0),
      decoration: divider
          ? BoxDecoration(
              border: Border(
                top: BorderSide(color: palette(context)['web.line']),
              ),
            )
          : null,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Semantics(
            headingLevel: 3,
            child: Text(
              title.toUpperCase(),
              style: webText(
                context,
                size: 12,
                weight: FontWeight.w600,
                color: 'text.secondary',
              ).copyWith(letterSpacing: .24, height: 14 / 12),
            ),
          ),
          ...children,
        ],
      ),
    );
  }
}

class AssistantParagraph extends StatelessWidget {
  const AssistantParagraph(
    this.text, {
    super.key,
    this.error = false,
    this.live = false,
    this.code = false,
    this.color,
    this.inlineCode,
    this.inlineCodeStart = 0,
  });
  final String text;
  final String? inlineCode;
  final String? color;
  final int inlineCodeStart;
  final bool error, live, code;
  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Semantics(
        liveRegion: live,
        child: text.isEmpty
            ? const SizedBox.shrink()
            : LayoutBuilder(
                builder: (context, constraints) {
                  final style =
                      webText(
                        context,
                        size: 13,
                        color:
                            color ?? (error ? 'status.danger' : 'text.muted'),
                      ).copyWith(
                        height: 1.55,
                        fontFamily: code ? 'monospace' : null,
                      );
                  return SelectionArea(
                    child: Text.rich(
                      _content(context, style, constraints.maxWidth),
                    ),
                  );
                },
              ),
      ),
    );
  }

  TextSpan _content(BuildContext context, TextStyle style, double maxWidth) {
    final fragment = inlineCode;
    if (fragment == null || fragment.isEmpty) {
      return TextSpan(text: text, style: style);
    }
    final start = text.indexOf(fragment, inlineCodeStart);
    if (start < 0) return TextSpan(text: text, style: style);

    final direction = Directionality.of(context);
    final scaler = MediaQuery.textScalerOf(context);
    final codeStyle = style.copyWith(fontFamily: 'monospace');
    final spans = <InlineSpan>[
      TextSpan(text: text.substring(0, start)),
      TextSpan(text: fragment, style: codeStyle),
      TextSpan(text: text.substring(start + fragment.length)),
    ];
    double? breakGap;
    if (maxWidth.isFinite && maxWidth > 0 && direction == TextDirection.ltr) {
      final fullLine = TextPainter(
        text: TextSpan(style: style, children: spans),
        textDirection: direction,
        textScaler: scaler,
        textWidthBasis: TextWidthBasis.parent,
      )..layout(maxWidth: maxWidth);
      final codeStart = fullLine
          .getOffsetForCaret(TextPosition(offset: start), Rect.zero)
          .dx;
      fullLine.dispose();

      final measuredCode = TextPainter(
        text: TextSpan(text: fragment, style: codeStyle),
        textDirection: direction,
        textScaler: scaler,
      )..layout();
      final codeWidth = measuredCode.width;
      measuredCode.dispose();
      final remaining = maxWidth - codeStart;

      // Keep an inline code run with its preceding text only when the whole
      // run fits that line. A longer run starts at the next line and can wrap
      // within the paragraph width.
      if (codeStart > 0 && remaining > .5 && codeWidth > remaining + .01) {
        // WidgetSpan scales its child by the current text scale factor. Leave
        // a fraction of a pixel for layout rounding so the spacer stays after
        // the prefix instead of moving to a line of its own.
        final fontSize = style.fontSize ?? 14;
        final inlineScale = scaler.scale(fontSize) / fontSize;
        breakGap = (remaining - .5) / inlineScale;
      }
    }
    if (breakGap != null) {
      spans.insert(1, WidgetSpan(child: SizedBox(width: breakGap, height: 0)));
    }
    return TextSpan(style: style, children: spans);
  }
}

TextStyle _assistantNormalLineStyle(
  BuildContext context, {
  FontWeight weight = FontWeight.w400,
  required String color,
}) => webText(
  context,
  size: 13,
  weight: weight,
  color: color,
).copyWith(height: kTextHeightNone);

class AssistantPromptEditor extends StatefulWidget {
  const AssistantPromptEditor({
    super.key,
    required this.controller,
    required this.name,
    required this.nodeId,
    required this.prompt,
  });
  final LiveController controller;
  final String name, nodeId;
  final Json prompt;
  @override
  State<AssistantPromptEditor> createState() => _AssistantPromptEditorState();
}

class _AssistantPromptEditorState extends State<AssistantPromptEditor> {
  late Json saved = widget.prompt;
  final inputFocus = FocusNode();
  late final text = TextEditingController(text: '${saved['text'] ?? ''}');
  bool saving = false;
  double? resizedHeight;
  double resizeStartY = 0, resizeStartHeight = 0;
  String? error, status;
  String get title => widget.name == 'soul' ? tr("Soul") : tr("Chat rules");
  bool get changed =>
      text.text.replaceAll('\r\n', '\n').trim() != saved['text'];
  bool get tooLong => text.text.length > (saved['maxChars'] as num? ?? 0);
  @override
  void initState() {
    super.initState();
    text.addListener(update);
  }

  void update() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    text.removeListener(update);
    text.dispose();
    inputFocus.dispose();
    super.dispose();
  }

  Future<void> save() async {
    if (saving || saved['writable'] != true || !changed || tooLong) return;
    final c = widget.controller, origin = widget.controller.origin;
    final draft = text.text, node = widget.nodeId;
    setState(() {
      saving = true;
      error = status = null;
    });
    bool current() =>
        mounted &&
        c == widget.controller &&
        origin == c.origin &&
        node == widget.nodeId;
    try {
      final result = await c.gateway.request(
        '/api/assistant/prompts/${widget.name}',
        method: 'PUT',
        body: {'text': draft, 'nodeId': node},
      );
      if (!current()) return;
      saved = obj(result['prompt']);
      text.text = '${saved['text'] ?? ''}';
      status = tr("Saved. Applies at the next chat agent start.");
    } catch (e) {
      if (!current()) return;
      error = LiveController.describe(e);
      // Refresh permissions only; retain the user's draft and never retarget a
      // failed save to a newly bound chat node or automatically retry the PUT.
      try {
        final latest = await c.gateway.request('/api/assistant/prompts');
        if (current() && latest['nodeId'] == node) {
          saved = obj(latest[widget.name]);
        }
      } catch (_) {
        /* The current draft remains available for review/retry. */
      }
    } finally {
      if (current()) setState(() => saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    final colors = palette(context);
    final writable = saved['writable'] == true;
    final scaler = MediaQuery.textScalerOf(context);
    final fontSize = scaler.scale(16);
    final normalLine = TextPainter(
      text: TextSpan(
        text: ' ',
        style: TextStyle(
          fontFamily: Theme.of(context).textTheme.bodyMedium?.fontFamily,
          fontSize: 16,
          fontWeight: FontWeight.w500,
          letterSpacing: 0,
        ),
      ),
      textScaler: scaler,
      textDirection: Directionality.of(context),
    )..layout();
    // A browser textarea's rows use normal font line metrics, rounded to
    // physical CSS pixels, rather than scaling an assumed 18px line height.
    final lineHeight = normalLine.preferredLineHeight;
    normalLine.dispose();
    final fieldHeight = resizedHeight ?? lineHeight * 8 + 6;
    final borderColor = Theme.of(context).brightness == Brightness.dark
        ? const Color(0xff858585)
        : const Color(0xff767676);
    return AssistantSection(
      title: title,
      divider: true,
      children: [
        AssistantParagraph('${saved['path'] ?? ''}', code: true),
        if (!writable)
          AssistantParagraph(
            switch (saved['reason']) {
              'nix-store' => tr("Managed by Nix: edit services.pirc.{0}.", [
                widget.name == 'soul' ? 'soulPrompt' : 'chatPrompt',
              ]),
              'symlink' => tr("Managed symlink: edit its source file."),
              _ => tr(
                "Read-only: the node does not have permission to edit this file.",
              ),
            },
            live: true,
            inlineCode: saved['reason'] == 'nix-store'
                ? "services.pirc.${widget.name == 'soul' ? 'soulPrompt' : 'chatPrompt'}"
                : null,
          ),
        Padding(
          padding: const EdgeInsets.only(top: 12, bottom: 6),
          child: Text(
            title,
            style: _assistantNormalLineStyle(
              context,
              weight: FontWeight.w500,
              color: 'text.secondary',
            ),
          ),
        ),
        Semantics(
          label: title,
          hint: tr("{0} / {1} characters", [
            text.text.length,
            saved['maxChars'],
          ]),
          validationResult: tooLong
              ? SemanticsValidationResult.invalid
              : SemanticsValidationResult.valid,
          child: ListenableBuilder(
            listenable: inputFocus,
            builder: (context, _) => Stack(
              clipBehavior: Clip.none,
              children: [
                if (inputFocus.hasFocus)
                  Positioned.fill(
                    left: -4,
                    right: -4,
                    top: -4,
                    bottom: -4,
                    child: IgnorePointer(
                      child: DecoratedBox(
                        key: ValueKey('assistant-${widget.name}-focus-ring'),
                        decoration: BoxDecoration(
                          border: Border.all(
                            color: colors['accent.default'],
                            width: 2,
                          ),
                          borderRadius: BorderRadius.circular(6),
                        ),
                      ),
                    ),
                  ),
                SizedBox(
                  height: fieldHeight,
                  child: TextField(
                    key: ValueKey('assistant-${widget.name}-text'),
                    focusNode: inputFocus,
                    controller: text,
                    readOnly: !writable,
                    enabled: !saving,
                    expands: true,
                    minLines: null,
                    maxLines: null,
                    textAlignVertical: TextAlignVertical.top,
                    style: webText(
                      context,
                      size: 16,
                      weight: FontWeight.w500,
                      color: 'text.secondary',
                    ).copyWith(height: lineHeight / fontSize),
                    decoration: InputDecoration(
                      isDense: true,
                      // RenderEditable reserves a 1px gap plus the 2px caret
                      // on the right. Count that as the textarea's 3px right
                      // inset instead of reducing the browser-matched line width
                      // a second time.
                      contentPadding: const EdgeInsets.fromLTRB(3, 3, 0, 3),
                      filled: true,
                      fillColor: Theme.of(context).brightness == Brightness.dark
                          ? const Color(0xff3b3b3b)
                          : Colors.white,
                      border: OutlineInputBorder(
                        gapPadding: 0,
                        borderRadius: BorderRadius.circular(2),
                        borderSide: BorderSide(color: borderColor),
                      ),
                      enabledBorder: OutlineInputBorder(
                        gapPadding: 0,
                        borderRadius: BorderRadius.circular(2),
                        borderSide: BorderSide(color: borderColor),
                      ),
                      focusedBorder: OutlineInputBorder(
                        gapPadding: 0,
                        borderRadius: BorderRadius.circular(2),
                        borderSide: BorderSide(color: borderColor),
                      ),
                    ),
                  ),
                ),
                Positioned(
                  right: 0,
                  bottom: 0,
                  width: 15,
                  height: 15,
                  child: MouseRegion(
                    cursor: SystemMouseCursors.resizeUpDown,
                    child: GestureDetector(
                      key: ValueKey('assistant-${widget.name}-resize'),
                      behavior: HitTestBehavior.opaque,
                      onVerticalDragDown: (details) {
                        resizeStartY = details.globalPosition.dy;
                        resizeStartHeight = fieldHeight;
                      },
                      onVerticalDragUpdate: (details) => setState(() {
                        resizedHeight =
                            (resizeStartHeight +
                                    details.globalPosition.dy -
                                    resizeStartY)
                                .clamp(15.0, double.infinity);
                      }),
                      child: CustomPaint(
                        painter: _PromptResizePainter(borderColor),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.only(top: 12),
          child: LayoutBuilder(
            builder: (context, bounds) {
              final count = Text(
                tr("{0} / {1} characters", [
                  text.text.length,
                  saved['maxChars'],
                ]),
                style: _assistantNormalLineStyle(
                  context,
                  color: tooLong ? 'status.danger' : 'text.secondary',
                ),
              );
              final actions = Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  AssistantButton(
                    tr("Revert"),
                    onPressed: saving || !changed
                        ? null
                        : () {
                            text.text = '${saved['text'] ?? ''}';
                            setState(() {
                              error = status = null;
                            });
                          },
                  ),
                  const SizedBox(width: 8),
                  AssistantButton(
                    saving ? tr("Saving…") : tr("Save"),
                    filled: true,
                    onPressed: saving || !writable || !changed || tooLong
                        ? null
                        : save,
                  ),
                ],
              );
              return _PromptActions(children: [count, actions]);
            },
          ),
        ),
        if (error != null) AssistantParagraph(error!, error: true, live: true),
        if (status != null && status!.isNotEmpty)
          AssistantParagraph(status!, live: true),
      ],
    );
  }
}

class AssistantButton extends StatefulWidget {
  const AssistantButton(
    this.label, {
    super.key,
    this.onPressed,
    this.filled = false,
    this.primary = false,
  });
  final String label;
  final VoidCallback? onPressed;
  final bool filled, primary;
  @override
  State<AssistantButton> createState() => _AssistantButtonState();
}

class _AssistantButtonState extends State<AssistantButton> {
  bool focused = false, keyboardFocus = true;
  bool keyEvent(KeyEvent event) {
    if (!keyboardFocus && mounted) setState(() => keyboardFocus = true);
    return false;
  }

  @override
  void initState() {
    super.initState();
    FocusManager.instance.addHighlightModeListener(highlightChanged);
    HardwareKeyboard.instance.addHandler(keyEvent);
  }

  void highlightChanged(FocusHighlightMode _) {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    FocusManager.instance.removeHighlightModeListener(highlightChanged);
    HardwareKeyboard.instance.removeHandler(keyEvent);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    final onPressed = widget.onPressed,
        primary = widget.primary,
        filled = widget.filled;
    final colors = palette(context);
    return Opacity(
      opacity: onPressed == null ? .45 : 1,
      child: Listener(
        onPointerDown: (_) => setState(() => keyboardFocus = false),
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            if (onPressed != null &&
                focused &&
                keyboardFocus &&
                FocusManager.instance.highlightMode ==
                    FocusHighlightMode.traditional)
              Positioned.fill(
                left: -4,
                right: -4,
                top: -4,
                bottom: -4,
                child: IgnorePointer(
                  child: DecoratedBox(
                    key: ValueKey(
                      'assistant-button-${widget.label}-focus-ring',
                    ),
                    decoration: ShapeDecoration(
                      shape: StadiumBorder(
                        side: BorderSide(
                          color: colors['accent.default'],
                          width: 2,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            TextButton(
              onPressed: onPressed,
              onFocusChange: (value) => setState(() => focused = value),
              style:
                  TextButton.styleFrom(
                    minimumSize: const Size(0, 36),
                    fixedSize: const Size.fromHeight(36),
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    foregroundColor: primary
                        ? Colors.white
                        : palette(context)['text.primary'],
                    disabledForegroundColor: primary
                        ? Colors.white
                        : palette(context)['text.primary'],
                    shape: const StadiumBorder(),
                    textStyle: TextStyle(
                      fontFamily: Theme.of(
                        context,
                      ).textTheme.bodyMedium?.fontFamily,
                      fontSize: 14,
                      fontWeight: FontWeight.w500,
                      letterSpacing: 0,
                    ),
                    overlayColor: Colors.transparent,
                    splashFactory: NoSplash.splashFactory,
                  ).copyWith(
                    backgroundColor: WidgetStateProperty.resolveWith((states) {
                      final hovered =
                          states.contains(WidgetState.hovered) &&
                          !states.contains(WidgetState.disabled);
                      if (primary) {
                        return colors[hovered
                            ? 'web.accent-hover'
                            : 'accent.default'];
                      }
                      if (filled) {
                        return colors[hovered
                            ? 'web.bg-hover-strong'
                            : 'web.bg-hover'];
                      }
                      return hovered
                          ? colors['web.bg-hover']
                          : Colors.transparent;
                    }),
                  ),
              child: Text(
                widget.label,
                textAlign: TextAlign.center,
                softWrap: false,
                maxLines: 1,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _PromptResizePainter extends CustomPainter {
  const _PromptResizePainter(this.color);
  final Color color;
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..strokeWidth = 1;
    for (final length in [3.0, 6.0, 9.0]) {
      canvas.drawLine(
        Offset(size.width - 3 - length, size.height - 3),
        Offset(size.width - 3, size.height - 3 - length),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(_PromptResizePainter oldDelegate) =>
      oldDelegate.color != color;
}

// CSS flex: the count grows into free space but cannot shrink below its
// min-content width. The browser permits overflow when the row cannot fit.
class _PromptActions extends MultiChildRenderObjectWidget {
  const _PromptActions({required super.children});
  @override
  RenderObject createRenderObject(BuildContext context) =>
      _RenderPromptActions();
}

class _PromptActionData extends ContainerBoxParentData<RenderBox> {}

class _RenderPromptActions extends RenderBox
    with
        ContainerRenderObjectMixin<RenderBox, _PromptActionData>,
        RenderBoxContainerDefaultsMixin<RenderBox, _PromptActionData> {
  @override
  void setupParentData(RenderBox child) {
    if (child.parentData is! _PromptActionData) {
      child.parentData = _PromptActionData();
    }
  }

  @override
  void performLayout() {
    final count = firstChild!, actions = lastChild!;
    actions.layout(const BoxConstraints(), parentUsesSize: true);
    final countWidth = math.max(
      count.getMinIntrinsicWidth(double.infinity),
      constraints.maxWidth - actions.size.width - 8,
    );
    count.layout(
      BoxConstraints.tightFor(width: countWidth),
      parentUsesSize: true,
    );
    final height = math.max(count.size.height, actions.size.height);
    size = constraints.constrain(Size(constraints.maxWidth, height));
    (count.parentData! as _PromptActionData).offset = Offset(
      0,
      (height - count.size.height) / 2,
    );
    (actions.parentData! as _PromptActionData).offset = Offset(
      countWidth + 8,
      (height - actions.size.height) / 2,
    );
  }

  @override
  void paint(PaintingContext context, Offset offset) =>
      defaultPaint(context, offset);
  @override
  bool hitTestChildren(BoxHitTestResult result, {required Offset position}) =>
      defaultHitTestChildren(result, position: position);
}
