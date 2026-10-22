import 'dart:async';

import 'gateway.dart';

/// A view of the shared native Gateway that isolates one browsing context.
///
/// Ordinary session, socket, and document operations are tagged with this
/// gateway's fixed [contextId]. Calls that act on shared account or device
/// state are passed through without a context tag. Enabling push retains the
/// caller context so an asynchronous distributor picker cannot finish for a
/// window that has closed.
class DartScopedGateway extends Gateway {
  static int _visibilityRevisionSequence = 0;

  DartScopedGateway(Gateway transport, {this.contextId = 'primary'})
    : rawTransport = _unwrap(transport) {
    if (contextId.trim().isEmpty) {
      throw ArgumentError.value(contextId, 'contextId', 'Must not be empty.');
    }
  }

  /// Stable native browsing-context identity.
  final String contextId;

  /// The underlying shared transport, unwrapped from any scoped gateway.
  final Gateway rawTransport;

  /// Alias for [rawTransport], useful to code that treats this as a decorator.
  Gateway get transport => rawTransport;

  static const Set<String> _sharedOperations = <String>{
    'boot',
    'preferences',
    'savePreferences',
    'pair',
    'unpair',
    'permissions',
    'completeOnboarding',
    'requestNotifications',
    'requestOverlay',
    'notificationSettings',
    'appSettings',
    'pushStatus',
    'pushDisable',
    'activity',
    'share',
    'external',
    'scan',
    'cancelScanPreparation',
    'recordingOpen',
    'recordingControl',
    'recordingClose',
    'recordingSave',
    'managementStatus',
    'managementBegin',
    'managementCheck',
    'managementCancel',
    'managementOpen',
    // The rooms are the account's, one state for every window.
    'roomsStart',
    'roomsStop',
    'roomsVisible',
    'roomsReload',
    'roomsOpen',
    'roomsOlder',
    'roomsSend',
    'roomsUpload',
    'roomsDownload',
    'roomsTyping',
    'roomsCreate',
    'roomsArchived',
    'roomsSetArchived',
    'roomsUpdate',
    'roomsMove',
    'roomsPin',
    'roomsFaceSaved',
    'roomsFaces',
    'roomsOpenThread',
    'roomsCloseThread',
    'roomDraft',
    'saveRoomDraft',
  };

  static const Set<String> _rootBootRouteFields = <String>{
    'route',
    'targetSession',
    'interactionId',
    'answerChoice',
    'confirmQuestion',
    'pairLink',
  };

  bool get isPrimary => contextId == 'primary';

  bool get isClosed => _closed;

  bool _closed = false;
  bool _registered = false;
  String? _pairingStamp;
  String? _latestWatchTag;
  String? _watchedSessionId;
  final Set<String> _unwatchingTags = <String>{};
  int _watchGeneration = 0;
  Future<void>? _openingFuture;
  Future<void>? _closeFuture;

  late final Stream<Json> _scopedEvents = rawTransport.events
      .where(_eventBelongsToThisScope)
      .asBroadcastStream(
        onCancel: (subscription) => unawaited(subscription.cancel()),
      );

  @override
  Stream<Json> get events => _scopedEvents;

  /// Registers a child context once, sharing the pending registration across
  /// concurrent callers. The primary context is owned by the App runtime.
  Future<void> ensureContext() {
    if (_closed) {
      return Future<void>.error(StateError('Gateway context is closed.'));
    }
    if (isPrimary || _registered) return Future<void>.value();
    final opening = _openingFuture;
    if (opening != null) return opening;
    final next = _registerContext();
    _openingFuture = next;
    return next;
  }

  Future<void> _registerContext() async {
    try {
      final boot = obj(await rawTransport.call('boot'));
      final stamp = boot['pairingStamp'];
      if (stamp is! String || stamp.isEmpty) {
        throw StateError('Cannot register a context without a pairing stamp.');
      }
      _pairingStamp = stamp;
      await rawTransport.call('openContext', <String, dynamic>{
        'contextId': contextId,
        'pairingStamp': stamp,
      });
      _registered = true;
    } catch (_) {
      _openingFuture = null;
      _pairingStamp = null;
      rethrow;
    }
  }

  /// Idempotently closes this native context after the owner has flushed its
  /// draft. If registration is in flight, close waits until it completes.
  /// Primary is owned by the App runtime and is never registered or closed by
  /// a child wrapper.
  Future<void> closeContext() {
    final existing = _closeFuture;
    if (existing != null) return existing;

    // Prevent pending requests from reaching the transport while close waits
    // for an in-progress registration.
    _closed = true;
    _latestWatchTag = null;
    _watchedSessionId = null;
    _unwatchingTags.clear();
    if (isPrimary) {
      return _closeFuture = Future<void>.value();
    }
    return _closeFuture = _closeAfterRegistration(_openingFuture);
  }

