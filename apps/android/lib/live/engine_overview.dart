import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../theme.dart';
import 'common.dart';
import 'gateway.dart';

/// The engine's sections, in tab order (the web's `?open=` names).
const engineSections = [
  'nodes',
  'brain',
  'loops',
  'wakes',
  'memory',
  'sources',
];

const _sectionLabels = {
  'nodes': 'Nodes',
  'brain': 'Brain',
  'loops': 'Open loops',
  'wakes': 'Wakes',
  'memory': 'Memory',
  'sources': 'Sources',
};

/// `5 min ago`, `3 h ago`, `2 d ago`.
String agoMs(Object? at, {int Function()? clock}) {
  if (at is! num) return '';
  final now = (clock ?? () => DateTime.now().millisecondsSinceEpoch)();
  final minutes = ((now - at) / 60000).round();
  if (minutes < 1) return 'just now';
  if (minutes < 60) return '$minutes min ago';
  final hours = (minutes / 60).round();
  if (hours < 48) return '$hours h ago';
  return '${(hours / 24).round()} d ago';
}

/// `Wed 18:00`, in the phone's time (with the date when not within a week).
String whenMs(Object? at, {int Function()? clock}) {
  if (at is! num) return '';
  final now = DateTime.fromMillisecondsSinceEpoch(
    (clock ?? () => DateTime.now().millisecondsSinceEpoch)(),
  );
  final time = DateTime.fromMillisecondsSinceEpoch(at.toInt());
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  String two(int value) => value.toString().padLeft(2, '0');
  final soon = time.difference(now).inDays.abs() < 6;
  final date = soon
      ? days[time.weekday - 1]
      : '${days[time.weekday - 1]} ${months[time.month - 1]} ${time.day}';
  return '$date ${two(time.hour)}:${two(time.minute)}';
}

/// "1.2k tokens".
String tokens(Object? count) {
  final value = count is num ? count.toInt() : 0;
  if (value == 0) return '0 tokens';
  return value >= 1000
      ? '${(value / 1000).toStringAsFixed(1)}k tokens'
      : '$value tokens';
}

/// What became of a brain turn, in words.
String turnOutcome(Json turn) => switch (turn['outcome']) {
  null => 'Running',
  'done' => 'Done',
  'failed' => 'Failed',
  'aborted' => 'Stopped',
  'timeout' => 'Timed out',
  'preempted' => 'Cut short by new messages',
  final other => '$other',
};

/// What woke (or will wake) pirc, for people.
String describeTrigger(Json wake) {
  final trigger = obj(wake['trigger']);
  if (wake['kind'] == 'self') {
    return 'Coming back to look at: ${trigger['why'] ?? ''}';
  }
  if (wake['kind'] == 'anchor') {
    return switch (trigger['moment']) {
      'eve' => 'The day before an open loop is due',
      'next' => 'A recurring open loop came round',
      _ => "An open loop's time came",
    };
  }
  final name = trigger['name'] ?? trigger['sourceId'];
  if (name == null) return 'A source changed';
  return trigger['reason'] == 'loop'
      ? 'Something new in $name touched an open loop'
      : 'Something new in $name';
}

/// How a wake went, or when it comes.
String describeWakeOutcome(Json wake, {int Function()? clock}) {
  final note = wake['note'];
  return switch (wake['outcome']) {
    null =>
      wake['startedAt'] != null
          ? 'Awake now'
          : 'At ${whenMs(wake['scheduledAt'], clock: clock)}',
    'spoke' => 'Said something in the room',
    'silent' => note != null ? 'Nothing to say ($note)' : 'Nothing to say',
    'preempted' => 'Someone spoke first; it came back after',
    'failed' => note != null ? 'Failed: $note' : 'Failed',
    'quota' => "Skipped: today's wakes were used up",
    'cancelled' => 'Cancelled',
    final other => '$other',
  };
}

/// A source's health: paused, failing, or fine.
String sourceHealth(Json source) {
  if (source['pausedAt'] != null) return 'Paused';
  final failures = (source['failures'] as num?)?.toInt() ?? 0;
  if (failures > 0) return 'Failing ($failures in a row)';
  return 'Fine';
}

