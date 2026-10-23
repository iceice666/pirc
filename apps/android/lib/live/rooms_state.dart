import 'dart:async';
import 'package:flutter/foundation.dart';
import 'gateway.dart';

/// The host face: it always exists and answers where no other face does.
const hostFaceId = 'host';

/// What the room pages show (plans/rewrite/12-android.md). The state lives in
/// the native runtime (`RoomsRuntime.kt`: the list, the open room, faces,
/// the thread, typing and presence, reduced like the web's `room-events.ts`);
/// this mirrors its snapshots and sends the user's actions back. Drafts are
/// kept per room, like the web's `relay.room-draft.<room>`.
class RoomsController extends ChangeNotifier {
  RoomsController(this.gateway, {this.pairingStampOf});
  final Gateway gateway;

  /// The current pairing (the controller that owns this knows it).
  final String? Function()? pairingStampOf;

  /// The pairing a saved file belongs to (the save picker checks it).
  String? get pairingStamp => pairingStampOf?.call();

  StreamSubscription<Json>? _events;
  bool _disposed = false;

  /// Whether [start] ran: the room pages follow the stream from then on.
  bool started = false;

  String user = '';
  String currentId = 'general';

  /// The open room: from the list, or archived and opened by a link.
  Json? current;
  List<Json> rooms = [];

  /// The archived rooms, once the list's fold was opened.
  List<Json>? archived;
  List<Json> messages = [], pinned = [], faces = [];
  bool hasMore = false, loading = true, opening = false;
  String? error;
  String connection = 'connecting';

  /// Others typing in each room: user → when their signal lapses (ms).
  Map<String, Map<String, int>> typing = {};

  /// Faces thinking in each room now: room → face ids.
  Map<String, List<String>> thinking = {};

  /// What each face is doing now: face id → its presence.
  Map<String, Json> facePresence = {};
  int loopsRevision = 0, wakesRevision = 0;

  /// Bumped when an open loop (or a wake) changes: the engine's lists reload.
  final loopsChanged = ValueNotifier<int>(0),
      wakesChanged = ValueNotifier<int>(0);

  /// The thread open beside the room.
  String? threadId, threadError;
  List<Json> threadMessages = [], threadWorkers = [];

  /// What each thread's workers did last: thread id → `{text, at}`.
  Map<String, Json> threadActivity = {};

  /// What is being written in the open room.
  String draft = '';
  String? _draftRoom;
  Timer? _draftSave;

  /// The last action that failed (sending, creating a room), to show.
  String? actionError;

  /// Rooms muted on this phone: they do not notify here (decision 1).
  Set<String> muted = {};

  /// A room a notification or link asked to show; the page opens it once.
  String? _reveal;

  /// Take the room to reveal, if any (the page shows it instead of the list).
  String? takeReveal() {
    final room = _reveal;
    _reveal = null;
    return room;
  }

  /// Files to send with the next message: `{name, mimeType, bytes}`.
  List<Json> files = [];

  /// Messages go out in the order they were written; the composer never waits.
  Future<void> _outbox = Future.value();
  bool sending = false;

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  /// Load the list and [roomId], then follow the stream.
  Future<void> start([String? roomId]) async {
    _events ??= gateway.events.listen((event) {
      if (event['type'] == 'rooms') apply(event['data']);
    });
    started = true;
    if (roomId != null) _reveal = roomId;
    unawaited(_loadMuted());
    try {
      apply(await gateway.call('roomsStart', {'roomId': ?roomId}));
    } catch (e) {
      error = LiveController.describe(e);
      loading = false;
      _changed();
    }
  }

  /// Unpaired or another account: forget everything shown.
  Future<void> stop() async {
    await flushDraft();
    started = false;
    apply(null);
    await _quietly('roomsStop');
  }

  /// The app came to the front (or left it): reads count only in front.
  Future<void> setVisible(bool visible) =>
      _quietly('roomsVisible', {'visible': visible});

  /// A call whose failure changes nothing shown (the next one tries again).
  Future<dynamic> _quietly(String method, [Json args = const {}]) async {
    try {
      return await gateway.call(method, args);
    } catch (_) {
      return null;
    }
  }

