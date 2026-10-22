import '../l10n/app_i18n.dart';
import 'dart:async';
import 'dart:math';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'gateway.dart';

class CheckpointsState extends ChangeNotifier {
  CheckpointsState(this.controller) {
    controller.addListener(observe);
    events = controller.gateway.events.listen(event);
    observe();
  }

  final LiveController controller;
  StreamSubscription<Json>? events;
  Timer? _poll;
  bool disposed = false, active = false, stale = false;
  bool loading = false, loadingMore = false, previewing = false,
      preparing = false, continuing = false;
  String? session, origin, client, error, fileError, previousRun,
      previousRunnerStatus;
  int _generation = 0, _readRevision = 0, _fileRevision = 0,
      _mutationRevision = 0;
  int _accountRevision = -1;
  String? selectedCaptureId, selectedOperationId, selectedJobId;
  Json? data, preview;
  String? previewFor;
  bool enabled = false;
  bool more = false;
  String? cursor;
  final files = <String, Json>{};
  final fileLoading = <String>{};
  final _recoveryKeys = <String, String>{};
  final _random = Random.secure();
  final reviewedKeepCurrent = <String, bool>{};

  List<Json> get captures => rows(data?['captures']);
  List<Json> get jobs => rows(data?['jobs']);
  Json? get recoveryOrigin {
    final value = obj(data?['origin']);
    if (value['sessionId'] is! String ||
        value['workspaceId'] is! String ||
        value['jobId'] is! String ||
        value['captureId'] is! String) {
      return null;
    }
    return value;
  }
  Json? get selectedCapture => captures
      .where((capture) => capture['id'] == selectedCaptureId)
      .firstOrNull;
  Json? get selectedOperation => rows(selectedCapture?['operations'])
      .where((operation) => operation['id'] == selectedOperationId)
      .firstOrNull;
  List<Json> get selectedJobs => jobs
      .where((job) => job['captureId'] == selectedCaptureId)
      .toList();
  Json? get selectedJob => selectedJobs
      .where((job) => job['id'] == selectedJobId)
      .firstOrNull;
  bool get offline => controller.connection != 'live';
  bool get canMutate =>
      !disposed &&
      active &&
      !offline &&
      enabled &&
      controller.canControl &&
      controller.control['generation'] != null;
  bool get needsPolling =>
      active && !offline && jobs.any((job) => job['state'] == 'preparing');

  void emit() {
    if (!disposed) notifyListeners();
  }

  bool _sameScope({int? generation, int? ticket}) =>
      !disposed &&
      (generation == null || generation == _generation) &&
      (ticket == null || ticket == _readRevision) &&
      session == controller.sessionId &&
      origin == controller.origin &&
      client == controller.clientId &&
      _accountRevision == controller.accountRevision &&
      controller.sessionNavigationRevision == _navigationRevision &&
      !offline;

  int _navigationRevision = -1;

  void observe() {
    final c = controller;
    final run = obj(c.state['run'])['status'] as String?;
    final runnerStatus = c.state['runnerStatus'] as String?;
    final changedScope = session != c.sessionId ||
        origin != c.origin ||
        client != c.clientId ||
        _accountRevision != c.accountRevision ||
        _navigationRevision != c.sessionNavigationRevision;
    if (changedScope) {
      _generation++;
      _readRevision++;
      _fileRevision++;
      _mutationRevision++;
      session = c.sessionId;
      origin = c.origin;
      client = c.clientId;
      _accountRevision = c.accountRevision;
      _navigationRevision = c.sessionNavigationRevision;
      data = null;
      enabled = false;
      more = false;
      cursor = null;
      selectedCaptureId = null;
      selectedOperationId = null;
      selectedJobId = null;
      loading = previewing = preparing = continuing = false;
      preview = null;
      previewFor = null;
      error = null;
      fileError = null;
      files.clear();
      fileLoading.clear();
      _recoveryKeys.clear();
      reviewedKeepCurrent.clear();
      stale = false;
      previousRun = run;
      previousRunnerStatus = runnerStatus;
      if (active && c.sessionId != null && !offline) unawaited(load());
      _schedulePoll();
      emit();
      return;
    }
    if ((previousRun == 'running' && run != 'running') ||
        (previousRunnerStatus != null &&
            previousRunnerStatus != runnerStatus &&
            (runnerStatus == 'stopped' || runnerStatus == 'failed'))) {
      changedOnServer();
    }
    previousRun = run;
    previousRunnerStatus = runnerStatus;
    if (offline) {
      if (!stale) {
        stale = true;
        _readRevision++;
        _fileRevision++;
        _mutationRevision++;
        loading = previewing = preparing = continuing = false;
        fileLoading.clear();
        fileError = null;
        error = tr('The connection is offline. Reconnect to review checkpoints.');
        _schedulePoll();
        emit();
      }
    } else if (stale && active) {
      stale = false;
      error = null;
      unawaited(load());
    }
  }