/// The engine's front page (the web's `EngineOverview.svelte`): what runs
/// behind the rooms, in six tabs — the nodes, the brain's turns, the open
/// loops, the wakes, the memory and the sources (decision 3). [section]
/// opens one (the web's `?open=`).
class EngineOverview extends StatefulWidget {
  const EngineOverview({
    super.key,
    required this.gateway,
    this.section = 'nodes',
    this.roomId,
    this.loopsRevision,
    this.wakesRevision,
    this.clock,
  });
  final Gateway gateway;
  final String section;

  /// The room whose brain turns show first.
  final String? roomId;

  /// Bumped when an open loop or a wake changes (the room stream says so).
  final ValueListenable<int>? loopsRevision, wakesRevision;
  final int Function()? clock;

  @override
  State<EngineOverview> createState() => _EngineOverviewState();
}

class _EngineOverviewState extends State<EngineOverview>
    with SingleTickerProviderStateMixin {
  late final TabController tabs = TabController(
    length: engineSections.length,
    vsync: this,
    initialIndex: engineSections.contains(widget.section)
        ? engineSections.indexOf(widget.section)
        : 0,
  );

  /// Room names by id, for lists that name rooms.
  Map<String, String> roomNames = {};
  List<Json> rooms = [];

  @override
  void initState() {
    super.initState();
    unawaited(_loadRooms());
  }

  Future<void> _loadRooms() async {
    try {
      final reply = await widget.gateway.request('/api/rooms?archived=1');
      if (!mounted) return;
      setState(() {
        rooms = rows(reply['rooms']);
        roomNames = {
          for (final room in rooms) '${room['id']}': '${room['name']}',
        };
      });
    } catch (_) {
      // Ids stand in for names.
    }
  }

  String roomName(Object? id) => '#${roomNames['$id'] ?? id ?? 'a room'}';

  @override
  void dispose() {
    tabs.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('Engine'),
      bottom: TabBar(
        controller: tabs,
        isScrollable: true,
        tabAlignment: TabAlignment.start,
        tabs: [
          for (final section in engineSections)
            Tab(text: _sectionLabels[section]),
        ],
      ),
    ),
    body: TabBarView(
      controller: tabs,
      children: [
        _NodesPage(gateway: widget.gateway, clock: widget.clock),
        _BrainPage(
          gateway: widget.gateway,
          rooms: rooms,
          roomId: widget.roomId,
          roomName: roomName,
        ),
        _LoopsPage(
          gateway: widget.gateway,
          revision: widget.loopsRevision,
          roomName: roomName,
          clock: widget.clock,
        ),
        _WakesPage(
          gateway: widget.gateway,
          revision: widget.wakesRevision,
          roomName: roomName,
          clock: widget.clock,
        ),
        _MemoryPage(gateway: widget.gateway, roomName: roomName),
        _SourcesPage(
          gateway: widget.gateway,
          roomName: roomName,
          clock: widget.clock,
        ),
      ],
    ),
  );
}

/// One page of the engine: loads, shows a failure, reloads on a pull.
abstract class _LoadingPage extends StatefulWidget {
  const _LoadingPage({required this.gateway, this.revision});
  final Gateway gateway;
  final ValueListenable<int>? revision;
}

abstract class _LoadingPageState<T extends _LoadingPage> extends State<T>
    with AutomaticKeepAliveClientMixin {
  bool loading = true, busy = false;
  String? error;

  Future<void> fetch();

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    widget.revision?.addListener(_reload);
    unawaited(load());
  }

  @override
  void dispose() {
    widget.revision?.removeListener(_reload);
    super.dispose();
  }

  void _reload() => unawaited(load());

  Future<void> load() async {
    try {
      await fetch();
      error = null;
    } catch (e) {
      error = LiveController.describe(e);
    }
    if (mounted) setState(() => loading = false);
  }

  /// One change: busy while it runs, then everything is read again.
  Future<void> act(Future<void> Function() change) async {
    if (busy) return;
    setState(() => busy = true);
    try {
      await change();
      await fetch();
      error = null;
    } catch (e) {
      error = LiveController.describe(e);
    }
    if (mounted) setState(() => busy = false);
  }

  /// The page's contents, under its intro, failure and loading state.
  List<Widget> contents(PircColors colors);
  String get intro;

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final colors = palette(context);
    return RefreshIndicator(
      onRefresh: load,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
        children: [
          if (intro.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Text(
                intro,
                style: TextStyle(color: colors['text.secondary'], height: 1.4),
              ),
            ),
          if (error != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(
                error!,
                style: TextStyle(color: colors['status.danger']),
              ),
            ),
          if (loading)
            const Padding(
              padding: EdgeInsets.all(24),
              child: Center(child: CircularProgressIndicator()),
            )
          else
            ...contents(colors),
        ],
      ),
    );
  }
}

