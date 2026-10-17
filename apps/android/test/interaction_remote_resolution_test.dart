import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/interaction.dart';
import 'live_test.dart' show FakeGateway, theme;

Json question({String epoch = 'epoch-1'}) => {
  'id': 'question-1',
  'epoch': epoch,
  'kind': 'confirm',
  'status': 'pending',
  'title': 'Continue?',
  'options': [
    {'value': 'yes', 'label': 'Yes'},
  ],
};

Json snapshot(List<Json> interactions) => {
  'session': {'id': 'session-1', 'name': 'Test'},
  'interactions': interactions,
};

LiveController readyController(FakeGateway gateway, Json q) =>
    LiveController(gateway)
      ..sessionId = 'session-1'
      ..connection = 'live'
      ..control = {'held': true}
      ..origin = 'https://gateway.test'
      ..pairingStamp = 'pairing-1'
      ..state = snapshot([q]);

Widget app(Widget child) => MaterialApp(
  theme: theme.build(Brightness.light),
  home: Scaffold(body: child),
);

Future<void> openQuestionModal(
  WidgetTester tester,
  LiveController controller,
  Json q, {
  bool requiresManualReview = false,
  String? notificationPairingStamp,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: theme.build(Brightness.light),
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () => showModalBottomSheet<void>(
              context: context,
              isScrollControlled: true,
              useSafeArea: true,
              builder: (_) => QuestionSheet(
                controller: controller,
                question: q,
                requiresManualReview: requiresManualReview,
                notificationPairingStamp: notificationPairingStamp,
              ),
            ),
            child: const Text('Open notification'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Open notification'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'inline card withdraws actions after an exact remote resolution',
    (tester) async {
      final gateway = FakeGateway(), q = question();
      gateway.snapshot = snapshot([q]);
      final controller = readyController(gateway, q);
      var answerCalls = 0;
      gateway.handler = (method, args) async {
        if (method == 'answer') answerCalls++;
        return gateway.normal(method, args);
      };

      await tester.pumpWidget(
        app(QuestionSheet(controller: controller, question: q, embedded: true)),
      );
      await tester.pumpAndSettle();
      expect(find.text('Yes, continue'), findsOneWidget);

      // Keep the old button in the tree for the immediate stale-tap race.
      controller.state = snapshot([]);
      controller.changed();
      await tester.tap(find.text('Yes, continue'));
      await tester.pumpAndSettle();

      expect(answerCalls, 0);
      expect(find.text('此問題已處理或已失效'), findsOneWidget);
      expect(find.text('Yes, continue'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      await gateway.stream.close();
    },
  );

  testWidgets(
    'read-only embedded question survives unrelated updates with incomplete scope',
    (tester) async {
      final gateway = FakeGateway(), q = question();
      final controller = readyController(gateway, q)
        ..origin = null
        ..pairingStamp = null;
      var answerCalls = 0;
      gateway.handler = (method, args) async {
        if (method == 'answer') answerCalls++;
        return gateway.normal(method, args);
      };

      await tester.pumpWidget(
        app(QuestionSheet(controller: controller, question: q, embedded: true)),
      );
      expect(find.text('Continue?'), findsOneWidget);
      expect(find.text('Yes, continue'), findsOneWidget);

      controller.state = {
        ...controller.state,
        'run': {'id': 'run-2', 'status': 'running'},
      };
      controller.changed();
      await tester.pumpAndSettle();

      expect(find.text('Continue?'), findsOneWidget);
      expect(find.text('Yes, continue'), findsOneWidget);
      await tester.tap(find.text('Yes, continue'));
      await tester.pumpAndSettle();
      expect(answerCalls, 0);

      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      await gateway.stream.close();
    },
  );

  testWidgets(
    'modal stays open with a generic handled notice after remote answer',
    (tester) async {
      final gateway = FakeGateway(), q = question();
      gateway.snapshot = snapshot([q]);
      final controller = readyController(gateway, q);
      await openQuestionModal(tester, controller, q);
      expect(find.text('Yes, continue'), findsOneWidget);

      controller.state = snapshot([]);
      controller.changed();
      await tester.pumpAndSettle();

      expect(find.text('此問題已處理或已失效'), findsOneWidget);
      expect(find.text('Yes, continue'), findsNothing);
      expect(find.textContaining('another device'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      await gateway.stream.close();
    },
  );

  testWidgets(
    'a resolution arriving before notification refresh cannot be overwritten',
    (tester) async {
      final gateway = FakeGateway(), q = question();
      gateway.snapshot = snapshot([q]);
      final controller = readyController(gateway, q);
      final refreshResponse = Completer<dynamic>();
      gateway.handler = (method, args) => method == 'refresh'
          ? refreshResponse.future
          : gateway.normal(method, args);

      await tester.pumpWidget(
        MaterialApp(
          theme: theme.build(Brightness.light),
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => showModalBottomSheet<void>(
                  context: context,
                  builder: (_) =>
                      QuestionSheet(controller: controller, question: q),
                ),
                child: const Text('Open notification'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open notification'));
      await tester.pump();

      controller.state = snapshot([]);
      controller.changed();
      await tester.pump();
      refreshResponse.complete(snapshot([q]));
      await tester.pumpAndSettle();

      expect(find.text('此問題已處理或已失效'), findsOneWidget);
      expect(find.text('Yes, continue'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      await gateway.stream.close();
    },
  );

  testWidgets('an offline empty snapshot is not treated as completion', (
    tester,
  ) async {
    final gateway = FakeGateway(), q = question();
    gateway.snapshot = snapshot([q]);
    final controller = readyController(gateway, q);
    var answerCalls = 0;
    gateway.handler = (method, args) async {
      if (method == 'answer') answerCalls++;
      return gateway.normal(method, args);
    };
    await openQuestionModal(tester, controller, q);

    controller.connection = 'offline';
    controller.changed();
    controller.state = snapshot([]);
    controller.changed();
    await tester.pumpAndSettle();
    expect(find.text('Yes, continue'), findsOneWidget);
    final yesButton = find.ancestor(
      of: find.text('Yes, continue'),
      matching: find.byType(TextButton),
    );
    expect(tester.widget<TextButton>(yesButton).onPressed, isNull);
    await tester.tap(find.text('Yes, continue'));
    await tester.pumpAndSettle();
    expect(answerCalls, 0);
    expect(find.text('此問題已處理'), findsNothing);

    controller.connection = 'live';
    controller.changed();
    await tester.pumpAndSettle();
    expect(find.text('Yes, continue'), findsOneWidget);
    expect(find.text('此問題已處理'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    controller.dispose();
    await gateway.stream.close();
  });

  testWidgets(
    'a stale 4xx refreshes exact state without resending the answer',
    (tester) async {
      final gateway = FakeGateway(), q = question();
      gateway.snapshot = snapshot([]);
      final controller = readyController(gateway, q);
      var answerCalls = 0, refreshCalls = 0, controlCalls = 0;
      gateway.handler = (method, args) async {
        if (method == 'answer') {
          answerCalls++;
          throw PlatformException(code: 'HTTP_409');
        }
        if (method == 'refresh') {
          refreshCalls++;
          return snapshot([]);
        }
        if (method == 'control') controlCalls++;
        return gateway.normal(method, args);
      };

      await tester.pumpWidget(
        app(QuestionSheet(controller: controller, question: q, embedded: true)),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Yes, continue'));
      await tester.pumpAndSettle();

      expect(answerCalls, 1);
      expect(refreshCalls, 1);
      expect(controlCalls, 0);
      expect(find.text('此問題已處理或已失效'), findsOneWidget);
      expect(find.text('Yes, continue'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      await gateway.stream.close();
    },
  );

  testWidgets(
    'a stale 4xx with a still-pending question reports lost control',
    (tester) async {
      final gateway = FakeGateway(), q = question();
      gateway.snapshot = snapshot([q]);
      final controller = readyController(gateway, q);
      var answerCalls = 0;
      gateway.handler = (method, args) async {
        if (method == 'answer') {
          answerCalls++;
          throw PlatformException(code: 'HTTP_409');
        }
        if (method == 'refresh') return snapshot([q]);
        if (method == 'control') return {'held': false};
        return gateway.normal(method, args);
      };

      await tester.pumpWidget(
        app(QuestionSheet(controller: controller, question: q, embedded: true)),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Yes, continue'));
      await tester.pumpAndSettle();

      expect(answerCalls, 1);
      expect(
        find.text('Control changed. Check the latest state before answering.'),
        findsOneWidget,
      );
      expect(find.text('此問題已處理'), findsNothing);
      expect(find.text('Yes, continue'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      await gateway.stream.close();
    },
  );

  testWidgets('a fresh resolution withdraws actions during an unknown answer', (
    tester,
  ) async {
    final gateway = FakeGateway(), q = question();
    gateway.snapshot = snapshot([q]);
    final controller = readyController(gateway, q);
    final answerResult = Completer<dynamic>();
    var answerCalls = 0;
    gateway.handler = (method, args) async {
      if (method == 'answer') {
        answerCalls++;
        return answerResult.future;
      }
      if (method == 'reconcileAnswer') {
        return {
          'sessionId': 'session-1',
          'status': 'resolved',
          'interaction': null,
        };
      }
      return gateway.normal(method, args);
    };

    await tester.pumpWidget(
      app(QuestionSheet(controller: controller, question: q, embedded: true)),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Yes, continue'));
    await tester.pump();

    controller.state = snapshot([]);
    controller.changed();
    await tester.pump();
    expect(find.text('此問題已處理或已失效'), findsOneWidget);
    expect(find.text('Yes, continue'), findsNothing);

    answerResult.completeError(PlatformException(code: 'HTTP_503'));
    await tester.pumpAndSettle();
    expect(answerCalls, 1);
    expect(find.text('此問題已處理或已失效'), findsOneWidget);
    expect(find.text('Check latest state'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    controller.dispose();
    await gateway.stream.close();
  });

  testWidgets(
    'account switch clears the old question without claiming completion',
    (tester) async {
      final gateway = FakeGateway(), q = question();
      gateway.snapshot = snapshot([q]);
      final controller = readyController(gateway, q);
      await tester.pumpWidget(
        app(QuestionSheet(controller: controller, question: q, embedded: true)),
      );
      await tester.pumpAndSettle();

      await controller.unpair();
      await tester.pumpAndSettle();
      controller.state = snapshot([]);
      controller.changed();
      await tester.pumpAndSettle();

      expect(find.text('Yes, continue'), findsNothing);
      expect(find.text('此問題已處理'), findsNothing);
      expect(find.text('此問題已處理或已失效'), findsNothing);
      expect(
        find.text('The connection changed. Reopen this question to continue.'),
        findsOneWidget,
      );
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      await gateway.stream.close();
    },
  );

  testWidgets('legacy ID-only notification remains read-only for review', (
    tester,
  ) async {
    final gateway = FakeGateway(), q = question();
    gateway.snapshot = snapshot([q]);
    final controller = readyController(gateway, q);
    await openQuestionModal(tester, controller, q, requiresManualReview: true);

    expect(find.text('Yes, continue'), findsOneWidget);
    expect(
      tester
          .widget<TextButton>(find.widgetWithText(TextButton, 'Yes, continue'))
          .onPressed,
      isNull,
    );
    expect(find.text('Close and review in conversation'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    controller.dispose();
    await gateway.stream.close();
  });

  testWidgets(
    'a notification from another pairing is read-only and not refreshed',
    (tester) async {
      final gateway = FakeGateway(), q = question();
      gateway.snapshot = snapshot([q]);
      final controller = readyController(gateway, q);
      var refreshCalls = 0, controlCalls = 0;
      gateway.handler = (method, args) async {
        if (method == 'refresh') refreshCalls++;
        if (method == 'control') controlCalls++;
        return gateway.normal(method, args);
      };

      await openQuestionModal(
        tester,
        controller,
        q,
        notificationPairingStamp: 'old-pairing',
      );

      expect(refreshCalls, 0);
      expect(controlCalls, 0);
      expect(find.text('Yes, continue'), findsNothing);
      expect(
        find.text(
          'This notification belongs to a different connection. Open the current conversation to review its questions.',
        ),
        findsOneWidget,
      );
      expect(find.text('Close and review in conversation'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      await gateway.stream.close();
    },
  );

  testWidgets(
    'HTTP outcome_unknown stays locked until explicit reconciliation',
    (tester) async {
      final gateway = FakeGateway(), q = question();
      gateway.snapshot = snapshot([q]);
      final controller = readyController(gateway, q);
      var answerCalls = 0, refreshCalls = 0, reconcileCalls = 0;
      gateway.handler = (method, args) async {
        if (method == 'answer') {
          answerCalls++;
          throw PlatformException(
            code: 'HTTP_409',
            details: {'code': 'outcome_unknown'},
          );
        }
        if (method == 'refresh') refreshCalls++;
        if (method == 'reconcileAnswer') {
          reconcileCalls++;
          return {
            'sessionId': 'session-1',
            'status': 'pending',
            'interaction': q,
          };
        }
        return gateway.normal(method, args);
      };

      await tester.pumpWidget(
        app(QuestionSheet(controller: controller, question: q, embedded: true)),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Yes, continue'));
      await tester.pumpAndSettle();

      expect(answerCalls, 1);
      expect(refreshCalls, 0);
      expect(reconcileCalls, 0);
      expect(find.text('Check latest state'), findsOneWidget);
      expect(find.text('Yes, continue'), findsOneWidget);
      expect(
        tester
            .widget<TextButton>(
              find.widgetWithText(TextButton, 'Yes, continue'),
            )
            .onPressed,
        isNull,
      );

      await tester.tap(find.text('Check latest state'));
      await tester.pumpAndSettle();
      expect(answerCalls, 1);
      expect(refreshCalls, 0);
      expect(reconcileCalls, 1);
      expect(find.text('Yes, continue'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      await gateway.stream.close();
    },
  );
}
