part of 'gateway.dart';

/// Private drafts and pending sends are independent of the visible conversation.
/// Native storage owns revisions, hashes and admission; this class never invents receipts.
class FirstSendState {
  FirstSendState(this.c);
  final LiveController c;
  Json capabilities = {};
  Json? current;
  List<Json> saved = [];
  bool controlBusy = false;
  bool unavailable = false;
  String? _submitting;
  int _epoch = 0, _capRevision = 0;
  Future<void> _writes = Future<void>.value();
  final _revisions = <String, int>{};
  bool get enabled => available && capabilities['canSubmit'] == true;
  bool get available =>
      capabilities['version'] == 1 &&
      capabilities['canFenceAccount'] == true &&
      capabilities['ownerUser'] is String &&
      capabilities['draftScope'] is String;
  bool get sending => current != null && current!['operationId'] == _submitting;
  bool get frozen => current?['frozen'] == true || sending;
  String? get phase => obj(current?['preparation'])['state'] as String?;
  bool get admitted => phase == 'admitted';
  bool get stopped =>
      phase != 'cancelled' &&
      obj(obj(current?['preparation'])['messageAdmission'])['stopConfirmed'] ==
          true;
  bool get hasMapping {
    final p = obj(current?['preparation']);
    return p['accepted'] == true &&
        phase != 'cancelled' &&
        (p.containsKey('nodeMapped')
            ? p['nodeMapped'] == true
            : phase != 'accepted');
  }

