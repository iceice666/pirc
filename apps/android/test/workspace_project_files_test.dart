import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/web_controls.dart';
import 'package:pirc_mobile/live/workspace_project_files.dart';
import 'package:pirc_mobile/live/workspace_settings.dart';

import 'live_test.dart' show FakeGateway, theme;

const _chat = <String, dynamic>{
  'id': 'host:project/alpha',
  'hostId': 'host',
  'kind': 'chat',
  'displayName': 'Project',
};
const _topChats = <String, dynamic>{
  'id': 'host:chats',
  'hostId': 'host',
  'kind': 'chat',
  'displayName': 'Chats',
};

class _TestController extends LiveController {
  _TestController(super.gateway);

  int revision = 0;

  @override
  int get accountRevision => revision;
}

_TestController _controller(FakeGateway gateway, Json workspace) =>
    _TestController(gateway)
      ..origin = 'https://gateway.example'
      ..clientId = 'phone'
      ..pairingStamp = 'pair-one'
      ..workspaces = [workspace]
      ..nodes = [
        {'id': workspace['hostId']},
      ];

Widget _host(LiveController controller, Json workspace) => MaterialApp(
  theme: theme.build(Brightness.light),
  home: Scaffold(
    body: SingleChildScrollView(
      child: WorkspaceProjectFiles(
        controller: controller,
        workspace: workspace,
      ),
    ),
  ),
);

Widget _settingsHost(LiveController controller, Json workspace) => MaterialApp(
  theme: theme.build(Brightness.light),
  home: Scaffold(
    body: SingleChildScrollView(
      child: WorkspaceSettings(controller: controller, workspace: workspace),
    ),
  ),
);

Json _listing({
  List<Json> files = const [],
  int maxFiles = 50,
  int maxBytes = 0,
}) => {'files': files, 'maxFiles': maxFiles, 'maxBytes': maxBytes};

Json _file(String name, int byteSize) => {
  'name': name,
  'byteSize': byteSize,
  'modifiedAt': 1,
};

Future<void> _mount(
  WidgetTester tester,
  LiveController controller,
  Json workspace,
) async {
  await tester.pumpWidget(_host(controller, workspace));
  await tester.pumpAndSettle();
}

