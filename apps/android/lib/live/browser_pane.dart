import 'dart:async';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'gateway.dart';
import 'common.dart';
import 'web_controls.dart';
import 'browser_state.dart';
import 'browser_pointer_surface.dart';
import 'recording_player.dart';

class BrowserPane extends StatefulWidget {
  const BrowserPane({super.key, required this.controller});
  final LiveController controller;
  @override
  State<BrowserPane> createState() => _BrowserPaneState();
}

class _BrowserPaneState extends State<BrowserPane> with WidgetsBindingObserver {
  late final state = BrowserState(widget.controller);
  final address = TextEditingController(),
      keys = TextEditingController(text: '\u200b');
  final addressFocus = FocusNode(), keyFocus = FocusNode();
  bool flushing = false;
  bool touchDrag = false;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    state.addListener(changed);
    addressFocus.addListener(addressChanged);
    keys.addListener(flushText);
  }

  void changed() {
    if (!mounted) return;
    if (!state.editingUrl && address.text != state.urlDraft) {
      address.text = state.urlDraft;
    }
    setState(() {});
  }

  void addressChanged() {
    state.editingUrl = addressFocus.hasFocus;
    if (!addressFocus.hasFocus) {
      state.urlDraft = '${state.view?['url'] ?? ''}';
      address.text = state.urlDraft;
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    state.setActive(TickerMode.valuesOf(context).enabled);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState value) =>
      state.setForeground(value == AppLifecycleState.resumed);
  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    state.removeListener(changed);
    state.dispose();
    addressFocus.removeListener(addressChanged);
    addressFocus.dispose();
    keyFocus.dispose();
    address.dispose();
    keys.dispose();
    super.dispose();
  }

  void flushText() {
    if (flushing ||
        !state.canDrive ||
        keys.value.composing.isValid && !keys.value.composing.isCollapsed) {
      return;
    }
    final value = keys.text;
    if (value == '\u200b') return;
    if (value.isEmpty) {
      unawaited(state.send({'type': 'key', 'key': 'Backspace'}));
    } else {
      final text = value.startsWith('\u200b') ? value.substring(1) : value;
      if (text.isNotEmpty) {
        unawaited(state.send({'type': 'text', 'text': text}));
      }
    }
    flushing = true;
    keys.value = const TextEditingValue(
      text: '\u200b',
      selection: TextSelection.collapsed(offset: 1),
    );
    flushing = false;
  }

  KeyEventResult keyDown(FocusNode node, KeyEvent event) {
    if (!state.canDrive ||
        event is KeyUpEvent ||
        (keys.value.composing.isValid && !keys.value.composing.isCollapsed)) {
      return KeyEventResult.ignored;
    }
    final key = event.logicalKey, keyboard = HardwareKeyboard.instance;
    final special = <LogicalKeyboardKey, String>{
      LogicalKeyboardKey.enter: 'Enter',
      LogicalKeyboardKey.tab: 'Tab',
      LogicalKeyboardKey.backspace: 'Backspace',
      LogicalKeyboardKey.delete: 'Delete',
      LogicalKeyboardKey.escape: 'Escape',
      LogicalKeyboardKey.arrowUp: 'ArrowUp',
      LogicalKeyboardKey.arrowDown: 'ArrowDown',
      LogicalKeyboardKey.arrowLeft: 'ArrowLeft',
      LogicalKeyboardKey.arrowRight: 'ArrowRight',
      LogicalKeyboardKey.home: 'Home',
      LogicalKeyboardKey.end: 'End',
      LogicalKeyboardKey.pageUp: 'PageUp',
      LogicalKeyboardKey.pageDown: 'PageDown',
      for (final (i, k) in [
        LogicalKeyboardKey.f1,
        LogicalKeyboardKey.f2,
        LogicalKeyboardKey.f3,
        LogicalKeyboardKey.f4,
        LogicalKeyboardKey.f5,
        LogicalKeyboardKey.f6,
        LogicalKeyboardKey.f7,
        LogicalKeyboardKey.f8,
        LogicalKeyboardKey.f9,
        LogicalKeyboardKey.f10,
        LogicalKeyboardKey.f11,
        LogicalKeyboardKey.f12,
      ].indexed)
        k: 'F${i + 1}',
    };
    final chord =
        keyboard.isControlPressed ||
        keyboard.isMetaPressed ||
        keyboard.isAltPressed;
    if (chord && key == LogicalKeyboardKey.keyV) return KeyEventResult.ignored;
    final name =
        special[key] ??
        (chord && key.keyLabel.length == 1
            ? (keyboard.isShiftPressed
                  ? key.keyLabel
                  : key.keyLabel.toLowerCase())
            : null);
    if (name == null) return KeyEventResult.ignored;
    unawaited(
      state.send({
        'type': 'key',
        'key': [
          if (keyboard.isControlPressed) 'Control',
          if (keyboard.isAltPressed) 'Alt',
          if (keyboard.isShiftPressed) 'Shift',
          if (keyboard.isMetaPressed) 'Meta',
          name,
        ].join('+'),
      }),
    );
    return KeyEventResult.handled;
  }

  TextStyle text(
    double size, {
    String color = 'text.primary',
    FontWeight weight = FontWeight.w400,
  }) => webText(
    context,
    size: size,
    color: color,
    weight: weight,
  ).copyWith(height: 1.15);
  Widget button(
    String label,
    VoidCallback? onTap, {
    IconData? icon,
    bool primary = false,
  }) => Opacity(
    opacity: onTap == null ? .5 : 1,
    child: TextButton(
      onPressed: onTap,
      style: TextButton.styleFrom(
        minimumSize: const Size(0, 32),
        padding: const EdgeInsets.symmetric(horizontal: 12),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        shape: const StadiumBorder(),
        backgroundColor: palette(
          context,
        )[primary ? 'accent.default' : 'web.bg-hover'],
        foregroundColor: palette(
          context,
        )[primary ? 'accent.on' : 'text.primary'],
        disabledForegroundColor: palette(
          context,
        )[primary ? 'accent.on' : 'text.primary'],
        textStyle: text(13, weight: FontWeight.w500),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[Icon(icon, size: 14), const SizedBox(width: 6)],
          Text(label),
        ],
      ),
    ),
  );
  Widget icon(
    IconData icon,
    String label,
    VoidCallback? onTap, {
    bool active = false,
    bool recording = false,
  }) => Opacity(
    opacity: onTap == null ? .45 : 1,
    child: IconButton(
      tooltip: label,
      isSelected: active,
      onPressed: onTap,
      icon: Icon(icon, size: 15),
      style: IconButton.styleFrom(
        minimumSize: const Size(28, 28),
        maximumSize: const Size(28, 28),
        padding: EdgeInsets.zero,
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        backgroundColor: Colors.transparent,
        foregroundColor: palette(
          context,
        )[recording ? 'status.danger' : 'text.muted'],
        disabledForegroundColor: palette(
          context,
        )[recording ? 'status.danger' : 'text.muted'],
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
      ),
    ),
  );
  Widget empty(String value, {String? detail}) => Padding(
    padding: const EdgeInsets.all(24),
    child: Column(
      children: [
        Icon(
          LucideIcons.globe,
          size: 22,
          color: palette(context)['text.muted'],
        ),
        const SizedBox(height: 10),
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 300),
          child: Text(
            value,
            textAlign: TextAlign.center,
            style: text(13, color: 'text.muted').copyWith(height: 1.5),
          ),
        ),
        if (detail != null) ...[
          const SizedBox(height: 10),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 300),
            child: Text(
              detail,
              textAlign: TextAlign.center,
              style: text(13, color: 'text.muted').copyWith(height: 1.5),
            ),
          ),
        ],
      ],
    ),
  );
  Widget statusText(String value) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 4),
    child: Text(
      value,
      style: text(13, color: 'text.muted').copyWith(height: 1.5),
    ),
  );
  String time(dynamic value) {
    final t = DateTime.fromMillisecondsSinceEpoch(
      (value as num).toInt(),
    ).toLocal();
    return '${(t.hour % 12 == 0 ? 12 : t.hour % 12).toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}:${t.second.toString().padLeft(2, '0')} ${t.hour < 12 ? 'AM' : 'PM'}';
  }

  String get statusLabel {
    if (state.userMode) {
      return state.view?['agentWaiting'] == true
          ? 'Agent is waiting for you'
          : 'You are in control';
    }
    if (state.view?['action'] != null) return '${state.view!['action']}';
    return state.view?['active'] == true ? 'Agent' : 'No browser open';
  }

  double toolbarWidth(double available) {
    if (!state.userMode && state.view?['active'] != true) return available;
    final painter = TextPainter(
      text: TextSpan(
        text: state.userMode ? 'Return control' : 'Take over',
        style: text(13, weight: FontWeight.w500),
      ),
      textDirection: TextDirection.ltr,
      textScaler: MediaQuery.textScalerOf(context),
    )..layout();
    final width = math.max(available, painter.width + 190);
    painter.dispose();
    return width;
  }

  Widget toolbar() => Container(
    decoration: BoxDecoration(
      border: Border(bottom: BorderSide(color: palette(context)['web.line'])),
    ),
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
    child: LayoutBuilder(
      builder: (context, b) => SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: SizedBox(
          width: toolbarWidth(b.maxWidth),
          child: Row(
            children: [
              Expanded(
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Tooltip(
                    message: '${state.view?['action'] ?? ''}',
                    child: Container(
                      constraints: BoxConstraints(maxWidth: b.maxWidth * .6),
                      height: 20,
                      padding: const EdgeInsets.symmetric(horizontal: 7),
                      decoration: BoxDecoration(
                        color:
                            palette(context)[state.userMode ||
                                    state.view?['action'] != null
                                ? 'accent.soft'
                                : 'web.bg-hover'],
                        borderRadius: BorderRadius.circular(999),
                      ),
                      child: Text(
                        statusLabel,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: text(
                          11,
                          color: state.userMode || state.view?['action'] != null
                              ? 'accent.default'
                              : 'text.secondary',
                          weight: FontWeight.w500,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              if (state.view?['active'] == true) ...[
                icon(
                  state.view?['recording'] != null
                      ? LucideIcons.square
                      : LucideIcons.circle,
                  state.view?['recording'] != null
                      ? 'Stop recording'
                      : 'Record video',
                  state.hasControl
                      ? () => state.act({
                          'type': 'record',
                          'action': state.view?['recording'] != null
                              ? 'stop'
                              : 'start',
                        })
                      : null,
                  recording: state.view?['recording'] != null,
                ),
                const SizedBox(width: 4),
              ],
              icon(
                LucideIcons.history,
                'Activity and replay',
                state.toggleLog,
                active: state.showLog,
              ),
              if (state.userMode || state.view?['active'] == true) ...[
                const SizedBox(width: 4),
                button(
                  state.userMode ? 'Return control' : 'Take over',
                  state.hasControl
                      ? () => state.act({
                          'type': state.userMode ? 'release' : 'takeover',
                        })
                      : null,
                  icon: state.userMode ? LucideIcons.undo2 : LucideIcons.hand,
                  primary: state.userMode,
                ),
              ],
            ],
          ),
        ),
      ),
    ),
  );
  Widget liveImage() => LayoutBuilder(
    builder: (context, b) {
      Widget image = Image.memory(
        state.image!,
        gaplessPlayback: true,
        width: b.maxWidth,
        fit: BoxFit.fitWidth,
        semanticLabel: state.view?['title'] == null
            ? 'Browser'
            : 'Browser: ${state.view!['title']}',
        errorBuilder: (_, _, _) =>
            statusText('Unable to display browser frame.'),
      );
      image = Container(
        key: const ValueKey('browser-live-screen'),
        decoration: BoxDecoration(
          border: Border.all(color: palette(context)['web.line']),
          borderRadius: BorderRadius.circular(8),
          color: Colors.white,
        ),
        foregroundDecoration: state.canDrive
            ? BoxDecoration(
                border: Border.all(
                  color: palette(context)['accent.default'],
                  width: 2,
                ),
                borderRadius: BorderRadius.circular(8),
              )
            : null,
        clipBehavior: Clip.antiAlias,
        child: AspectRatio(
          aspectRatio: state.width / state.height,
          child: image,
        ),
      );
      image = BrowserPointerSurface(
        enabled: state.canDrive && state.connected && state.foreground,
        scope: (state.tag, widget.controller.control['generation']),
        remoteSize: Size(state.width.toDouble(), state.height.toDouble()),
        touchDrag: touchDrag,
        onKeyboard: keyFocus.requestFocus,
        onMessage: (message) => unawaited(state.send(message)),
        child: image,
      );
      return image;
    },
  );
  Widget replay() => Column(
    children: [
      Row(
        children: [
          icon(LucideIcons.arrowLeft, 'Previous step', () => state.step(-1)),
          const SizedBox(width: 4),
          Expanded(
            child: Tooltip(
              message: '${state.replayEntry?['url'] ?? ''}',
              child: Text(
                state.replayEntry == null
                    ? ''
                    : '${time(state.replayEntry!['at'])} · ${state.replayEntry!['action']}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: text(12, color: 'text.secondary'),
              ),
            ),
          ),
          const SizedBox(width: 4),
          icon(LucideIcons.arrowRight, 'Next step', () => state.step(1)),
          const SizedBox(width: 4),
          button('Live', state.live),
        ],
      ),
      const SizedBox(height: 6),
      if (state.replayImage == null)
        Align(alignment: Alignment.centerLeft, child: statusText('Loading…'))
      else
        ClipRRect(
          borderRadius: BorderRadius.circular(8),
          child: Image.memory(
            state.replayImage!,
            fit: BoxFit.fitWidth,
            width: double.infinity,
            semanticLabel: 'Browser at this step',
          ),
        ),
    ],
  );
  @override
  Widget build(BuildContext context) => SingleChildScrollView(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (state.unavailable.isNotEmpty)
          empty(
            state.unavailable,
            detail:
                'Install Chromium on the node or set PIRC_BROWSER_EXECUTABLE.',
          )
        else ...[
          toolbar(),
          if (state.view?['handoff'] != null)
            Semantics(
              liveRegion: true,
              child: Container(
                margin: const EdgeInsets.fromLTRB(8, 8, 8, 0),
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 8,
                ),
                decoration: BoxDecoration(
                  color: palette(context)['accent.soft'],
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text.rich(
                  TextSpan(
                    children: [
                      const TextSpan(
                        text: 'The agent needs you: ',
                        style: TextStyle(fontWeight: FontWeight.w700),
                      ),
                      TextSpan(text: '${state.view!['handoff']}'),
                    ],
                  ),
                  style: text(13).copyWith(height: 1.45),
                ),
              ),
            ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            child: Row(
              children: [
                for (final (i, k, l) in [
                  (LucideIcons.arrowLeft, 'back', 'Back'),
                  (LucideIcons.arrowRight, 'forward', 'Forward'),
                  (LucideIcons.rotateCw, 'reload', 'Reload'),
                ]) ...[
                  icon(
                    i,
                    l,
                    state.canDrive ? () => state.act({'type': k}) : null,
                  ),
                  const SizedBox(width: 4),
                ],
                Expanded(
                  child: Container(
                    height: 28,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: palette(context)['web.bg-layer'],
                      border: Border.all(color: palette(context)['web.line']),
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: TextField(
                      controller: address,
                      focusNode: addressFocus,
                      readOnly: !state.hasControl,
                      keyboardType: TextInputType.url,
                      textInputAction: TextInputAction.go,
                      autocorrect: false,
                      enableSuggestions: false,
                      onChanged: (v) => state.urlDraft = v,
                      onSubmitted: (_) => state.navigate(),
                      textAlignVertical: TextAlignVertical.center,
                      style: text(
                        MediaQuery.sizeOf(context).width <= 650 ||
                                [
                                  TargetPlatform.android,
                                  TargetPlatform.iOS,
                                ].contains(Theme.of(context).platform)
                            ? 16
                            : 12.5,
                      ),
                      decoration: InputDecoration(
                        hintText: state.hasControl
                            ? 'Enter a URL to open it yourself'
                            : 'Address',
                        hintStyle: text(
                          MediaQuery.sizeOf(context).width <= 650 ? 16 : 12.5,
                          color: 'text.muted',
                        ),
                        isCollapsed: true,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 10,
                        ),
                        border: InputBorder.none,
                        enabledBorder: InputBorder.none,
                        focusedBorder: InputBorder.none,
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
          if (rows(state.view?['tabs']).length > 1)
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              child: Row(
                children: [
                  for (final tab in rows(state.view?['tabs']))
                    Padding(
                      padding: const EdgeInsets.only(right: 4),
                      child: Tooltip(
                        message: '${tab['url']}',
                        child: InkWell(
                          onTap: state.canDrive
                              ? () => state.act({
                                  'type': 'tab',
                                  'index': tab['index'],
                                })
                              : null,
                          child: Opacity(
                            opacity: state.canDrive ? 1 : .45,
                            child: Container(
                              height: 24,
                              constraints: const BoxConstraints(maxWidth: 160),
                              padding: const EdgeInsets.symmetric(
                                horizontal: 8,
                              ),
                              decoration: BoxDecoration(
                                color: tab['active'] == true
                                    ? palette(context)['web.bg-active']
                                    : null,
                                borderRadius: BorderRadius.circular(8),
                              ),
                              child: Center(
                                widthFactor: 1,
                                child: Text(
                                  '${tab['title'] ?? ''}'.isNotEmpty
                                      ? '${tab['title']}'
                                      : '${tab['url'] ?? ''}'.isNotEmpty
                                      ? '${tab['url']}'
                                      : 'New tab',
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: text(
                                    12,
                                    color: tab['active'] == true
                                        ? 'text.primary'
                                        : 'text.secondary',
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          if (state.canDrive && state.replayIndex == null)
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 0, 8, 6),
              child: Wrap(
                spacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Semantics(
                    toggled: touchDrag,
                    child: button(
                      touchDrag ? 'Touch: drag' : 'Touch: scroll',
                      () => setState(() => touchDrag = !touchDrag),
                      primary: touchDrag,
                    ),
                  ),
                  Text(
                    touchDrag
                        ? 'Drag objects · tap to type'
                        : 'Swipe to scroll · tap to type',
                    style: text(12, color: 'text.muted'),
                  ),
                ],
              ),
            ),
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
            child: Stack(
              children: [
                Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (state.replayIndex != null)
                      replay()
                    else if (state.image != null)
                      liveImage()
                    else if (state.view?['active'] == true)
                      statusText('Waiting for the first frame…')
                    else
                      empty(
                        'The agent opens a browser when it uses web tools. You can watch it here, take over to log in or fill forms, and record videos.',
                      ),
                    if (state.notice.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 6),
                        child: Text(
                          state.notice,
                          style: text(12, color: 'text.secondary'),
                        ),
                      ),
                  ],
                ),
                if (state.image != null && state.replayIndex == null)
                  Positioned(
                    left: 0,
                    bottom: 0,
                    width: 1,
                    height: 1,
                    child: Opacity(
                      opacity: 0,
                      child: Focus(
                        onKeyEvent: keyDown,
                        child: TextField(
                          controller: keys,
                          focusNode: keyFocus,
                          readOnly: !state.canDrive,
                          autocorrect: false,
                          enableSuggestions: false,
                          textInputAction: TextInputAction.done,
                          onSubmitted: (_) {
                            if (state.canDrive) {
                              state.send({'type': 'key', 'key': 'Enter'});
                            }
                          },
                          decoration: const InputDecoration(
                            labelText: 'Type into the browser',
                            border: InputBorder.none,
                            contentPadding: EdgeInsets.zero,
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
          if (state.showLog)
            Container(
              decoration: BoxDecoration(
                border: Border(
                  top: BorderSide(color: palette(context)['web.line']),
                ),
              ),
              padding: const EdgeInsets.fromLTRB(8, 4, 8, 12),
              child: Semantics(
                label: 'Browser activity',
                container: true,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (state.recordings.isNotEmpty) ...[
                      heading('Recordings'),
                      for (final path in state.recordings)
                        NativeRecordingPlayer(
                          key: ValueKey(
                            '${state.origin}:${state.client}:${state.session}:$path',
                          ),
                          gateway: widget.controller.gateway,
                          session: state.session!,
                          path: path,
                        ),
                    ],
                    heading('Activity'),
                    if (state.log.isEmpty) statusText('Nothing yet.'),
                    for (final entry in state.log.reversed)
                      Tooltip(
                        message: '${entry['url']}',
                        child: InkWell(
                          onTap: entry['image'] == true
                              ? () => state.openReplay(entry)
                              : null,
                          borderRadius: BorderRadius.circular(8),
                          child: Container(
                            key: ValueKey('browser-log-${entry['index']}'),
                            decoration: BoxDecoration(
                              color: state.replayIndex == entry['index']
                                  ? palette(context)['web.bg-hover']
                                  : null,
                              borderRadius: BorderRadius.circular(8),
                            ),
                            padding: const EdgeInsets.symmetric(
                              horizontal: 6,
                              vertical: 4,
                            ),
                            child: Row(
                              crossAxisAlignment: CrossAxisAlignment.baseline,
                              textBaseline: TextBaseline.alphabetic,
                              children: [
                                Flexible(
                                  flex: 2,
                                  child: Text(
                                    time(entry['at']),
                                    style: text(12, color: 'text.muted')
                                        .copyWith(
                                          fontFeatures: const [
                                            FontFeature.tabularFigures(),
                                          ],
                                        ),
                                  ),
                                ),
                                const SizedBox(width: 6),
                                Text(
                                  '${entry['actor']}',
                                  style: text(
                                    11,
                                    color: entry['actor'] == 'user'
                                        ? 'status.warning'
                                        : 'accent.default',
                                  ),
                                ),
                                const SizedBox(width: 6),
                                Expanded(
                                  child: Text(
                                    '${entry['action']}',
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: text(
                                      12,
                                      color: entry['image'] == true
                                          ? 'text.primary'
                                          : 'text.secondary',
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
        ],
      ],
    ),
  );
  Widget heading(String value) => Padding(
    padding: const EdgeInsets.fromLTRB(2, 8, 2, 4),
    child: Text(
      value.toUpperCase(),
      style: text(11.5, color: 'text.muted', weight: FontWeight.w600),
    ),
  );
}
