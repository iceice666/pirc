import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../theme.dart';
import 'common.dart';
import 'gateway.dart';
import 'mobile_tabs.dart';
import 'room_message_row.dart';
import 'face_page.dart';
import 'room_panels.dart';
import 'rooms_state.dart';

/// Where the room list ends and the room starts on a wide screen.
const roomListWidth = 248.0;

/// The rooms (the web's `Rooms.svelte`): the list in activity order with
/// unread dots and "Your turn", the open room's messages, who is typing and
/// thinking, and beside it the members or a worker's thread. A phone shows
/// one of them at a time, with the bottom tabs.
class RoomsPage extends StatefulWidget {
  const RoomsPage({
    super.key,
    required this.rooms,
    required this.onEngine,
    required this.onSettings,
    this.onDetails,
    this.clock = _now,
  });
  final RoomsController rooms;
  final VoidCallback onEngine, onSettings;

  /// A line's "Details": the engine at that section.
  final ValueChanged<String>? onDetails;

  /// Milliseconds since the epoch (tests pass their own).
  final int Function() clock;

  static int _now() => DateTime.now().millisecondsSinceEpoch;

  @override
  State<RoomsPage> createState() => RoomsPageState();
}

class RoomsPageState extends State<RoomsPage> {
  RoomsController get rooms => widget.rooms;

  /// Phone: the list covers the room.
  bool listOpen = true;

  /// Beside the room: the members (a thread comes first).
  bool membersOpen = false;

  /// A face's page, shown where the members are.
  String? faceId;
  bool showArchived = false;
  final composer = TextEditingController();
  final scroll = ScrollController();
  Timer? _clock;
  bool _loadingOlder = false;

  @override
  void initState() {
    super.initState();
    rooms.addListener(_update);
    scroll.addListener(_onScroll);
    composer.text = rooms.draft;
    composer.addListener(_composerChanged);
    _update();
  }

