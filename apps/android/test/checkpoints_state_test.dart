import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/checkpoints_pane.dart';
import 'package:pirc_mobile/live/checkpoints_state.dart';
import 'package:pirc_mobile/live/gateway.dart';

import 'live_test.dart' show FakeGateway, theme;

class _RecordingController extends LiveController {
  _RecordingController(super.gateway);

  final openedSessions = <String>[];

  @override
  Future<void> open(
    String id, {
    bool reveal = true,
    bool keepComposer = false,
    bool skipFirst = false,
  }) async {
    openedSessions.add(id);
  }
}

Json _capture(String id) => {
  'id': id,
  'state': 'closed',
  'coverage': 'observed file changes',
  'gaps': false,
  'pinned': false,
  'created': 1790000000000,
  'run': {'id': 'run-$id', 'status': 'succeeded'},
  'operations': [
    {
      'id': 'op-$id',
      'path': 'lib/example.dart',
      'state': 'observed',
      'before': {'kind': 'file', 'hash': 'before'},
      'after': {'kind': 'file', 'hash': 'after'},
    },
  ],
};

Json _page(List<Json> captures, {bool more = false, String? cursor}) => {
  'version': 1,
  'enabled': true,
  'captures': captures,
  'jobs': <Json>[],
  'more': more,
  'cursor': ?cursor,
};

LiveController _controller(FakeGateway gateway) => LiveController(gateway)
  ..sessionId = 'original'
  ..origin = 'https://gateway.example'
  ..clientId = 'phone'
  ..connection = 'live'
  ..control = {'held': true, 'generation': 3}
  ..state = {
    'session': {'id': 'original', 'workspaceId': 'w'},
    'run': {'status': 'succeeded'},
    'runnerStatus': 'stopped',
  };

