import 'package:pirc_mobile/live/gateway.dart';

/// `GET /api/modes` fixtures: the default directory mode and the guide's
/// scratch example (a per-session mode accepted on a coding node).
Json _mode(String id, Json fields) => {
  'id': id,
  'description': '',
  'prompt': ['body'],
  'body': '',
  'features_off': <String>[],
  'features_on': <String>[],
  'tools': null,
  'delegate_target': false,
  'project_config': false,
  'workspace_memory': false,
  'repository': false,
  'recap': false,
  ...fields,
};

final directoryModeFixture = _mode('directory', {
  'label': 'Work',
  'description': 'Coding sessions in a repository.',
  'ui': {'noun': 'session'},
  'workdir': 'workspace',
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
  'delegate_target': true,
});

final modeCatalogFixture = [directoryModeFixture, scratchModeFixture];

const directoryWorkspaceFixture = <String, dynamic>{
  'id': 'device:repo',
  'hostId': 'device',
  'displayName': 'Repository',
  'kind': 'directory',
  'mode': 'directory',
  'available': true,
};

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
  directoryWorkspaceFixture,
  scratchWorkspaceFixture,
  unavailableWorkspaceFixture,
];

const modeNodesFixture = [
  {
    'id': 'device',
    'modes': ['directory', 'scratch'],
  },
];