  @override
  void didUpdateWidget(RoomsPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.rooms != rooms) {
      oldWidget.rooms.removeListener(_update);
      rooms.addListener(_update);
    }
  }

  void _update() {
    if (!mounted) return;
    // A notification or link asked for a room: show it, not the list.
    if (rooms.takeReveal() != null) {
      listOpen = false;
      membersOpen = false;
    }
    if (composer.text != rooms.draft) {
      composer.value = TextEditingValue(
        text: rooms.draft,
        selection: TextSelection.collapsed(offset: rooms.draft.length),
      );
    }
    // Typing lapses on its own: tick while someone types.
    final typing = rooms.typingIn(rooms.currentId, widget.clock()).isNotEmpty;
    if (typing && _clock == null) {
      _clock = Timer.periodic(const Duration(seconds: 1), (_) => _update());
    } else if (!typing && _clock != null) {
      _clock!.cancel();
      _clock = null;
    }
    setState(() {});
  }

  bool _composerEmpty = true;

  /// Send is enabled once there is something to send.
  void _composerChanged() {
    final empty = composer.text.trim().isEmpty;
    if (empty != _composerEmpty && mounted) {
      setState(() => _composerEmpty = empty);
    }
  }

  void _onScroll() {
    // The list is reversed: the top is the far end.
    if (!scroll.hasClients || _loadingOlder || !rooms.hasMore) return;
    if (scroll.position.pixels > scroll.position.maxScrollExtent - 200) {
      _loadingOlder = true;
      unawaited(rooms.loadOlder().whenComplete(() => _loadingOlder = false));
    }
  }

  @override
  void dispose() {
    rooms.removeListener(_update);
    _clock?.cancel();
    unawaited(rooms.flushDraft());
    composer.dispose();
    scroll.dispose();
    super.dispose();
  }

  /// Open a room (from the list, a move line or a notification).
  Future<void> openRoom(String roomId) async {
    setState(() {
      listOpen = false;
      membersOpen = false;
    });
    if (scroll.hasClients) scroll.jumpTo(0);
    await rooms.open(roomId);
  }

  /// Back to the list (phone).
  void showList() => setState(() {
    listOpen = true;
    membersOpen = false;
  });

  Future<void> _createRoom() async {
    final name = await showDialog<String>(
      context: context,
      builder: (context) {
        final field = TextEditingController();
        return AlertDialog(
          title: const Text('New room'),
          content: TextField(
            controller: field,
            autofocus: true,
            maxLength: 80,
            decoration: const InputDecoration(hintText: 'Room name'),
            onSubmitted: (value) => Navigator.pop(context, value),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, field.text),
              child: const Text('Create'),
            ),
          ],
        );
      },
    );
    if (name == null || name.trim().isEmpty) return;
    final id = await rooms.createRoom(name);
    if (id != null && mounted) setState(() => listOpen = false);
  }

  Future<void> _toggleArchived() async {
    setState(() => showArchived = !showArchived);
    if (showArchived) await rooms.loadArchived();
  }

  Future<void> _continueIn() async {
    final others = rooms.rooms
        .where((room) => room['id'] != rooms.currentId)
        .toList();
    final target = await showModalBottomSheet<String>(
      context: context,
      useSafeArea: true,
      builder: (context) => ListView(
        shrinkWrap: true,
        children: [
          const ListTile(
            title: Text(
              'Continue in…',
              style: TextStyle(fontWeight: FontWeight.w600),
            ),
          ),
          for (final room in others)
            ListTile(
              leading: const Icon(LucideIcons.hash, size: 18),
              title: Text('${room['name']}'),
              onTap: () => Navigator.pop(context, '${room['id']}'),
            ),
        ],
      ),
    );
    if (target != null) await rooms.moveTo(target);
  }

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, size) {
      final phone = size.maxWidth <= 650;
      final thread = rooms.threadId != null;
      final side = thread || membersOpen;
      final tab = listOpen
          ? 'rooms'
          : side && !thread
          ? 'members'
          : 'rooms';
      final canPop = phone ? listOpen && !side : !side;
      return PopScope(
        canPop: canPop,
        onPopInvokedWithResult: (didPop, _) {
          if (didPop) return;
          if (thread) {
            unawaited(rooms.closeThread());
          } else if (faceId != null) {
            setState(() => faceId = null);
          } else if (membersOpen) {
            setState(() => membersOpen = false);
          } else if (phone) {
            showList();
          }
        },
        child: Scaffold(
          bottomNavigationBar: phone && (listOpen || (side && !thread))
              ? MobileTabs(
                  tabs: [
                    MobileTab('rooms', badge: rooms.waitingCount),
                    const MobileTab('members'),
                    const MobileTab('engine'),
                    const MobileTab('settings'),
                  ],
                  current: tab,
                  onPick: (picked) {
                    switch (picked) {
                      case 'rooms':
                        showList();
                      case 'members':
                        unawaited(rooms.closeThread());
                        setState(() {
                          listOpen = false;
                          membersOpen = true;
                          faceId = null;
                        });
                      case 'engine':
                        widget.onEngine();
                      case 'settings':
                        widget.onSettings();
                    }
                  },
                )
              : null,
          body: SafeArea(
            child: phone
                ? (listOpen
                      ? _list(phone: true)
                      : side
                      ? _side(phone: true)
                      : _room(phone: true))
                : Row(
                    children: [
                      SizedBox(
                        width: roomListWidth,
                        child: _list(phone: false),
                      ),
                      VerticalDivider(
                        width: 1,
                        color: palette(context)['web.line'],
                      ),
                      Expanded(child: _room(phone: false)),
                      if (side) ...[
                        VerticalDivider(
                          width: 1,
                          color: palette(context)['web.line'],
                        ),
                        SizedBox(
                          width: (size.maxWidth * .32).clamp(280.0, 380.0),
                          child: _side(phone: false),
                        ),
                      ],
                    ],
                  ),
          ),
        ),
      );
    },
  );

  /// Beside the room: a worker's thread, a face's page, or the members.
  Widget _side({required bool phone}) {
    if (rooms.threadId != null) {
      return RoomThread(
        rooms: rooms,
        back: phone,
        onClose: () => unawaited(rooms.closeThread()),
      );
    }
    final face = faceId;
    if (face != null) {
      return FacePage(
        key: ValueKey(('face', face)),
        rooms: rooms,
        faceId: face,
        onBack: () => setState(() => faceId = null),
        onPreferences: widget.onDetails == null
            ? null
            : () => widget.onDetails!('memory'),
      );
    }
    return RoomMembers(
      rooms: rooms,
      back: phone,
      onOpenFace: openFace,
      onClose: () => setState(() {
        membersOpen = false;
        faceId = null;
      }),
    );
  }

  /// A face's page, from the members or a speaker's name.
  void openFace(String id) {
    unawaited(rooms.closeThread());
    setState(() {
      listOpen = false;
      membersOpen = true;
      faceId = id;
    });
  }

  Widget _list({required bool phone}) {
    final colors = palette(context);
    return Material(
      color: colors['web.bg-subtle'],
      child: Column(
        children: [
          SizedBox(
            height: 52,
            child: Row(
              children: [
                const SizedBox(width: 16),
                const Expanded(
                  child: Text(
                    'pirc',
                    style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
                  ),
                ),
                IconButton(
                  tooltip: 'New room',
                  onPressed: _createRoom,
                  icon: const Icon(LucideIcons.plus),
                ),
              ],
            ),
          ),
          if (rooms.actionError != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: Text(
                rooms.actionError!,
                style: TextStyle(color: colors['status.danger'], fontSize: 13),
              ),
            ),
          Expanded(
            child: ListView(
              children: [
                for (final room in rooms.rooms) _roomRow(room, colors),
                if (rooms.loading && rooms.rooms.isEmpty)
                  const Padding(
                    padding: EdgeInsets.all(24),
                    child: Center(child: CircularProgressIndicator()),
                  ),
                TextButton.icon(
                  style: TextButton.styleFrom(
                    alignment: Alignment.centerLeft,
                    foregroundColor: colors['text.muted'],
                  ),
                  onPressed: _toggleArchived,
                  icon: Icon(
                    showArchived
                        ? LucideIcons.chevronDown
                        : LucideIcons.chevronRight,
                    size: 14,
                  ),
                  label: const Text('Archived'),
                ),
                if (showArchived) ...[
                  for (final room in rooms.archived ?? const <Json>[])
                    _roomRow(room, colors),
                  if (rooms.archived?.isEmpty == true)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(24, 4, 16, 8),
                      child: Text(
                        'No archived rooms.',
                        style: TextStyle(color: colors['text.muted']),
                      ),
                    ),
                ],
              ],
            ),
          ),
          if (!phone) ...[
            Divider(height: 1, color: colors['web.line']),
            ListTile(
              dense: true,
              leading: const Icon(LucideIcons.squareTerminal, size: 18),
              title: const Text('Engine'),
              onTap: widget.onEngine,
            ),
            ListTile(
              dense: true,
              leading: const Icon(LucideIcons.settings, size: 18),
              title: const Text('Settings'),
              onTap: widget.onSettings,
            ),
          ],
        ],
      ),
    );
  }

  Widget _roomRow(Json room, PircColors colors) {
    final id = '${room['id']}';
    final chosen = id == rooms.currentId && !listOpen;
    final unread = ((room['unread'] as num?) ?? 0) > 0 && id != rooms.currentId;
    return Semantics(
      selected: id == rooms.currentId,
      button: true,
      child: Material(
        color:
            chosen ||
                (id == rooms.currentId &&
                    MediaQuery.sizeOf(context).width > 650)
            ? colors['web.bg-hover']
            : Colors.transparent,
        child: InkWell(
          onTap: () => unawaited(openRoom(id)),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
            child: Row(
              children: [
                Icon(LucideIcons.hash, size: 16, color: colors['text.muted']),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    '${room['name']}',
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontWeight: unread ? FontWeight.w600 : FontWeight.w400,
                      color:
                          colors[room['archivedAt'] != null
                              ? 'text.muted'
                              : 'text.primary'],
                    ),
                  ),
                ),
                if (rooms.muted.contains(id))
                  Padding(
                    padding: const EdgeInsets.only(left: 6),
                    child: Icon(
                      LucideIcons.bellOff,
                      size: 13,
                      color: colors['text.muted'],
                      semanticLabel: 'Muted',
                    ),
                  ),
                if (room['waiting'] == true)
                  Container(
                    margin: const EdgeInsets.only(left: 6),
                    padding: const EdgeInsets.symmetric(
                      horizontal: 6,
                      vertical: 2,
                    ),
                    decoration: BoxDecoration(
                      color: colors['status.warning'],
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: const Text(
                      'Your turn',
                      style: TextStyle(color: Colors.white, fontSize: 11),
                    ),
                  ),
                if (unread)
                  Semantics(
                    label: '${room['unread']} unread',
                    child: Container(
                      margin: const EdgeInsets.only(left: 8),
                      width: 8,
                      height: 8,
                      decoration: BoxDecoration(
                        color: colors['accent.default'],
                        shape: BoxShape.circle,
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _room({required bool phone}) {
    final colors = palette(context);
    final current = rooms.current;
    final name = '${current?['name'] ?? rooms.currentId}';
    final archived = current?['archivedAt'] != null;
    final thinking = rooms.thinkingIn(rooms.currentId);
    final typing = rooms.typingIn(rooms.currentId, widget.clock());
    final asking = rooms.asking;
    final messages = rooms.messages;
    return Material(
      color: colors['surface.page'],
      child: Column(
        children: [
          Container(
            height: 52,
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: colors['web.line'])),
            ),
            child: Row(
              children: [
                if (phone)
                  IconButton(
                    tooltip: 'Rooms',
                    onPressed: showList,
                    icon: const Icon(LucideIcons.arrowLeft),
                  )
                else
                  const SizedBox(width: 12),
                Icon(LucideIcons.hash, size: 18, color: colors['text.muted']),
                const SizedBox(width: 4),
                Expanded(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        name,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      Semantics(
                        liveRegion: true,
                        child: Text(
                          thinking.isNotEmpty
                              ? '${thinking.join(', ')} thinking'
                              : '${rooms.hereIn(rooms.currentId)} is here',
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 12,
                            color:
                                colors[thinking.isNotEmpty
                                    ? 'accent.default'
                                    : 'text.muted'],
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                if (archived) _badge(colors, 'Archived'),
                if (rooms.connection != 'connected' && !rooms.loading)
                  _badge(colors, rooms.connection),
                IconButton(
                  tooltip: rooms.muted.contains(rooms.currentId)
                      ? 'Unmute this room on this phone'
                      : 'Mute this room on this phone',
                  isSelected: rooms.muted.contains(rooms.currentId),
                  onPressed: () => unawaited(
                    rooms.setMuted(
                      rooms.currentId,
                      !rooms.muted.contains(rooms.currentId),
                    ),
                  ),
                  icon: Icon(
                    rooms.muted.contains(rooms.currentId)
                        ? LucideIcons.bellOff
                        : LucideIcons.bell,
                    size: 20,
                  ),
                ),
                IconButton(
                  tooltip: 'Members',
                  isSelected: membersOpen,
                  onPressed: () {
                    unawaited(rooms.closeThread());
                    setState(() {
                      membersOpen = !membersOpen;
                      faceId = null;
                    });
                  },
                  icon: const Icon(LucideIcons.users, size: 20),
                ),
                PopupMenuButton<String>(
                  tooltip: 'Room actions',
                  icon: const Icon(LucideIcons.ellipsisVertical, size: 20),
                  onSelected: (action) {
                    switch (action) {
                      case 'move':
                        unawaited(_continueIn());
                      case 'archive':
                        unawaited(
                          rooms.setArchived(rooms.currentId, !archived),
                        );
                    }
                  },
                  itemBuilder: (context) => [
                    if (!archived && rooms.rooms.length > 1)
                      const PopupMenuItem(
                        value: 'move',
                        child: Text('Continue in…'),
                      ),
                    if (current != null && current['kind'] != 'general')
                      PopupMenuItem(
                        value: 'archive',
                        child: Text(archived ? 'Unarchive' : 'Archive'),
                      ),
                  ],
                ),
              ],
            ),
          ),
          if (rooms.pinned.isNotEmpty)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              color: colors['surface.subtle'],
              child: Text(
                rooms.pinned
                    .map((m) => '📌 ${obj(m['body'])['text'] ?? 'attachment'}')
                    .join('   '),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 13, color: colors['text.secondary']),
              ),
            ),
          Expanded(
            child: rooms.error != null
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Text(
                        rooms.error!,
                        textAlign: TextAlign.center,
                        style: TextStyle(color: colors['status.danger']),
                      ),
                    ),
                  )
                : (rooms.loading || rooms.opening) && messages.isEmpty
                ? const Center(child: CircularProgressIndicator())
                : messages.isEmpty
                ? Center(
                    child: Text(
                      'Nothing here yet. Say something.',
                      style: TextStyle(color: colors['text.muted']),
                    ),
                  )
                : ListView.builder(
                    controller: scroll,
                    reverse: true,
                    padding: const EdgeInsets.only(bottom: 8),
                    itemCount: messages.length + (rooms.hasMore ? 1 : 0),
                    itemBuilder: (context, index) {
                      if (index == messages.length) {
                        return const Padding(
                          padding: EdgeInsets.all(12),
                          child: Center(
                            child: SizedBox(
                              width: 20,
                              height: 20,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            ),
                          ),
                        );
                      }
                      final at = messages.length - 1 - index;
                      final message = messages[at];
                      return RoomMessageRow(
                        key: ValueKey(message['id']),
                        message: message,
                        previous: at > 0 ? messages[at - 1] : null,
                        rooms: rooms,
                        onOpenRoom: (id) => unawaited(openRoom(id)),
                        onOpenThread: (id) {
                          setState(() => membersOpen = false);
                          unawaited(rooms.openThread(id));
                        },
                        onPin: (message, pinned) =>
                            unawaited(rooms.pin(message, pinned)),
                        onDetails: widget.onDetails,
                        onOpenFace: openFace,
                      );
                    },
                  ),
          ),
          // A worker's question still waiting here: answered without
          // scrolling back to it.
          if (asking != null)
            Container(
              key: const Key('room-asking'),
              decoration: BoxDecoration(
                border: Border(top: BorderSide(color: colors['web.line'])),
              ),
              constraints: const BoxConstraints(maxHeight: 220),
              child: SingleChildScrollView(
                child: RoomMessageRow(
                  key: ValueKey(('asking', asking['id'])),
                  message: asking,
                  rooms: rooms,
                  onOpenRoom: (id) => unawaited(openRoom(id)),
                  onOpenThread: (id) {
                    setState(() => membersOpen = false);
                    unawaited(rooms.openThread(id));
                  },
                  onPin: (message, pinned) =>
                      unawaited(rooms.pin(message, pinned)),
                ),
              ),
            ),
          if (thinking.isNotEmpty || typing.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 2, 16, 2),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  [
                    if (thinking.isNotEmpty)
                      '${thinking.join(', ')} is thinking…',
                    if (typing.isNotEmpty)
                      '${typing.join(', ')} ${typing.length == 1 ? 'is' : 'are'} typing…',
                  ].join(' '),
                  style: TextStyle(fontSize: 12, color: colors['text.muted']),
                ),
              ),
            ),
          if (current != null && !archived)
            _composer(colors, name)
          else if (archived)
            Padding(
              padding: const EdgeInsets.all(12),
              child: Text(
                'This room is archived. Unarchive it to write here.',
                style: TextStyle(color: colors['text.muted']),
              ),
            ),
        ],
      ),
    );
  }

  Widget _badge(PircColors colors, String text) => Container(
    margin: const EdgeInsets.only(left: 4),
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
    decoration: BoxDecoration(
      color: colors['surface.subtle'],
      borderRadius: BorderRadius.circular(6),
    ),
    child: Text(
      text,
      style: TextStyle(fontSize: 11, color: colors['text.secondary']),
    ),
  );

  Widget _composer(PircColors colors, String name) {
    final empty = composer.text.trim().isEmpty && rooms.files.isEmpty;
    return Container(
      padding: const EdgeInsets.fromLTRB(4, 6, 6, 8),
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: colors['web.line'])),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (rooms.actionError != null)
            Align(
              alignment: Alignment.centerLeft,
              child: Text(
                rooms.actionError!,
                style: TextStyle(color: colors['status.danger'], fontSize: 13),
              ),
            ),
          if (rooms.files.isNotEmpty)
            Align(
              alignment: Alignment.centerLeft,
              child: Wrap(
                spacing: 6,
                children: [
                  for (final (index, file) in rooms.files.indexed)
                    InputChip(
                      label: Text('${file['name']}'),
                      deleteButtonTooltipMessage: 'Remove ${file['name']}',
                      onDeleted: () => rooms.removeFile(index),
                    ),
                ],
              ),
            ),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              IconButton(
                tooltip: 'Attach files',
                onPressed: () => unawaited(rooms.attach()),
                icon: Icon(LucideIcons.paperclip, color: colors['text.muted']),
              ),
              Expanded(
                child: CallbackShortcuts(
                  bindings: {
                    // A hardware keyboard: Ctrl+Enter sends at once.
                    const SingleActivator(
                      LogicalKeyboardKey.enter,
                      control: true,
                    ): () =>
                        unawaited(rooms.send(immediate: true)),
                  },
                  child: TextField(
                    controller: composer,
                    minLines: 1,
                    maxLines: 6,
                    keyboardType: TextInputType.multiline,
                    textCapitalization: TextCapitalization.sentences,
                    decoration: InputDecoration(
                      hintText: 'Message #$name',
                      border: InputBorder.none,
                      isDense: true,
                    ),
                    onChanged: rooms.editDraft,
                  ),
                ),
              ),
              // A long press sends at once, past the brain's wait for more
              // (decision #16). No tooltip: it would take the long press.
              Semantics(
                hint: 'Long press to send now',
                onLongPressHint: 'Send now',
                child: GestureDetector(
                  onLongPress: empty
                      ? null
                      : () => unawaited(rooms.send(immediate: true)),
                  child: IconButton(
                    onPressed: empty ? null : () => unawaited(rooms.send()),
                    icon: Icon(
                      LucideIcons.sendHorizontal,
                      semanticLabel: 'Send',
                      color: empty
                          ? colors['text.faint']
                          : colors['accent.default'],
                    ),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