  void event(Json value) {
    if (value['sessionId'] != session || value['type'] != 'checkpoints_changed') {
      return;
    }
    if (active && !offline) {
      unawaited(load());
    } else {
      stale = true;
      emit();
    }
  }

  void changedOnServer() {
    if (active && !offline) {
      unawaited(load());
    } else {
      stale = true;
      emit();
    }
  }

  void setActive(bool value) {
    if (active == value) return;
    active = value;
    if (!active) {
      _readRevision++;
      _fileRevision++;
      _mutationRevision++;
      loading = previewing = preparing = continuing = false;
      fileLoading.clear();
      _schedulePoll();
    } else if (!offline && session != null) {
      if (stale || data == null) {
        stale = false;
        unawaited(load());
      }
    }
    _schedulePoll();
    emit();
  }

  void _schedulePoll() {
    _poll?.cancel();
    if (!needsPolling) return;
    _poll = Timer(const Duration(seconds: 2), () {
      if (needsPolling) unawaited(refreshPreparingJobs());
    });
  }

  String get _base => '${sessionPath(session ?? '')}/checkpoints';

  String _failure(Object error, String fallback) {
    if (error is PlatformException && error.message != null) {
      return error.message!;
    }
    if (error is StateError) return error.message;
    if (error is Exception) return error.toString().replaceFirst('Exception: ', '');
    return fallback;
  }

  Future<void> load({bool reset = true}) async {
    final id = session;
    if (!active || offline || id == null || disposed) return;
    final generation = _generation, ticket = ++_readRevision;
    loading = true;
    loadingMore = !reset;
    error = null;
    if (reset) {
      preview = null;
      previewFor = null;
    }
    stale = false;
    emit();
    try {
      final nextCursor = reset ? null : cursor;
      final path = nextCursor == null
          ? _base
          : '$_base?${Uri(queryParameters: {'cursor': nextCursor}).query}';
      final result = await controller.gateway.request(path);
      if (!_sameScope(generation: generation, ticket: ticket)) return;
      if (result['version'] != 1) {
        throw StateError(tr('This server returned an unsupported checkpoints version.'));
      }
      data = reset
          ? result
          : {
              ...result,
              'captures': [
                ...captures,
                for (final capture in rows(result['captures']))
                  if (!captures.any((existing) => existing['id'] == capture['id'])) capture,
              ],
              'jobs': [
                ...jobs,
                for (final job in rows(result['jobs']))
                  if (!jobs.any((existing) => existing['id'] == job['id'])) job,
              ],
              'origin': result['origin'] ?? data?['origin'],
            };
      enabled = result['enabled'] == true;
      more = result['more'] == true;
      cursor = result['cursor'] as String?;
      if (!captures.any((capture) => capture['id'] == selectedCaptureId)) {
        selectedCaptureId = null;
        selectedOperationId = null;
        selectedJobId = null;
        preview = null;
        previewFor = null;
      }
      if (!selectedJobs.any((job) => job['id'] == selectedJobId)) {
        selectedJobId = null;
      }
    } catch (e) {
      if (_sameScope(generation: generation, ticket: ticket)) {
        error = _failure(e, tr('Unable to load checkpoints.'));
      }
    } finally {
      if (_sameScope(generation: generation, ticket: ticket)) {
        loading = false;
        loadingMore = false;
        _schedulePoll();
        emit();
      }
    }
  }

