import 'dart:async';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'gateway.dart';
import 'web_controls.dart';
import 'terminal_state.dart' show terminalError;

class RecordingState extends ChangeNotifier {
  RecordingState(this.gateway, this.session, this.path) {
    unawaited(open());
  }
  final Gateway gateway;
  final String session, path;
  Json? data;
  String? error;
  bool disposed = false, muted = false, polling = false, changingMute = false;
  static const playbackRates = [.25, .5, .75, 1.0, 1.25, 1.5, 1.75, 2.0];
  double playbackRate = 1;
  bool changingRate = false;
  Timer? timer;
  int revision = 0;
  int? get id => data?['id'] as int?;
  double get duration =>
      ((data?['duration'] as num?)?.toDouble() ?? 0).clamp(0, double.infinity);
  double get position =>
      ((data?['position'] as num?)?.toDouble() ?? 0).clamp(0, duration);
  bool get playing => data?['playing'] == true;
  double get ratio =>
      (data?['width'] as num? ?? 300).clamp(1, double.infinity) /
      (data?['height'] as num? ?? 150).clamp(1, double.infinity);
  void emit() {
    if (!disposed) notifyListeners();
  }

  Future<void> close(int value) async {
    try {
      await gateway.call('recordingClose', {'id': value});
    } catch (_) {}
  }

  Future<void> open() async {
    try {
      final value = obj(
        await gateway.call('recordingOpen', {
          'sessionId': session,
          'path': path,
        }),
      );
      if (disposed) {
        if (value['id'] is int) await close(value['id']);
        return;
      }
      data = value;
      error = null;
      emit();
      timer = Timer.periodic(const Duration(milliseconds: 250), (_) async {
        if (!playing || polling || disposed || error != null) return;
        polling = true;
        await command('status');
        polling = false;
      });
    } catch (e) {
      if (!disposed) {
        error = terminalError(e, 'Unable to play recording.');
        emit();
      }
    }
  }

  Future<bool> command(
    String action, {
    double? position,
    double? volume,
    double? rate,
  }) async {
    if (disposed || id == null) return false;
    final ticket = ++revision;
    try {
      final result = obj(
        await gateway.call('recordingControl', {
          'id': id,
          'action': action,
          if (position != null) 'position': position.round(),
          'volume': ?volume,
          'rate': ?rate,
        }),
      );
      if (!disposed && ticket == revision) {
        data = result;
        error = null;
        emit();
      }
      // The operation may succeed even if a later status read supersedes its
      // playback snapshot. Callers still need its acknowledgement.
      return !disposed;
    } catch (e) {
      if (!disposed && ticket == revision) {
        error = terminalError(e, 'Unable to control recording.');
        emit();
      }
      return false;
    }
  }

  Future<void> setPlaybackRate(double value) async {
    if (disposed ||
        id == null ||
        changingRate ||
        !playbackRates.contains(value)) {
      return;
    }
    changingRate = true;
    emit();
    try {
      final accepted = await command('rate', rate: value);
      if (!disposed && accepted) playbackRate = value;
    } finally {
      changingRate = false;
      emit();
    }
  }

  Future<void> toggleMute() async {
    if (disposed || id == null || changingMute) return;
    final next = !muted;
    changingMute = true;
    emit();
    try {
      final accepted = await command('volume', volume: next ? 0 : 1);
      if (!disposed && accepted) muted = next;
    } finally {
      changingMute = false;
      emit();
    }
  }

  @override
  void dispose() {
    disposed = true;
    timer?.cancel();
    if (id != null) unawaited(close(id!));
    super.dispose();
  }
}

class NativeRecordingPlayer extends StatefulWidget {
  const NativeRecordingPlayer({
    super.key,
    required this.gateway,
    required this.session,
    required this.path,
    this.showDownload = true,
    this.maxHeight,
  });
  final Gateway gateway;
  final String session, path;
  final bool showDownload;
  final double? maxHeight;
  @override
  State<NativeRecordingPlayer> createState() => _NativeRecordingPlayerState();
}

