import 'gateway.dart';
import 'modes.dart';

bool isWorking(Json s) =>
    const ['running', 'queued', 'stopping'].contains(s['runStatus']);
bool isWaiting(Json s) => s['runStatus'] == 'waiting_input';
bool isPinned(Json s) => s['pinnedAt'] != null;
bool isDone(Json s) => s['settledAt'] != null;
bool workspaceOnline(Json w, List<Json> nodes) =>
    !'${w['id']}'.contains(':') || nodes.any((n) => n['id'] == w['hostId']);

// The gateway already orders by activity. A stable partition preserves that order.
List<Json> pinnedFirst(Iterable<Json> sessions) => [
  ...sessions.where(isPinned),
  ...sessions.where((s) => !isPinned(s)),
];
List<Json> sidebarSessions(
  List<Json> sessions,
  String workspaceId,
  String? activeId, {
  bool skipWaiting = false,
}) => pinnedFirst(
  sessions.where(
    (s) =>
        s['workspaceId'] == workspaceId &&
        (s['id'] == activeId ||
            (s['unread'] == true && !(skipWaiting && isWaiting(s)))),
  ),
);

/// The Work tab: every workspace (including per-session and unavailable ones)
/// grouped by host, plus nodes that can host workspaces.
List<Json> workHosts(
  List<Json> workspaces,
  List<Json> nodes,
  ModeCatalog catalog,
) {
  final ids = <String>{
    ...workspaces.map((w) => '${w['hostId']}'),
    ...catalog.workNodes(nodes).map((n) => '${n['id']}'),
  }.toList();
  bool online(String id) => nodes.any((n) => n['id'] == id);
  ids.sort(
    (a, b) => online(a) == online(b)
        ? a.compareTo(b)
        : online(a)
        ? -1
        : 1,
  );
  return [
    for (final id in ids)
      {
        'id': id,
        'online': online(id),
        'workspaces': workspaces.where((w) => w['hostId'] == id).toList(),
      },
  ];
}

String shortAgo(dynamic updatedAt, {DateTime? now}) {
  final date = updatedAt is num
      ? DateTime.fromMillisecondsSinceEpoch(updatedAt.toInt())
      : DateTime.tryParse('$updatedAt');
  if (date == null) return '';
  final secs = (now ?? DateTime.now()).difference(date).inSeconds;
  return secs < 60
      ? 'now'
      : secs < 3600
      ? '${secs ~/ 60}m'
      : secs < 86400
      ? '${secs ~/ 3600}h'
      : '${secs ~/ 86400}d';
}
