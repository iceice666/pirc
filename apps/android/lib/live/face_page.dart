import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'common.dart';
import 'engine_overview.dart' show agoMs, describeTrigger;
import 'gateway.dart';
import 'room_message_row.dart' show RoomAvatar;
import 'room_panels.dart';
import 'rooms_state.dart';

/// A face's page (the web's `FacePanel.svelte`, plans/rewrite/10-faces.md):
/// its name, bio, voice and role, the rooms, workspaces and sources it looks
/// after, the loops it holds and what it did lately. Saved changes apply
/// from its next turn. The host's page also holds who pirc is (`SOUL.md`,
/// `CHAT.md`) and leads to the preferences it keeps.
class FacePage extends StatefulWidget {
  const FacePage({
    super.key,
    required this.rooms,
    required this.faceId,
    required this.onBack,
    this.onPreferences,
  });
  final RoomsController rooms;
  final String faceId;
  final VoidCallback onBack;

  /// The host's preferences, on the engine's memory page.
  final VoidCallback? onPreferences;

  @override
  State<FacePage> createState() => _FacePageState();
}

class _FacePageState extends State<FacePage> {
  final name = TextEditingController(),
      bio = TextEditingController(),
      tone = TextEditingController(),
      avatar = TextEditingController(),
      color = TextEditingController(),
      role = TextEditingController(),
      soul = TextEditingController(),
      chat = TextEditingController();
  Json territory = {'rooms': [], 'workspaces': [], 'sources': []};
  Json? activity, prompts;
  List<Json> workspaces = [], sources = [];
  bool busy = false, saved = false;
  String? error;
  String _shownId = '', _shownAt = '';

  RoomsController get rooms => widget.rooms;
  Gateway get g => rooms.gateway;
  Json? get face => rooms.face(widget.faceId);

  @override
  void initState() {
    super.initState();
    rooms.addListener(_follow);
    for (final field in [name, bio, tone, avatar, color, role, soul, chat]) {
      field.addListener(_edited);
    }
    _follow();
  }