  /// One snapshot from the native runtime; null when it stopped.
  void apply(dynamic raw) {
    if (raw == null) {
      user = '';
      current = null;
      rooms = [];
      archived = null;
      messages = [];
      pinned = [];
      faces = [];
      hasMore = false;
      loading = !started ? true : loading;
      opening = false;
      error = null;
      typing = {};
      thinking = {};
      facePresence = {};
      threadId = null;
      threadError = null;
      threadMessages = [];
      threadWorkers = [];
      threadActivity = {};
      _changed();
      return;
    }
    final data = obj(raw);
    user = '${data['user'] ?? ''}';
    final nextRoom = '${data['currentId'] ?? 'general'}';
    current = data['current'] == null ? null : obj(data['current']);
    rooms = rows(data['rooms']);
    archived = data['archived'] == null ? null : rows(data['archived']);
    messages = rows(data['messages']);
    pinned = rows(data['pinned']);
    hasMore = data['hasMore'] == true;
    loading = data['loading'] == true;
    opening = data['opening'] == true;
    error = data['error'] as String?;
    connection = '${data['connection'] ?? 'offline'}';
    typing = obj(data['typing']).map(
      (room, users) => MapEntry(
        room,
        obj(users).map((who, until) => MapEntry(who, (until as num).toInt())),
      ),
    );
    thinking = obj(data['thinking']).map(
      (room, ids) => MapEntry(room, [
        for (final id in ids is List ? ids : const []) '$id',
      ]),
    );
    faces = rows(data['faces']);
    facePresence = obj(
      data['facePresence'],
    ).map((id, p) => MapEntry(id, obj(p)));
    final loops = (data['loopsRevision'] as num?)?.toInt() ?? 0;
    final wakes = (data['wakesRevision'] as num?)?.toInt() ?? 0;
    if (loops != loopsRevision) loopsChanged.value++;
    if (wakes != wakesRevision) wakesChanged.value++;
    loopsRevision = loops;
    wakesRevision = wakes;
    threadId = data['threadId'] as String?;
    threadMessages = rows(data['threadMessages']);
    threadWorkers = rows(data['threadWorkers']);
    threadError = data['threadError'] as String?;
    threadActivity = obj(
      data['threadActivity'],
    ).map((id, activity) => MapEntry(id, obj(activity)));
    if (nextRoom != currentId || _draftRoom == null) {
      currentId = nextRoom;
      unawaited(_loadDraft(nextRoom));
    }
    _changed();
  }

  Future<void> _loadDraft(String roomId) async {
    await flushDraft();
    _draftRoom = roomId;
    final text = '${await _quietly('roomDraft', {'roomId': roomId}) ?? ''}';
    if (_draftRoom != roomId) return;
    draft = text;
    _changed();
  }

  /// The composer changed: kept for this room, and the others hear typing.
  void editDraft(String value) {
    final roomId = _draftRoom ?? currentId;
    final typed = value.length > draft.length;
    draft = value;
    _draftSave?.cancel();
    _draftSave = Timer(const Duration(milliseconds: 400), () {
      _draftSave = null;
      unawaited(_saveDraft(roomId, value));
    });
    if (typed && value.trim().isNotEmpty) {
      unawaited(_quietly('roomsTyping', {'roomId': roomId}));
    }
  }

  Future<void> _saveDraft(String roomId, String text) =>
      _quietly('saveRoomDraft', {'roomId': roomId, 'text': text});

  /// Write the pending draft now (leaving the room or the app).
  Future<void> flushDraft() async {
    final pending = _draftSave;
    if (pending == null) return;
    pending.cancel();
    _draftSave = null;
    final roomId = _draftRoom;
    if (roomId != null) await _saveDraft(roomId, draft);
  }

  Future<void> _loadMuted() async {
    final rooms = await _quietly('roomsMuted');
    if (rooms is List) {
      muted = {for (final room in rooms) '$room'};
      _changed();
    }
  }

  /// Mute or unmute a room on this phone.
  Future<void> setMuted(String roomId, bool mute) async {
    try {
      final rooms = await gateway.call('roomsSetMuted', {
        'roomId': roomId,
        'muted': mute,
      });
      muted = {for (final room in rooms is List ? rooms : const []) '$room'};
      actionError = null;
    } catch (e) {
      actionError = LiveController.describe(e);
    }
    _changed();
  }