  Future<void> _closeAfterRegistration(Future<void>? opening) async {
    if (opening != null) await opening;
    if (!_registered) return;
    await rawTransport.call('closeContext', <String, dynamic>{
      'contextId': contextId,
      'pairingStamp': _pairingStamp,
    });
    _registered = false;
  }

  @override
  Future<dynamic> call(String method, [Json args = const <String, dynamic>{}]) {
    if (method == 'closeContext') return closeContext();
    if (_closed) {
      return Future<dynamic>.error(StateError('Gateway context is closed.'));
    }
    if (method == 'openContext') {
      return Future<dynamic>.error(
        StateError('Use ensureContext() to register this gateway context.'),
      );
    }

    final forwarded = Map<String, dynamic>.of(args);
    if (_sharedOperations.contains(method)) {
      forwarded.remove('contextId');
    } else {
      // The gateway identity is authoritative even if the caller supplied a
      // contextId in its argument map.
      forwarded['contextId'] = contextId;
    }

    if (_sharedOperations.contains(method)) {
      return _callAndSanitizeBoot(method, forwarded);
    }
    return _callContextual(method, forwarded);
  }

  Future<dynamic> _callContextual(String method, Json args) async {
    String? thisWatchTag;
    if (method == 'watch') {
      final sessionId = args['sessionId'];
      if (_latestWatchTag == null ||
          _watchedSessionId != sessionId ||
          _unwatchingTags.contains(_latestWatchTag)) {
        _latestWatchTag = '$contextId:${++_watchGeneration}';
      }
      thisWatchTag = _latestWatchTag;
      _watchedSessionId = sessionId is String ? sessionId : null;
      args['watchTag'] = thisWatchTag;
    } else if (method == 'unwatch') {
      thisWatchTag = _latestWatchTag;
      if (thisWatchTag == null) {
        args.remove('watchTag');
      } else {
        args['watchTag'] = thisWatchTag;
        _unwatchingTags.add(thisWatchTag);
      }
    } else if (method == 'setWatchVisibility') {
      final requestedRevision = args['visibilityRevision'];
      if (requestedRevision is! int || requestedRevision < 0) {
        throw ArgumentError.value(
          requestedRevision,
          'visibilityRevision',
          'Must be a nonnegative integer.',
        );
      }
      // LiveController counters restart with a replacement controller. Keep
      // the native per-context revision monotonic across that replacement.
      _visibilityRevisionSequence =
          requestedRevision > _visibilityRevisionSequence
          ? requestedRevision
          : _visibilityRevisionSequence + 1;
      args['visibilityRevision'] = _visibilityRevisionSequence;
      thisWatchTag = _latestWatchTag;
      if (thisWatchTag == null) {
        args.remove('watchTag');
      } else {
        args['watchTag'] = thisWatchTag;
      }
    }
    if (method == 'unwatch' && thisWatchTag == null) return null;

    try {
      await ensureContext();
      if (_closed) throw StateError('Gateway context is closed.');
      final result = await _callAndSanitizeBoot(method, args);
      if (method == 'unwatch' && thisWatchTag != null) {
        _unwatchingTags.remove(thisWatchTag);
        if (_latestWatchTag == thisWatchTag) {
          _latestWatchTag = null;
          _watchedSessionId = null;
        }
      }
      return result;
    } catch (_) {
      if (method == 'unwatch' && thisWatchTag != null) {
        _unwatchingTags.remove(thisWatchTag);
      }
      if (method == 'watch' && _latestWatchTag == thisWatchTag) {
        _latestWatchTag = null;
        _watchedSessionId = null;
      }
      rethrow;
    }
  }

  Future<dynamic> _callAndSanitizeBoot(String method, Json args) async {
    final result = await rawTransport.call(method, args);
    if (method != 'boot' || isPrimary || result is! Map) return result;

    final boot = obj(result);
    boot.removeWhere((key, _) => _rootBootRouteFields.contains(key));
    return boot;
  }

  bool _eventBelongsToThisScope(Json event) {
    if (_closed) return false;

    // A pairing change invalidates every context, even if a native emitter
    // attaches a stale contextId to the notification.
    if (event['type'] == 'pairingChanged') return true;

    // OS notification routes belong to the primary App window, including if
    // a native producer mistakenly marks a route as account-wide.
    if (event['type'] == 'route') return isPrimary;

    final eventWatchTag = event['watchTag'];
    if (eventWatchTag != null && eventWatchTag != _latestWatchTag) {
      return false;
    }

    if (event['scope'] == 'account' || event['scope'] == 'rooms') return true;

    final eventContextId = event['contextId'];
    if (eventContextId is String) return eventContextId == contextId;

    // Legacy native events have no context tag. Keep them visible only to the
    // primary App controller while the native emitter is being scoped.
    return isPrimary && eventContextId == null;
  }

  static Gateway _unwrap(Gateway gateway) {
    if (gateway is DartScopedGateway) return gateway.rawTransport;
    return gateway;
  }
}