  bool get canStop =>
      obj(current?['preparation'])['accepted'] == true &&
      phase != 'cancelled' &&
      current?['cancelRequested'] != true &&
      (hasMapping || capabilities['canStopBeforeAllocation'] == true);
  bool get stopRequested =>
      obj(obj(current?['preparation'])['messageAdmission'])['stopRequested'] ==
      true;
  static String identity() => List.generate(
    16,
    (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0'),
  ).join();
  String _key(Json row) => '${row['scope']}\n${row['operationId']}';
  Json _args(Json row) => {
    'ownerUser': row['ownerUser'],
    'operationId': row['operationId'],
    'pairingStamp': row['pairingStamp'],
  };
  bool _visible(Json row, int epoch) =>
      !c._disposed &&
      epoch == _epoch &&
      row['scope'] == capabilities['draftScope'] &&
      row['pairingStamp'] == c.pairingStamp;
  Json _bound(Json row, String stamp) => {...row, 'pairingStamp': stamp};
  bool owns(Json row) => _visible(row, _epoch);
  void _remember(Json row, int epoch, {bool notify = true}) {
    final revision = row['revision'] as int? ?? 0;
    if (revision < (_revisions[_key(row)] ?? 0)) return;
    _revisions[_key(row)] = revision;
    if (!_visible(row, epoch)) return;
    final count = saved.length;
    saved = [
      if ('${row['message'] ?? ''}'.isNotEmpty ||
          rows(row['files']).isNotEmpty ||
          row['frozen'] == true)
        row,
      ...saved.where((item) => item['operationId'] != row['operationId']),
    ];
    if (current?['operationId'] == row['operationId']) {
      current = row;
      final preparation = obj(row['preparation']);
      if (preparation['accepted'] == true && c.isDraftSession) {
        c.sessionId = preparation['sessionId'] as String;
        c.state = {
          ...c.state,
          'session': {...obj(c.state['session']), 'id': c.sessionId},
        };
      }
      // Hashes are metadata only. Keep pending selection bytes out of later saves.
      final files = rows(row['files']);
      c.attachments = c.attachments.map((attachment) {
        final file = files
            .where((f) => f['id'] == attachment['id'])
            .firstOrNull;
        return file == null
            ? attachment
            : {...attachment, 'sha256': file['sha256'], 'nativeStored': true};
      }).toList();
    }
    if (notify || count != saved.length) c.changed();
  }

  void reset() {
    ++_epoch;
    ++_capRevision;
    capabilities = {};
    unavailable = true;
    current = null;
    saved = [];
    _submitting = null;
    controlBusy = false;
  }

  void leave() {
    final row = current, epoch = _epoch;
    current = null;
    if (row == null ||
        row['frozen'] == true ||
        row['operationId'] == _submitting) {
      return;
    }
    unawaited(
      _writes
          .then((_) async {
            final stored = await _read(row);
            if (stored != null &&
                stored['frozen'] != true &&
                '${stored['message'] ?? ''}'.isEmpty &&
                rows(stored['files']).isEmpty) {
              await _forget(stored, epoch);
            }
          })
          .catchError((Object _) {}),
    );
  }

  Future<void> initialize() async {
    final stamp = c.pairingStamp;
    var account = c._accountRevision;
    if (stamp == null || c.origin == null) return;
    final ticket = ++_capRevision;
    try {
      final raw = await c.gateway.call('firstSendCapabilities', {
        'pairingStamp': stamp,
      });
      final caps = obj(raw);
      if (c._disposed ||
          ticket != _capRevision ||
          stamp != c.pairingStamp ||
          account != c._accountRevision) {
        return;
      }
      if (capabilities['draftScope'] != null &&
          caps['draftScope'] != capabilities['draftScope']) {
        c.discardDraftSession();
        reset();
        account = ++c._accountRevision;
        c._selection++;
        c._navigationIntent++;
        c.busy = false;
        c.readers.clear();
        c.panelState.clear();
        c.attention.reset();
        c.state = {};
        c.sessionId = null;
        c.draft = '';
        c.models = [];
        c.sessions = [];
        c.workspaces = [];
        c.nodes = [];
        c._resetAttachments();
        unawaited(c.gateway.call('unwatch').catchError((Object _) => null));
      }
      capabilities = caps;
      // Null means an older bridge; explicit canSubmit:false is the gated legacy
      // contract. A failed/unknown negotiation never enables legacy creation.
      unavailable =
          !(raw == null ||
              (caps['version'] == 1 && caps['canSubmit'] == false) ||
              enabled);
      if (available) {
        final records = rows(
          await c.gateway.call('firstSendDrafts', {
            'pairingStamp': stamp,
            'ownerUser': caps['ownerUser'],
            'action': 'list',
          }),
        );
        if (stamp != c.pairingStamp ||
            account != c._accountRevision ||
            !identical(capabilities, caps) ||
            c._disposed) {
          return;
        }
        saved = records
            .map((r) => _bound(r, stamp))
            .where((r) => (r['revision'] as int) >= (_revisions[_key(r)] ?? 0))
            .where(
              (r) =>
                  '${r['message'] ?? ''}'.isNotEmpty ||
                  rows(r['files']).isNotEmpty ||
                  r['frozen'] == true,
            )
            .toList();
        for (final row in saved) {
          _revisions[_key(row)] = row['revision'] as int;
        }
      }
      c.changed();
    } catch (error) {
      final details = error is PlatformException
          ? obj(error.details)
          : <String, dynamic>{};
      if (stamp != c.pairingStamp ||
          account != c._accountRevision ||
          ticket != _capRevision) {
        return;
      }
      unavailable = !enabled;
      if (error is MissingPluginException || details['status'] == 404) {
        if (!enabled) {
          capabilities = {};
          unavailable = false;
        }
      }
      if ([401, 403].contains(details['status']) ||
          details['code'] == 'account_changed') {
        c.discardDraftSession();
        reset();
        c.state = {};
        c.sessionId = null;
        c.draft = '';
        c._resetAttachments();
        c.changed();
      }
      // Older native bridges/servers stay on their documented legacy flow.
      // A transient offline failure preserves an already-bound local draft.
    }
  }

  Json _value() {
    final model = c.selectedModel;
    return {
      'workspaceId': c._draftWorkspaceId,
      'message': c.draft,
      if (model != null)
        'model': {'provider': model['provider'], 'id': model['id']},
      'thinking': c.selectedThinking,
      'files': c.attachments
          .map(
            (a) => {
              'id': a['id'],
              'name': a['name'],
              'mimeType': '${a['mimeType'] ?? ''}'.isEmpty
                  ? 'application/octet-stream'
                  : a['mimeType'],
              'byteSize': a['size'],
              if (a['sha256'] != null) 'sha256': a['sha256'],
            },
          )
          .toList(),
    };
  }

  Future<void> save() {
    final row = current;
    if (row == null || row['frozen'] == true || sending) return _writes;
    final value = _value(), epoch = _epoch;
    final files = c.attachments
        .where((a) => a['draftBytes'] is Uint8List && a['nativeStored'] != true)
        .map((a) => {'id': a['id'], 'bytes': a['draftBytes']})
        .toList();
    final write = _writes.then((_) async {
      final revision = _revisions[_key(row)] ?? row['revision'];
      final stored = obj(
        await c.gateway.call('firstSendDrafts', {
          ..._args(row),
          'action': 'put',
          if (revision != 0) 'expectedRevision': revision,
          'record': value,
          'files': files,
        }),
      );
      _remember(
        _bound(stored, row['pairingStamp'] as String),
        epoch,
        notify: false,
      );
    });
    _writes = write.catchError((Object error) {
      if (_visible(row, epoch) &&
          current?['operationId'] == row['operationId']) {
        c.actionError = LiveController.describe(error);
        c.changed();
      }
    });
    return write;
  }

  Future<void> flush() async {
    final row = current;
    if (row == null) {
      await _writes;
      return;
    }
    do {
      final revision = c._draftRevision;
      await save();
      if (revision == c._draftRevision ||
          current?['operationId'] != row['operationId']) {
        return;
      }
    } while (true);
  }

  Future<void> reserve() async {
    current = {
      'operationId': c.sessionId,
      'scope': capabilities['draftScope'],
      'ownerUser': capabilities['ownerUser'],
      'pairingStamp': c.pairingStamp,
      'workspaceId': c._draftWorkspaceId,
      'message': c.draft,
      'files': [],
      'revision': 0,
      'frozen': false,
      'prepareAttempted': false,
    };
    c.changed();
    await save();
  }

  Future<Json?> _read(Json row) async {
    final result = await c.gateway.call('firstSendDrafts', {
      ..._args(row),
      'action': 'get',
    });
    return result == null
        ? null
        : _bound(obj(result), row['pairingStamp'] as String);
  }

  Future<void> _forget(Json row, int epoch) async {
    await c.gateway.call('firstSendDrafts', {
      ..._args(row),
      'action': 'delete',
      'expectedRevision': row['revision'],
    });
    _revisions[_key(row)] = (row['revision'] as int) + 1;
    if (!_visible(row, epoch)) return;
    saved = saved.where((r) => r['operationId'] != row['operationId']).toList();
    if (current?['operationId'] == row['operationId']) current = null;
  }

  Future<void> _finish(Json row, int selection, int epoch) async {
    if (!_visible(row, epoch) ||
        c._selection != selection ||
        current?['operationId'] != row['operationId']) {
      return;
    }
    if (obj(row['preparation'])['state'] != 'admitted' ||
        _revisions[_key(row)] != row['revision']) {
      return;
    }
    final id = obj(row['preparation'])['sessionId'] as String;
    await _forget(row, epoch);
    if (!_visible(row, epoch) || c._selection != selection) return;
    c.discardDraftSession();
    await c.open(id, skipFirst: true);
  }

  Future<void> submit() async {
    final row = current, epoch = _epoch, selection = c._selection;
    if (row == null || _submitting != null || c.uploading) return;
    if (!enabled) {
      c.actionError = tr(
        'Connect to the Gateway to confirm first-send support before creating a conversation.',
      );
      c.changed();
      return;
    }
    if (row['frozen'] != true &&
        c.draft.trim().isEmpty &&
        c.attachments.isEmpty) {
      return;
    }
    final saving = row['frozen'] == true ? _writes : save();
    _submitting = row['operationId'] as String;
    c.busy = true;
    c.actionError = null;
    c.changed();
    try {
      await saving;
      final stored = await _read(row);
      if (stored == null) {
        throw StateError(tr('This draft is no longer available.'));
      }
      final result = _bound(
        obj(
          await c.gateway.call('firstSendSubmit', {
            ..._args(stored),
            'expectedRevision': stored['revision'],
          }),
        ),
        row['pairingStamp'] as String,
      );
      _remember(result, epoch);
      await _finish(result, selection, epoch);
      if (_visible(row, epoch)) unawaited(c.refreshList());
    } catch (error) {
      // Native may have accepted the operation despite losing its response.
      // Read only its local journal; do not manufacture a new submission.
      try {
        final stored = await _read(row);
        if (stored != null) _remember(stored, epoch);
      } catch (_) {}
      if (_visible(row, epoch) && selection == c._selection) {
        c.actionError = LiveController.describe(error);
      }
    } finally {
      if (epoch == _epoch) {
        _submitting = null;
        c.busy = false;
        c.changed();
      }
    }
  }

  Future<void> _control(String method, {bool finish = false}) async {
    final row = current, epoch = _epoch, selection = c._selection;
    if (row == null || controlBusy) return;
    controlBusy = true;
    c.changed();
    try {
      final result = await c.gateway.call(method, _args(row));
      if (result is Map) {
        final stored = _bound(obj(result), row['pairingStamp'] as String);
        _remember(stored, epoch);
        if (finish) await _finish(stored, selection, epoch);
      }
    } finally {
      if (epoch == _epoch) {
        controlBusy = false;
        c.changed();
      }
    }
  }

  Future<void> check() => _control('firstSendCheck');
  Future<void> stop() => _control('firstSendStop');
  Future<void> takeControl() => _control('firstSendTakeControl');
  Future<void> openKnown() async {
    final row = current, epoch = _epoch, selection = c._selection;
    if (row == null || controlBusy) return;
    if (admitted) {
      await _finish(row, selection, epoch);
      return;
    }
    if (!stopped) return;
    controlBusy = true;
    c.changed();
    try {
      final result = _bound(
        obj(await c.gateway.call('firstSendRelease', _args(row))),
        row['pairingStamp'] as String,
      );
      _remember(result, epoch);
      if (!_visible(row, epoch) || selection != c._selection) return;
      c.discardDraftSession();
      await c.open(
        obj(result['preparation'])['sessionId'] as String,
        skipFirst: true,
      );
    } finally {
      if (epoch == _epoch) {
        controlBusy = false;
        c.changed();
      }
    }
  }

  Future<void> resume(Json row) async {
    final epoch = _epoch, selection = c._selection;
    final stored = await _read(row);
    if (stored == null ||
        !_visible(stored, epoch) ||
        selection != c._selection) {
      return;
    }
    if (obj(stored['preparation'])['state'] == 'admitted') {
      await _forget(stored, epoch);
      if (_visible(stored, epoch) && selection == c._selection) {
        await c.open(
          obj(stored['preparation'])['sessionId'] as String,
          skipFirst: true,
        );
      }
      return;
    }
    await c.create('${stored['workspaceId']}', recovered: stored);
  }

  Future<Json?> find(String id) async {
    final local = saved
        .where(
          (r) =>
              r['operationId'] == id ||
              obj(r['preparation'])['sessionId'] == id,
        )
        .firstOrNull;
    if (local != null) return local;
    if (!available || capabilities['canFindPendingSession'] != true) {
      return null;
    }
    final epoch = _epoch, stamp = c.pairingStamp;
    if (stamp == null) return null;
    try {
      final row = _bound(
        obj(
          await c.gateway.call('firstSendAdopt', {
            'pairingStamp': stamp,
            'ownerUser': capabilities['ownerUser'],
            'sessionId': id,
          }),
        ),
        stamp,
      );
      _remember(row, epoch);
      return _visible(row, epoch) ? row : null;
    } on PlatformException catch (error) {
      if (obj(error.details)['status'] == 404) return null;
      rethrow;
    }
  }

  Future<Json?> inspect(Json row) async {
    final epoch = _epoch;
    final stored = await _read(row);
    if (stored != null) _remember(stored, epoch);
    return stored;
  }

  Future<void> discard(Json row, {bool deleteAccepted = false}) async {
    final epoch = _epoch, selection = c._selection;
    final selected = current?['operationId'] == row['operationId'];
    await _writes;
    final before = await _read(row);
    if (before == null) {
      if (_visible(row, epoch) && selected && selection == c._selection) {
        c.discardDraftSession();
      }
      return;
    }
    dynamic result;
    try {
      result = await c.gateway.call('firstSendCancel', {
        ..._args(row),
        'deleteAccepted': deleteAccepted,
      });
    } catch (_) {
      try {
        final stored = await _read(row);
        if (stored != null) _remember(stored, epoch);
      } catch (_) {}
      rethrow;
    }
    if (result is Map) {
      final stored = _bound(obj(result), row['pairingStamp'] as String);
      _remember(stored, epoch);
      if (obj(stored['preparation'])['state'] == 'cancelled' &&
          obj(stored['preparation'])['cleanupPending'] != true) {
        await _forget(stored, epoch);
      }
    } else if (_visible(row, epoch)) {
      saved = saved
          .where((r) => r['operationId'] != row['operationId'])
          .toList();
      if (selected) current = null;
    }
    if (_visible(row, epoch) && selected && selection == c._selection) {
      c.discardDraftSession();
    }
    c.changed();
  }

  void sessionDeleted(String id) {
    final epoch = _epoch;
    final candidates = saved
        .where(
          (row) =>
              obj(row['preparation'])['sessionId'] == id ||
              row['operationId'] == _submitting,
        )
        .toList();
    for (final row in candidates) {
      unawaited(() async {
        try {
          final local = await _read(row);
          if (local == null ||
              obj(local['preparation'])['sessionId'] != id ||
              !_visible(local, epoch)) {
            return;
          }
          final result = _bound(
            obj(await c.gateway.call('firstSendCheck', _args(local))),
            local['pairingStamp'] as String,
          );
          _remember(result, epoch);
          if (obj(result['preparation'])['state'] == 'cancelled' &&
              obj(result['preparation'])['cleanupPending'] != true) {
            await _forget(result, epoch);
          }
          c.changed();
        } catch (_) {
          /* Keep the original for explicit reconciliation while offline. */
        }
      }());
    }
  }

  Future<void> dismiss(Json row) async {
    final epoch = _epoch, selection = c._selection;
    final selected = current?['operationId'] == row['operationId'];
    await _forget(row, epoch);
    if (_visible(row, epoch) && selected && selection == c._selection) {
      c.discardDraftSession();
    }
    c.changed();
  }

  void restore(Json row) {
    current = row;
    c.draft = '${row['message'] ?? ''}';
    c.state = {
      ...c.state,
      'thinking': row['thinking'] ?? 'medium',
      'modelId': obj(row['model'])['id'],
      'modelProvider': obj(row['model'])['provider'],
    };
    c.attachments = rows(row['files'])
        .map(
          (f) => {
            'id': f['id'],
            'name': f['name'],
            'mimeType': f['mimeType'],
            'size': f['byteSize'],
            'sha256': f['sha256'],
            'nativeStored': true,
            'kind': '${f['mimeType']}'.startsWith('image/') ? 'image' : 'file',
          },
        )
        .toList();
  }
}