  /// Show [roomId] from outside the page (a notification, a link).
  Future<void> reveal(String roomId) async {
    _reveal = roomId;
    _changed();
    await open(roomId);
  }

  Future<void> open(String roomId) async {
    if (roomId == currentId && !opening && error == null) {
      // Already shown: read what came meanwhile.
      await setVisible(true);
      return;
    }
    await flushDraft();
    await _call('roomsOpen', {'roomId': roomId});
  }

  Future<void> reload() => _call('roomsReload');
  Future<void> loadOlder() => _call('roomsOlder');

  /// Send what was written. [immediate] (a long press on Send) asks the
  /// brain not to wait for more (decision #16).
  Future<void> send({bool immediate = false}) {
    final text = draft;
    final roomId = currentId;
    final attached = files;
    if (text.trim().isEmpty && attached.isEmpty) return Future.value();
    draft = '';
    files = [];
    _draftSave?.cancel();
    _draftSave = null;
    unawaited(_saveDraft(roomId, ''));
    actionError = null;
    sending = true;
    _changed();
    final sent = _outbox.then((_) async {
      try {
        final uploads = <String>[];
        for (final file in attached) {
          final upload = obj(
            await gateway.call('roomsUpload', {
              'roomId': roomId,
              'name': file['name'],
              'mimeType': file['mimeType'],
              'bytes': file['bytes'],
            }),
          );
          uploads.add('${upload['id']}');
        }
        await gateway.call('roomsSend', {
          'roomId': roomId,
          'text': text,
          'attachments': uploads,
          'immediate': immediate,
        });
      } catch (e) {
        actionError = LiveController.describe(e);
        // Give the words back unless something new was written meanwhile.
        if (draft.isEmpty && currentId == roomId) {
          draft = text;
          unawaited(_saveDraft(roomId, text));
        }
        if (files.isEmpty && currentId == roomId) files = attached;
      }
    });
    _outbox = sent;
    return sent.whenComplete(() {
      if (_outbox == sent) sending = false;
      _changed();
    });
  }

  /// Pick files for the next message (8 MiB each).
  Future<void> attach() async {
    try {
      final picked = rows(await gateway.call('pickAttachments'));
      final failed = picked.where((file) => file['error'] != null).toList();
      files = [
        ...files,
        for (final file in picked)
          if (file['error'] == null && file['bytes'] != null) file,
      ];
      actionError = failed.isEmpty
          ? null
          : 'Could not read ${failed.map((file) => file['name']).join(', ')}: ${failed.first['error']}';
    } catch (e) {
      actionError = LiveController.describe(e);
    }
    _changed();
  }

  void removeFile(int index) {
    files = [...files]..removeAt(index);
    _changed();
  }

  /// A file of a message: its bytes and type.
  Future<Json> download(String roomId, String uploadId) async => obj(
    await gateway.call('roomsDownload', {
      'roomId': roomId,
      'uploadId': uploadId,
    }),
  );

  /// Make a face (the member list's "Add"); its event says the same later.
  Future<String> createFace(String name) async {
    final reply = await gateway.request(
      '/api/faces',
      method: 'POST',
      body: {'name': name.trim()},
    );
    final face = obj(reply['face']);
    await _quietly('roomsFaceSaved', {'face': face});
    return '${face['id']}';
  }

  /// Change a face (name, bio, territory, archived, hidden, ...).
  Future<void> updateFace(String faceId, Json input) async {
    final reply = await gateway.request(
      '/api/faces/${enc(faceId)}',
      method: 'PATCH',
      body: input,
    );
    await _quietly('roomsFaceSaved', {'face': reply['face']});
  }

  // ---- what a line or a worker's message offers ----
  // Each answer comes back through the room's stream: the gateway rewrites
  // the line or the anchor, so nothing is changed here first.

