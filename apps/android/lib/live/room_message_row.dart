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

/// One message of a room (the web's `RoomMessageRow.svelte`): who said it
/// and what. A `line` is a quiet note between messages; a worker's anchor
/// shows what its workers do now and opens its thread.
class RoomMessageRow extends StatelessWidget {
  const RoomMessageRow({
    super.key,
    required this.message,
    required this.rooms,
    this.previous,
    required this.onOpenRoom,
    required this.onOpenThread,
    required this.onPin,
  });
  final Json message;
  final Json? previous;
  final RoomsController rooms;
  final ValueChanged<String> onOpenRoom, onOpenThread;
  final void Function(Json message, bool pinned) onPin;

  @override
  Widget build(BuildContext context) {
    final colors = palette(context);
    final body = obj(message['body']);
    final text = body['text'] as String? ?? '';
    final kind = message['kind'];
    if (kind == 'line') return _line(context, colors, body, text);
    final speaker = '${message['speaker'] ?? ''}';
    final name = rooms.speakerName(message);
    final face = speaker.startsWith('face:')
        ? rooms.face(speaker.substring(5))
        : null;
    // Several messages from one speaker in a row share one header.
    final continued =
        previous != null &&
        previous!['kind'] != 'line' &&
        previous!['speaker'] == speaker &&
        previous!['user'] == message['user'];
    final worker = body['worker'] is Map ? obj(body['worker']) : null;
    final question = body['question'] is Map ? obj(body['question']) : null;
    final threadId =
        message['threadId'] as String? ?? worker?['threadId'] as String?;
    final activity = threadId == null ? null : rooms.threadActivity[threadId];
    final attachments = rows(body['attachments']);
    final pinned = message['pinnedAt'] != null;
    return Semantics(
      container: true,
      label: '$name: ${text.isEmpty ? 'an attachment' : text}',
      child: GestureDetector(
        onLongPress: () => _menu(context, pinned, text),
        child: Padding(
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
                    if (!continued)
                      Row(
                        children: [
                          Flexible(
                            child: Text(
                              name,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                fontWeight: FontWeight.w600,
                                color: colors['text.primary'],
                              ),
                            ),
                          ),
                          if (pinned) ...[
                            const SizedBox(width: 6),
                            Icon(
                              LucideIcons.pin,
                              size: 12,
                              color: colors['text.muted'],
                            ),
                          ],
                        ],
                      ),
                    if (text.isNotEmpty)
                      SelectableText(
                        text,
                        style: TextStyle(
                          color: body['streaming'] == true
                              ? colors['text.secondary']
                              : colors['text.primary'],
                          height: 1.45,
                        ),
                      ),
                    for (final file in attachments)
                      Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(
                              LucideIcons.paperclip,
                              size: 14,
                              color: colors['text.muted'],
                            ),
                            const SizedBox(width: 4),
                            Flexible(
                              child: Text(
                                '${file['filename'] ?? file['mimeType'] ?? 'file'}',
                                style: TextStyle(
                                  color: colors['text.secondary'],
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    if (question != null)
                      _note(
                        context,
                        LucideIcons.circleHelp,
                        '${obj(question['request'])['title'] ?? 'A question'} · ${question['status']}',
                      ),
                    if (worker != null || threadId != null)
                      _thread(context, colors, worker, activity, threadId),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _line(
    BuildContext context,
    PircColors colors,
    Json body,
    String text,
  ) {
    final move = body['move'] is Map ? obj(body['move']) : null;
    final label = Text(
      text,
      textAlign: TextAlign.center,
      style: TextStyle(fontSize: 12.5, color: colors['text.muted']),
    );
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 6),
      child: Center(
        child: move != null && move['roomId'] is String
            ? InkWell(
                onTap: () => onOpenRoom(move['roomId'] as String),
                child: label,
              )
            : label,
      ),
    );
  }

  Widget _note(BuildContext context, IconData icon, String text) {
    final colors = palette(context);
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 14, color: colors['text.muted']),
          const SizedBox(width: 4),
          Flexible(
            child: Text(
              text,
              style: TextStyle(color: colors['text.secondary'], fontSize: 13),
            ),
          ),
        ],
      ),
    );
  }

  Widget _thread(
    BuildContext context,
    PircColors colors,
    Json? worker,
    Json? activity,
    String? threadId,
  ) {
    final status = worker?['status'] as String?;
    final working = status == 'running' || status == 'queued';
    final line = working ? (activity?['text'] as String?) : null;
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Material(
        color: colors['surface.subtle'],
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: threadId == null ? null : () => onOpenThread(threadId),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
            child: Row(
              children: [
                Icon(
                  LucideIcons.messagesSquare,
                  size: 15,
                  color: colors['text.muted'],
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        [
                          if (worker?['title'] != null) '${worker!['title']}',
                          ?status,
                        ].join(' · ').ifEmpty('Thread'),
                        style: TextStyle(
                          fontSize: 13,
                          color: colors['text.primary'],
                        ),
                      ),
                      if (line != null)
                        Text(
                          line,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 12,
                            color: colors['text.muted'],
                          ),
                        ),
                    ],
                  ),
                ),
                Icon(
                  LucideIcons.chevronRight,
                  size: 16,
                  color: colors['text.muted'],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _menu(BuildContext context, bool pinned, String text) async {
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
    if (picked == 'pin') onPin(message, !pinned);
  }
}

extension on String {
  String ifEmpty(String fallback) => isEmpty ? fallback : this;
}