  Future<void> loadMore() async {
    if (!more || cursor == null || loading) return;
    await load(reset: false);
  }

  Future<void> refreshPreparingJobs() async {
    final generation = _generation;
    final pending = jobs
        .where((job) => job['state'] == 'preparing' && job['id'] is String)
        .toList();
    if (!active || offline || pending.isEmpty || !_sameScope(generation: generation)) {
      _schedulePoll();
      return;
    }
    for (final job in pending) {
      if (!_sameScope(generation: generation)) return;
      try {
        final result = await controller.gateway.request(
          '$_base/${enc('${job['captureId']}')}/recoveries/${enc('${job['id']}')}',
        );
        if (!_sameScope(generation: generation)) return;
        _replaceJob(obj(result['job']).isNotEmpty ? obj(result['job']) : result);
      } catch (e) {
        if (_sameScope(generation: generation)) {
          error = _failure(e, tr('Unable to refresh the recovery workspace.'));
          emit();
        }
      }
    }
    _schedulePoll();
  }

  void _replaceJob(Json next) {
    final id = next['id'];
    if (id is! String) return;
    final current = jobs.indexWhere((job) => job['id'] == id);
    if (current < 0) {
      data = {...?data, 'jobs': [...jobs, next]};
    } else {
      final updated = [...jobs]..[current] = next;
      data = {...?data, 'jobs': updated};
    }
    _schedulePoll();
    emit();
  }

  void selectCapture(Json capture) {
    if (capture['state'] == 'capturing' || capture['id'] is! String) return;
    selectedCaptureId = '${capture['id']}';
    selectedOperationId = null;
    selectedJobId = null;
    preview = null;
    previewFor = null;
    files.clear();
    fileError = null;
    _fileRevision++;
    emit();
  }

  void selectOperation(Json operation) {
    if (selectedCapture?['state'] == 'capturing' ||
        operation['state'] != 'observed' ||
        operation['after'] == null ||
        operation['id'] is! String) {
      return;
    }
    selectedOperationId = '${operation['id']}';
    selectedJobId = null;
    preview = null;
    previewFor = null;
    files.clear();
    fileError = null;
    _fileRevision++;
    emit();
  }

  void selectJob(Json job) {
    if (job['captureId'] != selectedCaptureId || job['id'] is! String) return;
    final operations = job['operations'];
    final currentOperation = selectedOperationId;
    if (operations is List) {
      if (currentOperation == null || !operations.contains(currentOperation)) {
        selectedOperationId = operations.length == 1 && operations.single is String
            ? operations.single as String
            : null;
      }
    } else {
      selectedOperationId = null;
    }
    selectedJobId = '${job['id']}';
    preview = null;
    previewFor = null;
    files.clear();
    fileError = null;
    _fileRevision++;
    emit();
  }

  String get _selectionKey => '$session:$selectedCaptureId:$selectedOperationId';

  Future<bool> createPreview({required bool reviewObservational}) async {
    if (disposed || !active || offline || !enabled || !reviewObservational || selectedCapture == null || selectedCapture?['state'] == 'capturing' || selectedOperationId == null || previewing) return false;
    final generation = _generation, ticket = ++_readRevision;
    final captureId = selectedCaptureId!, operationId = selectedOperationId!;
    previewing = true;
    error = null;
    preview = null;
    previewFor = null;
    emit();
    try {
      final result = await controller.gateway.request(
        '$_base/${enc(captureId)}/preview',
        method: 'POST',
        body: {
          'operations': [operationId],
          'reviewObservational': true,
        },
      );
      if (!_sameScope(generation: generation, ticket: ticket) || _selectionKey != '$session:$captureId:$operationId') return false;
      if (result['version'] != 1 ||
          (result['revision'] is! String && result['revision'] is! num)) {
        throw StateError(tr('This server returned an invalid checkpoint preview.'));
      }
      preview = result;
      previewFor = _selectionKey;
      return true;
    } catch (e) {
      if (_sameScope(generation: generation, ticket: ticket)) {
        error = _isConflict(e)
            ? tr('This preview is out of date. Refresh checkpoints and review again.')
            : _failure(e, tr('Unable to preview checkpoint recovery.'));
      }
      return false;
    } finally {
      if (_sameScope(generation: generation, ticket: ticket)) {
        previewing = false;
        emit();
      }
    }
  }

