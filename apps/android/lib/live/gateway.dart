import 'dart:async';
import 'dart:math';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'work_index.dart';
import 'modes.dart';
import 'panel_resource.dart';
import 'rooms_state.dart';

typedef Json = Map<String, dynamic>;
Json obj(dynamic value) =>
    value is Map ? value.map((k, v) => MapEntry('$k', v)) : {};
List<Json> rows(dynamic value) => value is List ? value.map(obj).toList() : [];
String enc(String value) => Uri.encodeComponent(value);
String sessionPath(String id) => '/api/sessions/${enc(id)}';
const workspaceUnavailableNotice =
    "This workspace's mode is unavailable on the gateway: its history is read-only and it takes no new sessions.";

class Gateway {
  static const channel = MethodChannel('dev.pirc.mobile/gateway');
  static const eventChannel = EventChannel('dev.pirc.mobile/events');
  late final Stream<Json> events = eventChannel
      .receiveBroadcastStream()
      .map(obj)
      .asBroadcastStream();
  Future<dynamic> call(String method, [Json args = const {}]) =>
      channel.invokeMethod(method, args);
  Future<Json> request(
    String path, {
    String method = 'GET',
    dynamic body,
    String? pairingStamp,
  }) async => obj(
    await call('request', {
      'method': method,
      'path': path,
      'body': body,
      'pairingStamp': ?pairingStamp,
    }),
  );
  Future<Json> command(String id, Json payload) async => obj(
    await call('command', {
      'sessionId': id,
      'payload': payload,
      'commandId': List.generate(
        16,
        (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0'),
      ).join(),
    }),
  );
}

class ReadingState {
  ReadingState(String first) : versions = [first];
  final List<String> versions;
  final offsets = <int, double>{};
  int selected = 0;
}

class LiveController extends ChangeNotifier {
  LiveController(this.gateway, {this.showing = 'rooms'});

  /// Which page the app shows: `rooms` (the default: the conversations) or
  /// `engine` (sessions, nodes and the rest of the machinery).
  String showing;

  /// The rooms (plans/rewrite/12-android.md), started once they are shown.
  late final RoomsController rooms = RoomsController(
    gateway,
    pairingStampOf: () => pairingStamp,
  );

  /// The engine section a room line's "Details" asked for (`memory`,
  /// `loops`, `wakes`), until the engine shows it.
  String? engineSection;

  /// Show the rooms, following them from the first time on.
  void showRooms({String? roomId}) {
    showing = 'rooms';
    if (origin != null) {
      if (!rooms.started) {
        unawaited(rooms.start(roomId));
      } else if (roomId != null) {
        unawaited(rooms.reveal(roomId));
      }
      unawaited(rooms.setVisible(_appVisible));
    }
    changed();
  }

  /// Show the engine: sessions, workspaces, nodes.
  void showEngine({String? section}) {
    engineSection = section;
    showing = 'engine';
    if (rooms.started) unawaited(rooms.setVisible(false));
    unawaited(rooms.flushDraft());
    changed();
  }

  /// Another account (or none): the rooms start over if they are shown.
  Future<void> _restartRooms() async {
    if (rooms.started) await rooms.stop();
    if (origin != null && showing == 'rooms') await rooms.start();
  }

  int get attentionCount => sessions.where(isWaiting).length;
  final Gateway gateway;
  String? origin, clientId, sessionId, error, actionError, pairLink, routePage;
  Json state = {}, control = {}, preferences = {};
  Json? notificationQuestion;
  bool fromNotification = false;
  List<Json> sessions = [],
      workspaces = [],
      nodes = [],
      models = [],
      attachments = [];

  /// The gateway's mode catalog; empty with an older gateway (legacy `kind`).
  ModeCatalog catalog = ModeCatalog();
  bool uploading = false;
  Json? get selectedModel {
    final id = state['modelId'];
    final provider = state['modelProvider'];
    return models
            .where(
              (m) =>
                  m['id'] == id &&
                  (provider == null || m['provider'] == provider),
            )
            .firstOrNull ??
        models.where((m) => m['available'] != false).firstOrNull;
  }

  int _modelRefreshRevision = 0;

  /// Refresh choices without applying a response to another account or session.
  Future<void> refreshModels() async {
    final revision = ++_modelRefreshRevision;
    final selection = _selection, account = _accountRevision;
    final id = sessionId, host = origin, client = clientId;
    final data = await gateway.request(
      id == null ? '/api/models' : '/api/models?sessionId=${enc(id)}',
    );
    if (_disposed ||
        revision != _modelRefreshRevision ||
        selection != _selection ||
        account != _accountRevision ||
        id != sessionId ||
        host != origin ||
        client != clientId) {
      return;
    }
    models = rows(data['models']);
    changed();
  }

  String get selectedThinking => '${state['thinking'] ?? 'medium'}';
  String? get approvalMode =>
      const ['read-only', 'auto', 'full-access'].contains(state['approvalMode'])
      ? state['approvalMode'] as String
      : null;

  Future<void> changeModel(Json model) async {
    final id = sessionId;
    if (id == null || running || model['available'] == false) return;
    state = {
      ...state,
      'modelId': model['id'],
      'modelProvider': model['provider'],
    };
    changed();
    if (canControl) {
      await sendCommand({
        'type': 'set_model',
        'provider': model['provider'],
        'modelId': model['id'],
      });
    }
  }