  /// "Don't keep" on what the brain remembered (`body.memory`).
  Future<void> dontKeep(Json memory) => _request(
    memory['kind'] == 'fact'
        ? '/api/memory/records/${enc('${memory['id']}')}'
        : '/api/memory/preferences/${enc('${memory['id']}')}/forget',
    method: memory['kind'] == 'fact' ? 'DELETE' : 'POST',
  );

  /// Undo what happened to an open loop (`body.loop`): see [loopActionLabel].
  Future<void> undoLoop(Json loop) => _request(
    '/api/loops/${enc('${loop['id']}')}',
    method: 'PATCH',
    body: {
      'status': loop['event'] == 'opened' || loop['event'] == 'reopened'
          ? 'closed'
          : 'open',
    },
  );

  /// Call off a wake pirc said it would come back for (`body.wake`).
  Future<void> cancelWake(String wakeId) =>
      _request('/api/wakes/${enc(wakeId)}', method: 'DELETE');

  /// Answer a worker's red-line question (plan 07).
  Future<void> answer(String threadId, String interactionId, Json answer) =>
      _request(
        '/api/threads/${enc(threadId)}/answer',
        method: 'POST',
        body: {'interactionId': interactionId, 'answer': answer},
      );

  /// Stop a worker; its anchor and the room say how it ended.
  Future<void> stopWorker(String delegationId) => _request(
    '/api/delegations/${enc(delegationId)}/stop',
    method: 'POST',
    body: const {},
  );

  /// One of the above: its failure is shown, and thrown for the row to say.
  Future<void> _request(
    String path, {
    required String method,
    Json? body,
  }) async {
    try {
      await gateway.request(path, method: method, body: body ?? const {});
      actionError = null;
    } catch (e) {
      actionError = LiveController.describe(e);
      _changed();
      rethrow;
    }
  }

  Future<String?> createRoom(String name) async {
    try {
      final id = await gateway.call('roomsCreate', {'name': name.trim()});
      actionError = null;
      return id as String?;
    } catch (e) {
      actionError = LiveController.describe(e);
      _changed();
      return null;
    }
  }

  Future<void> loadArchived() => _call('roomsArchived');
  Future<void> setArchived(String roomId, bool archived) =>
      _call('roomsSetArchived', {'roomId': roomId, 'archived': archived});
  Future<void> rename(String roomId, String name) => _call('roomsUpdate', {
    'roomId': roomId,
    'patch': {'name': name},
  });
  /// Moves this room's loops to another room. The gateway still does this (its
  /// move_room tool leaves a "Continued in" row behind); no screen calls it
  /// since "Continue in…" was removed from the room menu.
  Future<void> moveTo(String toRoomId, {String? topic}) =>
      _call('roomsMove', {'toRoomId': toRoomId, 'topic': ?topic});
  Future<void> pin(Json message, bool pinned) => _call('roomsPin', {
    'roomId': message['roomId'],
    'messageId': message['id'],
    'pinned': pinned,
  });
  Future<void> openThread(String threadId) =>
      _call('roomsOpenThread', {'threadId': threadId});
  Future<void> closeThread() => _call('roomsCloseThread');

  Future<void> _call(String method, [Json args = const {}]) async {
    try {
      await gateway.call(method, args);
      actionError = null;
    } catch (e) {
      actionError = LiveController.describe(e);
      _changed();
    }
  }

  // ---- what the pages read ----

  Json? face(String id) => faces.where((face) => face['id'] == id).firstOrNull;

  /// A face's name; the host is pirc until the faces are loaded.
  String faceName(String id) =>
      face(id)?['name'] as String? ?? (id == hostFaceId ? 'pirc' : id);

  /// Who said a message: a face's name, or the user who sent it.
  String speakerName(Json message) {
    final speaker = '${message['speaker'] ?? ''}';
    if (speaker.startsWith('face:')) return faceName(speaker.substring(5));
    if (speaker.startsWith('worker:')) return 'worker';
    return message['user'] as String? ?? 'someone';
  }

  /// The face whose territory has the room (never the host).
  Json? roomFace(String roomId) => faces
      .where(
        (face) =>
            face['isHost'] != true &&
            face['archivedAt'] == null &&
            (obj(face['territory'])['rooms'] as List? ?? const []).contains(
              roomId,
            ),
      )
      .firstOrNull;

