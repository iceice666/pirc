import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/common.dart';
import 'package:pirc_mobile/live/conversation_empty.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/interaction.dart';
import 'package:pirc_mobile/live/mobile_tabs.dart';
import 'package:pirc_mobile/live/permissions.dart';
import 'package:pirc_mobile/live/session_sidebar.dart';
import 'live_test.dart' show FakeGateway, theme;

Json sessionRow(String id, {bool unread = false}) => {
  'id': id,
  'name': 'Session $id',
  'workspaceId': 'w',
  'updatedAt': 100,
  if (unread) 'unread': true,
};

class StartupGateway extends FakeGateway {
  StartupGateway({
    List<Json>? sessions,
    this.targetSession,
    this.pairLink,
    this.onboardingComplete = true,
    bool delaySessions = false,
  }) : sessionRows = sessions ?? [sessionRow('s', unread: true)] {
    if (delaySessions) delayedSessions = Completer<dynamic>();
  }

  final List<Json> sessionRows;
  final String? targetSession;
  final String? pairLink;
  bool onboardingComplete;
  final sessionsRequestStarted = Completer<void>();
  Completer<dynamic>? delayedSessions;

  void completeSessions([List<Json>? result]) {
    delayedSessions!.complete({'sessions': result ?? sessionRows});
  }

  @override
  dynamic normal(String method, Json args) {
    switch (method) {
      case 'boot':
        return {
          'origin': 'https://gateway.example',
          'clientId': 'phone',
          'onboardingComplete': onboardingComplete,
          if (targetSession != null) 'targetSession': targetSession,
          if (pairLink != null) 'pairLink': pairLink,
          if (snapshot['interactions'] is List &&
              (snapshot['interactions'] as List).isNotEmpty) ...{
            'interactionId': obj(
              (snapshot['interactions'] as List).first,
            )['id'],
            'confirmQuestion': true,
          },
        };
      case 'preferences':
        return {'mode': 'chat'};
      case 'permissions':
        return {
          'notifications': false,
          'overlay': false,
          'notificationSettings': false,
        };
      case 'completeOnboarding':
        onboardingComplete = true;
        return null;
      case 'request':
        final path = '${args['path']}';
        if (path == '/api/sessions') {
          if (!sessionsRequestStarted.isCompleted) {
            sessionsRequestStarted.complete();
          }
          return delayedSessions?.future ?? {'sessions': sessionRows};
        }
        if (path == '/api/workspaces') {
          return {
            'workspaces': [
              {
                'id': 'w',
                'hostId': 'device',
                'displayName': 'Workspace',
                'kind': 'directory',
              },
            ],
          };
        }
        if (path == '/api/nodes') return {'nodes': []};
        if (path == '/api/memory') return {'user': []};
        if (path.endsWith('/read')) return {};
        if (path.startsWith('/api/models')) {
          return {
            'models': [
              {'id': 'm1', 'provider': 'p', 'name': 'Model one'},
            ],
          };
        }
        return <String, dynamic>{};
      default:
        return super.normal(method, args);
    }
  }

  @override
  Future<dynamic> call(String method, [Json args = const {}]) async {
    final result = await super.call(method, args);
    if (method == 'watch') _publishSnapshot('${args['sessionId']}');
    return result;
  }