/// One item of a list: a title, lines under it, and an action at the side.
Widget engineItem(
  PircColors colors,
  String title,
  List<String> lines, {
  Widget? action,
  Color? dot,
}) => Container(
  margin: const EdgeInsets.only(bottom: 8),
  padding: const EdgeInsets.all(12),
  decoration: BoxDecoration(
    color: colors['surface.subtle'],
    borderRadius: BorderRadius.circular(10),
  ),
  child: Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      if (dot != null)
        Padding(
          padding: const EdgeInsets.only(top: 6, right: 8),
          child: Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(color: dot, shape: BoxShape.circle),
          ),
        ),
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              title,
              style: TextStyle(
                fontWeight: FontWeight.w500,
                color: colors['text.primary'],
              ),
            ),
            for (final line in lines.where((line) => line.isNotEmpty))
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(
                  line,
                  style: TextStyle(fontSize: 12.5, color: colors['text.muted']),
                ),
              ),
          ],
        ),
      ),
      ?action,
    ],
  ),
);

Widget _heading(PircColors colors, String text) => Padding(
  padding: const EdgeInsets.fromLTRB(0, 12, 0, 8),
  child: Text(
    text,
    style: TextStyle(
      fontWeight: FontWeight.w600,
      color: colors['text.primary'],
    ),
  ),
);

Widget _none(PircColors colors, String text) =>
    Text(text, style: TextStyle(color: colors['text.muted']));

// ---- Nodes ----

class _NodesPage extends _LoadingPage {
  const _NodesPage({required super.gateway, this.clock});
  final int Function()? clock;
  @override
  State<_NodesPage> createState() => _NodesPageState();
}

class _NodesPageState extends _LoadingPageState<_NodesPage> {
  List<Json> nodes = [];

  @override
  String get intro =>
      'The machines pirc works on: what each can do and how busy it is.';

  @override
  Future<void> fetch() async =>
      nodes = rows((await widget.gateway.request('/api/nodes'))['nodes']);

  @override
  List<Widget> contents(PircColors colors) => [
    if (nodes.isEmpty) _none(colors, 'No node is connected.'),
    for (final node in nodes)
      () {
        final caps = node['capabilities'] is Map
            ? obj(node['capabilities'])
            : null;
        final load = obj(node['load']);
        final gpus = rows(caps?['gpus']);
        final sandbox = obj(caps?['sandbox']);
        return engineItem(colors, '${node['id']}', [
          'Last seen ${agoMs(node['lastSeenAt'], clock: widget.clock)}',
          if (caps != null) '${caps['os']} · ${caps['arch']}',
          if (gpus.isNotEmpty)
            'GPU: ${gpus.map((gpu) => ['${gpu['vendor']}', if ((gpu['count'] as num? ?? 1) > 1) '×${gpu['count']}', if (gpu['model'] != null && gpu['model'] != '') '${gpu['model']}', if (gpu['vramMb'] != null) '${((gpu['vramMb'] as num) / 1024).round()} GB'].join(' ')).join(', ')}'
          else if (caps != null)
            'No GPU',
          if (load.isNotEmpty)
            'Running ${load['running']}${load['max'] != null ? ' of ${load['max']}' : ''}',
          if (sandbox.isNotEmpty)
            'Sandbox: ${sandbox['backend']} (${sandbox['status']})',
          if (caps != null)
            [
              if (caps['browser'] == true) 'browser',
              if (caps['terminals'] == true) 'terminals',
            ].join(' · '),
          'Workspaces: ${rows(node['workspaces']).map((w) => w['displayName']).join(', ').ifEmpty('none')}',
        ]);
      }(),
  ];
}

