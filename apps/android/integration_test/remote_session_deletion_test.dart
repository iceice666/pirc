import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/workspace_page.dart';
import 'package:pirc_mobile/theme.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'browser client deletes the Android active chat through real Gateway events',
    (t) async {
      expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), isTrue);
      final g = Gateway();
      await g.call('pair', {
        'link': const String.fromEnvironment('PIRC_PAIR_LINK'),
      });
      await g.call('completeOnboarding');
      final c = LiveController(g);
      String? created;
      bool remotelyDeleted = false;
      final events = <Json>[];
      final observed = g.events.listen(events.add);
      Future<void> until(bool Function() ready, String label) async {
        for (var i = 0; i < 250 && !ready(); i++) {
          await t.pump(const Duration(milliseconds: 200));
        }
        expect(ready(), isTrue, reason: '$label: ${c.error}');
        expect(t.takeException(), isNull, reason: label);
      }

      try {
        await t.pumpWidget(
          MobileApp(theme: await PircTheme.load(), controller: c),
        );
        await until(
          () =>
              !c.booting &&
              !c.initializing &&
              c.workspaces.any((w) => w['kind'] == 'chat'),
          'load chat workspace',
        );
        final workspace =
            c.workspaces.firstWhere((w) => w['kind'] == 'chat')['id'] as String;
        final response = await g.request(
          '/api/sessions',
          method: 'POST',
          body: {'workspaceId': workspace},
        );
        created = obj(response['session'])['id'] as String;
        await g.request(
          sessionPath(created),
          method: 'PATCH',
          body: {'name': 'Remote deletion acceptance'},
        );
        await c.refreshList();
        await c.open(created);
        await until(
          () => c.connection == 'live' && c.state.isNotEmpty,
          'watch created chat',
        );
        c.editDraft('draft removed with remotely deleted conversation');
        await c.flushDraft();
        expect(c.draft, 'draft removed with remotely deleted conversation');
        debugPrint('REMOTE_DELETE:ready:$created');
        await until(
          () =>
              c.sessionId == null &&
              find.byType(WorkspacePage).hitTestable().evaluate().isNotEmpty,
          'remote deletion returns to workspace',
        );
        remotelyDeleted = true;
        expect(
          events.where(
            (e) => e['type'] == 'sessionDeleted' && e['sessionId'] == created,
          ),
          hasLength(1),
        );
        expect(c.draft, isEmpty);
        expect(c.state, isEmpty);
        expect(c.error, isNull);
        expect(c.control, isEmpty);
        expect(c.attachments, isEmpty);
        expect(
          t.widget<WorkspacePage>(find.byType(WorkspacePage)).workspaceId,
          workspace,
        );
        await c.refreshList();
        expect(c.sessions.where((s) => s['id'] == created), isEmpty);
        // watch returns the saved draft; a tombstoned session must not refetch.
        expect(await g.call('watch', {'sessionId': created}), '');
        await t.pump(const Duration(seconds: 2));
        expect(c.sessionId, isNull);
        expect(
          events.where(
            (e) => e['type'] == 'error' && e['sessionId'] == created,
          ),
          isEmpty,
        );
        expect(t.takeException(), isNull);
        debugPrint('REMOTE_DELETE:accepted-workspace-draft-no-404');
      } finally {
        if (created != null && !remotelyDeleted) {
          await g.request(sessionPath(created), method: 'DELETE');
        }
        await observed.cancel();
        await t.pumpWidget(const SizedBox());
        await g.call('unpair');
      }
    },
  );
}
