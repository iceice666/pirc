import 'dart:async';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../theme.dart';
import 'common.dart';
import 'gateway.dart';
import 'rooms_state.dart';

/// A round avatar: the face's own emoji or initial, on its color or a hue of
/// its name.
class RoomAvatar extends StatelessWidget {
  const RoomAvatar({
    super.key,
    required this.name,
    this.avatar,
    this.color,
    this.size = 32,
  });
  final String name;
  final String? avatar, color;
  final double size;

  @override
  Widget build(BuildContext context) {
    final parsed =
        color != null && RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(color!)
        ? Color(int.parse('ff${color!.substring(1)}', radix: 16))
        : HSLColor.fromAHSL(1, hueOf(name).toDouble(), .45, .55).toColor();
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: parsed, shape: BoxShape.circle),
      child: Text(
        initialOf(name, avatar),
        style: TextStyle(
          color: Colors.white,
          fontSize: size * .45,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

/// `18:04`, in the phone's time.
String roomTime(Object? at) {
  if (at is! num) return '';
  final time = DateTime.fromMillisecondsSinceEpoch(at.toInt());
  String two(int value) => value.toString().padLeft(2, '0');
  return '${two(time.hour)}:${two(time.minute)}';
}

/// Where the engine shows what a line is about (decision 3's deep links).
String? detailsSection(Json body) => body['memory'] is Map
    ? 'memory'
    : body['loop'] is Map
    ? 'loops'
    : body['wake'] is Map
    ? 'wakes'
    : null;

/// One message of a room (the web's `RoomMessageRow.svelte`), by kind:
/// `text` (with a worker's anchor or a red-line question in it), `line` (a
/// quiet note that may be undone: "Don't keep", the loop's action, Cancel),
/// `progress` (what is being done now) and `question`.
class RoomMessageRow extends StatefulWidget {
  const RoomMessageRow({
    super.key,
    required this.message,
    required this.rooms,
    this.previous,
    required this.onOpenRoom,
    required this.onOpenThread,
    required this.onPin,
    this.onDetails,
    this.onOpenFace,
  });
  final Json message;
  final Json? previous;
  final RoomsController rooms;
  final ValueChanged<String> onOpenRoom, onOpenThread;
  final void Function(Json message, bool pinned) onPin;

  /// Open the engine at a section (`memory`, `loops`, `wakes`).
  final ValueChanged<String>? onDetails;

  /// Open a face's page.
  final ValueChanged<String>? onOpenFace;

  @override
  State<RoomMessageRow> createState() => _RoomMessageRowState();
}

class _RoomMessageRowState extends State<RoomMessageRow> {
  bool expanded = false, busy = false, loopDone = false, wakeDone = false;
  String? error;

  Json get message => widget.message;
  Json get body => obj(message['body']);
  RoomsController get rooms => widget.rooms;

  /// One action of the row: busy while it runs, its failure said under it.
  Future<void> _act(
    Future<void> Function() action, {
    VoidCallback? done,
  }) async {
    if (busy) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await action();
      done?.call();
    } catch (e) {
      error = LiveController.describe(e);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  String? get _threadId =>
      message['threadId'] as String? ??
      (body['worker'] is Map
          ? obj(body['worker'])['threadId'] as String?
          : null);

  @override
  Widget build(BuildContext context) {
    final colors = palette(context);
    return switch (message['kind']) {
      'progress' => _progress(colors),
      'line' => _line(colors),
      _ => _message(colors),
    };
  }

  Widget _progress(PircColors colors) => Semantics(
    liveRegion: true,
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 6),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const SizedBox(
            width: 12,
            height: 12,
            child: CircularProgressIndicator(strokeWidth: 1.5),
          ),
          const SizedBox(width: 8),
          Flexible(
            child: Text(
              '${body['text'] ?? ''}',
              style: TextStyle(fontSize: 12.5, color: colors['text.muted']),
            ),
          ),
          const SizedBox(width: 8),
          _time(colors),
        ],
      ),
    ),
  );

  Widget _time(PircColors colors) => Text(
    roomTime(message['createdAt']),
    style: TextStyle(fontSize: 11, color: colors['text.faint']),
  );