// ---- Brain turns ----

class _BrainPage extends _LoadingPage {
  const _BrainPage({
    required super.gateway,
    required this.rooms,
    this.roomId,
    required this.roomName,
  });
  final List<Json> rooms;
  final String? roomId;
  final String Function(Object?) roomName;
  @override
  State<_BrainPage> createState() => _BrainPageState();
}

class _BrainPageState extends _LoadingPageState<_BrainPage> {
  late String room = widget.roomId ?? 'general';
  List<Json> turns = [];

  @override
  String get intro =>
      "The brain's latest turns in a room: why it spoke, how it ended, what it cost.";

  @override
  Future<void> fetch() async => turns = rows(
    (await widget.gateway.request(
      '/api/brain/turns?room=${enc(room)}&limit=20',
    ))['turns'],
  );

  @override
  List<Widget> contents(PircColors colors) => [
    if (widget.rooms.isNotEmpty)
      DropdownButton<String>(
        value: widget.rooms.any((r) => r['id'] == room) ? room : null,
        hint: Text(widget.roomName(room)),
        isExpanded: true,
        items: [
          for (final r in widget.rooms)
            DropdownMenuItem(value: '${r['id']}', child: Text('#${r['name']}')),
        ],
        onChanged: (value) {
          if (value == null) return;
          setState(() {
            room = value;
            loading = true;
          });
          unawaited(load());
        },
      ),
    const SizedBox(height: 8),
    if (turns.isEmpty)
      _none(colors, 'No turns in ${widget.roomName(room)} yet.'),
    for (final turn in turns)
      () {
        final usage = obj(turn['usage']);
        final total =
            usage['totalTokens'] ??
            ((usage['input'] as num? ?? 0) + (usage['output'] as num? ?? 0));
        final started = turn['startedAt'] as num?;
        final ended = turn['endedAt'] as num?;
        return engineItem(
          colors,
          turn['kind'] == 'wake'
              ? 'Came back on its own'
              : turn['kind'] == 'report'
              ? 'A worker ended'
              : 'People spoke',
          [
            '${turnOutcome(turn)} · ${agoMs(started)}'
                '${started != null && ended != null ? ' · ${((ended - started) / 1000).toStringAsFixed(1)} s' : ''}'
                ' · ${tokens(total)}',
            if (turn['error'] != null) '${turn['error']}',
          ],
          dot:
              colors[switch (turn['outcome']) {
                null => 'accent.default',
                'done' => 'status.success',
                'failed' || 'timeout' => 'status.danger',
                _ => 'text.muted',
              }],
        );
      }(),
  ];
}

// ---- Open loops ----

class _LoopsPage extends _LoadingPage {
  const _LoopsPage({
    required super.gateway,
    super.revision,
    required this.roomName,
    this.clock,
  });
  final String Function(Object?) roomName;
  final int Function()? clock;
  @override
  State<_LoopsPage> createState() => _LoopsPageState();
}

class _LoopsPageState extends _LoadingPageState<_LoopsPage> {
  List<Json> open = [], closed = [];

  @override
  String get intro =>
      'What is still open between pirc and you: always on its mind until it is resolved. '
      'pirc opens and closes them on its own and says so in the room.';

  @override
  Future<void> fetch() async {
    final results = await Future.wait([
      widget.gateway.request('/api/loops?status=open'),
      widget.gateway.request('/api/loops?status=closed&limit=20'),
    ]);
    open = rows(results[0]['loops']);
    closed = rows(results[1]['loops']);
  }

  Future<void> _set(Json loop, String status) => act(() async {
    await widget.gateway.request(
      '/api/loops/${enc('${loop['id']}')}',
      method: 'PATCH',
      body: {'status': status},
    );
  });