  @override
  void didUpdateWidget(FacePage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.faceId != widget.faceId) _follow();
  }

  @override
  void dispose() {
    rooms.removeListener(_follow);
    for (final field in [name, bio, tone, avatar, color, role, soul, chat]) {
      field.dispose();
    }
    super.dispose();
  }

  void _edited() {
    if (mounted) setState(() {});
  }

  /// The form follows the face it shows (another face, or a change from elsewhere).
  void _follow() {
    final current = face;
    if (current == null || !mounted) return;
    final stamp = jsonEncode(current);
    if (current['id'] == _shownId && stamp == _shownAt) return;
    final other = current['id'] != _shownId;
    _shownId = '${current['id']}';
    _shownAt = stamp;
    name.text = '${current['name'] ?? ''}';
    bio.text = '${current['bio'] ?? ''}';
    tone.text = '${current['tone'] ?? ''}';
    avatar.text = '${current['avatar'] ?? ''}';
    color.text = '${current['color'] ?? ''}';
    role.text = '${current['roleMd'] ?? ''}';
    final own = obj(current['territory']);
    territory = {
      for (final key in ['rooms', 'workspaces', 'sources'])
        key: [
          for (final id in own[key] is List ? own[key] as List : const [])
            '$id',
        ],
    };
    if (other) {
      saved = false;
      error = null;
      unawaited(_loadActivity(_shownId));
      if (current['isHost'] == true) {
        unawaited(_loadPrompts());
      } else {
        unawaited(_loadChoices());
      }
    }
    setState(() {});
  }

  Future<void> _loadActivity(String id) async {
    activity = null;
    try {
      final loaded = await g.request('/api/faces/${enc(id)}/activity');
      if (mounted && id == _shownId) setState(() => activity = loaded);
    } catch (_) {
      // Shown without it.
    }
  }

  Future<void> _loadChoices() async {
    if (workspaces.isNotEmpty || sources.isNotEmpty) return;
    try {
      final listed = await g.request('/api/workspaces');
      workspaces = rows(listed['workspaces'])
          .where((w) => '${w['id']}'.contains(':') && w['mode'] != 'scratch')
          .toList();
    } catch (_) {}
    try {
      sources = rows((await g.request('/api/sources'))['sources']);
    } catch (_) {}
    if (mounted) setState(() {});
  }

  Future<void> _loadPrompts() async {
    if (prompts != null) return;
    try {
      prompts = obj((await g.request('/api/brain/prompts'))['prompts']);
      soul.text = '${obj(prompts!['soul'])['text'] ?? ''}';
      chat.text = '${obj(prompts!['chat'])['text'] ?? ''}';
      if (mounted) setState(() {});
    } catch (_) {
      // The host's page works without them.
    }
  }

  List<String> _list(Object? value) => [
    for (final id in value is List ? value : const []) '$id',
  ];

  bool get dirty {
    final current = face;
    if (current == null) return false;
    return name.text != '${current['name'] ?? ''}' ||
        bio.text != '${current['bio'] ?? ''}' ||
        tone.text != '${current['tone'] ?? ''}' ||
        avatar.text != '${current['avatar'] ?? ''}' ||
        color.text != '${current['color'] ?? ''}' ||
        role.text != '${current['roleMd'] ?? ''}' ||
        jsonEncode(territory) !=
            jsonEncode({
              for (final key in ['rooms', 'workspaces', 'sources'])
                key: _list(obj(current['territory'])[key]),
            });
  }

  Future<void> _act(Future<void> Function() run) async {
    if (busy) return;
    setState(() {
      busy = true;
      saved = false;
      error = null;
    });
    try {
      await run();
      saved = true;
    } catch (e) {
      error = LiveController.describe(e);
    }
    if (mounted) setState(() => busy = false);
  }

  Future<void> _save() {
    final current = face!;
    final input = <String, dynamic>{
      if (name.text != '${current['name'] ?? ''}') 'name': name.text.trim(),
      if (bio.text != '${current['bio'] ?? ''}') 'bio': bio.text,
      if (tone.text != '${current['tone'] ?? ''}') 'tone': tone.text,
      if (avatar.text != '${current['avatar'] ?? ''}')
        'avatar': avatar.text.trim().isEmpty ? null : avatar.text.trim(),
      if (color.text != '${current['color'] ?? ''}')
        'color': color.text.trim().isEmpty ? null : color.text.trim(),
      if (role.text != '${current['roleMd'] ?? ''}') 'roleMd': role.text,
      if (current['isHost'] != true) 'territory': territory,
    };
    return _act(() => rooms.updateFace(widget.faceId, input));
  }

  Future<void> _savePrompt(String which) => _act(() async {
    final reply = await g.request(
      '/api/brain/prompts/$which',
      method: 'PUT',
      body: {'text': which == 'soul' ? soul.text : chat.text},
    );
    prompts = {...?prompts, which: reply['prompt']};
  });

  /// Rooms another face has: not offered.
  Json? ownerOf(String roomId) => rooms.faces
      .where(
        (other) =>
            other['id'] != widget.faceId &&
            other['isHost'] != true &&
            other['archivedAt'] == null &&
            _list(obj(other['territory'])['rooms']).contains(roomId),
      )
      .firstOrNull;

  void toggle(String key, String id, bool on) => setState(() {
    final list = _list(territory[key])..remove(id);
    territory = {
      ...territory,
      key: on ? [...list, id] : list,
    };
  });

  Widget field(
    TextEditingController controller,
    String label, {
    int lines = 1,
    int? max,
    String? hint,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: TextField(
      controller: controller,
      minLines: lines,
      maxLines: lines == 1 ? 1 : lines + 4,
      maxLength: max,
      decoration: InputDecoration(
        labelText: label,
        hintText: hint,
        border: const OutlineInputBorder(),
        isDense: true,
      ),
    ),
  );

  Widget heading(String text) => Padding(
    padding: const EdgeInsets.fromLTRB(0, 14, 0, 6),
    child: Text(text, style: const TextStyle(fontWeight: FontWeight.w600)),
  );

  @override
  Widget build(BuildContext context) {
    final colors = palette(context);
    final current = face;
    if (current == null) {
      return RoomSidePanel(
        title: 'Face',
        back: true,
        onClose: widget.onBack,
        child: const Center(child: Text('This face is gone.')),
      );
    }
    final host = current['isHost'] == true;
    final archived = current['archivedAt'] != null;
    final muted = TextStyle(fontSize: 12.5, color: colors['text.muted']);
    final topicRooms = [
      ...rooms.rooms,
      ...?rooms.archived,
    ].where((room) => room['kind'] != 'general').toList();
    return RoomSidePanel(
      title: '${current['name']}',
      closeLabel: 'Back to the members',
      back: true,
      onClose: widget.onBack,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
        children: [
          Row(
            children: [
              RoomAvatar(
                name: '${current['name']}',
                avatar: current['avatar'] as String?,
                color: current['color'] as String?,
                size: 40,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  '${archived ? 'Archived' : presenceLabel(rooms.facePresence[widget.faceId])}${host ? ' · the host' : ''}',
                  style: muted,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          field(name, 'Name', max: 40),
          field(bio, 'Who it is', lines: 2, max: 500),
          field(tone, 'How it talks', max: 300),
          Row(
            children: [
              Expanded(
                child: field(avatar, 'Avatar', max: 16, hint: 'An emoji'),
              ),
              const SizedBox(width: 8),
              Expanded(child: field(color, 'Color', hint: '#rrggbb', max: 7)),
            ],
          ),
          field(
            role,
            'What it does',
            lines: 5,
            hint: 'Its instructions, in Markdown',
          ),
          heading('Territory'),
          if (host)
            Text(
              'Answers in #general and in every room no other face has.',
              style: muted,
            )
          else ...[
            Text('Rooms it answers in', style: muted),
            if (topicRooms.isEmpty)
              Text('No rooms besides #general yet.', style: muted),
            for (final room in topicRooms)
              () {
                final id = '${room['id']}';
                final owner = ownerOf(id);
                return CheckboxListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  value: _list(territory['rooms']).contains(id),
                  onChanged: owner != null
                      ? null
                      : (on) => toggle('rooms', id, on == true),
                  title: Text(
                    '#${room['name']}${owner != null ? " · ${owner['name']}'s" : ''}',
                  ),
                );
              }(),
            Text('Workspaces it is about', style: muted),
            if (workspaces.isEmpty) Text('No workspaces.', style: muted),
            for (final workspace in workspaces)
              CheckboxListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                value: _list(
                  territory['workspaces'],
                ).contains('${workspace['id']}'),
                onChanged: (on) =>
                    toggle('workspaces', '${workspace['id']}', on == true),
                title: Text(
                  '${workspace['displayName']} · ${workspace['hostId']}',
                ),
              ),
            Text('Sources it watches', style: muted),
            if (sources.isEmpty) Text('No sources.', style: muted),
            for (final source in sources)
              CheckboxListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                value: _list(territory['sources']).contains('${source['id']}'),
                onChanged: (on) =>
                    toggle('sources', '${source['id']}', on == true),
                title: Text('${source['name']}'),
              ),
          ],
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              FilledButton(
                onPressed: dirty && !busy ? _save : null,
                child: const Text('Save'),
              ),
              if (!host)
                OutlinedButton(
                  onPressed: busy
                      ? null
                      : () => _act(
                          () => rooms.updateFace(widget.faceId, {
                            'archived': !archived,
                          }),
                        ),
                  child: Text(archived ? 'Unarchive' : 'Archive'),
                ),
              if (saved && !dirty)
                Text('Saved; from its next turn.', style: muted),
            ],
          ),
          if (error != null)
            Text(error!, style: TextStyle(color: colors['status.danger'])),
          if (host && prompts != null) ...[
            heading('Who pirc is'),
            for (final (which, file, what, controller) in [
              ('soul', 'SOUL.md', 'Its persona, for every face', soul),
              ('chat', 'CHAT.md', 'House rules for talking', chat),
            ])
              () {
                final prompt = obj(prompts![which]);
                final writable = prompt['writable'] == true;
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('$file · $what', style: muted),
                    const SizedBox(height: 4),
                    TextField(
                      controller: controller,
                      readOnly: !writable,
                      minLines: 4,
                      maxLines: 12,
                      maxLength: (prompt['maxChars'] as num?)?.toInt(),
                      decoration: const InputDecoration(
                        border: OutlineInputBorder(),
                        isDense: true,
                      ),
                    ),
                    if (writable)
                      OutlinedButton(
                        onPressed:
                            busy || controller.text == '${prompt['text']}'
                            ? null
                            : () => _savePrompt(which),
                        child: Text('Save $file'),
                      )
                    else
                      Text(
                        '${switch (prompt['reason']) {
                          'nix-store' => 'Managed by Nix',
                          'symlink' => 'A symlink: change it where it points',
                          _ => 'Not writable',
                        }} (${prompt['path']}).',
                        style: muted,
                      ),
                    const SizedBox(height: 8),
                  ],
                );
              }(),
          ],
          heading('Loops it holds'),
          if (activity == null)
            Text('Loading…', style: muted)
          else if (rows(activity!['loops']).isEmpty)
            Text('None open.', style: muted)
          else
            for (final open in rows(activity!['loops']))
              Text('• ${open['what']}'),
          heading('Lately'),
          if (activity != null &&
              rows(activity!['workers']).isEmpty &&
              rows(activity!['wakes']).isEmpty)
            Text('Nothing yet.', style: muted),
          if (activity != null) ...[
            for (final worker in rows(activity!['workers']))
              Text(
                '• ${worker['title']} · ${workerStatusLabel(worker['status'] as String?)} · ${agoMs(worker['updatedAt'])}',
              ),
            for (final wake in rows(activity!['wakes']))
              Text(
                '• Woke up (${describeTrigger(wake)}) · ${wake['outcome'] ?? 'waiting'} · ${agoMs(wake['createdAt'])}',
              ),
          ],
          if (host && widget.onPreferences != null) ...[
            heading('What it keeps in mind'),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: widget.onPreferences,
                icon: const Icon(LucideIcons.brain, size: 16),
                label: const Text('Preferences'),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
