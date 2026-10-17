// Exercises directory project trust through the real Android gateway and app UI.
// Only run with the private real_gateway.ts --project-trust fixture.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/web_controls.dart';
import 'package:pirc_mobile/live/workspace_page.dart';
import 'package:pirc_mobile/theme.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'directory project trust refreshes a stale config hash without replaying the decision',
    (tester) async {
      expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), isTrue);
      const link = String.fromEnvironment('PIRC_PAIR_LINK');
      const workspaceId = String.fromEnvironment(
        'PIRC_PROJECT_TRUST_WORKSPACE',
      );
      expect(link, isNotEmpty, reason: 'Missing private pairing link.');
      expect(
        workspaceId,
        'git:fixture',
        reason: 'Run the isolated helper with --project-trust.',
      );

      final gateway = Gateway();
      await gateway.call('pair', {'link': link});
      await gateway.call('completeOnboarding');
      final controller = LiveController(gateway);
      final theme = await PircTheme.load();
      final workspacePath = '/api/workspaces/${enc(workspaceId)}';
      const fixtureConfigPath = '/api/parity-project-trust/config';
      const fixtureStatsPath = '/api/parity-project-trust/stats';
      var paired = true;

      Future<void> until(bool Function() ready, String label) async {
        for (var i = 0; i < 150 && !ready(); i++) {
          await tester.pump(const Duration(milliseconds: 100));
        }
        expect(ready(), isTrue, reason: label);
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull, reason: label);
      }

      Future<void> tap(Finder target) async {
        await tester.ensureVisible(target);
        await tester.pumpAndSettle();
        expect(target.hitTestable(), findsOneWidget);
        await tester.tap(target);
        await tester.pumpAndSettle();
      }

      Finder button(String label) => find.byWidgetPredicate(
        (widget) => widget is WebButton && widget.label == label,
      );
      Finder codeContaining(String text) => find.byWidgetPredicate(
        (widget) =>
            widget is SelectableText && (widget.data?.contains(text) ?? false),
      );

      try {
        final workspaces = rows(
          (await gateway.request('/api/workspaces'))['workspaces'],
        );
        final workspace = workspaces.singleWhere(
          (row) => row['id'] == workspaceId,
        );
        expect(
          workspace['kind'],
          'directory',
          reason:
              'The node must register this as an actual directory workspace.',
        );
        await gateway.request(
          fixtureConfigPath,
          method: 'POST',
          body: {'version': 'v1'},
        );
        await gateway.request(
          '$workspacePath/project-trust',
          method: 'POST',
          body: {'trusted': false},
        );
        final statsBaseline = obj(await gateway.request(fixtureStatsPath));
        final initialResponse = await gateway.request(
          '$workspacePath/project-config',
        );
        final initialProject = obj(initialResponse['project']);
        expect(initialProject['empty'], isFalse);
        expect(initialProject['trusted'], isFalse);
        expect(initialProject['hash'], isA<String>());
        expect(obj(initialProject['env'])['PIRC_PARITY_TRUST_FIXTURE'], 'v1');
        expect(statsBaseline['configVersion'], 'v1');

        await tester.pumpWidget(
          MobileApp(theme: theme, controller: controller),
        );
        await until(
          () =>
              !controller.booting &&
              controller.workspaces.any((row) => row['id'] == workspaceId),
          'real gateway boot and directory workspace list',
        );
        await tap(find.text('Work'));
        await tap(find.text('Native Git workspace').first);
        await until(
          () => find.text('Settings').evaluate().isNotEmpty,
          'directory workspace page',
        );
        await tap(
          find.descendant(
            of: find.byType(WorkspacePage),
            matching: find.text('Settings'),
          ),
        );
        await until(
          () =>
              find.text('PROJECT CONFIG').evaluate().isNotEmpty &&
              codeContaining(
                'PIRC_PARITY_TRUST_FIXTURE=v1',
              ).evaluate().isNotEmpty,
          'native project config loaded for review',
        );
        expect(find.text('Not trusted: ignored'), findsOneWidget);
        expect(button('Trust'), findsOneWidget);

        final switched = await gateway.request(
          fixtureConfigPath,
          method: 'POST',
          body: {'version': 'v2'},
        );
        expect(switched['configVersion'], 'v2');

        await tap(button('Trust'));
        await until(
          () =>
              codeContaining(
                'PIRC_PARITY_TRUST_FIXTURE=v2',
              ).evaluate().isNotEmpty &&
              find
                  .text(
                    'The project config changed since it was shown; review it again before trusting it',
                  )
                  .evaluate()
                  .isNotEmpty,
          '409 refreshes the displayed config and reports the rejected stale decision',
        );

        final afterConflict = obj(
          (await gateway.request('$workspacePath/project-config'))['project'],
        );
        expect(afterConflict['hash'], isNot(initialProject['hash']));
        expect(afterConflict['trusted'], isFalse);
        expect(afterConflict['trustedHash'], isNull);
        expect(obj(afterConflict['env'])['PIRC_PARITY_TRUST_FIXTURE'], 'v2');
        final conflictStats = obj(await gateway.request(fixtureStatsPath));
        expect(
          conflictStats['trustPosts'],
          (statsBaseline['trustPosts'] as num).toInt() + 1,
        );
        expect(
          conflictStats['trustConflicts'],
          (statsBaseline['trustConflicts'] as num).toInt() + 1,
        );
        expect(conflictStats['configVersion'], 'v2');
        expect(
          codeContaining('PIRC_PARITY_TRUST_FIXTURE=v2'),
          findsOneWidget,
          reason: 'A stale decision must not silently trust the new hash.',
        );

        await tap(button('Trust'));
        await until(
          () => find
              .text(
                'Trusted. New sessions in this workspace use these hooks, environment and paths.',
              )
              .evaluate()
              .isNotEmpty,
          'a second, explicit review and trust succeeds',
        );
        final trustedProject = obj(
          (await gateway.request('$workspacePath/project-config'))['project'],
        );
        expect(trustedProject['trusted'], isTrue);
        expect(trustedProject['trustedHash'], trustedProject['hash']);
        final finalStats = obj(await gateway.request(fixtureStatsPath));
        expect(
          finalStats['trustPosts'],
          (statsBaseline['trustPosts'] as num).toInt() + 2,
        );
        expect(
          finalStats['trustConflicts'],
          (statsBaseline['trustConflicts'] as num).toInt() + 1,
        );

        for (final path in [
          '/api/devices',
          '/api/providers',
          '/api/provider-auth',
        ]) {
          await expectLater(
            gateway.request(path),
            throwsA(
              isA<PlatformException>().having(
                (error) => error.code,
                'code',
                'HTTP_403',
              ),
            ),
            reason:
                'Directory trust must not loosen device-token policy for $path.',
          );
        }
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        if (paired) {
          // Keep the private fixture safe for a later test run even on assertion failure.
          try {
            await gateway.request(
              '$workspacePath/project-trust',
              method: 'POST',
              body: {'trusted': false},
            );
          } catch (_) {}
          try {
            await gateway.request(
              fixtureConfigPath,
              method: 'POST',
              body: {'version': 'v1'},
            );
          } catch (_) {}
          await gateway.call('unpair');
          paired = false;
        }
      }
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