class _NativeRecordingPlayerState extends State<NativeRecordingPlayer>
    with WidgetsBindingObserver {
  late RecordingState state = RecordingState(
    widget.gateway,
    widget.session,
    widget.path,
  );
  bool fullscreen = false, saving = false;
  String? downloadNotice;
  DialogRoute<void>? fullscreenRoute;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didUpdateWidget(NativeRecordingPlayer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.gateway != widget.gateway ||
        oldWidget.session != widget.session ||
        oldWidget.path != widget.path) {
      closeFullscreen();
      state.dispose();
      state = RecordingState(widget.gateway, widget.session, widget.path);
      saving = false;
      downloadNotice = null;
    }
  }

  void closeFullscreen() {
    final route = fullscreenRoute;
    fullscreenRoute = null;
    if (route == null) {
      fullscreen = false;
      return;
    }
    // Source changes/disposal may happen during the parent's build. Remove only
    // this player's route after that build, never pop an unrelated top route.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (route.isActive) route.navigator?.removeRoute(route);
      if (mounted && fullscreenRoute == null) {
        setState(() => fullscreen = false);
      }
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!TickerMode.valuesOf(context).enabled && state.playing) {
      unawaited(state.command('pause'));
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s != AppLifecycleState.resumed && state.playing) {
      unawaited(state.command('pause'));
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    closeFullscreen();
    state.dispose();
    super.dispose();
  }

  String time(double value) {
    final seconds = value ~/ 1000;
    return '${seconds ~/ 60}:${(seconds % 60).toString().padLeft(2, '0')}';
  }

  Future<void> expand() async {
    if (fullscreen) return;
    setState(() => fullscreen = true);
    final route = DialogRoute<void>(
      context: context,
      builder: (context) => Dialog.fullscreen(
        backgroundColor: Colors.black,
        child: SafeArea(
          child: Center(
            child: AnimatedBuilder(
              animation: state,
              builder: (_, _) => video(context, full: true),
            ),
          ),
        ),
      ),
    );
    fullscreenRoute = route;
    await Navigator.of(context, rootNavigator: false).push(route);
    if (mounted && identical(fullscreenRoute, route)) {
      setState(() {
        fullscreenRoute = null;
        fullscreen = false;
      });
    }
  }

  Future<void> saveRecording(RecordingState owner) async {
    if (!mounted || !identical(state, owner) || saving) return;
    setState(() {
      saving = true;
      downloadNotice = null;
    });
    try {
      final result = await owner.gateway.call('recordingSave', {
        'sessionId': owner.session,
        'path': owner.path,
      });
      if (mounted && identical(state, owner)) {
        setState(() => downloadNotice = '$result');
      }
    } catch (e) {
      if (mounted && identical(state, owner)) {
        setState(
          () => downloadNotice = terminalError(
            e,
            'Unable to download recording.',
          ),
        );
      }
    } finally {
      if (mounted && identical(state, owner)) setState(() => saving = false);
    }
  }

  Widget speedMenu() => Builder(
    builder: (buttonContext) {
      final owner = state;
      Future<void> openMenu() async {
        var speeds = false;
        while (true) {
          if (!mounted || !identical(state, owner)) return;
          if (!buttonContext.mounted) return;
          final overlay =
              Navigator.of(
                    buttonContext,
                    rootNavigator: false,
                  ).overlay!.context.findRenderObject()!
                  as RenderBox;
          final button = buttonContext.findRenderObject()! as RenderBox;
          final origin = button.localToGlobal(Offset.zero, ancestor: overlay);
          final selection = await showMenu<String>(
            context: buttonContext,
            useRootNavigator: false,
            position: RelativeRect.fromRect(
              origin & button.size,
              Offset.zero & overlay.size,
            ),
            initialValue: speeds ? '${owner.playbackRate}' : null,
            items: speeds
                ? [
                    const PopupMenuItem(
                      value: 'back',
                      child: Row(
                        children: [
                          Icon(LucideIcons.arrowLeft, size: 16),
                          SizedBox(width: 12),
                          Text('Playback speed'),
                        ],
                      ),
                    ),
                    for (final rate in RecordingState.playbackRates)
                      PopupMenuItem(
                        value: '$rate',
                        child: Semantics(
                          key: ValueKey('recording-rate-$rate'),
                          checked: rate == owner.playbackRate,
                          child: Row(
                            children: [
                              Expanded(
                                child: Text(rate == 1 ? 'Normal' : '$rate'),
                              ),
                              SizedBox(
                                width: 24,
                                child: rate == owner.playbackRate
                                    ? const Icon(LucideIcons.check, size: 16)
                                    : null,
                              ),
                            ],
                          ),
                        ),
                      ),
                  ]
                : [
                    PopupMenuItem(
                      value: 'download',
                      enabled: !saving,
                      child: const Text('Download'),
                    ),
                    PopupMenuItem(
                      value: 'speed',
                      enabled: !owner.changingRate,
                      child: const Text('Playback speed'),
                    ),
                  ],
          );
          if (!mounted ||
              !buttonContext.mounted ||
              !identical(state, owner) ||
              selection == null) {
            return;
          }
          if (selection == 'speed') {
            speeds = true;
            continue;
          }
          if (selection == 'back') {
            speeds = false;
            continue;
          }
          if (selection == 'download') {
            await saveRecording(owner);
          } else {
            await owner.setPlaybackRate(double.parse(selection));
          }
          return;
        }
      }

      return IconButton(
        tooltip: 'More media controls',
        onPressed: owner.id == null ? null : openMenu,
        icon: const Icon(
          LucideIcons.ellipsisVertical,
          size: 16,
          color: Colors.white,
        ),
      );
    },
  );

  Widget picture(bool full) => AspectRatio(
    aspectRatio: state.ratio,
    child: state.id == null || (fullscreen && !full)
        ? const ColoredBox(color: Colors.black)
        : Texture(textureId: state.id!),
  );

  Widget video(
    BuildContext context, {
    bool full = false,
    bool constrained = false,
  }) => Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      if (full || constrained)
        Flexible(child: picture(full))
      else
        picture(full),
      Container(
        color: const Color(0xff222222),
        padding: const EdgeInsets.symmetric(horizontal: 4),
        child: Row(
          children: [
            IconButton(
              tooltip: state.playing ? 'Pause recording' : 'Play recording',
              onPressed: state.id == null
                  ? null
                  : () => state.command(state.playing ? 'pause' : 'play'),
              icon: Icon(
                state.playing ? LucideIcons.pause : LucideIcons.play,
                size: 18,
                color: Colors.white,
              ),
            ),
            Flexible(
              child: Text(
                '${time(state.position)} / ${time(state.duration)}',
                style: const TextStyle(color: Colors.white, fontSize: 11),
              ),
            ),
            Expanded(
              child: Slider(
                value: state.position,
                max: state.duration > 0 ? state.duration : 1,
                onChanged: state.id == null
                    ? null
                    : (v) => state.command('seek', position: v),
              ),
            ),
            IconButton(
              tooltip: state.muted ? 'Unmute recording' : 'Mute recording',
              onPressed: state.id == null || state.changingMute
                  ? null
                  : state.toggleMute,
              icon: Icon(
                state.muted ? LucideIcons.volumeX : LucideIcons.volume2,
                size: 16,
                color: Colors.white,
              ),
            ),
            IconButton(
              tooltip: full ? 'Exit fullscreen' : 'Fullscreen recording',
              onPressed: full ? () => Navigator.pop(context) : expand,
              icon: Icon(
                full ? LucideIcons.minimize : LucideIcons.maximize,
                size: 16,
                color: Colors.white,
              ),
            ),
            speedMenu(),
          ],
        ),
      ),
      if (state.error != null)
        Padding(
          padding: const EdgeInsets.all(8),
          child: Text(
            state.error!,
            style: webText(context, size: 12, color: 'status.danger'),
          ),
        ),
    ],
  );
  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    // Each source owns its controls, focus and semantics nodes, including when
    // a fullscreen route is covered by another dialog during replacement.
    key: ObjectKey(state),
    animation: state,
    builder: (context, _) => Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(8),
          child: ColoredBox(
            color: Colors.black,
            child: LayoutBuilder(
              builder: (context, bounds) {
                final limit = widget.maxHeight;
                if (limit == null) return video(context);
                return SizedBox(
                  height: math.min(limit, bounds.maxWidth / state.ratio + 48),
                  child: video(context, constrained: true),
                );
              },
            ),
          ),
        ),
        if (widget.showDownload)
          TextButton(
            onPressed: saving ? null : () => saveRecording(state),
            style: TextButton.styleFrom(
              alignment: Alignment.centerLeft,
              padding: const EdgeInsets.only(top: 2, bottom: 8),
              minimumSize: Size.zero,
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
            child: Text(
              widget.path,
              style: webText(context, size: 11.5, color: 'text.muted'),
            ),
          ),
        if (downloadNotice != null)
          Text(
            downloadNotice!,
            style: webText(context, size: 12, color: 'text.secondary'),
          ),
      ],
    ),
  );
}
