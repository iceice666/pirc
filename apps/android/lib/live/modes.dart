import 'gateway.dart';

/// Workspace modes: the gateway's catalog says what a workspace can do. The UI
/// asks these capabilities (`catalog.of(workspace).repository`, …), never mode
/// ids; the legacy `kind` is read only when the catalog lacks the workspace's
/// mode (an older gateway). Mirrors `apps/web/src/lib/modes.ts`.
class ModeInfo {
  const ModeInfo(this.data);
  final Json data;

  String get id => '${data['id'] ?? ''}';
  String get label => '${data['label'] ?? ''}';
  String get description => '${data['description'] ?? ''}';

  /// The noun for one session in this mode ("chat", "session", …).
  String get noun {
    final noun = obj(data['ui'])['noun'];
    return noun is String && noun.trim().isNotEmpty ? noun : 'session';
  }

  /// "chat" → "Chats", for tab and section labels.
  String get nounPlural => capitalized('${noun}s');

  /// The personal assistant's modes (chats and projects): no Work chrome.
  bool get assistant => data['assistant'] == 'full';

  /// Each session gets its own node-managed directory.
  bool get perSession => data['workdir'] == 'per-session';

  /// Sessions share the workspace's directory (terminals, a path on creation).
  bool get sharedDirectory => data['workdir'] == 'workspace';
  bool _flag(String key) => data[key] == true;
  bool get delegate => _flag('delegate');
  bool get delegateTarget => _flag('delegate_target');
  bool get projectInstructions => _flag('project_instructions');
  bool get projectFiles => _flag('project_files');
  bool get projectConfig => _flag('project_config');
  bool get workspaceMemory => _flag('workspace_memory');
  bool get repository => _flag('repository');
  bool get recap => _flag('recap');
  bool get deleteSessions => _flag('delete_sessions');
  bool get projects => _flag('projects');

  /// A compact identity of every capability the client reads, so scoped
  /// widgets can reset when a reload changes a workspace's mode.
  String get signature => [
    data['assistant'],
    data['workdir'],
    for (final key in const [
      'delegate_target',
      'project_instructions',
      'project_files',
      'project_config',
      'repository',
      'delete_sessions',
      'projects',
    ])
      _flag(key),
  ].join('|');
}

const _nothing = <String, dynamic>{
  'description': '',
  'delegate': false,
  'delegate_target': false,
  'schedule_scope': 'own',
  'project_instructions': false,
  'project_files': false,
  'project_config': false,
  'workspace_memory': false,
  'repository': false,
  'recap': false,
  'delete_sessions': false,
  'projects': false,
};

/// An older gateway's `kind: chat` workspace: the default chat mode.
final legacyChatMode = ModeInfo({
  ..._nothing,
  'id': 'chat',
  'label': 'Chat',
  'ui': {'noun': 'chat'},
  'workdir': 'per-session',
  'assistant': 'full',
  'delegate': true,
  'schedule_scope': 'any',
  'project_instructions': true,
  'project_files': true,
  'delete_sessions': true,
  'projects': true,
});

/// An older gateway's directory workspace: the default directory mode.
final legacyDirectoryMode = ModeInfo({
  ..._nothing,
  'id': 'directory',
  'label': 'Work',
  'ui': {'noun': 'session'},
  'workdir': 'workspace',
  'assistant': 'user',
  'delegate_target': true,
  'project_config': true,
  'workspace_memory': true,
  'repository': true,
  'recap': true,
});

/// A workspace whose mode is missing from the catalog: its history stays
/// readable under Work, but it offers nothing else and takes no new sessions.
final unavailableMode = ModeInfo({
  ..._nothing,
  'id': '',
  'label': 'Unavailable',
  'ui': {'noun': 'session'},
  'workdir': 'per-session',
  'assistant': 'user',
});

/// "chat" → "Chat".
String capitalized(String noun) =>
    noun.isEmpty ? noun : noun[0].toUpperCase() + noun.substring(1);

/// Mode missing from the catalog: read-only, no new sessions.
bool isReadOnly(Json? workspace) => workspace?['available'] == false;

/// The gateway's validated mode catalog (`GET /api/modes`). Empty with an
/// older gateway, in which case every lookup falls back to the legacy `kind`.
class ModeCatalog {
  ModeCatalog([List<Json> modes = const []])
    : modes = List.unmodifiable(modes.map(ModeInfo.new)),
      _byId = {for (final mode in modes) '${mode['id']}': ModeInfo(mode)};

  final List<ModeInfo> modes;
  final Map<String, ModeInfo> _byId;
  bool get isEmpty => modes.isEmpty;
  ModeInfo? byId(String id) => _byId[id];

  /// The workspace's mode, or what its legacy `kind` implies without a
  /// catalog entry.
  ModeInfo of(Json workspace) {
    if (isReadOnly(workspace)) return unavailableMode;
    final id = workspace['mode'];
    final found = id is String ? _byId[id] : null;
    if (found != null) return found;
    return workspace['kind'] == 'chat' ? legacyChatMode : legacyDirectoryMode;
  }

  /// A workspace is in the Chat tab iff its mode is the assistant's.
  bool assistant(Json workspace) => of(workspace).assistant;

  /// The top-level chats of a chat node, among assistant workspaces.
  bool topChats(Json workspace) =>
      assistant(workspace) && workspace['id'] == "${workspace['hostId']}:chats";

  /// The modes a new Work workspace on [node] can have: the node's accepted
  /// modes the catalog knows, without the assistant's (chat projects have
  /// their own dialog). Empty with an older gateway: a path makes a directory.
  List<ModeInfo> creatable(Json? node) {
    final accepted = node?['modes'];
    if (accepted is! List || isEmpty) return const [];
    final ids = accepted.map((id) => '$id').toSet();
    return modes.where((m) => ids.contains(m.id) && !m.assistant).toList();
  }

  /// Nodes that can host Work workspaces: those accepting a non-assistant
  /// mode. Without node modes (an older gateway), every node but those
  /// hosting top-level chats.
  List<Json> workNodes(List<Json> nodes, List<Json> workspaces) {
    final chatNodes = workspaces
        .where(topChats)
        .map((w) => '${w['hostId']}')
        .toSet();
    return nodes
        .where(
          (node) => node['modes'] is List && !isEmpty
              ? creatable(node).isNotEmpty
              : !chatNodes.contains('${node['id']}'),
        )
        .toList();
  }

  /// Workspaces delegated work and project links can target.
  List<Json> delegateTargets(List<Json> workspaces) =>
      workspaces.where((w) => of(w).delegateTarget).toList(growable: false);
}