  bool _isConflict(Object error) =>
      error is PlatformException &&
      (error.code == 'HTTP_409' || error.code == 'HTTP_412');

  bool _validMutation(int generation, int ticket) =>
      ticket == _mutationRevision && _sameScope(generation: generation);

  String _newKey() => List.generate(
    24,
    (_) => _random.nextInt(256).toRadixString(16).padLeft(2, '0'),
  ).join();

  Future<bool> prepareWorkspace({required bool reviewObservational}) async {
    final dataPreview = preview;
    if (!canMutate || !reviewObservational || preparing || dataPreview == null || previewFor != _selectionKey || selectedCaptureId == null || selectedOperationId == null) return false;
    final generation = _generation, ticket = ++_mutationRevision;
    final captureId = selectedCaptureId!, operationId = selectedOperationId!;
    final keyForRetry = '$session:$captureId:${dataPreview['revision']}:$operationId';
    final key = _recoveryKeys.putIfAbsent(keyForRetry, _newKey);
    final leaseGeneration = controller.control['generation'];
    preparing = true;
    error = null;
    emit();
    try {
      final result = await controller.gateway.request(
        '$_base/${enc(captureId)}/recoveries',
        method: 'POST',
        body: {
          'version': 1,
          'key': key,
          'previewRevision': dataPreview['revision'],
          'operations': [operationId],
          'reviewObservational': true,
          'clientId': client,
          'generation': leaseGeneration,
        },
      );
      if (!_validMutation(generation, ticket)) return false;
      final job = obj(result['job']).isNotEmpty ? obj(result['job']) : result;
      if (job['id'] is! String || job['captureId'] != captureId) {
        throw StateError(tr('The server did not return a recovery workspace.'));
      }
      _replaceJob(job);
      selectedJobId = '${job['id']}';
      return true;
    } catch (e) {
      if (_validMutation(generation, ticket)) {
        error = _isConflict(e)
            ? tr('The preview is stale. Refresh checkpoints and review again.')
            : _failure(e, tr('Unable to prepare an independent recovery workspace.'));
        if (_isConflict(e)) {
          preview = null;
          previewFor = null;
          stale = true;
        }
      }
      return false;
    } finally {
      if (_validMutation(generation, ticket)) {
        preparing = false;
        _schedulePoll();
        emit();
      }
    }
  }

  void setKeepCurrentReviewed(String jobId, bool value) {
    reviewedKeepCurrent[jobId] = value;
    emit();
  }

  bool hasUnresolved(Json job) {
    final exclusions = obj(job['manifest'])['exclusions'];
    final hasExclusions = exclusions is Map
        ? exclusions.isNotEmpty
        : exclusions is List
        ? exclusions.isNotEmpty
        : exclusions != null && exclusions != false && '$exclusions'.isNotEmpty;
    return hasExclusions || rows(obj(job['manifest'])['paths']).any(
      (path) => path['status'] != 'inverse_reviewed_observation',
    );
  }