  Widget _link(String label, VoidCallback? onTap, {bool quiet = false}) =>
      Builder(
        builder: (context) {
          final colors = palette(context);
          return InkWell(
            onTap: onTap,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
              child: Text(
                label,
                style: TextStyle(
                  fontSize: 12.5,
                  color: onTap == null
                      ? colors['text.faint']
                      : colors[quiet ? 'text.secondary' : 'accent.default'],
                  decoration: quiet ? null : TextDecoration.underline,
                ),
              ),
            ),
          );
        },
      );

  Widget _line(PircColors colors) {
    final text = '${body['text'] ?? ''}';
    final move = body['move'] is Map ? obj(body['move']) : null;
    final memory = body['memory'] is Map ? obj(body['memory']) : null;
    final remembered = memory != null && memory['forgotten'] != true
        ? memory
        : null;
    final wake =
        body['wake'] is Map && obj(body['wake'])['event'] == 'scheduled'
        ? obj(body['wake'])
        : null;
    final loop = body['loop'] is Map ? obj(body['loop']) : null;
    final threadId = body['worker'] is Map ? _threadId : null;
    final section = detailsSection(body);
    final muted = TextStyle(fontSize: 12.5, color: colors['text.muted']);
    final parts = <Widget>[
      if (move != null && move['roomId'] is String)
        _link(text, () => widget.onOpenRoom(move['roomId'] as String))
      else if (remembered != null) ...[
        Semantics(
          button: true,
          expanded: expanded,
          child: InkWell(
            onTap: () => setState(() => expanded = !expanded),
            child: Text(text, style: muted),
          ),
        ),
        _link(
          "Don't keep",
          busy ? null : () => _act(() => rooms.dontKeep(remembered)),
        ),
      ] else if (wake != null) ...[
        Text(text, style: muted),
        if (!wakeDone)
          _link(
            'Cancel',
            busy
                ? null
                : () => _act(
                    () => rooms.cancelWake('${wake['id']}'),
                    done: () => wakeDone = true,
                  ),
          ),
      ] else if (threadId != null) ...[
        Text(text, style: muted),
        _link('Open the thread', () => widget.onOpenThread(threadId)),
      ] else if (loop != null) ...[
        Text(text, style: muted),
        if (!loopDone)
          _link(
            loopActionLabel(loop),
            busy
                ? null
                : () => _act(
                    () => rooms.undoLoop(loop),
                    done: () => loopDone = true,
                  ),
          ),
      ] else
        Text(text, style: muted, textAlign: TextAlign.center),
      if (section != null && widget.onDetails != null)
        _link('Details', () => widget.onDetails!(section), quiet: true),
      _time(colors),
    ];
    final origin = '${remembered?['origin'] ?? ''}';
    final detail = remembered == null
        ? ''
        : '${remembered['kind'] == 'preference' ? 'A preference: always on its mind.' : 'A fact: found again when it matters.'} '
              '${describeOrigin(origin)}'
              '${remembered['user'] != null ? ' · for ${remembered['user']}' : ''}.';
    return Semantics(
      container: true,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 6),
        child: Column(
          children: [
            Wrap(
              alignment: WrapAlignment.center,
              crossAxisAlignment: WrapCrossAlignment.center,
              spacing: 6,
              children: parts,
            ),
            if (remembered != null && expanded)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  detail,
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontSize: 12,
                    color: colors['text.secondary'],
                  ),
                ),
              ),
            if (error != null)
              Text(
                error!,
                style: TextStyle(fontSize: 12, color: colors['status.danger']),
              ),
          ],
        ),
      ),
    );
  }

  Widget _message(PircColors colors) {
    final text = body['text'] as String? ?? '';
    final streaming = body['streaming'] == true;
    final speaker = '${message['speaker'] ?? ''}';
    final name = rooms.speakerName(message);
    final face = speaker.startsWith('face:')
        ? rooms.face(speaker.substring(5))
        : null;
    final previous = widget.previous;
    // A run by one speaker within five minutes shares one header.
    final continued =
        previous != null &&
        previous['kind'] != 'line' &&
        message['kind'] != 'question' &&
        previous['speaker'] == speaker &&
        previous['user'] == message['user'] &&
        ((message['createdAt'] as num? ?? 0) -
                (previous['createdAt'] as num? ?? 0)) <
            5 * 60 * 1000;
    final asking = message['kind'] == 'question';
    final question = asking && body['question'] is Map
        ? obj(body['question'])
        : null;
    final worker = body['worker'] is Map ? obj(body['worker']) : null;
    final anchor = worker != null && worker.containsKey('title')
        ? worker
        : null;
    final threadId = _threadId;
    final attachments = rows(body['attachments']);
    final pinned = message['pinnedAt'] != null;
    return Semantics(
      container: true,
      label: '$name${asking ? ' asks' : ''}, ${roomTime(message['createdAt'])}',
      child: GestureDetector(
        onLongPress: () => _menu(pinned),
        child: Container(
          color: asking ? colors['accent.soft'] : null,
          padding: EdgeInsets.fromLTRB(12, continued ? 2 : 10, 12, 2),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                width: 32,
                child: continued
                    ? null
                    : RoomAvatar(
                        name: name,
                        avatar: face?['avatar'] as String?,
                        color: face?['color'] as String?,
                      ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (!continued) _header(colors, name, face, asking, pinned),
                    if (text.isNotEmpty || streaming)
                      SelectableText(
                        streaming ? '$text▍' : text,
                        style: TextStyle(
                          color: colors['text.primary'],
                          height: 1.45,
                        ),
                      ),
                    if (question != null) _question(colors, question, threadId),
                    if (anchor != null)
                      _anchor(colors, anchor)
                    else if (worker != null &&
                        worker['report'] == true &&
                        threadId != null)
                      _link(
                        'Open the thread',
                        () => widget.onOpenThread(threadId),
                      ),
                    for (final file in attachments)
                      Padding(
                        padding: const EdgeInsets.only(top: 6),
                        child: file['kind'] == 'image'
                            ? RoomImage(
                                rooms: rooms,
                                roomId: '${message['roomId']}',
                                attachment: file,
                                name: name,
                              )
                            : RoomFile(
                                rooms: rooms,
                                roomId: '${message['roomId']}',
                                attachment: file,
                              ),
                      ),
                    if (error != null)
                      Text(
                        error!,
                        style: TextStyle(
                          fontSize: 12.5,
                          color: colors['status.danger'],
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _header(
    PircColors colors,
    String name,
    Json? face,
    bool asking,
    bool pinned,
  ) {
    final title = Text(
      name,
      overflow: TextOverflow.ellipsis,
      style: TextStyle(
        fontWeight: FontWeight.w600,
        color: colors['text.primary'],
      ),
    );
    return Row(
      children: [
        Flexible(
          child: face != null && widget.onOpenFace != null
              ? InkWell(
                  onTap: () => widget.onOpenFace!('${face['id']}'),
                  child: title,
                )
              : title,
        ),
        const SizedBox(width: 6),
        _time(colors),
        if (asking) ...[
          const SizedBox(width: 6),
          Text(
            'asks you',
            style: TextStyle(fontSize: 12, color: colors['accent.default']),
          ),
        ],
        if (pinned) ...[
          const SizedBox(width: 6),
          Icon(
            LucideIcons.pin,
            size: 12,
            color: colors['text.muted'],
            semanticLabel: 'Pinned',
          ),
        ],
      ],
    );
  }

  Widget _question(PircColors colors, Json question, String? threadId) {
    if (question['status'] != 'pending') {
      return Padding(
        padding: const EdgeInsets.only(top: 4),
        child: Text(
          questionOutcome(question),
          style: TextStyle(fontSize: 13, color: colors['text.muted']),
        ),
      );
    }
    final request = obj(question['request']);
    Future<void> answer(Json given) => _act(
      () => rooms.answer(threadId!, '${question['interactionId']}', given),
    );
    final ready = !busy && threadId != null;
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Wrap(
        spacing: 8,
        runSpacing: 6,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          FilledButton(
            onPressed: ready ? () => answer({'confirmed': true}) : null,
            child: const Text('Yes'),
          ),
          if (request['allowAgain'] == true)
            OutlinedButton(
              onPressed: ready
                  ? () => answer({'confirmed': true, 'again': true})
                  : null,
              child: const Text('Allow again this session'),
            ),
          OutlinedButton(
            onPressed: ready ? () => answer({'confirmed': false}) : null,
            child: const Text('No'),
          ),
          if (threadId != null)
            _link('Thread', () => widget.onOpenThread(threadId)),
        ],
      ),
    );
  }

  Widget _anchor(PircColors colors, Json anchor) {
    final status = anchor['status'] as String?;
    final threadId = anchor['threadId'] as String?;
    final working = status == 'running' || status == 'waiting_input';
    // While it works: what it did last, updated in place.
    final progress = working && threadId != null
        ? rooms.threadActivity[threadId]
        : null;
    final dot = switch (status) {
      'running' || 'queued' => colors['accent.default'],
      'waiting_input' => colors['status.warning'],
      'completed' => colors['status.success'],
      'failed' => colors['status.danger'],
      _ => colors['text.muted'],
    };
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(color: dot, shape: BoxShape.circle),
              ),
              Text(
                workerStatusLabel(
                  status,
                  (anchor['workers'] as num?)?.toInt() ?? 1,
                ),
                style: TextStyle(fontSize: 13, color: colors['text.secondary']),
              ),
              if (anchor['note'] != null)
                Text(
                  '· waits for ${anchor['note']}',
                  style: TextStyle(fontSize: 13, color: colors['text.muted']),
                ),
              if (threadId != null)
                _link('Thread', () => widget.onOpenThread(threadId)),
              if (workerStoppable(status) && anchor['delegationId'] != null)
                _link(
                  'Stop',
                  busy
                      ? null
                      : () => _act(
                          () => rooms.stopWorker('${anchor['delegationId']}'),
                        ),
                ),
            ],
          ),
          if (progress != null)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                '${progress['text']}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 12.5, color: colors['text.muted']),
              ),
            ),
        ],
      ),
    );
  }

  Future<void> _menu(bool pinned) async {
    final picked = await showModalBottomSheet<String>(
      context: context,
      useSafeArea: true,
      builder: (context) => Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ListTile(
            leading: Icon(pinned ? LucideIcons.pinOff : LucideIcons.pin),
            title: Text(pinned ? 'Unpin' : 'Pin'),
            onTap: () => Navigator.pop(context, 'pin'),
          ),
        ],
      ),
    );
    if (picked == 'pin') widget.onPin(message, !pinned);
  }
}

