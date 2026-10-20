import 'gateway.dart';

/// Workspace modes: the gateway's catalog says what a workspace can do. The UI
/// asks these capabilities (`catalog.of(workspace).repository`, …), never mode
/// ids. Mirrors `apps/web/src/lib/modes.ts`.
class ModeInfo {
  const ModeInfo(this.data);
  final Json data;

  String get id => '${data['id'] ?? ''}';
  String get label => '${data['label'] ?? ''}';
  String get description => '${data['description'] ?? ''}';

  /// The noun for one session in this mode ("session", …).
  String get noun {
    final noun = obj(data['ui'])['noun'];
    return noun is String && noun.trim().isNotEmpty ? noun : 'session';
  }

  /// "session" → "Sessions", for tab and section labels.
  String get nounPlural => capitalized('${noun}s');

  /// Each session gets its own node-managed directory.
  bool get perSession => data['workdir'] == 'per-session';

  /// Sessions share the workspace's directory (terminals, a path on creation).
  bool get sharedDirectory => data['workdir'] == 'workspace';
  bool _flag(String key) => data[key] == true;
  bool get delegateTarget => _flag('delegate_target');
  bool get projectConfig => _flag('project_config');
  bool get workspaceMemory => _flag('workspace_memory');
  bool get repository => _flag('repository');
  bool get recap => _flag('recap');

  /// A compact identity of every capability the client reads, so scoped
  /// widgets can reset when a reload changes a workspace's mode.
  String get signature => [
    data['workdir'],
    for (final key in const ['delegate_target', 'project_config', 'repository'])
      _flag(key),
  ].join('|');
}

const _nothing = <String, dynamic>{
  'description': '',
  'delegate_target': false,
  'project_config': false,
  'workspace_memory': false,
  'repository': false,
  'recap': false,
};

/// An older gateway's directory workspace: the default directory mode.
final legacyDirectoryMode = ModeInfo({
  ..._nothing,
  'id': 'directory',
  'label': 'Work',
  'ui': {'noun': 'session'},
  'workdir': 'workspace',
  'delegate_target': true,
  'project_config': true,
  'workspace_memory': true,
  'repository': true,
  'recap': true,
});

/// A workspace whose mode is missing from the catalog: its history stays
/// readable, but it offers nothing else and takes no new sessions.
final unavailableMode = ModeInfo({
  ..._nothing,
  'id': '',
  'label': 'Unavailable',
  'ui': {'noun': 'session'},
  'workdir': 'per-session',
});

/// "session" → "Session".
String capitalized(String noun) =>
    noun.isEmpty ? noun : noun[0].toUpperCase() + noun.substring(1);

/// Mode missing from the catalog: read-only, no new sessions.
bool isReadOnly(Json? workspace) => workspace?['available'] == false;

/// The gateway's validated mode catalog (`GET /api/modes`). Empty with an
/// older gateway, in which case every lookup falls back to the directory mode.
class ModeCatalog {
  ModeCatalog([List<Json> modes = const []])
    : modes = List.unmodifiable(modes.map(ModeInfo.new)),
      _byId = {for (final mode in modes) '${mode['id']}': ModeInfo(mode)};

  final List<ModeInfo> modes;
  final Map<String, ModeInfo> _byId;
  bool get isEmpty => modes.isEmpty;
  ModeInfo? byId(String id) => _byId[id];

  /// The workspace's mode, or the default directory mode without a catalog
  /// entry.
  ModeInfo of(Json workspace) {
    if (isReadOnly(workspace)) return unavailableMode;
    final id = workspace['mode'];
    final found = id is String ? _byId[id] : null;
    return found ?? legacyDirectoryMode;
  }

  /// The modes a new workspace on [node] can have: the node's accepted modes
  /// the catalog knows. Empty with an older gateway: a path makes a directory.
  List<ModeInfo> creatable(Json? node) {
    final accepted = node?['modes'];
    if (accepted is! List || isEmpty) return const [];
    final ids = accepted.map((id) => '$id').toSet();
    return modes.where((m) => ids.contains(m.id)).toList();
  }

  /// Nodes that can host workspaces: those accepting a mode the catalog
  /// knows. Without node modes (an older gateway), every node.
  List<Json> workNodes(List<Json> nodes) => nodes
      .where(
        (node) =>
            node['modes'] is! List || isEmpty || creatable(node).isNotEmpty,
      )
      .toList();
}