  Future<bool> continueRecovery(Json job) async {
    final id = job['id'], captureId = job['captureId'];
    if (!active || offline || continuing || id is! String || captureId is! String) return false;
    final continuation = obj(job['continuation']);
    final existingSessionId = continuation['sessionId'];
    if (job['state'] == 'opened' &&
        existingSessionId is String &&
        existingSessionId.isNotEmpty) {
      final generation = _generation;
      continuing = true;
      emit();
      try {
        await controller.open(existingSessionId);
        return controller.sessionId == existingSessionId;
      } catch (e) {
        if (_sameScope(generation: generation)) {
          error = _failure(e, tr('Unable to continue in the recovery conversation.'));
        }
        return false;
      } finally {
        if (_sameScope(generation: generation)) {
          continuing = false;
          emit();
        }
      }
    }
    if (!canMutate ||
        (job['state'] != 'ready' && job['state'] != 'opened')) {
      return false;
    }
    final unresolved = hasUnresolved(job);
    final acceptUnresolved = reviewedKeepCurrent[id] == true;
    if (unresolved && !acceptUnresolved) return false;
    final generation = _generation, ticket = ++_mutationRevision;
    final sourceId = session;
    final leaseGeneration = controller.control['generation'];
    continuing = true;
    error = null;
    emit();
    try {
      final result = await controller.gateway.request(
        '$_base/${enc(captureId)}/recoveries/${enc(id)}/continue',
        method: 'POST',
        body: {
          'revision': job['revision'],
          'acceptUnresolved': acceptUnresolved,
          'clientId': client,
          'generation': leaseGeneration,
        },
      );
      if (!_validMutation(generation, ticket)) return false;
      final refreshedJob = obj(result['job']);
      if (refreshedJob.isNotEmpty) _replaceJob(refreshedJob);
      final sessionDto = obj(result['session']);
      final nextId = sessionDto['id'];
      if (nextId is! String || nextId.isEmpty || sourceId == null) {
        throw StateError(tr('The server did not return the new conversation.'));
      }
      controller.sessions = [
        sessionDto,
        ...controller.sessions.where((item) => item['id'] != nextId),
      ];
      // Opening the returned session only subscribes to it. It does not send
      // a prompt or replay the previous conversation.
      await controller.open(nextId);
      return true;
    } catch (e) {
      if (_validMutation(generation, ticket)) {
        error = _isConflict(e)
            ? tr('This recovery changed while you were reviewing it. Refresh and review again.')
            : _failure(e, tr('Unable to continue in the recovery conversation.'));
      }
      return false;
    } finally {
      if (_validMutation(generation, ticket)) {
        continuing = false;
        emit();
      }
    }
  }

  String _fileKey(String side, String jobId) =>
      '$selectedCaptureId:$selectedOperationId:$jobId:$side';

  Future<void> loadFile(String side, {String? jobId}) async {
    final captureId = selectedCaptureId, operationId = selectedOperationId;
    if (!active || offline || captureId == null || operationId == null) return;
    if ((side == 'current' || side == 'candidate') && jobId == null) return;
    final jobKey = jobId ?? '';
    final key = _fileKey(side, jobKey);
    if (files.containsKey(key) || fileLoading.contains(key)) return;
    final generation = _generation, ticket = ++_fileRevision;
    fileLoading.add(key);
    fileError = null;
    emit();
    try {
      final query = Uri(queryParameters: {
        'operation': operationId,
        'side': side,
        'job': ?jobId,
      }).query;
      final result = await controller.gateway.request(
        '$_base/${enc(captureId)}/file?$query',
      );
      if (!_sameScope(generation: generation) || ticket != _fileRevision || selectedCaptureId != captureId || selectedOperationId != operationId || selectedJobId != jobId) return;
      files[key] = result;
    } catch (e) {
      if (_sameScope(generation: generation) && ticket == _fileRevision) {
        fileError = _failure(e, tr('Unable to load this checkpoint file.'));
      }
    } finally {
      fileLoading.remove(key);
      if (_sameScope(generation: generation)) emit();
    }
  }

  Json? fileFor(String side, {String? jobId}) =>
      files[_fileKey(side, jobId ?? '')];

  @override
  void dispose() {
    disposed = true;
    _generation++;
    _readRevision++;
    _fileRevision++;
    _mutationRevision++;
    _poll?.cancel();
    unawaited(events?.cancel());
    controller.removeListener(observe);
    super.dispose();
  }
}
