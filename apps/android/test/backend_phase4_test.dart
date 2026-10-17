import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/approval_mode_control.dart';
import 'package:pirc_mobile/live/conversation_composer.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/interaction_card.dart';
import 'package:pirc_mobile/live/session_row.dart';
import 'live_test.dart' show FakeGateway, theme;

Widget shell(Widget child, {double scale = 1}) => MaterialApp(
  theme: theme.build(Brightness.light),
  builder: (context, child) => MediaQuery(
    data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(scale)),
    child: child!,
  ),
  home: Scaffold(body: child),
);
Future<LiveController> ready(FakeGateway g) async {
  g.snapshot = {
    ...g.snapshot,
    'approvalMode': 'auto',
    'defaultApprovalMode': 'auto',
  };
  final c = LiveController(g);
  await c.boot();
  await c.open('s');
  g.publish('s');
  return c;
}

void main() {
  test('approval mode requires control and an accepted command', () async {
    final g = FakeGateway(), c = await ready(g);
    c.control = {};
    await c.changeApprovalMode('read-only');
    expect(g.calls.where((x) => x.$1 == 'command'), isEmpty);
    expect(c.approvalMode, 'auto');
    c.control = {'held': true};
    g.handler = (m, a) async => m == 'command'
        ? {'status': 'rejected', 'message': 'Denied'}
        : g.normal(m, a);
    await c.changeApprovalMode('read-only');
    expect(c.approvalMode, 'auto');
    expect(c.actionError, 'Denied');
    g.handler = null;
    await c.changeApprovalMode('read-only');
    expect(c.approvalMode, 'read-only');
    expect(obj(g.calls.lastWhere((x) => x.$1 == 'command').$2['payload']), {
      'type': 'set_approval_mode',
      'mode': 'read-only',
    });
    c.dispose();
    await g.stream.close();
  });
  test(
    'late approval receipt cannot overwrite remote state or another session',
    () async {
      final g = FakeGateway(), c = await ready(g);
      var gate = Completer<Json>();
      g.handler = (m, a) async => m == 'command' ? gate.future : g.normal(m, a);
      final pending = c.changeApprovalMode('full-access');
      g.snapshot = {...g.snapshot, 'approvalMode': 'read-only'};
      g.publish('s');
      gate.complete({'status': 'accepted'});
      await pending;
      expect(c.approvalMode, 'read-only');
      gate = Completer<Json>();
      final switched = c.changeApprovalMode('full-access');
      await c.open('other');
      g.publish('other');
      gate.complete({'status': 'accepted'});
      await switched;
      expect(c.sessionId, 'other');
      expect(c.approvalMode, 'read-only');
      c.dispose();
      await g.stream.close();
    },
  );
  test('reverse approval receipts keep the last choice', () async {
    final g = FakeGateway(), c = await ready(g);
    final first = Completer<Json>(), second = Completer<Json>();
    var count = 0;
    g.handler = (m, a) async => m == 'command'
        ? (++count == 1 ? first.future : second.future)
        : g.normal(m, a);
    final a = c.changeApprovalMode('full-access');
    final b = c.changeApprovalMode('read-only');
    second.complete({'status': 'accepted'});
    await b;
    first.complete({'status': 'accepted'});
    await a;
    expect(c.approvalMode, 'read-only');
    c.dispose();
    await g.stream.close();
  });
  test('unknown approval outcome blocks another change', () async {
    final g = FakeGateway(), c = await ready(g);
    g.handler = (m, a) async => m == 'command'
        ? {'status': 'outcome_unknown', 'message': 'Unknown'}
        : g.normal(m, a);
    await c.changeApprovalMode('full-access');
    await c.changeApprovalMode('read-only');
    expect(c.approvalMode, 'auto');
    expect(c.unknownCommand, isTrue);
    expect(g.calls.where((x) => x.$1 == 'command').length, 1);
    c.dispose();
    await g.stream.close();
  });
  testWidgets('full access requires confirmation; cancel sends nothing', (
    t,
  ) async {
    final g = FakeGateway(), c = await ready(g);
    await t.pumpWidget(shell(ApprovalModeControl(controller: c)));
    await t.tap(find.byTooltip('Approval mode'));
    await t.pumpAndSettle();
    await t.tap(find.text('Full access'));
    await t.pumpAndSettle();
    expect(find.text('Give this session full access?'), findsOneWidget);
    expect(g.calls.where((x) => x.$1 == 'command'), isEmpty);
    await t.tap(find.text('Cancel'));
    await t.pumpAndSettle();
    expect(c.approvalMode, 'auto');
    expect(g.calls.where((x) => x.$1 == 'command'), isEmpty);
    await t.tap(find.byTooltip('Approval mode'));
    await t.pumpAndSettle();
    await t.tap(find.text('Full access'));
    await t.pumpAndSettle();
    await t.tap(find.text('Allow full access'));
    await t.pumpAndSettle();
    expect(c.approvalMode, 'full-access');
    await t.pumpWidget(const SizedBox());
    c.dispose();
    await g.stream.close();
  });
  testWidgets('an open dialog cannot authorize a newly selected session', (
    t,
  ) async {
    final g = FakeGateway(), c = await ready(g);
    await t.pumpWidget(shell(ApprovalModeControl(controller: c)));
    await t.tap(find.byTooltip('Approval mode'));
    await t.pumpAndSettle();
    await t.tap(find.text('Full access'));
    await t.pumpAndSettle();
    await c.open('other');
    g.publish('other');
    await t.tap(find.text('Allow full access'));
    await t.pumpAndSettle();
    expect(g.calls.where((x) => x.$1 == 'command'), isEmpty);
    expect(c.approvalMode, 'auto');
    await t.pumpWidget(const SizedBox());
    c.dispose();
    await g.stream.close();
  });
  testWidgets('warning and three selectors fit a narrow enlarged composer', (
    t,
  ) async {
    t.view.devicePixelRatio = 1;
    t.view.physicalSize = const Size(320, 900);
    addTearDown(t.view.reset);
    final g = FakeGateway(), c = await ready(g), text = TextEditingController();
    c.state = {...c.state, 'approvalMode': 'full-access'};
    await t.pumpWidget(
      shell(ConversationComposer(controller: c, text: text), scale: 2),
    );
    await t.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('composer-full-access-notice')),
      findsOneWidget,
    );
    expect(find.byTooltip('Approval mode'), findsOneWidget);
    expect(t.takeException(), isNull);
    await t.pumpWidget(const SizedBox());
    text.dispose();
    c.dispose();
    await g.stream.close();
  });
  for (final checked in [false, true]) {
    for (final accepted in [false, true]) {
      testWidgets('delegation checked=$checked accepted=$accepted', (t) async {
        Json? answer;
        await t.pumpWidget(
          shell(
            NativeInteractionCard(
              question: {
                'id': 'q',
                'epoch': 'e',
                'kind': 'confirm',
                'status': 'pending',
                'title': 'Delegate?',
                'userRequestChoice': {
                  'label': 'Send as my request',
                  'checked': checked,
                },
              },
              onAnswer: (value) async {
                answer = value;
              },
            ),
          ),
        );
        await t.pumpAndSettle();
        expect(
          t.widget<CheckboxListTile>(find.byType(CheckboxListTile)).value,
          checked,
        );
        await t.tap(find.text(accepted ? 'Yes, continue' : 'No'));
        await t.pumpAndSettle();
        expect(answer, {
          'confirmed': accepted,
          if (accepted && checked) 'asUserRequest': true,
        });
        await t.pumpWidget(const SizedBox());
      });
    }
  }
  testWidgets(
    'delegation choice resets with question epoch and disables when locked',
    (t) async {
      Json? answer;
      Widget card(String epoch, {bool disabled = false}) => shell(
        NativeInteractionCard(
          question: {
            'id': 'q',
            'epoch': epoch,
            'kind': 'confirm',
            'status': 'pending',
            'title': 'Delegate?',
            'userRequestChoice': {
              'label': 'Send as my request',
              'checked': false,
            },
          },
          disabled: disabled,
          onAnswer: (value) async {
            answer = value;
          },
        ),
      );
      await t.pumpWidget(card('one'));
      await t.tap(find.byType(CheckboxListTile));
      await t.pump();
      expect(
        t.widget<CheckboxListTile>(find.byType(CheckboxListTile)).value,
        isTrue,
      );
      await t.pumpWidget(card('two'));
      expect(
        t.widget<CheckboxListTile>(find.byType(CheckboxListTile)).value,
        isFalse,
      );
      await t.pumpWidget(card('two', disabled: true));
      expect(
        t.widget<CheckboxListTile>(find.byType(CheckboxListTile)).onChanged,
        isNull,
      );
      await t.tap(find.text('Yes, continue'));
      await t.pump();
      expect(answer, isNull);
      await t.pumpWidget(const SizedBox());
    },
  );
  for (final status in ['completed', 'failed']) {
    testWidgets('delegated task $status is visible', (t) async {
      final g = FakeGateway(), c = await ready(g);
      await t.pumpWidget(
        shell(
          SessionRow(
            controller: c,
            session: {
              'id': 'd',
              'name': 'Delegated task',
              'workspaceId': 'w',
              'origin': {
                'kind': 'delegation',
                'title': 'Research',
                'status': status,
              },
            },
            onOpen: () {},
            onDeleted: (_) {},
          ),
        ),
      );
      await t.pumpAndSettle();
      expect(
        find.text(status == 'completed' ? 'Done' : 'Failed'),
        findsOneWidget,
      );
      expect(
        find.byTooltip(
          'Delegated: Research (${status == 'completed' ? 'finished' : 'failed'})',
        ),
        findsOneWidget,
      );
      expect(t.takeException(), isNull);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    });
  }
}