Future<void> _finish(
  WidgetTester tester,
  LiveController controller,
  FakeGateway gateway,
) async {
  await tester.pumpWidget(const SizedBox());
  controller.dispose();
  await gateway.stream.close();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('lists encoded workspace files and fits a narrow screen', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(320, 760);
    addTearDown(tester.view.reset);
    final gateway = FakeGateway();
    gateway.handler = (method, args) async {
      if (method == 'request') {
        return _listing(
          files: [
            _file(
              'A project file with a very long name that should ellipsize.txt',
              1111,
            ),
          ],
          maxFiles: 10,
          maxBytes: 10 * 1024 * 1024,
        );
      }
      return gateway.normal(method, args);
    };
    final controller = _controller(gateway, _chat);

    await _mount(tester, controller, _chat);

    expect(
      gateway.calls.where((call) => call.$1 == 'request').single.$2['path'],
      '/api/workspaces/${Uri.encodeComponent('${_chat['id']}')}/files',
    );
    expect(find.text('PROJECT FILES'), findsOneWidget);
    expect(find.text('1.1 KB'), findsOneWidget);
    expect(find.text('1 / 10 files, up to 10.0 MB each'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await _finish(tester, controller, gateway);
  });

  testWidgets('shows the empty state and enforces the file count cap', (
    tester,
  ) async {
    final gateway = FakeGateway();
    gateway.handler = (method, args) async {
      if (method == 'request') {
        return _listing(
          files: [_file('only.txt', 1)],
          maxFiles: 1,
          maxBytes: 0,
        );
      }
      return gateway.normal(method, args);
    };
    final controller = _controller(gateway, _chat);
    await _mount(tester, controller, _chat);

    final upload = tester.widget<WebButton>(
      find.byKey(const ValueKey('project-files-upload')),
    );
    expect(upload.onPressed, isNull);
    expect(find.text('1 / 1 files'), findsOneWidget);
    expect(
      gateway.calls.where((call) => call.$1 == 'pickProjectFiles'),
      isEmpty,
    );

    await _finish(tester, controller, gateway);
  });

  testWidgets('shows an empty folder and no byte limit when maxBytes is zero', (
    tester,
  ) async {
    final gateway = FakeGateway();
    gateway.handler = (method, args) async {
      if (method == 'request') return _listing(maxFiles: 3, maxBytes: 0);
      return gateway.normal(method, args);
    };
    final controller = _controller(gateway, _chat);
    await _mount(tester, controller, _chat);

    expect(find.text('No files yet.'), findsOneWidget);
    expect(find.text('0 / 3 files'), findsOneWidget);
    expect(find.textContaining('up to'), findsNothing);
    await _finish(tester, controller, gateway);
  });

  testWidgets('continues a batch after an upload fails and reloads the list', (
    tester,
  ) async {
    final gateway = FakeGateway();
    final uploads = <Json>[];
    Json released = {};
    var reads = 0;
    gateway.handler = (method, args) async {
      if (method == 'request') {
        reads++;
        return _listing(
          files: reads == 1 ? const [] : [_file('good.txt', 3)],
          maxFiles: 5,
          maxBytes: 5,
        );
      }
      if (method == 'pickProjectFiles') {
        return [
          {'name': 'failed.txt', 'byteSize': 2, 'fileToken': 'failed-token'},
          {'name': 'good.txt', 'fileToken': 'good-token'},
        ];
      }
      if (method == 'uploadProjectFile') {
        uploads.add(args);
        if (args['name'] == 'failed.txt') {
          throw PlatformException(code: 'HTTP_500', message: 'Upload failed');
        }
        return {'file': _file('good.txt', 3)};
      }
      if (method == 'releaseProjectFiles') {
        released = args;
        return null;
      }
      return gateway.normal(method, args);
    };
    final controller = _controller(gateway, _chat);
    await _mount(tester, controller, _chat);

    await tester.tap(find.byKey(const ValueKey('project-files-upload')));
    await tester.pumpAndSettle();

    expect(reads, 2);
    expect(uploads.map((args) => args['name']), ['failed.txt', 'good.txt']);
    expect(uploads.first['pairingStamp'], 'pair-one');
    expect(uploads.first['maxBytes'], 5);
    expect(uploads.first['workspaceId'], _chat['id']);
    expect(
      gateway.calls.where((call) => call.$1 == 'pickProjectFiles').single.$2,
      {
        'workspaceId': _chat['id'],
        'pairingStamp': 'pair-one',
        'maxBytes': 5,
        'multiple': true,
      },
    );
    expect(released, {
      'fileTokens': ['failed-token', 'good-token'],
    });
    expect(find.text('failed.txt: Upload failed'), findsOneWidget);
    expect(
      find.text('1 file uploaded. Every chat in this project can read it now.'),
      findsOneWidget,
    );
    expect(find.text('good.txt'), findsOneWidget);
    await _finish(tester, controller, gateway);
  });

  for (final chosen in [
    (
      title: 'rejects a selected file larger than the byte limit',
      file: <String, dynamic>{
        'name': 'large.txt',
        'byteSize': 6,
        'fileToken': 'large-token',
      },
      message: 'large.txt is larger than the 5 B limit.',
    ),
    (
      title: 'rejects a zero byte file',
      file: <String, dynamic>{
        'name': 'empty.txt',
        'byteSize': 0,
        'fileToken': 'empty-token',
      },
      message: 'empty.txt is empty.',
    ),
  ]) {
    testWidgets(chosen.title, (tester) async {
      final gateway = FakeGateway();
      gateway.handler = (method, args) async {
        if (method == 'request') return _listing(maxFiles: 5, maxBytes: 5);
        if (method == 'pickProjectFiles') return [chosen.file];
        if (method == 'releaseProjectFiles') return null;
        return gateway.normal(method, args);
      };
      final controller = _controller(gateway, _chat);
      await _mount(tester, controller, _chat);

      await tester.tap(find.byKey(const ValueKey('project-files-upload')));
      await tester.pumpAndSettle();

      expect(find.text(chosen.message), findsOneWidget);
      expect(
        gateway.calls.where((call) => call.$1 == 'uploadProjectFile'),
        isEmpty,
      );
      expect(
        gateway.calls
            .where((call) => call.$1 == 'releaseProjectFiles')
            .single
            .$2,
        {
          'fileTokens': [chosen.file['fileToken']],
        },
      );
      await _finish(tester, controller, gateway);
    });
  }

  testWidgets('inline remove confirmation can cancel or delete an encoded name', (
    tester,
  ) async {
    const name = 'notes ?/#.txt';
    final gateway = FakeGateway();
    var reads = 0;
    String? deletePath;
    gateway.handler = (method, args) async {
      if (method == 'request') {
        if (args['method'] == 'DELETE') {
          deletePath = args['path'] as String;
          return <String, dynamic>{};
        }
        reads++;
        return _listing(
          files: reads == 1 ? [_file(name, 8)] : const [],
          maxFiles: 5,
          maxBytes: 20,
        );
      }
      return gateway.normal(method, args);
    };
    final controller = _controller(gateway, _chat);
    await _mount(tester, controller, _chat);

    await tester.tap(find.byKey(const ValueKey('project-file-remove-$name')));
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('project-file-confirm-remove-$name')),
      findsOneWidget,
    );
    await tester.tap(
      find.byKey(const ValueKey('project-file-cancel-remove-$name')),
    );
    await tester.pumpAndSettle();
    expect(deletePath, isNull);
    expect(
      find.byKey(const ValueKey('project-file-remove-$name')),
      findsOneWidget,
    );

    await tester.tap(find.byKey(const ValueKey('project-file-remove-$name')));
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(const ValueKey('project-file-confirm-remove-$name')),
    );
    await tester.pumpAndSettle();

    expect(
      deletePath,
      '/api/workspaces/${Uri.encodeComponent('${_chat['id']}')}/files?name=${Uri.encodeComponent(name)}',
    );
    expect(reads, 2);
    expect(find.text('$name removed.'), findsOneWidget);
    expect(find.text('No files yet.'), findsOneWidget);
    await _finish(tester, controller, gateway);
  });

  testWidgets(
    'native file read errors preserve actionable feedback and release tokens',
    (tester) async {
      final gateway = FakeGateway();
      gateway.handler = (method, args) async {
        if (method == 'request') return _listing(maxBytes: 1024);
        if (method == 'pickProjectFiles') {
          return [
            {'name': 'unavailable.txt', 'fileToken': 'unavailable-token'},
          ];
        }
        if (method == 'uploadProjectFile') {
          throw PlatformException(
            code: 'PROJECT_FILE_READ',
            message: 'Unable to read the selected file. Choose it again.',
          );
        }
        return gateway.normal(method, args);
      };
      final controller = _controller(gateway, _chat);
      await _mount(tester, controller, _chat);
      await tester.tap(find.byKey(const ValueKey('project-files-upload')));
      await tester.pumpAndSettle();
      expect(
        find.text(
          'unavailable.txt: Unable to read the selected file. Choose it again.',
        ),
        findsOneWidget,
      );
      expect(
        gateway.calls
            .where((call) => call.$1 == 'releaseProjectFiles')
            .single
            .$2,
        {
          'fileTokens': ['unavailable-token'],
        },
      );
      await _finish(tester, controller, gateway);
    },
  );

  testWidgets('failed initial read can be retried', (tester) async {
    final gateway = FakeGateway();
    var reads = 0;
    gateway.handler = (method, args) async {
      if (method == 'request') {
        if (++reads == 1) {
          throw PlatformException(
            code: 'HTTP_503',
            message: 'Files unavailable',
          );
        }
        return _listing(files: [_file('fresh.txt', 4)]);
      }
      return gateway.normal(method, args);
    };
    final controller = _controller(gateway, _chat);
    await _mount(tester, controller, _chat);

    expect(find.text('Files unavailable'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(reads, 2);
    expect(find.text('fresh.txt'), findsOneWidget);
    await _finish(tester, controller, gateway);
  });

  testWidgets('account change rejects a stale list response', (tester) async {
    final gateway = FakeGateway();
    final stale = Completer<dynamic>();
    var reads = 0;
    gateway.handler = (method, args) async {
      if (method == 'request') {
        if (++reads == 1) return stale.future;
        return _listing(files: [_file('current-account.txt', 2)]);
      }
      return gateway.normal(method, args);
    };
    final controller = _controller(gateway, _chat);
    await tester.pumpWidget(_host(controller, _chat));
    await tester.pump();

    controller.revision++;
    controller.pairingStamp = 'pair-two';
    controller.changed();
    await tester.pumpAndSettle();
    stale.complete(_listing(files: [_file('stale-account.txt', 1)]));
    await tester.pumpAndSettle();

    expect(reads, 2);
    expect(find.text('current-account.txt'), findsOneWidget);
    expect(find.text('stale-account.txt'), findsNothing);
    await _finish(tester, controller, gateway);
  });

  testWidgets('workspace change rejects a stale list response', (tester) async {
    const nextWorkspace = <String, dynamic>{
      'id': 'host:project/beta',
      'hostId': 'host',
      'kind': 'chat',
      'displayName': 'New project',
    };
    final gateway = FakeGateway();
    final stale = Completer<dynamic>();
    var reads = 0;
    gateway.handler = (method, args) async {
      if (method == 'request') {
        if (++reads == 1) return stale.future;
        return _listing(files: [_file('beta.txt', 2)]);
      }
      return gateway.normal(method, args);
    };
    final controller = _controller(gateway, _chat);
    await tester.pumpWidget(_host(controller, _chat));
    await tester.pump();

    controller.workspaces = [nextWorkspace];
    await tester.pumpWidget(_host(controller, nextWorkspace));
    await tester.pumpAndSettle();
    stale.complete(_listing(files: [_file('alpha-stale.txt', 1)]));
    await tester.pumpAndSettle();

    expect(reads, 2);
    expect(find.text('beta.txt'), findsOneWidget);
    expect(find.text('alpha-stale.txt'), findsNothing);
    expect(
      gateway.calls.where((call) => call.$1 == 'request').last.$2['path'],
      '/api/workspaces/${Uri.encodeComponent('${nextWorkspace['id']}')}/files',
    );
    await _finish(tester, controller, gateway);
  });

  testWidgets('host change rejects a stale list response', (tester) async {
    final gateway = FakeGateway();
    final stale = Completer<dynamic>();
    var reads = 0;
    gateway.handler = (method, args) async {
      if (method == 'request') {
        if (++reads == 1) return stale.future;
        return _listing(files: [_file('new-host.txt', 2)]);
      }
      return gateway.normal(method, args);
    };
    final controller = _controller(gateway, _chat);
    await tester.pumpWidget(_host(controller, _chat));
    await tester.pump();

    controller
      ..workspaces = [
        <String, dynamic>{..._chat, 'hostId': 'new-host'},
      ]
      ..nodes = [
        {'id': 'new-host'},
      ]
      ..changed();
    await tester.pumpAndSettle();
    stale.complete(_listing(files: [_file('old-host.txt', 1)]));
    await tester.pumpAndSettle();

    expect(reads, 2);
    expect(find.text('new-host.txt'), findsOneWidget);
    expect(find.text('old-host.txt'), findsNothing);
    await _finish(tester, controller, gateway);
  });

  testWidgets('scope change during an upload stops later files in the batch', (
    tester,
  ) async {
    final gateway = FakeGateway();
    final firstUpload = Completer<dynamic>();
    final uploads = <Json>[];
    final released = <Json>[];
    var reads = 0;
    gateway.handler = (method, args) async {
      if (method == 'request') {
        reads++;
        return _listing(files: [_file('current.txt', 1)], maxFiles: 5);
      }
      if (method == 'pickProjectFiles') {
        return [
          {'name': 'first.txt', 'byteSize': 1, 'fileToken': 'first-token'},
          {'name': 'second.txt', 'byteSize': 1, 'fileToken': 'second-token'},
        ];
      }
      if (method == 'uploadProjectFile') {
        uploads.add(args);
        return firstUpload.future;
      }
      if (method == 'releaseProjectFiles') {
        released.add(args);
        return null;
      }
      return gateway.normal(method, args);
    };
    final controller = _controller(gateway, _chat);
    await _mount(tester, controller, _chat);

    await tester.tap(find.byKey(const ValueKey('project-files-upload')));
    await tester.pump();
    expect(uploads.map((args) => args['name']), ['first.txt']);

    controller
      ..pairingStamp = 'pair-two'
      ..changed();
    await tester.pumpAndSettle();
    firstUpload.complete({'file': _file('first.txt', 1)});
    await tester.pumpAndSettle();

    expect(reads, 2);
    expect(uploads.map((args) => args['name']), ['first.txt']);
    expect(released, [
      {
        'fileTokens': ['first-token', 'second-token'],
      },
    ]);
    await _finish(tester, controller, gateway);
  });

  testWidgets(
    'stale picker result stops uploads and still releases its token',
    (tester) async {
      final gateway = FakeGateway();
      final picker = Completer<dynamic>();
      final released = <Json>[];
      var reads = 0;
      gateway.handler = (method, args) async {
        if (method == 'request') {
          reads++;
          return _listing(files: [_file('current.txt', 1)], maxFiles: 5);
        }
        if (method == 'pickProjectFiles') return picker.future;
        if (method == 'uploadProjectFile') {
          return {'file': _file('stale.txt', 1)};
        }
        if (method == 'releaseProjectFiles') {
          released.add(args);
          return null;
        }
        return gateway.normal(method, args);
      };
      final controller = _controller(gateway, _chat);
      await _mount(tester, controller, _chat);

      await tester.tap(find.byKey(const ValueKey('project-files-upload')));
      await tester.pump();
      controller
        ..pairingStamp = 'pair-two'
        ..changed();
      await tester.pumpAndSettle();
      picker.complete([
        {'name': 'stale.txt', 'byteSize': 1, 'fileToken': 'stale-token'},
      ]);
      await tester.pumpAndSettle();

      expect(reads, 2);
      expect(
        gateway.calls.where((call) => call.$1 == 'uploadProjectFile'),
        isEmpty,
      );
      expect(released, [
        {
          'fileTokens': ['stale-token'],
        },
      ]);
      expect(find.text('current.txt'), findsOneWidget);
      await _finish(tester, controller, gateway);
    },
  );

  testWidgets('offline transition clears files and reconnect reloads them', (
    tester,
  ) async {
    final gateway = FakeGateway();
    var reads = 0;
    gateway.handler = (method, args) async {
      if (method == 'request') {
        reads++;
        return _listing(
          files: [_file(reads == 1 ? 'old.txt' : 'fresh.txt', 1)],
        );
      }
      return gateway.normal(method, args);
    };
    final controller = _controller(gateway, _chat);
    await _mount(tester, controller, _chat);

    controller
      ..nodes = []
      ..changed();
    await tester.pumpAndSettle();
    expect(find.text('PROJECT FILES'), findsNothing);
    expect(find.text('old.txt'), findsNothing);

    controller
      ..nodes = [
        {'id': 'host'},
      ]
      ..changed();
    await tester.pumpAndSettle();
    expect(reads, 2);
    expect(find.text('fresh.txt'), findsOneWidget);
    expect(find.text('old.txt'), findsNothing);
    await _finish(tester, controller, gateway);
  });

  testWidgets('project files follow instructions in top-level Chats settings', (
    tester,
  ) async {
    final gateway = FakeGateway();
    gateway.handler = (method, args) async {
      if (method != 'request') return gateway.normal(method, args);
      final path = '${args['path']}';
      if (path.endsWith('/instructions')) {
        return {
          'instructions': {'text': 'Chat instructions', 'maxChars': 8000},
        };
      }
      if (path.endsWith('/capabilities')) {
        return {
          'capabilities': {
            'delegation': true,
            'memory_search': true,
            'remote_recall': true,
            'schedules': true,
            'web_search': true,
          },
        };
      }
      if (path.endsWith('/files')) return _listing();
      return <String, dynamic>{};
    };
    final controller = _controller(gateway, _topChats);
    await tester.pumpWidget(_settingsHost(controller, _topChats));
    await tester.pumpAndSettle();

    expect(find.text('PROJECT INSTRUCTIONS'), findsOneWidget);
    expect(find.text('PROJECT FILES'), findsOneWidget);
    expect(find.text('Linked workspaces'), findsNothing);
    expect(
      tester.getTopLeft(find.text('PROJECT INSTRUCTIONS')).dy,
      lessThan(tester.getTopLeft(find.text('PROJECT FILES')).dy),
    );
    expect(
      tester.getTopLeft(find.text('PROJECT FILES')).dy,
      lessThan(tester.getTopLeft(find.text('PROJECT CAPABILITIES')).dy),
    );
    await _finish(tester, controller, gateway);
  });

  testWidgets('project files are not loaded for a deleting project', (
    tester,
  ) async {
    final deleting = {..._chat, 'deleting': true};
    final gateway = FakeGateway();
    final controller = _controller(gateway, deleting);
    await _mount(tester, controller, deleting);

    expect(find.text('PROJECT FILES'), findsNothing);
    expect(gateway.calls.where((call) => call.$1 == 'request'), isEmpty);
    await _finish(tester, controller, gateway);
  });
}
