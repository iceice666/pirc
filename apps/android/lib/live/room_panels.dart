import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'common.dart';
import 'gateway.dart';
import 'room_message_row.dart';
import 'rooms_state.dart';

/// A panel beside a room (or a whole page on a phone): a title, a close
/// button and its contents.
class RoomSidePanel extends StatelessWidget {
  const RoomSidePanel({
    super.key,
    required this.title,
    required this.onClose,
    required this.child,
    this.closeLabel = 'Close',
    this.back = false,
  });
  final String title, closeLabel;
  final VoidCallback onClose;
  final Widget child;

  /// A phone shows a back arrow instead of a cross.
  final bool back;

  @override
  Widget build(BuildContext context) {
    final colors = palette(context);
    return Material(
      color: colors['surface.page'],
      child: Column(
        children: [
          Container(
            height: 52,
            padding: const EdgeInsets.symmetric(horizontal: 4),
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: colors['web.line'])),
            ),
            child: Row(
              children: [
                if (back)
                  IconButton(
                    tooltip: closeLabel,
                    onPressed: onClose,
                    icon: const Icon(LucideIcons.arrowLeft),
                  )
                else
                  const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    title,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                if (!back)
                  IconButton(
                    tooltip: closeLabel,
                    onPressed: onClose,
                    icon: const Icon(LucideIcons.x, size: 18),
                  ),
              ],
            ),
          ),
          Expanded(child: child),
        ],
      ),
    );
  }
}

/// The faces beside a room (the web's `MembersPanel.svelte`): who is here
/// and what each is doing. An archived face is greyed out until someone
/// hides it; hidden ones show only when asked for.
class RoomMembers extends StatefulWidget {
  const RoomMembers({
    super.key,
    required this.rooms,
    required this.onClose,
    this.back = false,
  });
  final RoomsController rooms;
  final VoidCallback onClose;
  final bool back;

  @override
  State<RoomMembers> createState() => _RoomMembersState();
}

class _RoomMembersState extends State<RoomMembers> {
  bool showHidden = false;

  @override
  Widget build(BuildContext context) {
    final colors = palette(context);
    final rooms = widget.rooms;
    final own = rooms.roomFace(rooms.currentId);
    final faces = rooms.listedFaces(showHidden: showHidden);
    final hidden = rooms.faces.where((face) => face['hiddenAt'] != null).length;
    return RoomSidePanel(
      title: 'Members',
      closeLabel: widget.back ? 'Back to the room' : 'Close members',
      back: widget.back,
      onClose: widget.onClose,
      child: ListView(
        children: [
          for (final face in faces)
            Opacity(
              opacity: face['archivedAt'] != null ? .5 : 1,
              child: ListTile(
                leading: RoomAvatar(
                  name: '${face['name']}',
                  avatar: face['avatar'] as String?,
                  color: face['color'] as String?,
                ),
                title: Text(
                  [
                    '${face['name']}',
                    if (face['isHost'] == true) '(host)',
                    if (own?['id'] == face['id']) '· answers here',
                  ].join(' '),
                ),
                subtitle: Text(
                  face['archivedAt'] != null
                      ? 'Archived'
                      : presenceLabel(rooms.facePresence['${face['id']}']),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: colors['text.muted']),
                ),
              ),
            ),
          if (faces.isEmpty)
            Padding(
              padding: const EdgeInsets.all(16),
              child: Text(
                'No faces yet.',
                style: TextStyle(color: colors['text.muted']),
              ),
            ),
          if (hidden > 0)
            TextButton(
              onPressed: () => setState(() => showHidden = !showHidden),
              child: Text(
                showHidden ? 'Hide the hidden faces' : 'Show $hidden hidden',
              ),
            ),
        ],
      ),
    );
  }
}

/// A worker's thread beside the room (the web's `ThreadPanel.svelte`): its
/// workers and everything they said and did, live.
class RoomThread extends StatelessWidget {
  const RoomThread({
    super.key,
    required this.rooms,
    required this.onClose,
    this.back = false,
  });
  final RoomsController rooms;
  final VoidCallback onClose;
  final bool back;

  @override
  Widget build(BuildContext context) {
    final colors = palette(context);
    final workers = rooms.threadWorkers;
    return RoomSidePanel(
      title: 'Thread',
      closeLabel: back ? 'Back to the room' : 'Close the thread',
      back: back,
      onClose: onClose,
      child: rooms.threadError != null
          ? Padding(
              padding: const EdgeInsets.all(16),
              child: Text(
                rooms.threadError!,
                style: TextStyle(color: colors['status.danger']),
              ),
            )
          : ListView(
              padding: const EdgeInsets.only(bottom: 16),
              children: [
                for (final worker in workers)
                  ListTile(
                    dense: true,
                    leading: Icon(
                      LucideIcons.squareTerminal,
                      size: 18,
                      color: colors['text.muted'],
                    ),
                    title: Text(
                      '${worker['title'] ?? worker['name'] ?? worker['id'] ?? 'Worker'}',
                    ),
                    subtitle: Text(
                      [
                        if (worker['status'] != null) '${worker['status']}',
                        if (worker['workspace'] != null)
                          '${worker['workspace']}',
                      ].join(' · '),
                      style: TextStyle(color: colors['text.muted']),
                    ),
                  ),
                if (workers.isNotEmpty)
                  Divider(height: 1, color: colors['web.line']),
                for (final message in rooms.threadMessages)
                  _ThreadLine(message: message, rooms: rooms),
                if (rooms.threadMessages.isEmpty)
                  Padding(
                    padding: const EdgeInsets.all(16),
                    child: Text(
                      'Nothing in this thread yet.',
                      style: TextStyle(color: colors['text.muted']),
                    ),
                  ),
              ],
            ),
    );
  }
}

class _ThreadLine extends StatelessWidget {
  const _ThreadLine({required this.message, required this.rooms});
  final Json message;
  final RoomsController rooms;

  @override
  Widget build(BuildContext context) {
    final colors = palette(context);
    final body = obj(message['body']);
    final kind = message['kind'];
    final speaker = '${message['speaker'] ?? ''}';
    final who = speaker == 'user'
        ? '${message['user'] ?? 'you'}'
        : speaker.startsWith('face:')
        ? rooms.faceName(speaker.substring(5))
        : speaker.replaceFirst('worker:', '');
    final text = kind == 'tool'
        ? [body['tool'], body['summary']].whereType<String>().join(' · ')
        : '${body['text'] ?? obj(body['request'])['title'] ?? ''}';
    return Padding(
      padding: EdgeInsets.fromLTRB(
        16 + (message['depth'] == 1 ? 16 : 0),
        6,
        16,
        6,
      ),
      child: kind == 'line'
          ? Text(
              text,
              style: TextStyle(fontSize: 12.5, color: colors['text.muted']),
            )
          : Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (kind == 'tool')
                  Padding(
                    padding: const EdgeInsets.only(top: 2, right: 6),
                    child: Icon(
                      LucideIcons.wrench,
                      size: 13,
                      color: colors['text.muted'],
                    ),
                  ),
                Expanded(
                  child: Text.rich(
                    TextSpan(
                      children: [
                        TextSpan(
                          text: '$who  ',
                          style: TextStyle(
                            fontWeight: FontWeight.w600,
                            color: colors['text.secondary'],
                          ),
                        ),
                        TextSpan(text: text),
                      ],
                    ),
                    style: TextStyle(
                      fontSize: 13.5,
                      color: colors['text.primary'],
                      height: 1.4,
                    ),
                  ),
                ),
              ],
            ),
    );
  }
}
