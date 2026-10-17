// New backend contracts through the real Android bridge and Flutter controls.
// Start real_gateway.ts --git with fresh Rust binaries; all data is synthetic.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/approval_mode_control.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/workspace_project_links.dart';
import 'package:pirc_mobile/live/web_controls.dart';
import 'package:pirc_mobile/theme.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'native approval controls and project links persist on the new Rust backend',
    (t) async {
      expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), isTrue);
      const link = String.fromEnvironment('PIRC_PAIR_LINK');
      expect(link, isNotEmpty);
      final g = Gateway(), c = LiveController(g);
      final theme = await PircTheme.load();
      String? session;
      Future<void> until(bool Function() ready, String step) async {
        for (var i = 0; i < 200 && !ready(); i++) {
          await t.pump(const Duration(milliseconds: 100));
        }
        expect(
          ready(),
          isTrue,
          reason: '$step; ${c.actionError ?? c.error ?? c.connection}',
        );
        expect(t.takeException(), isNull, reason: step);
      }

      Future<void> tap(Finder finder) async {
        expect(finder, findsOneWidget);
        await t.ensureVisible(finder);
        await t.pumpAndSettle();
        await t.tap(finder);
        await t.pumpAndSettle();
      }

      Future<void> serverMode(String expected) async {
        Json agent = {};
        for (var i = 0; i < 60; i++) {
          agent = obj(
            (await g.request('${sessionPath(session!)}/snapshot'))['agent'],
          );
          if (agent['approvalMode'] == expected) break;
          await t.pump(const Duration(milliseconds: 100));
        }
        expect(agent['approvalMode'], expected);
        await until(
          () => c.approvalMode == expected,
          'live approval mode $expected',
        );
      }

      try {
        await g.call('pair', {'link': link});
        await g.call('completeOnboarding');
        await c.boot();
        final project = await c.createWorkspace({
          'nodeId': 'chat',
          'kind': 'chat',
          'displayName': 'Backend phase 4 integration',
        });
        final projectId = '${project['id']}';
        expect(c.workspaces.any((w) => w['id'] == 'git:fixture'), isTrue);
        await c.create(projectId);
        session = c.sessionId;
        await t.pumpWidget(
          MaterialApp(
            theme: theme.build(Brightness.light),
            home: Scaffold(
              body: SingleChildScrollView(
                child: Column(
                  children: [
                    ApprovalModeControl(controller: c),
                    WorkspaceProjectLinks(
                      controller: c,
                      workspaceId: projectId,
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
        await until(
          () => c.canControl && c.approvalMode != null,
          'mode snapshot and control lease',
        );
        expect(c.state['defaultApprovalMode'], 'auto');
        await tap(find.byTooltip('Approval mode'));
        await tap(find.text('Read-only'));
        await serverMode('read-only');
        await tap(find.byTooltip('Approval mode'));
        await tap(find.text('Full access'));
        expect(find.text('Give this session full access?'), findsOneWidget);
        await tap(find.text('Cancel'));
        await serverMode('read-only');
        await tap(find.byTooltip('Approval mode'));
        await tap(find.text('Full access'));
        await tap(find.text('Allow full access'));
        await serverMode('full-access');
        await c.refreshSession();
        expect(c.approvalMode, 'full-access');
        await tap(find.byTooltip('Approval mode'));
        await tap(find.text('Auto'));
        await serverMode('auto');
        await until(
          () => find.byType(Checkbox).evaluate().isNotEmpty,
          'directory link choices',
        );
        await tap(find.byType(Checkbox));
        await tap(
          find.byWidgetPredicate((w) => w is WebButton && w.label == 'Save'),
        );
        await until(
          () => find.text('Linked workspaces saved.').evaluate().isNotEmpty,
          'links saved',
        );
        final saved = rows(
          (await g.request('/api/workspaces/${enc(projectId)}/links'))['links'],
        );
        expect(saved.map((row) => row['workspaceId']), ['git:fixture']);
        await tap(find.byType(Checkbox));
        await tap(
          find.byWidgetPredicate((w) => w is WebButton && w.label == 'Save'),
        );
        await until(
          () => find.text('Linked workspaces saved.').evaluate().isNotEmpty,
          'links cleared',
        );
        expect(
          rows(
            (await g.request(
              '/api/workspaces/${enc(projectId)}/links',
            ))['links'],
          ),
          isEmpty,
        );
        debugPrint(
          'BACKEND_PHASE4:approval read-only/full-access/auto persisted; project links saved/cleared; real Rust and native bridge PASS',
        );
      } finally {
        await t.pumpWidget(const SizedBox());
        if (session != null) {
          await g.request(sessionPath(session), method: 'DELETE');
        }
        c.dispose();
        await g.call('unpair');
      }
    },
  );
}