  Future<void> changeThinking(String level) async {
    final id = sessionId;
    if (id == null ||
        !['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].contains(level)) {
      return;
    }
    state = {...state, 'thinking': level};
    changed();
    if (canControl) {
      await sendCommand({'type': 'set_thinking', 'level': level});
    }
  }

  bool onboardingComplete = true;
  bool booting = true,
      initializing = false,
      busy = false,
      loading = false,
      active = true,
      unknownCommand = false;
  String connection = 'connecting', draft = '';
  String? workspaceFilter;
  bool sessionVisible = false;
  int _documentDepth = 0, _visibilityRevision = 0;
  bool _appVisible = true;
  Future<void> coverDocument() {
    _documentDepth++;
    return lifecycle(_appVisible);
  }

  Future<void> resyncVisibility() => lifecycle(_appVisible);

  Future<void> uncoverDocument() {
    if (_documentDepth > 0) _documentDepth--;
    return lifecycle(_appVisible, preserveUnchangedMemory: true);
  }

  // Initial selection keeps the phone list open; explicit navigation reveals it.
  bool revealSelectedSession = true;
  int sessionNavigationRevision = 0;
  bool _selectFirstSessionOnRefresh = false;
  final _reading = <String>{};
  final _deleted = <String>{};
  final readers = <String, ReadingState>{};
  final panelState = <String, Json>{};
  PanelResource? _panelData;
  PanelResource get panelData => _panelData ??= PanelResource(this);
  int _accountRevision = 0;
  int get accountRevision => _accountRevision;
  String? pairingStamp;
  Timer? _poll, _save, _indexRefresh;
  Future<void> _draftWrites = Future<void>.value();
  final _indexChanges = <String>{};
  bool _everLive = false, _retryListOnNetwork = false;
  StreamSubscription<Json>? _events;
  bool _disposed = false;
  int _selection = 0, _navigationIntent = 0, _draftRevision = 0;
  int _unwatchPending = 0;
  String get title => '${obj(state['session'])['name'] ?? '新對話'}';
  bool get running => [
    'queued',
    'running',
    'waiting_input',
    'stopping',
  ].contains(obj(state['run'])['status']);
  bool get canControl =>
      sessionId != null &&
      connection == 'live' &&
      control['held'] == true &&
      !_pairingMutation;
  bool _historyRefreshing = false, _historyNeedsSnapshot = false;
  int _historyRevision = 0;
  bool get canWrite =>
      canControl && !busy && !_historyRefreshing && !_historyNeedsSnapshot;
  bool get canChangeHistory =>
      canWrite &&
      !running &&
      !unknownCommand &&
      !_historyNeedsSnapshot &&
      state['runnerStatus'] != 'starting' &&
      !messages.any((message) => message['partial'] == true);

  /// The open session's workspace, when the index has it.
  Json? get sessionWorkspace {
    final id = obj(state['session'])['workspaceId'];
    return workspaces.where((w) => w['id'] == id).firstOrNull;
  }

  /// The open session's mode capabilities, when its workspace is known.
  ModeInfo? get sessionMode {
    final workspace = sessionWorkspace;
    return workspace == null ? null : catalog.of(workspace);
  }

  /// Side panels by capability: Git needs a repository, terminals a shared
  /// workspace directory. Unknown workspaces keep every panel, as before.
  bool sessionPanel(String kind) {
    final mode = sessionMode;
    if (mode == null) return true;
    if (kind == 'git') return mode.repository;
    if (kind == 'terminals') return mode.sharedDirectory;
    return true;
  }

  static const messagePageSize = 60;
  int hiddenMessages = 0;
  bool _historyInitialized = false;
  List<Json> get messages => rows(state['messages']);
  List<Json> get visibleMessages => messages.skip(hiddenMessages).toList();

  void _resetHistory() {
    hiddenMessages = 0;
    _historyInitialized = false;
  }

  void _applySnapshot(Json next, {bool authoritativeHistory = false}) {
    if (_historyNeedsSnapshot && !authoritativeHistory) return;
    _historyNeedsSnapshot = false;
    state = next;
    if (!_historyInitialized) {
      hiddenMessages = max(0, messages.length - messagePageSize);
      _historyInitialized = true;
    }
  }

  bool revealEarlierMessages() {
    if (hiddenMessages == 0) return false;
    hiddenMessages = max(0, hiddenMessages - messagePageSize);
    changed();
    return true;
  }

  List<Json> get questions => rows(
    state['interactions'],
  ).where((q) => q['status'] == 'pending').toList();
  void changed() {
    if (!_disposed) notifyListeners();
  }

  Future<void> boot() async {
    _events ??= gateway.events.listen(
      _event,
      onError: (Object e) {
        error = describe(e);
        changed();
      },
    );
    _poll ??= Timer.periodic(const Duration(seconds: 20), (_) {
      if (active && origin != null) {
        unawaited(refreshList());
      }
    });
    try {
      final data = obj(await gateway.call('boot'));
      onboardingComplete = data['onboardingComplete'] != false;
      preferences = obj(await gateway.call('preferences'));
      origin = data['origin'] as String?;
      clientId = data['clientId'] as String?;
      pairingStamp = data['pairingStamp'] as String?;
      pairLink = data['pairLink'] as String?;
      routePage = data['route'] as String?;
      initializing = origin != null;
      _selectFirstSessionOnRefresh =
          origin != null && data['targetSession'] == null && pairLink == null;
      booting = false;
      changed();
      // A notification about a room opens on it.
      if (origin != null && data['targetRoom'] is String) showing = 'rooms';
      if (origin != null &&
          showing == 'rooms' &&
          data['targetSession'] == null) {
        unawaited(rooms.start(data['targetRoom'] as String?));
      }
      if (origin != null) {
        final account = _accountRevision;
        final navigation = _navigationIntent;
        await refreshList();
        if (account != _accountRevision || _disposed) return;
        if (data['targetSession'] != null &&
            navigation == _navigationIntent &&
            pairLink == null) {
          final target = '${data['targetSession']}';
          if (sessions.any((session) => session['id'] == target)) {
            await _openNotificationTarget({...data, 'sessionId': target});
          } else if (sessionId == null &&
              sessions.isNotEmpty &&
              pairLink == null) {
            // Web ignores a missing linked session and retains its recent default.
            await open('${sessions.first['id']}', reveal: false);
          }
        }
      }
    } catch (e) {
      error = describe(e);
    }
    booting = false;
    initializing = false;
    changed();
  }

  Future<bool> _openNotificationTarget(Json data) async {
    final target = data['sessionId'];
    if (target is! String ||
        target.isEmpty ||
        origin == null ||
        pairLink != null) {
      return false;
    }
    final account = _accountRevision;
    final navigation = ++_navigationIntent;
    _selectFirstSessionOnRefresh = false;
    // A session lives in the engine.
    if (showing != 'engine') showEngine();
    if (!sessions.any((session) => session['id'] == target)) {
      await refreshList();
    }
    if (_disposed ||
        account != _accountRevision ||
        navigation != _navigationIntent ||
        pairLink != null ||
        !sessions.any((session) => session['id'] == target)) {
      return false;
    }
    await open(target);
    if (_disposed ||
        account != _accountRevision ||
        _navigationIntent != navigation + 1 ||
        sessionId != target) {
      return false;
    }
    fromNotification = true;
    if (data['interactionId'] != null || data['confirmQuestion'] == true) {
      notificationQuestion = data;
    }
    changed();
    return true;
  }

  Future<void> _dockWrite = Future.value();
  void setDockExpanded(String key, bool expanded) {
    if (!['goalExpanded', 'todoExpanded'].contains(key)) return;
    preferences = {...preferences, key: expanded};
    // Serialize rapid toggles so an older native commit cannot win after a newer choice.
    _dockWrite = _dockWrite.then((_) async {
      try {
        await gateway.call('savePreferences', {key: expanded});
      } catch (e) {
        actionError = describe(e);
        changed();
      }
    });
  }

  Future<void> savePreferences(Json changes) async {
    preferences = obj(await gateway.call('savePreferences', changes));
    changed();
  }

  bool _pairingMutation = false;

  Future<void> pair(String link) async {
    if (busy) return;
    _pairingMutation = true;
    _accountRevision++;
    initializing = false;
    _selectFirstSessionOnRefresh = false;
    _retryListOnNetwork = false;
    _deleted.clear();
    _selection++;
    loading = false;
    busy = true;
    error = null;
    changed();
    try {
      final data = obj(await gateway.call('pair', {'link': link}));
      origin = data['origin'];
      clientId = data['clientId'];
      pairingStamp = data['pairingStamp'] as String?;
      pairLink = null;
      sessionId = null;
      state = {};
      _resetHistory();
      draft = '';
      _resetAttachments();
      readers.clear();
      panelState.clear();
      unknownCommand = false;
      initializing = true;
      _selectFirstSessionOnRefresh = true;
      changed();
      unawaited(_restartRooms());
      await refreshList();
    } catch (e) {
      error = describe(e);
    } finally {
      _pairingMutation = false;
      busy = false;
      initializing = false;
      changed();
    }
  }

  Future<void> unpair() async {
    _pairingMutation = true;
    try {
      _accountRevision++;
      initializing = false;
      _selectFirstSessionOnRefresh = false;
      _retryListOnNetwork = false;
      _deleted.clear();
      _selection++;
      loading = false;
      await flushDraft();
      if (rooms.started) await rooms.stop();
      await gateway.call('unpair');
      readers.clear();
      panelState.clear();
      origin = null;
      pairingStamp = null;
      sessionId = null;
      state = {};
      _resetHistory();
      sessions = [];
      draft = '';
      _resetAttachments();
      changed();
    } finally {
      _pairingMutation = false;
    }
  }

  Completer<void>? _listRefreshCompletion;
  int? _listRefreshAccount;

  Future<void> refreshList() async {
    if (origin == null) return;
    if (loading) {
      if (_listRefreshAccount == _accountRevision) {
        await _listRefreshCompletion?.future;
      }
      return;
    }
    loading = true;
    final revision = _accountRevision;
    final completion = Completer<void>();
    _listRefreshCompletion = completion;
    _listRefreshAccount = revision;
    final initialLoad = initializing;
    try {
      final modes = _requestModes();
      final result = await Future.wait([
        gateway.request('/api/sessions'),
        gateway.request('/api/workspaces'),
        gateway.request('/api/nodes'),
      ]);
      final catalogRows = await modes;
      if (revision != _accountRevision) return;
      if (catalogRows != null) catalog = ModeCatalog(catalogRows);
      sessions = rows(
        result[0]['sessions'],
      ).where((s) => !_deleted.contains(s['id'])).toList();
      workspaces = rows(result[1]['workspaces']);
      nodes = rows(result[2]['nodes']);
      if (!workspaces.any((w) => w['id'] == workspaceFilter)) {
        workspaceFilter = null;
      }
      if (_selectFirstSessionOnRefresh) {
        _selectFirstSessionOnRefresh = false;
        if (sessionId == null && sessions.isNotEmpty && pairLink == null) {
          await open('${sessions.first['id']}', reveal: false);
        }
      }
      unawaited(markVisibleRead());
    } catch (e) {
      // Like web refreshSessions/refreshNodes, background list failures keep
      // the last data and must not replace or clear a session's page error.
      // Bootstrap records its failure, but the no-session view stays generic.
      if (revision == _accountRevision && initialLoad && state.isEmpty) {
        error = describe(e);
      }
    } finally {
      if (revision == _accountRevision) {
        loading = false;
        if (_retryListOnNetwork) {
          _retryListOnNetwork = false;
          if (!_disposed && active && origin != null) {
            unawaited(refreshList());
          }
        }
      }
      changed();
      completion.complete();
      if (identical(_listRefreshCompletion, completion)) {
        _listRefreshCompletion = null;
        _listRefreshAccount = null;
      }
    }
  }

  /// The catalog loads with the index. An older gateway answers 404: no
  /// catalog, so workspaces fall back to their legacy `kind`. Other failures
  /// keep the last catalog (null), like the rest of a failed refresh.
  Future<List<Json>?> _requestModes() async {
    try {
      return rows((await gateway.request('/api/modes'))['modes']);
    } on PlatformException catch (e) {
      return e.code == 'HTTP_404' ? const [] : null;
    } catch (_) {
      return null;
    }
  }

  Future<void> open(String id, {bool reveal = true}) async {
    _selectFirstSessionOnRefresh = false;
    final navigation = ++_navigationIntent;
    if (routePage?.startsWith('workspace:') == true) routePage = null;
    // The web keeps its stream and view when revealing the already-open chat.
    // Re-watching here clears the snapshot and destroys local message state.
    if (sessionId == id && state.isNotEmpty && _unwatchPending == 0) {
      revealSelectedSession = reveal;
      sessionNavigationRevision++;
      sessionVisible = reveal;
      changed();
      unawaited(markVisibleRead());
      return;
    }
    final previousSelection = _selection;
    await flushDraft();
    if (navigation != _navigationIntent ||
        previousSelection != _selection ||
        _deleted.contains(id)) {
      return;
    }
    final selection = ++_selection;
    final account = _accountRevision;
    sessionId = id;
    ++_historyRevision;
    _historyNeedsSnapshot = false;
    revealSelectedSession = reveal;
    sessionNavigationRevision++;
    sessionVisible = reveal;
    state = {};
    _resetHistory();
    control = {};
    models = [];
    _resetAttachments();
    connection = 'connecting';
    _everLive = false;
    actionError = null;
    draft = '';
    unknownCommand = false;
    error = null;
    changed();
    unawaited(markVisibleRead());
    try {
      final watchVisibilityRevision = ++_visibilityRevision;
      final watchVisibility = active;
      await gateway.call('setWatchVisibility', {
        'visible': watchVisibility,
        'visibilityRevision': watchVisibilityRevision,
      });
      if (_disposed ||
          selection != _selection ||
          account != _accountRevision ||
          navigation != _navigationIntent ||
          sessionId != id) {
        return;
      }
      final revision = _draftRevision;
      final saved = await gateway.call('watch', {'sessionId': id});
      if (selection != _selection) return;
      if (_draftRevision == revision) draft = saved as String? ?? '';
      final uncertain = await gateway.call('commandStatus', {'sessionId': id});
      if (selection != _selection) return;
      unknownCommand = uncertain == true;
      if (unknownCommand) actionError = '先前送出結果不明，請先檢查最新狀態。';
      changed();
      await refreshModels();
    } catch (e) {
      if (selection == _selection) error = describe(e);
    }
    changed();
  }

  Future<void> home() async {
    _selectFirstSessionOnRefresh = false;
    final navigation = ++_navigationIntent;
    final previousSelection = _selection;
    await flushDraft();
    if (navigation != _navigationIntent || previousSelection != _selection) {
      return;
    }
    final selection = ++_selection;
    _unwatchPending++;
    try {
      await gateway.call('unwatch');
    } finally {
      _unwatchPending--;
    }
    if (selection != _selection) return;
    sessionId = null;
    state = {};
    _resetHistory();
    control = {};
    _resetAttachments();
    draft = '';
    actionError = null;
    error = null;
    unknownCommand = false;
    changed();
  }

  Future<void> create(String workspaceId) async {
    final workspace = workspaces
        .where((w) => w['id'] == workspaceId)
        .firstOrNull;
    if (isReadOnly(workspace)) {
      throw StateError(workspaceUnavailableNotice);
    }
    final account = _accountRevision, stamp = pairingStamp;
    final data = await gateway.request(
      '/api/sessions',
      method: 'POST',
      pairingStamp: stamp,
      body: {'workspaceId': workspaceId},
    );
    if (_disposed || account != _accountRevision || stamp != pairingStamp) {
      return;
    }
    await refreshList();
    if (_disposed || account != _accountRevision || stamp != pairingStamp) {
      return;
    }
    await open('${obj(data['session'])['id']}');
  }

  // Only an actually visible conversation may clear the server-owned unread bit.
  Future<void> markVisibleRead() async {
    final id = sessionId;
    if (!active ||
        !sessionVisible ||
        id == null ||
        _reading.contains(id) ||
        !sessions.any((s) => s['id'] == id && s['unread'] == true)) {
      return;
    }
    final revision = _accountRevision;
    _reading.add(id);
    try {
      await gateway.request('${sessionPath(id)}/read', method: 'POST');
      if (revision != _accountRevision) return;
      sessions = [
        for (final s in sessions) s['id'] == id ? {...s, 'unread': false} : s,
      ];
      changed();
    } catch (_) {
      // The next index refresh reconciles a failed read acknowledgement.
    } finally {
      _reading.remove(id);
    }
  }

  Future<Json> createWorkspace(Json body) async {
    final revision = _accountRevision;
    final data = await gateway.request(
      '/api/workspaces',
      method: 'POST',
      body: body,
    );
    if (revision != _accountRevision) throw StateError('Connection changed.');
    final workspace = obj(data['workspace']);
    if (workspace['id'] == null) {
      throw StateError('The gateway did not return a workspace.');
    }
    await refreshList();
    return workspace;
  }

  /// A server deletion is terminal, even when it arrives before our DELETE ack.
  Future<void> _removeSession(String id) {
    if (!_deleted.add(id)) return Future<void>.value();
    final deleted =
        sessions.where((s) => s['id'] == id).firstOrNull ??
        (sessionId == id ? obj(state['session']) : null);
    sessions.removeWhere((s) => s['id'] == id);
    if (sessionId == id) {
      ++_selection;
      ++_navigationIntent;
      ++sessionNavigationRevision;
      _save?.cancel();
      _selectFirstSessionOnRefresh = false;
      sessionId = null;
      sessionVisible = false;
      revealSelectedSession = false;
      state = {};
      _resetHistory();
      control = {};
      models = [];
      _resetAttachments();
      draft = '';
      actionError = error = null;
      busy = false;
      unknownCommand = false;
      connection = 'stopped';
      readers.clear();
      panelState.clear();
      final workspace = deleted?['workspaceId'];
      if (workspace != null) routePage = 'workspace:$workspace';
      // Queue before a new watch; native deletion has already stopped this hub.
      unawaited(gateway.call('unwatch').catchError((Object _) => null));
    }
    final account = _accountRevision;
    // An in-flight draft write must finish before the terminal empty write.
    final clear = _draftWrites.then((_) async {
      if (_disposed || account != _accountRevision) return;
      await gateway.call('draft', {'sessionId': id, 'text': ''});
    });
    _draftWrites = clear.catchError((Object _) {});
    changed();
    return _draftWrites;
  }

  Future<void> updateSession(Json patch, {String? targetId}) async {
    final id = targetId ?? sessionId;
    if (id == null) return;
    final data = await gateway.request(
      sessionPath(id),
      method: 'PATCH',
      body: patch,
    );
    if (sessionId == id) state = {...state, 'session': data['session']};
    await refreshList();
    changed();
  }

  void _event(Json event) {
    if (event['type'] == 'networkAvailable') {
      if (active && origin != null) {
        if (loading) {
          _retryListOnNetwork = true;
        } else {
          unawaited(refreshList());
        }
      }
      return;
    }
    if (event['type'] == 'preferencesChanged') {
      preferences = obj(event['data']);
      changed();
      return;
    }
    if (event['type'] == 'pairingChanged') {
      final next = obj(event['data']);
      if (_pairingMutation ||
          (next['pairingStamp'] == pairingStamp && next['origin'] == origin)) {
        return;
      }
      _accountRevision++;
      _selection++;
      _navigationIntent++;
      _save?.cancel();
      _selectFirstSessionOnRefresh = next['origin'] != null;
      _deleted.clear();
      origin = next['origin'] as String?;
      clientId = next['clientId'] as String?;
      pairingStamp = next['pairingStamp'] as String?;
      sessionId = null;
      state = {};
      control = {};
      draft = '';
      _resetAttachments();
      sessions = [];
      workspaces = [];
      nodes = [];
      catalog = ModeCatalog();
      readers.clear();
      panelState.clear();
      _resetHistory();
      unknownCommand = false;
      error = null;
      busy = false;
      loading = false;
      initializing = origin != null;
      // Reset notifies listeners: publish the complete new identity/state first.
      changed();
      unawaited(_restartRooms());
      final account = _accountRevision;
      unawaited(
        refreshList().whenComplete(() {
          if (!_disposed && account == _accountRevision) {
            initializing = false;
            changed();
          }
        }),
      );
      return;
    }
    if (event['type'] == 'route') {
      final data = obj(event['data']);
      pairLink = data['pairLink'];
      routePage = data['page'];
      if (data['roomId'] is String && origin != null) {
        showRooms(roomId: data['roomId'] as String);
        return;
      }
      if (data['sessionId'] != null && origin != null) {
        unawaited(_openNotificationTarget(data));
      }
      changed();
      return;
    }
    if (event['sessionId'] != sessionId) return;
    switch (event['type']) {
      case 'sessionDeleted':
        final id = event['sessionId'];
        if (id is String) unawaited(_removeSession(id));
        return;
      case 'indexChange':
        _indexChanges.add('${event['data']}');
        _indexRefresh ??= Timer(const Duration(milliseconds: 250), () {
          _indexRefresh = null;
          final changes = Set<String>.of(_indexChanges);
          _indexChanges.clear();
          if (!active || origin == null) return;
          if (changes.contains('memory_changed')) {}
          if (changes.contains('directory_changed') ||
              changes.contains('sessions_changed')) {
            unawaited(refreshList());
          }
        });
        return;
      case 'snapshot':
        _applySnapshot(obj(event['data']));
      case 'connection':
        final reconnect =
            event['data'] == 'live' && connection != 'live' && _everLive;
        connection = '${event['data']}';
        if (connection == 'live') _everLive = true;
        if (reconnect) {
          unawaited(refreshList());
        }
      case 'control':
        control = obj(event['data']);
      case 'error':
        error = '${event['data']}';
      default:
        return;
    }
    changed();
  }

  void editDraft(String value) {
    _draftRevision++;
    draft = value;
    _save?.cancel();
    final id = sessionId;
    final account = _accountRevision;
    if (id == null) return;
    // Bind the debounce to the conversation that was edited. Navigation may
    // change the visible conversation before this timer fires.
    _save = Timer(const Duration(milliseconds: 250), () async {
      try {
        await _persistDraft(id, value, account);
      } catch (e) {
        if (account == _accountRevision && sessionId == id) {
          actionError = describe(e);
          changed();
        }
      }
    });
  }

  Future<void> _persistDraft(String id, String value, int account) {
    // Preserve write order even when a platform call is still in flight.
    final write = _draftWrites.then((_) async {
      if (account != _accountRevision || _deleted.contains(id)) return;
      await gateway.call('draft', {'sessionId': id, 'text': value});
    });
    _draftWrites = write.catchError((Object _) {});
    return write;
  }

  Future<void> flushDraft() async {
    final id = sessionId;
    final account = _accountRevision;
    if (id == null) return;
    do {
      _save?.cancel();
      final revision = _draftRevision;
      await _persistDraft(id, draft, account);
      // The old composer remains editable while navigation waits for storage.
      // Drain those edits before allowing the new conversation to load.
      if (revision == _draftRevision) return;
    } while (sessionId == id && account == _accountRevision);
  }

  Future<void> lifecycle(
    bool visible, {
    bool preserveUnchangedMemory = false,
  }) async {
    _appVisible = visible;
    active = visible && _documentDepth == 0;
    if (rooms.started) {
      unawaited(rooms.setVisible(visible && showing == 'rooms'));
    }
    final ticket = ++_visibilityRevision, account = _accountRevision;
    bool current() =>
        !_disposed &&
        ticket == _visibilityRevision &&
        account == _accountRevision;
    if (origin == null) return;
    await gateway.call('setWatchVisibility', {
      'visible': active,
      'visibilityRevision': ticket,
    });
    if (!current()) return;
    if (!active) {
      await flushDraft();
      if (!current()) return;
      // A covered document relinquishes its subscription as before. A true
      // app background keeps the native stream alive while pausing Dart's
      // visible polling through `active == false`.
      if (_documentDepth > 0) await gateway.call('unwatch');
    } else {
      await refreshList();
      if (current() && sessionId != null) {
        await gateway.call('watch', {'sessionId': sessionId});
      }
    }
  }

  Future<void> takeControl({bool force = false}) async {
    final id = sessionId;
    if (id == null) return;
    final next = obj(
      await gateway.call('control', {
        'sessionId': id,
        'acquire': true,
        'force': force,
      }),
    );
    if (sessionId == id) control = next;
    changed();
  }

  /// `POST /api/delegations/:id/stop`, no lease. Throws with the gateway's
  /// message on 404/409 (e.g. another device controls the delegated session).
  Future<void> stopDelegation(String delegationId) =>
      gateway.call('stopDelegation', {'delegationId': delegationId});

  /// Allow or deny a relayed (`relay.`) delegation approval on [chatId]
  /// without its control lease, then refresh the session list.
  Future<void> answerRelayedApproval(
    String chatId,
    String interactionId,
    bool confirmed,
  ) async {
    final account = _accountRevision;
    // A relayed (`relay.`) approval is answered without the control lease:
    // no generation goes with it.
    if (!interactionId.startsWith('relay.')) {
      throw StateError('Only relayed approvals are answered from the list.');
    }
    await gateway.request(
      '${sessionPath(chatId)}/interactions/${enc(interactionId)}/answer',
      method: 'POST',
      body: {
        'clientId': clientId,
        'answer': {'confirmed': confirmed},
      },
    );
    if (account == _accountRevision && !_disposed) {
      unawaited(refreshList());
    }
  }

  Future<void> refreshSession() async {
    final id = sessionId;
    if (id == null) return;
    final revision = _historyRevision, selection = _selection;
    final next = obj(await gateway.call('refresh', {'sessionId': id}));
    if (sessionId == id &&
        selection == _selection &&
        revision == _historyRevision) {
      _applySnapshot(next, authoritativeHistory: true);
      changed();
    }
  }

  final _commandsInFlight = <Object, ({int account, bool blocking})>{};
  Future<bool> sendCommand(Json payload, {List<Json> before = const []}) async {
    // Selection menus remain interactive while another request is pending.
    // Keep every choice; Android serializes ordinary commands at transport.
    final controlOnly = const {
      'stop',
      'set_model',
      'set_thinking',
      'set_approval_mode',
    }.contains(payload['type']);
    if (controlOnly ? !canControl : !canWrite) return false;
    final id = sessionId!;
    final selection = _selection, account = _accountRevision;
    bool current() =>
        sessionId == id &&
        selection == _selection &&
        account == _accountRevision;
    if (unknownCommand && payload['type'] != 'stop') return false;
    final commandToken = Object();
    final preference = const {
      'set_model',
      'set_thinking',
      'set_approval_mode',
    }.contains(payload['type']);
    _commandsInFlight[commandToken] = (account: account, blocking: !preference);
    busy = _commandsInFlight.values.any(
      (operation) => operation.account == account && operation.blocking,
    );
    actionError = null;
    changed();
    try {
      for (final command in [...before, payload]) {
        if (!current()) return false;
        final receipt = await gateway.command(id, command);
        if (!current()) return false;
        if (receipt['status'] != 'accepted') {
          unknownCommand = receipt['status'] == 'outcome_unknown';
          actionError = '${receipt['message'] ?? receipt['status']}';
          return false;
        }
      }
      return true;
    } catch (e) {
      if (!current()) return false;
      unknownCommand =
          e is! PlatformException ||
          !e.code.startsWith('HTTP_4') ||
          obj(e.details)['code'] == 'outcome_unknown';
      actionError = unknownCommand ? '送出結果不明，請檢查對話；不會自動重送。' : describe(e);
      return false;
    } finally {
      _commandsInFlight.remove(commandToken);
      if (account == _accountRevision) {
        busy = _commandsInFlight.values.any(
          (operation) => operation.account == account && operation.blocking,
        );
        changed();
      }
    }
  }

  /// Only persistent, currently visible user turns can be edited or switched.
  Future<bool> changeMessageHistory(String entryId, {String? message}) async {
    if (!canChangeHistory || entryId.isEmpty) return false;
    final valid = messages.any(
      (turn) =>
          turn['role'] == 'user' &&
          (message != null
              ? turn['entryId'] == entryId
              : rows(turn['branches']).any(
                  (branch) =>
                      branch['entryId'] == entryId &&
                      branch['selected'] != true,
                )),
    );
    if (!valid || (message != null && message.trim().isEmpty)) return false;
    final id = sessionId, selection = _selection, account = _accountRevision;
    ++_historyRevision;
    final accepted = await sendCommand({
      'type': message == null ? 'switch_branch' : 'edit_message',
      'entryId': entryId,
      'message': ?message,
    });
    if (!accepted ||
        sessionId != id ||
        selection != _selection ||
        account != _accountRevision) {
      return false;
    }
    ++_historyRevision;
    _historyRefreshing = true;
    _historyNeedsSnapshot = true;
    changed();
    try {
      final next = obj(await gateway.call('refresh', {'sessionId': id}));
      if (sessionId == id &&
          selection == _selection &&
          account == _accountRevision) {
        _resetHistory();
        _applySnapshot(next, authoritativeHistory: true);
      }
    } catch (e) {
      if (sessionId == id &&
          selection == _selection &&
          account == _accountRevision) {
        actionError = 'Message updated, but refreshing failed: ${describe(e)}';
      }
    } finally {
      _historyRefreshing = false;
      changed();
    }
    // The command was accepted even if refreshing failed; do not offer to
    // resubmit an already committed edit.
    return true;
  }

  Future<void> acknowledgeCommand() async {
    final id = sessionId;
    if (id == null) return;
    await gateway.call('acknowledgeCommand', {'sessionId': id});
    if (id == sessionId) {
      unknownCommand = false;
      actionError = null;
      changed();
    }
  }

  Future<void> send(String kind) async {
    if (draft.trim().isEmpty || unknownCommand || uploading) return;
    final text = draft;
    final sentAttachments = List<Json>.of(attachments);
    final id = sessionId;
    final model = selectedModel;
    if (await sendCommand(
      {
        'type': kind,
        'message': text.trim(),
        'uploadIds': sentAttachments.map((a) => a['id']).toList(),
      },
      before: kind == 'prompt'
          ? [
              if (model != null)
                {
                  'type': 'set_model',
                  'provider': model['provider'],
                  'modelId': model['id'],
                },
              {'type': 'set_thinking', 'level': selectedThinking},
            ]
          : const [],
    )) {
      if (sessionId == id && draft == text) {
        draft = '';
        attachments.removeWhere((a) => sentAttachments.contains(a));
        await flushDraft();
        changed();
      }
    }
  }

  int _nextLocalAttachment = 0;
  int _attachmentOperations = 0, _attachmentEpoch = 0;
  void _resetAttachments() {
    attachments = [];
    _attachmentEpoch++;
    _attachmentOperations = 0;
    uploading = false;
  }

  Future<void> insertImage(KeyboardInsertedContent content) {
    if (!content.mimeType.startsWith('image/')) return Future<void>.value();
    final uri = Uri.tryParse(content.uri);
    final name = uri != null && uri.pathSegments.isNotEmpty
        ? uri.pathSegments.last
        : 'image';
    return _attachFiles(
      () async => [
        {
          'name': name,
          'mimeType': content.mimeType,
          if (content.hasData)
            'bytes': content.data
          else
            'error': 'The keyboard did not provide image data.',
        },
      ],
    );
  }

  Future<void> pasteClipboard(ValueChanged<String> insertText) {
    final id = sessionId, account = _accountRevision, selection = _selection;
    return _attachFiles(() async {
      final clip = obj(await gateway.call('readClipboard'));
      if (!_disposed &&
          sessionId == id &&
          account == _accountRevision &&
          selection == _selection) {
        final text = clip['text'] as String? ?? '';
        if (text.isNotEmpty) insertText(text);
      }
      return rows(clip['files']);
    });
  }

  Future<void> attach() async {
    if (uploading) return;
    await _attachFiles(() async => rows(await gateway.call('pickAttachments')));
  }

  /// Snapshot used by a visible native drop target to bind a drag to one chat.
  Json captureExternalImageDropScope() => {
    'sessionId': sessionId,
    'accountRevision': _accountRevision,
    'selectionRevision': _selection,
    'navigationIntent': _navigationIntent,
    'sessionNavigationRevision': sessionNavigationRevision,
    'origin': origin,
    'clientId': clientId,
    'pairingStamp': pairingStamp,
  };

  bool _externalImageDropScopeIsCurrent(Json scope) =>
      sessionId != null &&
      scope['sessionId'] == sessionId &&
      scope['accountRevision'] == _accountRevision &&
      scope['selectionRevision'] == _selection &&
      scope['navigationIntent'] == _navigationIntent &&
      scope['sessionNavigationRevision'] == sessionNavigationRevision &&
      scope['origin'] == origin &&
      scope['clientId'] == clientId &&
      scope['pairingStamp'] == pairingStamp;

  /// Starts ordered uploads only if the target still belongs to the captured chat.
  Future<void> acceptExternalImageDrop(Json scope, List<Json> files) {
    if (!_externalImageDropScopeIsCurrent(scope)) return Future<void>.value();
    final images = files
        .where((file) => '${file['mimeType'] ?? ''}'.startsWith('image/'))
        .toList(growable: false);
    if (images.isEmpty) return Future<void>.value();
    return _attachFiles(() async => images);
  }

  Future<void> _attachFiles(Future<List<Json>> Function() read) async {
    final id = sessionId;
    if (id == null || _disposed) return;
    final account = _accountRevision, selection = _selection;
    bool current() =>
        !_disposed &&
        sessionId == id &&
        account == _accountRevision &&
        selection == _selection;
    final attachmentEpoch = _attachmentEpoch;
    _attachmentOperations++;
    uploading = true;
    actionError = null;
    changed();
    try {
      final picked = await read();
      for (final file in picked) {
        if (!current()) break;
        final name = file['name'] as String? ?? 'attachment';
        if (file['error'] != null) {
          actionError = 'Could not read $name: ${file['error']}';
          changed();
          continue;
        }
        final bytes = file['bytes'];
        if (bytes is! Uint8List) {
          actionError = 'Could not read $name.';
          changed();
          continue;
        }
        final mime = file['mimeType'] as String? ?? 'application/octet-stream';
        final isImage = mime.startsWith('image/');
        final pending = <String, dynamic>{
          'id': 'local-${++_nextLocalAttachment}',
          'name': name,
          'mimeType': mime,
          'kind': isImage ? 'image' : 'file',
          'size': bytes.length,
          'uploading': true,
          if (isImage) 'previewBytes': bytes,
        };
        attachments.add(pending);
        changed();
        try {
          final uploaded = obj(
            await gateway.call('uploadAttachment', {
              'sessionId': id,
              'name': name,
              'mimeType': mime,
              'bytes': bytes,
            }),
          );
          if (!current()) break;
          final index = attachments.indexOf(pending);
          if (index >= 0) {
            attachments[index] = {
              ...uploaded,
              'name': uploaded['name'] ?? name,
              if (isImage) 'previewBytes': bytes,
            };
          }
        } catch (e) {
          if (!current()) break;
          attachments.remove(pending);
          actionError = describe(e);
        }
        changed();
      }
    } catch (e) {
      if (current()) actionError = describe(e);
    } finally {
      if (attachmentEpoch == _attachmentEpoch) {
        uploading = --_attachmentOperations > 0;
        changed();
      }
    }
  }

  static String describe(Object e) {
    if (e is StateError) return e.message;
    if (e is PlatformException) {
      switch (e.code) {
        case 'SCAN_TIMEOUT':
          return '掃描器準備逾時，請重試或貼上配對連結。';
        case 'SCAN_DOWNLOADING':
          return '掃描元件正在下載，請稍後再試，也可以貼上配對連結。';
        case 'SCAN_UNSUPPORTED':
          return '掃描器需要更新 Google Play 服務。也可以貼上配對連結。';
        case 'SCAN_BUSY':
          return '掃描器已開啟，請完成或關閉目前的掃描。';
        case 'SCAN':
          return '暫時無法開啟掃描器，請重試或貼上配對連結。';
        case 'HTTP_401':
          return '此裝置的配對已失效，請重新配對。';
        case 'HTTP_403':
          return '目前沒有執行這項操作的權限。';
        case 'HTTP_404':
          return '找不到這個項目，請重新載入。';
        case 'HTTP_409':
          return '狀態已改變，請重新載入後再操作。';
        case 'NETWORK':
          return '連線或裝置操作失敗，請確認連線後重試。';
      }
      final message = e.message;
      if (message != null &&
          !message.contains('java.') &&
          !message.contains('Exception') &&
          !message.contains('null object')) {
        return message;
      }
      return '操作未完成，請重試。';
    }
    return '操作未完成，請重新載入後再試。';
  }

  @override
  void dispose() {
    _disposed = true;
    rooms.dispose();
    _panelData?.dispose();
    _events?.cancel();
    _poll?.cancel();
    _indexRefresh?.cancel();
    _save?.cancel();
    super.dispose();
  }
}