  @override
  List<Widget> contents(PircColors colors) => [
    if (open.isEmpty)
      _none(
        colors,
        'Nothing open. Ask pirc to remind you of something, or tell it what is still unresolved.',
      ),
    for (final loop in open)
      engineItem(
        colors,
        '${loop['what']}',
        [
          if (loop['dueAt'] != null)
            'Next: ${whenMs(loop['dueAt'], clock: widget.clock)}',
          if (obj(loop['anchor'])['cron'] != null)
            'repeats (${obj(loop['anchor'])['cron']})',
          [
            if ('${loop['why'] ?? ''}'.isNotEmpty) '${loop['why']}',
            if (loop['roomId'] != null) widget.roomName(loop['roomId']),
          ].join(' · '),
        ],
        action: TextButton(
          onPressed: busy ? null : () => _set(loop, 'closed'),
          child: const Text('Not needed'),
        ),
      ),
    if (closed.isNotEmpty) ...[
      _heading(colors, 'Recently closed · ${closed.length}'),
      for (final loop in closed)
        engineItem(
          colors,
          '${loop['what']}',
          [
            [
              if (loop['closedReason'] != null) '${loop['closedReason']}',
              if (loop['closedAt'] != null)
                agoMs(loop['closedAt'], clock: widget.clock),
            ].join(' · '),
          ],
          action: TextButton(
            onPressed: busy ? null : () => _set(loop, 'open'),
            child: const Text('Not done yet'),
          ),
        ),
    ],
  ];
}

// ---- Wakes ----

class _WakesPage extends _LoadingPage {
  const _WakesPage({
    required super.gateway,
    super.revision,
    required this.roomName,
    this.clock,
  });
  final String Function(Object?) roomName;
  final int Function()? clock;
  @override
  State<_WakesPage> createState() => _WakesPageState();
}

class _WakesPageState extends _LoadingPageState<_WakesPage> {
  List<Json> wakes = [];
  Json today = {};

  @override
  String get intro =>
      "pirc wakes up on its own when an open loop's time comes, the day before a deadline, or when it said it would come back to something. "
      'Awake, it only reads and remembers; it speaks in the room only when something is worth saying.';

  @override
  Future<void> fetch() async {
    final reply = await widget.gateway.request(
      '/api/wakes?status=all&limit=40',
    );
    wakes = rows(reply['wakes']);
    today = obj(reply['today']);
  }

  @override
  List<Widget> contents(PircColors colors) {
    final coming = wakes.where((wake) => wake['outcome'] == null).toList();
    final ended = wakes.where((wake) => wake['outcome'] != null).toList();
    return [
      if (today.isNotEmpty)
        Text(
          'Today: ${today['used']} of ${today['limit']}',
          style: TextStyle(color: colors['text.secondary']),
        ),
      const SizedBox(height: 8),
      if (coming.isEmpty)
        _none(
          colors,
          'Nothing coming. pirc wakes for open loops with a time, and when it says it will come back.',
        ),
      for (final wake in coming)
        engineItem(
          colors,
          describeTrigger(wake),
          [
            '${describeWakeOutcome(wake, clock: widget.clock)} · ${widget.roomName(wake['roomId'])}',
          ],
          action: wake['startedAt'] == null
              ? TextButton(
                  onPressed: busy
                      ? null
                      : () => act(() async {
                          await widget.gateway.request(
                            '/api/wakes/${enc('${wake['id']}')}',
                            method: 'DELETE',
                          );
                        }),
                  child: const Text('Cancel'),
                )
              : null,
        ),
      if (ended.isNotEmpty) ...[
        _heading(colors, 'Recent wakes · ${ended.length}'),
        for (final wake in ended)
          engineItem(colors, describeTrigger(wake), [
            '${describeWakeOutcome(wake, clock: widget.clock)} · ${widget.roomName(wake['roomId'])} · ${agoMs(wake['endedAt'] ?? wake['scheduledAt'], clock: widget.clock)}',
          ]),
      ],
    ];
  }
}

// ---- Memory ----

class _MemoryPage extends _LoadingPage {
  const _MemoryPage({required super.gateway, required this.roomName});
  final String Function(Object?) roomName;
  @override
  State<_MemoryPage> createState() => _MemoryPageState();
}