/// An image sent in a room, fetched with this phone's token.
class RoomImage extends StatefulWidget {
  const RoomImage({
    super.key,
    required this.rooms,
    required this.roomId,
    required this.attachment,
    required this.name,
  });
  final RoomsController rooms;
  final String roomId, name;
  final Json attachment;

  @override
  State<RoomImage> createState() => _RoomImageState();
}

class _RoomImageState extends State<RoomImage> {
  late final Future<Uint8List> bytes = widget.rooms
      .download(widget.roomId, '${widget.attachment['id']}')
      .then((file) => file['bytes'] as Uint8List);

  @override
  Widget build(BuildContext context) => FutureBuilder<Uint8List>(
    future: bytes,
    builder: (context, snapshot) {
      if (snapshot.hasError) {
        return RoomFile(
          rooms: widget.rooms,
          roomId: widget.roomId,
          attachment: widget.attachment,
        );
      }
      if (!snapshot.hasData) {
        return const SizedBox(
          width: 160,
          height: 120,
          child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
        );
      }
      return ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 320, maxHeight: 320),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(8),
          child: Image.memory(
            snapshot.data!,
            fit: BoxFit.contain,
            semanticLabel: 'Attachment from ${widget.name}',
          ),
        ),
      );
    },
  );
}

/// A file sent in a room: tapping saves it where the user picks.
class RoomFile extends StatefulWidget {
  const RoomFile({
    super.key,
    required this.rooms,
    required this.roomId,
    required this.attachment,
  });
  final RoomsController rooms;
  final String roomId;
  final Json attachment;

