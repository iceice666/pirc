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
  RoomsController(this.gateway);
  final Gateway gateway;

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
    loopsRevision = (data['loopsRevision'] as num?)?.toInt() ?? 0;
    wakesRevision = (data['wakesRevision'] as num?)?.toInt() ?? 0;
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
    if (text.trim().isEmpty) return Future.value();
    draft = '';
    _draftSave?.cancel();
    _draftSave = null;
    unawaited(_saveDraft(roomId, ''));
    actionError = null;
    sending = true;
    _changed();
    final sent = _outbox.then((_) async {
      try {
        await gateway.call('roomsSend', {
          'roomId': roomId,
          'text': text,
          'attachments': <String>[],
          'immediate': immediate,
        });
      } catch (e) {
        actionError = LiveController.describe(e);
        // Give the words back unless something new was written meanwhile.
        if (draft.isEmpty && currentId == roomId) {
          draft = text;
          unawaited(_saveDraft(roomId, text));
        }
      }
    });
    _outbox = sent;
    return sent.whenComplete(() {
      if (_outbox == sent) sending = false;
      _changed();
    });
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
    unawaited(_events?.cancel());
    super.dispose();
  }
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