  /// Who answers in a room when nobody is named.
  String hereIn(String roomId) =>
      roomFace(roomId)?['name'] as String? ?? faceName(hostFaceId);

  /// The faces thinking in a room now, by name.
  List<String> thinkingIn(String roomId) => [
    for (final id in thinking[roomId] ?? const <String>[]) faceName(id),
  ];

  /// Who else is typing in a room at [now] (ms since the epoch).
  List<String> typingIn(String roomId, int now) => [
    for (final entry in (typing[roomId] ?? const <String, int>{}).entries)
      if (entry.key != user && entry.value > now) entry.key,
  ];

  /// Rooms where a face waits for this user's reply.
  int get waitingCount => rooms.where((room) => room['waiting'] == true).length;

  /// The faces the member list shows: hidden ones only when asked for.
  List<Json> listedFaces({bool showHidden = false}) => [
    for (final face in faces)
      if (showHidden || face['hiddenAt'] == null) face,
  ];

  /// A worker's question still waiting in the open room: the newest.
  Json? get asking => messages.reversed
      .where(
        (message) =>
            message['kind'] == 'question' &&
            obj(obj(message['body'])['question'])['status'] == 'pending',
      )
      .firstOrNull;

  @override
  void dispose() {
    _disposed = true;
    _draftSave?.cancel();
    loopsChanged.dispose();
    wakesChanged.dispose();
    unawaited(_events?.cancel());
    super.dispose();
  }
}

/// What a line's button does to its open loop: undo an opening, or open again.
String loopActionLabel(Json loop) =>
    loop['event'] == 'opened' || loop['event'] == 'reopened'
    ? "Don't keep"
    : 'Not done yet';

/// Where a fact or preference came from, for people.
String describeOrigin(String origin) {
  if (origin == 'user') return 'From your words';
  if (origin == 'om:promoted') return 'From an earlier conversation';
  if (origin == 'tool:assistant') return 'From the old assistant';
  if (origin.startsWith('tool:')) {
    return 'From what it read (${origin.substring(5)})';
  }
  return origin.isEmpty ? '' : 'From $origin';
}

/// A worker's status in a few words; [count] workers in its thread.
String workerStatusLabel(String? status, [int count = 1]) => switch (status) {
  'queued' => 'Waiting its turn',
  'running' => count > 1 ? 'Working ($count)' : 'Working',
  'waiting_input' => 'Asking you',
  'completed' => 'Done',
  'failed' => 'Failed',
  _ => status ?? '',
};

/// Whether a worker in this status can still be stopped.
bool workerStoppable(String? status) =>
    status == 'queued' || status == 'running' || status == 'waiting_input';

/// How a worker's question ended, in words.
String questionOutcome(Json question) {
  if (question['status'] == 'cancelled') return 'No longer asked.';
  if (question['status'] == 'expired') {
    return 'Nobody answered in time: the worker was told no.';
  }
  final answer = obj(question['answer']);
  final how = answer.containsKey('confirmed')
      ? answer['confirmed'] == true
            ? answer['again'] == true
                  ? 'allowed for the rest of its session'
                  : 'allowed'
            : 'declined'
      : 'answered';
  final capitalized = how[0].toUpperCase() + how.substring(1);
  return question['answeredBy'] != null
      ? '$capitalized by ${question['answeredBy']}.'
      : '$capitalized.';
}

/// What a presence says, in a few words.
String presenceLabel(Json? presence) => switch (presence?['state']) {
  'thinking' => 'Thinking',
  'working' =>
    presence?['line'] != null ? 'Working on ${presence!['line']}' : 'Working',
  'waiting' => presence?['line'] as String? ?? 'Waiting for you',
  _ => 'Here',
};

/// A stable hue per name, for faces and people without a color.
int hueOf(String name) =>
    name.runes.fold(7, (sum, char) => (sum * 31 + char) % 360);

/// What an avatar shows: the face's own, else the first letter.
String initialOf(String name, [String? avatar]) {
  if (avatar != null && avatar.isNotEmpty) return avatar;
  if (name.isEmpty) return '?';
  return String.fromCharCode(name.runes.first).toUpperCase();
}