class _MemoryPageState extends _LoadingPageState<_MemoryPage> {
  Json view = {};
  List<Json> records = [];
  String scope = 'person';
  final search = TextEditingController();
  Timer? _searching;

  @override
  String get intro =>
      'Preferences are always on its mind and change only on your word; facts are found again when they matter.';

  @override
  void dispose() {
    _searching?.cancel();
    search.dispose();
    super.dispose();
  }

  String get _recordsPath {
    final q = search.text.trim();
    return '/api/memory/records?scope=$scope${q.isEmpty ? '' : '&q=${enc(q)}'}';
  }

  @override
  Future<void> fetch() async {
    final results = await Future.wait([
      widget.gateway.request('/api/memory/preferences'),
      widget.gateway.request(_recordsPath),
    ]);
    view = results[0];
    records = rows(results[1]['records']);
  }

  Future<void> _records() async {
    try {
      final reply = await widget.gateway.request(_recordsPath);
      if (mounted) setState(() => records = rows(reply['records']));
    } catch (e) {
      if (mounted) setState(() => error = LiveController.describe(e));
    }
  }

  Future<void> _change(Json preference, String op) => act(() async {
    await widget.gateway.request(
      '/api/memory/preferences/${enc('${preference['id']}')}/$op',
      method: 'POST',
      body: {},
    );
  });

  Future<void> _history(Json preference) async {
    final reply = await widget.gateway.request(
      '/api/memory/preferences/${enc('${preference['id']}')}/history',
    );
    if (!mounted) return;
    final versions = rows(reply['versions']);
    final revision = await showModalBottomSheet<int>(
      context: context,
      useSafeArea: true,
      isScrollControlled: true,
      builder: (context) => ListView(
        shrinkWrap: true,
        children: [
          const ListTile(
            title: Text(
              'History',
              style: TextStyle(fontWeight: FontWeight.w600),
            ),
          ),
          for (final version in versions.reversed)
            ListTile(
              title: Text('${version['content'] ?? '(removed)'}'),
              subtitle: Text(
                '${version['op']} · revision ${version['revision']} · ${agoMs(version['at'])}',
              ),
              trailing:
                  version['content'] != null &&
                      version['revision'] != preference['revision']
                  ? TextButton(
                      onPressed: () => Navigator.pop(
                        context,
                        (version['revision'] as num).toInt(),
                      ),
                      child: const Text('Restore'),
                    )
                  : null,
            ),
        ],
      ),
    );
    if (revision == null) return;
    await act(() async {
      await widget.gateway.request(
        '/api/memory/preferences/${enc('${preference['id']}')}/restore',
        method: 'POST',
        body: {'revision': revision},
      );
    });
  }