  void _publishSnapshot(String id) {
    final row = sessionRows.where((item) => item['id'] == id).firstOrNull;
    stream.add({
      'type': 'snapshot',
      'sessionId': id,
      'data': {
        ...snapshot,
        'session': row ?? sessionRow(id),
        'messages': [
          {
            'id': 'message-$id',
            'role': 'assistant',
            'content': 'Startup snapshot for $id',
          },
        ],
      },
    });
    stream.add({
      'type': 'control',
      'sessionId': id,
      'data': {'held': true, 'generation': 3},
    });
    stream.add({'type': 'connection', 'sessionId': id, 'data': 'live'});
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('phone selects the latest session behind the open sidebar', (
    tester,
  ) async {
    _setSize(tester, 390);
    final gateway = StartupGateway();
    final controller = LiveController(gateway, showing: 'engine');
    await _showApp(tester, controller);
    await tester.pumpAndSettle();

    expect(controller.sessionId, 's');
    expect(controller.revealSelectedSession, isFalse);
    expect(controller.sessionVisible, isFalse);
    expect(find.byType(SessionSidebar), findsOneWidget);
    expect(find.byType(MobileTabs), findsOneWidget);
    expect(controller.sessions.single['unread'], isTrue);
    expect(_readRequests(gateway), isEmpty);

    await _disposeApp(tester, gateway);
  });

  testWidgets('tablet shows the automatic snapshot and marks it read', (
    tester,
  ) async {
    _setSize(tester, 768);
    final gateway = StartupGateway();
    final controller = LiveController(gateway, showing: 'engine');
    await _showApp(tester, controller);
    await tester.pumpAndSettle();

    expect(controller.sessionId, 's');
    expect(controller.state['session'], isNotEmpty);
    expect(
      find.byWidgetPredicate(
        (widget) =>
            widget is RichTextBody && widget.text == 'Startup snapshot for s',
      ),
      findsOneWidget,
    );
    expect(_readRequests(gateway), ['/api/sessions/s/read']);
    expect(controller.sessions.single['unread'], isFalse);

    await _disposeApp(tester, gateway);
  });

  testWidgets('notification target wins and opens the phone conversation', (
    tester,
  ) async {
    _setSize(tester, 390);
    final gateway = StartupGateway(
      sessions: [sessionRow('first'), sessionRow('requested')],
      targetSession: 'requested',
    );
    final controller = LiveController(gateway, showing: 'engine');
    await _showApp(tester, controller);
    await tester.pumpAndSettle();

    expect(controller.sessionId, 'requested');
    expect(controller.revealSelectedSession, isTrue);
    expect(
      gateway.calls
          .where((call) => call.$1 == 'watch')
          .map((call) => call.$2['sessionId']),
      ['requested'],
    );
    expect(find.byType(MobileTabs), findsNothing);
    expect(find.byType(SessionSidebar), findsNothing);
    expect(
      find.byWidgetPredicate(
        (widget) =>
            widget is RichTextBody &&
            widget.text == 'Startup snapshot for requested',
      ),
      findsOneWidget,
    );

    await _disposeApp(tester, gateway);
  });

  testWidgets(
    'deleted boot notification target falls back to the recent session',
    (tester) async {
      _setSize(tester, 390);
      final gateway = StartupGateway(
        sessions: [sessionRow('recent')],
        targetSession: 'deleted',
      );
      final controller = LiveController(gateway, showing: 'engine');
      await _showApp(tester, controller);
      await tester.pumpAndSettle();

      expect(controller.sessionId, 'recent');
      expect(controller.revealSelectedSession, isFalse);
      expect(controller.fromNotification, isFalse);
      expect(controller.error, isNull);
      expect(
        gateway.calls
            .where((call) => call.$1 == 'watch')
            .map((call) => call.$2['sessionId']),
        ['recent'],
      );
      expect(_readRequests(gateway), isEmpty);
      expect(find.byType(SessionSidebar), findsOneWidget);

      await _disposeApp(tester, gateway);
    },
  );

  testWidgets('pending boot pairing link defers all session watching', (
    tester,
  ) async {
    _setSize(tester, 390);
    final gateway = StartupGateway(
      sessions: [sessionRow('recent')],
      targetSession: 'recent',
      pairLink: 'pirc://gateway.example/pair?token=synthetic',
    );
    final controller = LiveController(gateway, showing: 'engine');
    await _showApp(tester, controller);
    await tester.pumpAndSettle();

    expect(controller.pairLink, gateway.pairLink);
    expect(find.byType(PairingScreen), findsOneWidget);
    expect(controller.sessionId, isNull);
    expect(gateway.calls.where((call) => call.$1 == 'watch'), isEmpty);
    expect(_readRequests(gateway), isEmpty);

    await _disposeApp(tester, gateway);
  });

  testWidgets('explicitly reopening the same session reveals it on phone', (
    tester,
  ) async {
    _setSize(tester, 390);
    final gateway = StartupGateway();
    final controller = LiveController(gateway, showing: 'engine');
    await _showApp(tester, controller);
    await tester.pumpAndSettle();

    expect(controller.sessionId, 's');
    expect(find.byType(MobileTabs), findsOneWidget);
    await controller.open('s');
    await tester.pumpAndSettle();

    expect(controller.revealSelectedSession, isTrue);
    expect(find.byType(MobileTabs), findsNothing);
    expect(find.byType(SessionSidebar), findsNothing);

    await _disposeApp(tester, gateway);
  });

  testWidgets('local boot reveals sidebar while the session list is pending', (
    tester,
  ) async {
    _setSize(tester, 768);
    final gateway = StartupGateway(delaySessions: true);
    final controller = LiveController(gateway, showing: 'engine');
    await _showApp(tester, controller);
    await gateway.sessionsRequestStarted.future.timeout(
      const Duration(seconds: 2),
    );
    await tester.pump();

    expect(controller.booting, isFalse);
    expect(controller.initializing, isTrue);
    expect(controller.origin, 'https://gateway.example');
    expect(find.byType(SessionSidebar), findsOneWidget);
    expect(find.byType(AppLoadingState), findsOneWidget);

    gateway.completeSessions([]);
    await tester.pumpAndSettle();
    expect(controller.initializing, isFalse);

    await _disposeApp(tester, gateway);
  });

  testWidgets('empty paired account shows the no-session state', (
    tester,
  ) async {
    _setSize(tester, 768);
    final gateway = StartupGateway(sessions: []);
    final controller = LiveController(gateway, showing: 'engine');
    await _showApp(tester, controller);
    await tester.pumpAndSettle();

    expect(controller.sessionId, isNull);
    expect(find.byType(AppNoSessionState), findsOneWidget);
    expect(find.text('No session could be loaded.'), findsOneWidget);
    expect(find.byType(SessionSidebar), findsOneWidget);

    await _disposeApp(tester, gateway);
  });

  testWidgets('notification question waits until first-run onboarding ends', (
    tester,
  ) async {
    _setSize(tester, 390);
    final gateway = StartupGateway(
      targetSession: 's',
      onboardingComplete: false,
    );
    gateway.snapshot['interactions'] = [
      {
        'id': 'question-1',
        'epoch': 'e',
        'kind': 'confirm',
        'title': 'Confirm the operation?',
        'status': 'pending',
      },
    ];
    final controller = LiveController(gateway, showing: 'engine');
    await _showApp(tester, controller);
    await tester.pumpAndSettle();

    expect(find.byType(PermissionPage), findsOneWidget);
    expect(controller.notificationQuestion?['interactionId'], 'question-1');
    expect(find.byType(QuestionSheet), findsNothing);

    await _finishOnboarding(tester);
    await tester.pumpAndSettle();

    expect(controller.notificationQuestion, isNull);
    expect(
      find.byWidgetPredicate(
        (widget) => widget is QuestionSheet && !widget.embedded,
      ),
      findsOneWidget,
    );

    await _disposeApp(tester, gateway);
  });

  testWidgets(
    'stale notification is dropped after navigation to another session',
    (tester) async {
      _setSize(tester, 390);
      final gateway = StartupGateway(
        sessions: [sessionRow('s'), sessionRow('other')],
      );
      gateway.snapshot['interactions'] = [
        {
          'id': 'question-1',
          'epoch': 'e',
          'kind': 'confirm',
          'title': 'Confirm the operation?',
          'status': 'pending',
        },
      ];
      final controller = LiveController(gateway, showing: 'engine');
      await _showApp(tester, controller);
      await tester.pumpAndSettle();
      expect(controller.sessionId, 's');

      controller.notificationQuestion = {
        'sessionId': 's',
        'interactionId': 'question-1',
        'interactionEpoch': 'e',
        'confirmQuestion': true,
      };
      await controller.open('other');
      await tester.pumpAndSettle();

      expect(controller.sessionId, 'other');
      expect(
        find.byWidgetPredicate(
          (widget) => widget is QuestionSheet && !widget.embedded,
        ),
        findsNothing,
      );

      await _disposeApp(tester, gateway);
    },
  );

  testWidgets('deleted route event refresh keeps the current recent session', (
    tester,
  ) async {
    _setSize(tester, 390);
    final gateway = StartupGateway(sessions: [sessionRow('recent')]);
    final controller = LiveController(gateway, showing: 'engine');
    await _showApp(tester, controller);
    await tester.pumpAndSettle();
    expect(controller.sessionId, 'recent');

    final previousListReads = gateway.calls
        .where(
          (call) => call.$1 == 'request' && call.$2['path'] == '/api/sessions',
        )
        .length;
    gateway.stream.add({
      'type': 'route',
      'data': {'sessionId': 'deleted'},
    });
    await tester.pumpAndSettle();

    expect(
      gateway.calls
          .where(
            (call) =>
                call.$1 == 'request' && call.$2['path'] == '/api/sessions',
          )
          .length,
      previousListReads + 1,
    );
    expect(controller.sessionId, 'recent');
    expect(controller.fromNotification, isFalse);
    expect(controller.error, isNull);
    expect(
      gateway.calls
          .where((call) => call.$1 == 'watch')
          .map((call) => call.$2['sessionId']),
      ['recent'],
    );

    await _disposeApp(tester, gateway);
  });

  testWidgets(
    'late deleted route refresh cannot replace an explicit selection',
    (tester) async {
      _setSize(tester, 390);
      final sessions = [sessionRow('recent'), sessionRow('other')];
      final gateway = StartupGateway(sessions: sessions);
      final controller = LiveController(gateway, showing: 'engine');
      await _showApp(tester, controller);
      await tester.pumpAndSettle();
      expect(controller.sessionId, 'recent');

      final previousListReads = gateway.calls
          .where(
            (call) =>
                call.$1 == 'request' && call.$2['path'] == '/api/sessions',
          )
          .length;
      gateway.delayedSessions = Completer<dynamic>();
      gateway.stream.add({
        'type': 'route',
        'data': {'sessionId': 'deleted'},
      });
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 10));
        final reads = gateway.calls
            .where(
              (call) =>
                  call.$1 == 'request' && call.$2['path'] == '/api/sessions',
            )
            .length;
        if (reads > previousListReads) break;
      }
      expect(
        gateway.calls
            .where(
              (call) =>
                  call.$1 == 'request' && call.$2['path'] == '/api/sessions',
            )
            .length,
        previousListReads + 1,
        reason: 'The missing route starts a refresh that remains pending.',
      );