  @override
  State<RoomFile> createState() => _RoomFileState();
}

class _RoomFileState extends State<RoomFile> {
  bool saving = false;

  Future<void> _save() async {
    if (saving) return;
    setState(() => saving = true);
    final name = '${widget.attachment['filename'] ?? 'file'}';
    await guarded(context, () async {
      final file = await widget.rooms.download(
        widget.roomId,
        '${widget.attachment['id']}',
      );
      await widget.rooms.gateway.call('saveDocument', {
        'name': name,
        'mimeType': widget.attachment['mimeType'] ?? file['mimeType'],
        'bytes': file['bytes'],
        'pairingStamp': widget.rooms.pairingStamp,
      });
    });
    if (mounted) setState(() => saving = false);
  }

  @override
  Widget build(BuildContext context) {
    final colors = palette(context);
    final size = (widget.attachment['byteSize'] as num?)?.toInt();
    return InkWell(
      onTap: saving ? null : () => unawaited(_save()),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            saving ? LucideIcons.loader : LucideIcons.paperclip,
            size: 14,
            color: colors['text.muted'],
          ),
          const SizedBox(width: 4),
          Flexible(
            child: Text(
              '${widget.attachment['filename'] ?? 'file'}'
              '${size == null ? '' : ' · ${formatBytes(size)}'}',
              style: TextStyle(
                color: colors['accent.default'],
                decoration: TextDecoration.underline,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// `12 KB`, `3.4 MB`.
String formatBytes(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).round()} KB';
  return '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
}