Future<void> _settle() => Future<void>.delayed(Duration.zero);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('preview consent and lease gate recovery; repeated prepare reuses its key', () async {
    final gateway = FakeGateway();
    final capture = _capture('c1');
    final job = {
      'id': 'recovery-1',
      'captureId': 'c1',
      'state': 'ready',
      'revision': 7,
      'reservedBytes': 20,
      'manifest': {
        'paths': [
          {
            'path': 'lib/example.dart',
            'status': 'conflict',
            'before': {'kind': 'file'},
            'after': {'kind': 'file'},
            'current': {'kind': 'file'},
            'candidate': {'kind': 'file'},
          },
        ],
        'exclusions': <String, String>{},
        'copiedBytes': 20,
        'coverage': 'observed file changes',
      },
    };
    final previewBodies = <Json>[];
    final recoveryBodies = <Json>[];
    gateway.handler = (method, args) async {
      if (method != 'request') return gateway.normal(method, args);
      final path = '${args['path']}';
      if (path == '/api/sessions/original/checkpoints') return _page([capture]);
      if (path.endsWith('/preview')) {
        previewBodies.add(obj(args['body']));
        return {
          'version': 1,
          'revision': 'preview-8',
          'copiedBytes': 20,
          'exclusions': <String, String>{},
          'coverage': 'observed file changes',
        };
      }
      if (path.endsWith('/recoveries')) {
        recoveryBodies.add(obj(args['body']));
        return {'job': job};
      }
      return gateway.normal(method, args);
    };

    final controller = _controller(gateway);
    final state = CheckpointsState(controller)..active = true;
    addTearDown(() async {
      state.dispose();
      controller.dispose();
      await gateway.stream.close();
    });

    await state.load();
    state.selectCapture(capture);
    state.selectOperation(rows(capture['operations']).first);
    expect(await state.createPreview(reviewObservational: false), isFalse);
    expect(previewBodies, isEmpty);

    expect(await state.createPreview(reviewObservational: true), isTrue);
    expect(previewBodies.single, {
      'operations': ['op-c1'],
      'reviewObservational': true,
    });

    controller.control = {'held': false, 'generation': 3};
    expect(await state.prepareWorkspace(reviewObservational: true), isFalse);
    expect(recoveryBodies, isEmpty);

    controller.control = {'held': true, 'generation': 3};
    expect(await state.prepareWorkspace(reviewObservational: true), isTrue);
    expect(await state.prepareWorkspace(reviewObservational: true), isTrue);
    expect(recoveryBodies, hasLength(2));
    expect(recoveryBodies[0]['key'], recoveryBodies[1]['key']);
    expect(recoveryBodies[0]['previewRevision'], 'preview-8');
    expect(recoveryBodies[0]['operations'], ['op-c1']);
    expect(recoveryBodies[0]['reviewObservational'], isTrue);
    expect(recoveryBodies[0]['clientId'], 'phone');
    expect(recoveryBodies[0]['generation'], 3);
    expect(state.hasUnresolved(job), isTrue);
  });

  test('checkpoint pages append by cursor and keep capture operations intact', () async {
    final gateway = FakeGateway();
    final paths = <String>[];
    gateway.handler = (method, args) async {
      if (method != 'request') return gateway.normal(method, args);
      final path = '${args['path']}';
      if (path.startsWith('/api/sessions/original/checkpoints')) {
        paths.add(path);
        if (path.contains('cursor=next')) return _page([_capture('c2')]);
        return _page([_capture('c1')], more: true, cursor: 'next');
      }
      return gateway.normal(method, args);
    };
    final controller = _controller(gateway);
    final state = CheckpointsState(controller)..active = true;
    addTearDown(() async {
      state.dispose();
      controller.dispose();
      await gateway.stream.close();
    });

    await state.load();
    expect(state.more, isTrue);
    await state.loadMore();
    expect(paths, [
      '/api/sessions/original/checkpoints',
      '/api/sessions/original/checkpoints?cursor=next',
    ]);
    expect(state.captures.map((capture) => capture['id']), ['c1', 'c2']);
    expect(rows(state.captures.first['operations']).single['id'], 'op-c1');
    expect(state.more, isFalse);
  });

  test('late list responses cannot replace a switched session or offline view', () async {
    final gateway = FakeGateway();
    final oldPage = Completer<dynamic>();
    final offlinePage = Completer<dynamic>();
    var holdNewPage = false;
    gateway.handler = (method, args) async {
      if (method != 'request') return gateway.normal(method, args);
      final path = '${args['path']}';
      if (path == '/api/sessions/old/checkpoints') return oldPage.future;
      if (path == '/api/sessions/new/checkpoints') {
        if (holdNewPage) return offlinePage.future;
        return _page([_capture('new-capture')]);
      }
      return gateway.normal(method, args);
    };
    final controller = _controller(gateway);
    final state = CheckpointsState(controller)..active = true;
    addTearDown(() async {
      state.dispose();
      controller.dispose();
      await gateway.stream.close();
    });

    final oldRequest = state.load();
    await _settle();
    controller.sessionId = 'new';
    controller.sessionNavigationRevision++;
    controller.state = {'session': {'id': 'new', 'workspaceId': 'w'}};
    controller.notifyListeners();
    await _settle();
    await _settle();
    expect(state.captures.single['id'], 'new-capture');

    oldPage.complete(_page([_capture('old-capture')]));
    await oldRequest;
    expect(state.session, 'new');
    expect(state.captures.single['id'], 'new-capture');

    holdNewPage = true;
    final offlineRequest = state.load();
    await _settle();
    controller.connection = 'offline';
    controller.notifyListeners();
    offlinePage.complete(_page([_capture('offline-stale')]));
    await offlineRequest;
    expect(state.offline, isTrue);
    expect(state.captures.single['id'], 'new-capture');
  });

  test('offline fences an in-flight recovery response without retrying the mutation', () async {
    final gateway = FakeGateway();
    final capture = _capture('c1');
    final recoveryResponse = Completer<dynamic>();
    final recoveryBodies = <Json>[];
    gateway.handler = (method, args) async {
      if (method != 'request') return gateway.normal(method, args);
      final path = '${args['path']}';
      if (path == '/api/sessions/original/checkpoints') return _page([capture]);
      if (path.endsWith('/preview')) {
        return {
          'version': 1,
          'revision': 'preview-8',
          'copiedBytes': 20,
          'exclusions': <String, String>{},
          'coverage': 'observed',
        };
      }
      if (path.endsWith('/recoveries')) {
        recoveryBodies.add(obj(args['body']));
        return recoveryResponse.future;
      }
      return gateway.normal(method, args);
    };
    final controller = _controller(gateway);
    final state = CheckpointsState(controller)..active = true;
    addTearDown(() async {
      state.dispose();
      controller.dispose();
      await gateway.stream.close();
    });

    await state.load();
    state.selectCapture(capture);
    state.selectOperation(rows(capture['operations']).first);
    expect(await state.createPreview(reviewObservational: true), isTrue);
    final preparing = state.prepareWorkspace(reviewObservational: true);
    await _settle();
    expect(state.preparing, isTrue);
    expect(recoveryBodies, hasLength(1));

    controller.connection = 'offline';
    controller.notifyListeners();
    recoveryResponse.complete({
      'job': {
        'id': 'late-job',
        'captureId': 'c1',
        'state': 'preparing',
        'revision': 1,
        'manifest': {'paths': [], 'exclusions': {}, 'copiedBytes': 0, 'coverage': ''},
      },
    });
    expect(await preparing, isFalse);
    expect(state.preparing, isFalse);
    expect(state.jobs, isEmpty);
    expect(recoveryBodies, hasLength(1), reason: 'a mutation must never retry automatically');
  });

  test('re-pairing invalidates an in-flight preview', () async {
    final gateway = FakeGateway();
    final capture = _capture('c1');
    final previewResponse = Completer<dynamic>();
    gateway.handler = (method, args) async {
      if (method == 'pair') {
        return {
          'origin': 'https://replacement.example',
          'clientId': 'replacement',
          'pairingStamp': 'replacement-pairing',
        };
      }
      if (method != 'request') return gateway.normal(method, args);
      final path = '${args['path']}';
      if (path == '/api/sessions/original/checkpoints') return _page([capture]);
      if (path.endsWith('/preview')) return previewResponse.future;
      if (path == '/api/sessions') return {'sessions': []};
      return gateway.normal(method, args);
    };
    final controller = _controller(gateway);
    final state = CheckpointsState(controller)..active = true;
    addTearDown(() async {
      state.dispose();
      controller.dispose();
      await gateway.stream.close();
    });

    await state.load();
    state.selectCapture(capture);
    state.selectOperation(rows(capture['operations']).first);
    final pendingPreview = state.createPreview(reviewObservational: true);
    await _settle();
    final oldAccount = controller.accountRevision;
    await controller.pair('pair-link');
    expect(controller.accountRevision, oldAccount + 1);
    previewResponse.complete({
      'version': 1,
      'revision': 'late-preview',
      'copiedBytes': 20,
      'exclusions': <String, String>{},
      'coverage': 'observed',
    });

    expect(await pendingPreview, isFalse);
    expect(state.preview, isNull);
  });

  test('closed run and checkpoint events refresh only the active checkpoint list', () async {
    final gateway = FakeGateway();
    var page = _page([_capture('c1')]);
    gateway.handler = (method, args) async {
      if (method != 'request') return gateway.normal(method, args);
      if (args['path'] == '/api/sessions/original/checkpoints') return page;
      return gateway.normal(method, args);
    };
    final controller = _controller(gateway);
    final state = CheckpointsState(controller)..active = true;
    addTearDown(() async {
      state.dispose();
      controller.dispose();
      await gateway.stream.close();
    });

    await state.load();
    var listCalls = gateway.calls
        .where((call) => call.$1 == 'request' && call.$2['path'] == '/api/sessions/original/checkpoints')
        .length;
    expect(listCalls, 1);

    state.event({'type': 'checkpoints_changed', 'sessionId': 'original'});
    await _settle();
    expect(
      gateway.calls.where((call) => call.$1 == 'request' && call.$2['path'] == '/api/sessions/original/checkpoints').length,
      2,
    );

    controller.state = {
      ...controller.state,
      'run': {'status': 'running'},
    };
    controller.notifyListeners();
    controller.state = {
      ...controller.state,
      'run': {'status': 'succeeded'},
    };
    page = _page([_capture('c2')]);
    controller.notifyListeners();
    await _settle();
    expect(state.captures.single['id'], 'c2');

    state.setActive(false);
    state.event({'type': 'checkpoints_changed', 'sessionId': 'original'});
    await _settle();
    listCalls = gateway.calls
        .where((call) => call.$1 == 'request' && call.$2['path'] == '/api/sessions/original/checkpoints')
        .length;
    expect(listCalls, 3);
    expect(state.stale, isTrue);
  });

  test('duplicate keep-current confirmations reuse the returned conversation', () async {
    final gateway = FakeGateway();
    final capture = _capture('c1');
    final job = {
      'id': 'recovery-1',
      'captureId': 'c1',
      'state': 'ready',
      'revision': 12,
      'manifest': {
        'paths': [
          {
            'path': 'lib/example.dart',
            'status': 'conflict',
            'before': {'kind': 'file'},
            'after': {'kind': 'file'},
            'current': {'kind': 'file'},
            'candidate': {'kind': 'file'},
          },
        ],
        'exclusions': <String, String>{},
        'copiedBytes': 20,
        'coverage': 'observed file changes',
      },
    };
    final continueBodies = <Json>[];
    gateway.handler = (method, args) async {
      if (method != 'request') return gateway.normal(method, args);
      final path = '${args['path']}';
      if (path == '/api/sessions/original/checkpoints') {
        return {
          ..._page([capture]),
          'jobs': [job],
        };
      }
      if (path.endsWith('/recoveries/recovery-1/continue')) {
        continueBodies.add(obj(args['body']));
        final refreshed = continueBodies.length == 1
            ? {
                ...job,
                'state': 'opened',
                'revision': 13,
                'continuation': null,
              }
            : {
                ...job,
                'state': 'opened',
                'revision': 14,
                'continuation': {
                  'sessionId': 'recovery-session',
                  'workspaceId': 'recovery-workspace',
                },
              };
        return {
          'session': {
            'id': 'recovery-session',
            'workspaceId': 'recovery-workspace',
            'name': 'Recovery',
          },
          'workspaceId': 'recovery-workspace',
          'job': refreshed,
        };
      }
      return gateway.normal(method, args);
    };
    final controller = _RecordingController(gateway)
      ..sessionId = 'original'
      ..origin = 'https://gateway.example'
      ..clientId = 'phone'
      ..connection = 'live'
      ..control = {'held': true, 'generation': 3}
      ..state = {
        'session': {'id': 'original', 'workspaceId': 'w'},
        'run': {'status': 'succeeded'},
        'runnerStatus': 'stopped',
      };
    final state = CheckpointsState(controller)..active = true;
    addTearDown(() async {
      state.dispose();
      controller.dispose();
      await gateway.stream.close();
    });

    await state.load();
    expect(state.hasUnresolved(job), isTrue);
    expect(await state.continueRecovery(job), isFalse);
    expect(continueBodies, isEmpty);
    state.setKeepCurrentReviewed('recovery-1', true);

    expect(await state.continueRecovery(job), isTrue);
    final openedWithoutLink = state.jobs.single;
    expect(openedWithoutLink['state'], 'opened');
    expect(openedWithoutLink['continuation'], isNull);
    expect(await state.continueRecovery(openedWithoutLink), isTrue);
    controller.sessionId = 'recovery-session';
    expect(await state.continueRecovery(state.jobs.single), isTrue);
    expect(controller.openedSessions, [
      'recovery-session',
      'recovery-session',
      'recovery-session',
    ]);
    expect(continueBodies, hasLength(2));
    expect(continueBodies.first['revision'], 12);
    expect(continueBodies.last['revision'], 13);
    expect(continueBodies.first['acceptUnresolved'], isTrue);
    expect(continueBodies.first['clientId'], 'phone');
    expect(continueBodies.first['generation'], 3);
    expect(gateway.calls.where((call) => call.$1 == 'command'), isEmpty);
  });

  test('reopening a recovery uses its selected operation ID when paths repeat', () async {
    final gateway = FakeGateway();
    final capture = {
      ..._capture('c1'),
      'operations': [
        {
          'id': 'op-first',
          'path': 'lib/shared.dart',
          'state': 'observed',
          'after': {'kind': 'file'},
        },
        {
          'id': 'op-second',
          'path': 'lib/shared.dart',
          'state': 'observed',
          'after': {'kind': 'file'},
        },
      ],
    };
    final job = {
      'id': 'recovery-1',
      'captureId': 'c1',
      'operations': ['op-first'],
      'state': 'ready',
      'manifest': {'paths': [], 'exclusions': <String, String>{}},
    };
    gateway.handler = (method, args) async {
      if (method != 'request') return gateway.normal(method, args);
      final path = '${args['path']}';
      if (path == '/api/sessions/original/checkpoints') {
        return {..._page([capture]), 'jobs': [job]};
      }
      if (path.startsWith('/api/sessions/original/checkpoints/c1/file?')) {
        return {'path': 'lib/shared.dart', 'side': 'current', 'text': 'first'};
      }
      return gateway.normal(method, args);
    };
    final controller = _controller(gateway);
    final state = CheckpointsState(controller)..active = true;
    addTearDown(() async {
      state.dispose();
      controller.dispose();
      await gateway.stream.close();
    });

    await state.load();
    state.selectCapture(capture);
    state.selectOperation(capture['operations'][1] as Json);
    expect(state.selectedOperationId, 'op-second');
    state.selectJob(job);
    expect(state.selectedOperationId, 'op-first');
    await state.loadFile('current', jobId: 'recovery-1');

    final fileRequest = gateway.calls
        .where((call) => call.$1 == 'request' &&
            '${call.$2['path']}'.contains('/checkpoints/c1/file?'))
        .single;
    expect(
      Uri.parse('${fileRequest.$2['path']}').queryParameters['operation'],
      'op-first',
    );
    expect(
      Uri.parse('${fileRequest.$2['path']}').queryParameters['job'],
      'recovery-1',
    );
  });

  testWidgets('recovery origin from the list opens the original session', (tester) async {
    final gateway = FakeGateway();
    gateway.handler = (method, args) async {
      if (method != 'request') return gateway.normal(method, args);
      if (args['path'] == '/api/sessions/recovery/checkpoints') {
        return {
          ..._page([_capture('c1')]),
          'origin': {
            'sessionId': 'original',
            'workspaceId': 'w',
            'jobId': 'job-1',
            'captureId': 'capture-1',
          },
        };
      }
      return gateway.normal(method, args);
    };
    final controller = _controller(gateway)
      ..sessionId = 'recovery'
      ..sessions = [
        {'id': 'recovery', 'workspaceId': 'w'},
        {'id': 'original', 'workspaceId': 'w'},
      ];
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox.shrink());
      controller.dispose();
      await gateway.stream.close();
    });

    await tester.pumpWidget(
      MaterialApp(
        theme: theme.build(Brightness.light),
        home: Scaffold(body: CheckpointsPane(controller: controller)),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('checkpoint-origin-job-1')), findsOneWidget);
    expect(find.text('This recovery conversation is linked to its original session and checkpoint.'), findsOneWidget);
    await tester.tap(find.text('Open original session'));
    await tester.pumpAndSettle();
    expect(controller.sessionId, 'original');
    expect(tester.takeException(), isNull);
  });
}