      await controller.open('other');
      expect(controller.sessionId, 'other');
      gateway.completeSessions(sessions);
      await tester.pumpAndSettle();

      expect(controller.sessionId, 'other');
      expect(controller.fromNotification, isFalse);
      expect(controller.error, isNull);
      expect(
        gateway.calls
            .where((call) => call.$1 == 'watch')
            .map((call) => call.$2['sessionId']),
        ['recent', 'other'],
      );

      await _disposeApp(tester, gateway);
    },
  );

  testWidgets('notification route waits for the initial session list', (
    tester,
  ) async {
    _setSize(tester, 390);
    final sessions = [sessionRow('recent'), sessionRow('target')];
    final gateway = StartupGateway(sessions: sessions, delaySessions: true);
    final controller = LiveController(gateway, showing: 'engine');
    await _showApp(tester, controller);
    await gateway.sessionsRequestStarted.future.timeout(
      const Duration(seconds: 2),
    );

    gateway.stream.add({
      'type': 'route',
      'data': {'sessionId': 'target'},
    });
    await tester.pump();
    gateway.completeSessions(sessions);
    await tester.pumpAndSettle();

    expect(controller.sessionId, 'target');
    expect(controller.fromNotification, isTrue);
    expect(controller.revealSelectedSession, isTrue);
    expect(
      gateway.calls
          .where((call) => call.$1 == 'watch')
          .map((call) => call.$2['sessionId']),
      ['target'],
    );

    await _disposeApp(tester, gateway);
  });

  testWidgets('an explicit selection during bootstrap is not replaced later', (
    tester,
  ) async {
    _setSize(tester, 390);
    final sessions = [sessionRow('first'), sessionRow('second')];
    final gateway = StartupGateway(sessions: sessions, delaySessions: true);
    final controller = LiveController(gateway, showing: 'engine');
    await _showApp(tester, controller);
    await gateway.sessionsRequestStarted.future.timeout(
      const Duration(seconds: 2),
    );

    await controller.open('second');
    await tester.pumpAndSettle();
    expect(controller.sessionId, 'second');
    expect(find.byType(MobileTabs), findsNothing);

    gateway.completeSessions(sessions);
    await tester.pumpAndSettle();

    expect(controller.sessionId, 'second');
    expect(controller.revealSelectedSession, isTrue);
    expect(
      gateway.calls
          .where((call) => call.$1 == 'watch')
          .map((call) => call.$2['sessionId']),
      ['second'],
    );

    await _disposeApp(tester, gateway);
  });
  testWidgets('account replacement during bootstrap retains polling', (
    tester,
  ) async {
    final gateway = StartupGateway(delaySessions: true);
    final controller = LiveController(gateway, showing: 'engine');
    final boot = controller.boot();
    await gateway.sessionsRequestStarted.future;
    await controller.unpair();
    gateway.completeSessions();
    await boot;
    expect(controller.origin, isNull);
    expect(controller.sessionId, isNull);
    gateway.handler = (method, args) async {
      if (method == 'pair') {
        return {
          'origin': 'https://new-gateway.example',
          'clientId': 'new-phone',
        };
      }
      return gateway.normal(method, args);
    };
    await controller.pair('replacement');
    final before = gateway.calls
        .where(
          (call) => call.$1 == 'request' && call.$2['path'] == '/api/sessions',
        )
        .length;
    await tester.pump(const Duration(seconds: 20));
    expect(
      gateway.calls
          .where(
            (call) =>
                call.$1 == 'request' && call.$2['path'] == '/api/sessions',
          )
          .length,
      before + 1,
    );
    expect(controller.origin, 'https://new-gateway.example');
    controller.dispose();
    await gateway.stream.close();
  });
}

void _setSize(WidgetTester tester, double width) {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 900);
  addTearDown(tester.view.reset);
}

Future<void> _showApp(WidgetTester tester, LiveController controller) async {
  await tester.pumpWidget(MobileApp(theme: theme, controller: controller));
}

Future<void> _disposeApp(WidgetTester tester, StartupGateway gateway) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pump();
  await gateway.stream.close();
}

List<String> _readRequests(StartupGateway gateway) => gateway.calls
    .where(
      (call) => call.$1 == 'request' && '${call.$2['path']}'.endsWith('/read'),
    )
    .map((call) => '${call.$2['path']}')
    .toList();

Future<void> _finishOnboarding(WidgetTester tester) async {
  final button = find.byKey(const Key('finish-onboarding'));
  await tester.scrollUntilVisible(
    button,
    300,
    scrollable: find.byType(Scrollable).first,
  );
  await tester.pumpAndSettle();
  await tester.ensureVisible(button);
  await tester.pumpAndSettle();
  await tester.tap(button);
  await tester.pumpAndSettle();
}
