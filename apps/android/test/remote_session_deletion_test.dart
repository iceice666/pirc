import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/workspace_page.dart';
import 'live_test.dart' show FakeGateway, theme;

Json deletedEvent(String id) => {
  'type': 'sessionDeleted',
  'sessionId': id,
  'data': {'sessionId': id},
};
void main() {
  for (final width in [390.0, 1024.0]) {
    for (final brightness in Brightness.values) {
      testWidgets(
        'remote deletion returns to workspace and cannot restore stale state $width $brightness',
        (t) async {
          t.view.devicePixelRatio = 1;
          t.view.physicalSize = Size(width, 900);
          addTearDown(t.view.reset);
          final g = FakeGateway();
          g.handler = (method, args) async {
            if (method == 'request' && args['path'] == '/api/workspaces') {
              return {
                'workspaces': [
                  {'id': 'w', 'displayName': 'My chats', 'kind': 'chat'},
                ],
              };
            }
            return g.normal(method, args);
          };
          final c = LiveController(g);
          await t.pumpWidget(MobileApp(theme: theme, controller: c));
          await t.pumpAndSettle();
          c.preferences['appearance'] = brightness.name;
          await c.open('s');
          g.publish('s');
          await t.pumpAndSettle();
          c.editDraft('unsent remote deletion draft');
          c.attachments = [
            {'id': 'attachment', 'name': 'note.txt'},
          ];
          c.panelState['files'] = {'path': 'secret.txt'};
          g.stream.add(deletedEvent('s'));
          await t.pumpAndSettle();
          expect(c.sessionId, isNull);
          expect(c.draft, isEmpty);
          expect(c.state, isEmpty);
          expect(c.attachments, isEmpty);
          expect(c.control, isEmpty);
          expect(c.panelState, isEmpty);
          expect(c.error, isNull);
          expect(find.byType(WorkspacePage).hitTestable(), findsOneWidget);
          expect(
            t.widget<WorkspacePage>(find.byType(WorkspacePage)).workspaceId,
            'w',
          );
          expect(
            g.calls.where(
              (call) => call.$1 == 'request' && call.$2['method'] == 'DELETE',
            ),
            isEmpty,
          );
          expect(g.drafts['s'], '');
          g.publish('s');
          await c.refreshList();
          await t.pumpAndSettle();
          expect(c.sessionId, isNull);
          expect(c.state, isEmpty);
          expect(c.sessions.where((s) => s['id'] == 's'), isEmpty);
          expect(t.takeException(), isNull);
          await t.pumpWidget(const SizedBox());
          await g.stream.close();
        },
      );
    }
  }
  testWidgets('terminal draft clear waits for an in-flight save', (t) async {
    final g = FakeGateway(), pending = Completer<dynamic>();
    final writes = <String>[];
    g.handler = (method, args) async {
      if (method == 'draft' && args['text'] == 'old pending write') {
        writes.add('old-start');
        await pending.future;
        writes.add('old-finish');
      }
      if (method == 'draft' && args['text'] == '') writes.add('clear');
      return g.normal(method, args);
    };
    final c = LiveController(g);
    await c.boot();
    await c.open('s');
    g.publish('s');
    writes.clear();
    c.editDraft('old pending write');
    await t.pump(const Duration(milliseconds: 250));
    expect(writes, ['old-start']);
    g.stream.add(deletedEvent('s'));
    await t.pump();
    expect(c.sessionId, isNull);
    expect(writes, ['old-start']);
    pending.complete(null);
    await t.pumpAndSettle();
    expect(writes, ['old-start', 'old-finish', 'clear']);
    expect(g.drafts['s'], '');
    c.dispose();
    await g.stream.close();
  });
  testWidgets(
    'late deletion event and DELETE acknowledgement preserve a newly selected chat',
    (t) async {
      final g = FakeGateway(), ack = Completer<Json>();
      g.handler = (method, args) async {
        if (method == 'request' && args['method'] == 'DELETE') {
          return ack.future;
        }
        if (method == 'request' && args['path'] == '/api/workspaces') {
          return {
            'workspaces': [
              {'id': 'w', 'displayName': 'Chats', 'kind': 'chat'},
            ],
          };
        }
        return g.normal(method, args);
      };
      final c = LiveController(g);
      await c.boot();
      await c.open('s');
      g.publish('s');
      final removing = c.deleteChat('s');
      g.stream.add(deletedEvent('s'));
      await c.open('next');
      c.editDraft('new draft');
      g.stream.add(deletedEvent('s'));
      ack.complete({});
      await removing;
      await t.pump();
      expect(c.sessionId, 'next');
      expect(c.draft, 'new draft');
      expect(c.routePage, isNull);
      expect(g.calls.where((call) => call.$1 == 'unwatch'), hasLength(1));
      c.dispose();
      await g.stream.close();
    },
  );
}
