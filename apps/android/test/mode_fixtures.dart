import 'package:pirc_mobile/live/gateway.dart';

/// `GET /api/modes` fixtures: the two default modes and the guide's scratch
/// example (a per-session, non-assistant mode accepted on a coding node).
Json _mode(String id, Json fields) => {
  'id': id,
  'description': '',
  'prompt': ['body'],
  'body': '',
  'features_off': <String>[],
  'features_on': <String>[],
  'tools': null,
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
  ...fields,
};

final chatModeFixture = _mode('chat', {
  'label': 'Chat',
  'description': "The personal assistant's chats and projects.",
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

final directoryModeFixture = _mode('directory', {
  'label': 'Work',
  'description': 'Coding sessions in a repository.',
  'ui': {'noun': 'session'},
  'workdir': 'workspace',
  'assistant': 'user',
  'delegate_target': true,
  'project_config': true,
  'workspace_memory': true,
  'repository': true,
  'recap': true,
});

final scratchModeFixture = _mode('scratch', {
  'label': 'Scratch',
  'description': 'One-off jobs in their own folder.',
  'ui': {'noun': 'session'},
  'workdir': 'per-session',
  'assistant': 'user',
  'delegate_target': true,
});

final modeCatalogFixture = [
  chatModeFixture,
  directoryModeFixture,
  scratchModeFixture,
];

const chatsWorkspaceFixture = <String, dynamic>{
  'id': 'assistant:chats',
  'hostId': 'assistant',
  'displayName': 'Chats',
  'kind': 'chat',
  'mode': 'chat',
  'available': true,
};

const projectWorkspaceFixture = <String, dynamic>{
  'id': 'assistant:trip',
  'hostId': 'assistant',
  'displayName': 'Trip',
  'kind': 'chat',
  'mode': 'chat',
  'available': true,
};

const directoryWorkspaceFixture = <String, dynamic>{
  'id': 'device:repo',
  'hostId': 'device',
  'displayName': 'Repository',
  'kind': 'directory',
  'mode': 'directory',
  'available': true,
};

/// The gateway derives the legacy `kind` from `workdir`: per-session reads
/// "chat", although scratch is not an assistant mode.
const scratchWorkspaceFixture = <String, dynamic>{
  'id': 'device:jobs',
  'hostId': 'device',
  'displayName': 'Jobs',
  'kind': 'chat',
  'mode': 'scratch',
  'available': true,
};

/// A mode missing from the catalog: read-only history under Work.
const unavailableWorkspaceFixture = <String, dynamic>{
  'id': 'device:review',
  'hostId': 'device',
  'displayName': 'Old review',
  'kind': 'directory',
  'mode': 'review',
  'available': false,
};

const modeWorkspacesFixture = [
  chatsWorkspaceFixture,
  projectWorkspaceFixture,
  directoryWorkspaceFixture,
  scratchWorkspaceFixture,
  unavailableWorkspaceFixture,
];

const modeNodesFixture = [
  {
    'id': 'assistant',
    'modes': ['chat'],
  },
  {
    'id': 'device',
    'modes': ['directory', 'scratch'],
  },
];