  @override
  List<Widget> contents(PircColors colors) {
    final usage = obj(view['usage']);
    final preferences = rows(view['preferences']);
    final removed = rows(view['removed']);
    return [
      _heading(
        colors,
        'Preferences${usage.isNotEmpty ? ' · ${usage['used']} of ${usage['max']} characters' : ''}',
      ),
      if (preferences.isEmpty)
        _none(colors, 'None yet. Tell pirc how you like things done.'),
      for (final preference in preferences)
        engineItem(
          colors,
          '${preference['content']}',
          [
            if (preference['createdInRoom'] != null)
              'Said in ${widget.roomName(preference['createdInRoom'])}',
          ],
          action: PopupMenuButton<String>(
            tooltip: 'Preference actions',
            enabled: !busy,
            onSelected: (op) => op == 'history'
                ? unawaited(_history(preference))
                : unawaited(_change(preference, op)),
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'remove', child: Text('Remove')),
              PopupMenuItem(value: 'forget', child: Text('Forget')),
              PopupMenuItem(value: 'history', child: Text('History')),
            ],
          ),
        ),
      if (removed.isNotEmpty) ...[
        _heading(colors, 'Removed · ${removed.length}'),
        for (final preference in removed)
          engineItem(
            colors,
            '${preference['content']}',
            const [],
            action: TextButton(
              onPressed: busy ? null : () => _change(preference, 'restore'),
              child: const Text('Restore'),
            ),
          ),
      ],
      _heading(colors, 'Facts'),
      TextField(
        controller: search,
        decoration: const InputDecoration(
          hintText: 'Search what pirc knows',
          prefixIcon: Icon(LucideIcons.search, size: 18),
          isDense: true,
        ),
        onChanged: (_) {
          _searching?.cancel();
          _searching = Timer(
            const Duration(milliseconds: 300),
            () => unawaited(_records()),
          );
        },
      ),
      const SizedBox(height: 8),
      Wrap(
        spacing: 6,
        children: [
          for (final (value, label) in [
            ('person', 'Household'),
            ('repo', 'Workspaces'),
            ('all', 'All'),
          ])
            ChoiceChip(
              label: Text(label),
              selected: scope == value,
              onSelected: (_) {
                setState(() => scope = value);
                unawaited(_records());
              },
            ),
        ],
      ),
      const SizedBox(height: 8),
      if (records.isEmpty)
        _none(
          colors,
          search.text.trim().isEmpty ? 'No facts yet.' : 'Nothing matches.',
        ),
      for (final record in records)
        engineItem(
          colors,
          '${record['content']}',
          [
            [
              '${record['date'] ?? ''}',
              if (record['workspace'] != null) '${record['workspace']}',
              if (record['roomId'] != null) widget.roomName(record['roomId']),
            ].where((part) => part.isNotEmpty).join(' · '),
          ],
          action: record['kind'] == 'fact'
              ? TextButton(
                  onPressed: busy
                      ? null
                      : () => act(() async {
                          await widget.gateway.request(
                            '/api/memory/records/${enc('${record['id']}')}',
                            method: 'DELETE',
                          );
                        }),
                  child: const Text('Forget'),
                )
              : null,
        ),
    ];
  }
}

// ---- Sources ----

class _SourcesPage extends _LoadingPage {
  const _SourcesPage({
    required super.gateway,
    required this.roomName,
    this.clock,
  });
  final String Function(Object?) roomName;
  final int Function()? clock;
  @override
  State<_SourcesPage> createState() => _SourcesPageState();
}

class _SourcesPageState extends _LoadingPageState<_SourcesPage> {
  List<Json> sources = [];

  @override
  String get intro =>
      'What pirc reads beyond the rooms, and how reading it goes. Add sources in Settings.';

  @override
  Future<void> fetch() async =>
      sources = rows((await widget.gateway.request('/api/sources'))['sources']);

  @override
  List<Widget> contents(PircColors colors) => [
    if (sources.isEmpty)
      _none(
        colors,
        'No sources yet. Add mail, calendars or Moodle in Settings.',
      ),
    for (final source in sources)
      () {
        final health = sourceHealth(source);
        final followed = [
          for (final id
              in source['rooms'] is List ? source['rooms'] as List : const [])
            widget.roomName(id),
        ];
        final paused = source['pausedAt'] != null;
        return engineItem(
          colors,
          '${source['name']} · ${source['kind']}',
          [
            health,
            '${source['lastPolledAt'] != null ? 'Read ${agoMs(source['lastPolledAt'], clock: widget.clock)}' : 'Not read yet'}'
                ' · ${followed.isEmpty ? 'no room follows it' : 'followed in ${followed.join(', ')}'}',
            if (source['lastError'] != null &&
                ((source['failures'] as num?) ?? 0) > 0)
              '${source['lastError']}',
          ],
          dot:
              colors[paused
                  ? 'text.muted'
                  : health == 'Fine'
                  ? 'status.success'
                  : 'status.danger'],
          action: TextButton(
            onPressed: busy
                ? null
                : () => act(() async {
                    await widget.gateway.request(
                      '/api/sources/${enc('${source['id']}')}/${paused ? 'resume' : 'pause'}',
                      method: 'POST',
                      body: {},
                    );
                  }),
            child: Text(paused ? 'Resume' : 'Pause'),
          ),
        );
      }(),
  ];
}

extension on String {
  String ifEmpty(String fallback) => isEmpty ? fallback : this;
}
