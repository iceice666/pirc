import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import 'gateway.dart';

/// Registers [child]'s visible bounds as the Android external-image drop area.
///
/// Wrap only the composer surface that should accept dropped images. The
/// native target is scoped to the current controller, account, and session.
class ExternalImageDropTarget extends StatefulWidget {
  const ExternalImageDropTarget({
    super.key,
    required this.controller,
    required this.child,
  });

  final LiveController controller;
  final Widget child;

  @override
  State<ExternalImageDropTarget> createState() =>
      _ExternalImageDropTargetState();
}

class _RegisteredImageDropTarget {
  const _RegisteredImageDropTarget({
    required this.controller,
    required this.targetId,
    required this.scopeToken,
    required this.scope,
    required this.rect,
    required this.devicePixelRatio,
  });

  final LiveController controller;
  final String targetId;
  final String scopeToken;
  final Json scope;
  final Rect rect;
  final double devicePixelRatio;
}

class _ExternalImageDropTargetState extends State<ExternalImageDropTarget>
    with WidgetsBindingObserver {
  final _boundsKey = GlobalKey();
  late final String _targetId =
      'flutter-image-drop-${identityHashCode(this)}-${DateTime.now().microsecondsSinceEpoch}';
  StreamSubscription<Json>? _events;
  _RegisteredImageDropTarget? _registered;
  int _generation = 0;
  int _syncRevision = 0;
  bool _syncQueued = false;
  Future<void> _syncQueue = Future<void>.value();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _bindController(widget.controller);
  }

  void _bindController(LiveController controller) {
    controller.addListener(_scheduleSync);
    _events = controller.gateway.events.listen(_onEvent, onError: (_) {});
  }

  void _unbindController(LiveController controller) {
    controller.removeListener(_scheduleSync);
    unawaited(_events?.cancel());
    _events = null;
  }

  @override
  void didUpdateWidget(covariant ExternalImageDropTarget oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      final oldTarget = _registered;
      _registered = null;
      _unbindController(oldWidget.controller);
      if (oldTarget != null) unawaited(_clearNative(oldTarget));
      _bindController(widget.controller);
    }
    _scheduleSync();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _scheduleSync();
  }

  @override
  void didChangeMetrics() => _scheduleSync();

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _scheduleSync();
    } else {
      _deactivateTarget();
    }
  }

  void _onEvent(Json event) {
    if (event['type'] != 'externalImageDrop') return;
    final active = _registered;
    if (active == null || !identical(active.controller, widget.controller)) {
      return;
    }
    final data = obj(event['data']);
    if (data['targetId'] != active.targetId ||
        data['scopeToken'] != active.scopeToken ||
        event['sessionId'] != active.scope['sessionId']) {
      return;
    }
    final files = rows(data['files']);
    unawaited(active.controller.acceptExternalImageDrop(active.scope, files));
  }

  void _scheduleSync() {
    if (!mounted || _syncQueued) return;
    _syncQueued = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _syncQueued = false;
      if (!mounted) return;
      final revision = ++_syncRevision;
      _syncQueue = _syncQueue.then((_) => _syncTarget(revision));
    });
  }

  Rect? _visibleBounds(RenderBox box) {
    if (!box.attached || !box.hasSize || box.size.isEmpty) return null;
    if (!TickerMode.valuesOf(context).enabled ||
        ModalRoute.of(context)?.isCurrent == false) {
      return null;
    }

    var bounds = MatrixUtils.transformRect(
      box.getTransformTo(null),
      Offset.zero & box.size,
    );
    RenderObject child = box;
    RenderObject? ancestor = box.parent;
    while (ancestor != null) {
      if (ancestor is RenderOffstage && ancestor.offstage) return null;
      if (ancestor is RenderOpacity && ancestor.opacity == 0) return null;
      final clip = ancestor.describeApproximatePaintClip(child);
      if (clip != null && ancestor is RenderBox) {
        bounds = bounds.intersect(
          MatrixUtils.transformRect(ancestor.getTransformTo(null), clip),
        );
      }
      child = ancestor;
      ancestor = ancestor.parent;
    }

    final media = MediaQuery.of(context);
    final visibleHeight = (media.size.height - media.viewInsets.bottom).clamp(
      0.0,
      media.size.height,
    );
    bounds = bounds.intersect(
      Rect.fromLTWH(0, 0, media.size.width, visibleHeight),
    );
    return bounds.isEmpty ? null : bounds;
  }

  Future<void> _syncTarget(int revision) async {
    if (!mounted || revision != _syncRevision) return;
    final controller = widget.controller;
    final scope = controller.captureExternalImageDropScope();
    final sessionId = scope['sessionId'];
    final dpr = View.of(context).devicePixelRatio;
    final box = _boundsKey.currentContext?.findRenderObject();
    final rect =
        sessionId is String &&
            sessionId.isNotEmpty &&
            dpr > 0 &&
            box is RenderBox
        ? _visibleBounds(box)
        : null;

    final oldTarget = _registered;
    if (rect == null) {
      if (oldTarget != null) {
        _registered = null;
        await _clearNative(oldTarget);
      }
      return;
    }

    if (oldTarget != null &&
        identical(oldTarget.controller, controller) &&
        _sameScope(oldTarget.scope, scope) &&
        oldTarget.rect == rect &&
        oldTarget.devicePixelRatio == dpr) {
      return;
    }

    if (oldTarget != null) {
      _registered = null;
      await _clearNative(oldTarget);
      if (!mounted || revision != _syncRevision) return;
    }

    final target = _RegisteredImageDropTarget(
      controller: controller,
      targetId: _targetId,
      scopeToken: '$_targetId:${++_generation}',
      scope: Map<String, dynamic>.of(scope),
      rect: rect,
      devicePixelRatio: dpr,
    );
    // Install locally before awaiting the platform call; EventChannel can
    // deliver the first drop before setExternalImageDropTarget replies.
    _registered = target;
    try {
      await controller.gateway.call('setExternalImageDropTarget', {
        'targetId': target.targetId,
        'scopeToken': target.scopeToken,
        'sessionId': sessionId,
        'devicePixelRatio': dpr,
        'rect': {
          'left': rect.left,
          'top': rect.top,
          'right': rect.right,
          'bottom': rect.bottom,
        },
      });
    } catch (_) {
      if (identical(_registered, target)) _registered = null;
      return;
    }
    if (!mounted ||
        revision != _syncRevision ||
        !identical(_registered, target)) {
      if (identical(_registered, target)) _registered = null;
      await _clearNative(target);
    }
  }

  bool _sameScope(Json a, Json b) =>
      a['sessionId'] == b['sessionId'] &&
      a['accountRevision'] == b['accountRevision'] &&
      a['selectionRevision'] == b['selectionRevision'] &&
      a['navigationIntent'] == b['navigationIntent'] &&
      a['sessionNavigationRevision'] == b['sessionNavigationRevision'] &&
      a['origin'] == b['origin'] &&
      a['clientId'] == b['clientId'] &&
      a['pairingStamp'] == b['pairingStamp'];

  Future<void> _clearNative(_RegisteredImageDropTarget target) async {
    try {
      await target.controller.gateway.call('clearExternalImageDropTarget', {
        'targetId': target.targetId,
        'scopeToken': target.scopeToken,
      });
    } catch (_) {
      // A closed native context already invalidates its target.
    }
  }

  void _deactivateTarget() {
    final target = _registered;
    _registered = null;
    ++_syncRevision;
    if (target != null) unawaited(_clearNative(target));
  }

  @override
  Widget build(BuildContext context) {
    _scheduleSync();
    return NotificationListener<ScrollNotification>(
      onNotification: (_) {
        _scheduleSync();
        return false;
      },
      child: SizedBox(key: _boundsKey, child: widget.child),
    );
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.controller.removeListener(_scheduleSync);
    unawaited(_events?.cancel());
    final target = _registered;
    _registered = null;
    if (target != null) unawaited(_clearNative(target));
    super.dispose();
  }
}
