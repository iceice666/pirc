import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/modes.dart';
import 'package:pirc_mobile/live/workspace_settings.dart';
import 'package:pirc_mobile/live/web_controls.dart';
import 'package:pirc_mobile/theme.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'real Android project instructions and server-confirmed capabilities',
    (tester) async {
      expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), isTrue);
      final gateway = Gateway();
      await gateway.call('pair', {
        'link': const String.fromEnvironment('PIRC_PAIR_LINK'),
      });
      await gateway.call('completeOnboarding');
      final boot = obj(await gateway.call('boot'));
      final workspaces = rows(
        (await gateway.request('/api/workspaces'))['workspaces'],
      );
      final catalog = ModeCatalog(
        rows((await gateway.request('/api/modes'))['modes']),
      );
      final workspace = workspaces.singleWhere(
        (row) => row['id'] == 'chat:chats' && catalog.assistant(row),
      );
      final root = '/api/workspaces/${enc('${workspace['id']}')}';
      final originalInstructions = obj(
        (await gateway.request('$root/instructions'))['instructions'],
      );
      final originalCapabilities = obj(
        (await gateway.request('$root/capabilities'))['capabilities'],
      );
      final controller = LiveController(gateway)
        ..origin = boot['origin'] as String?
        ..clientId = boot['clientId'] as String?
        ..pairingStamp = boot['pairingStamp'] as String?
        ..nodes = rows((await gateway.request('/api/nodes'))['nodes'])
        ..workspaces = workspaces;
      final theme = await PircTheme.load();
      Future<void> until(bool Function() ready, String label) async {
        for (var i = 0; i < 150 && !ready(); i++) {
          await tester.pump(const Duration(milliseconds: 100));
        }
        expect(ready(), isTrue, reason: label);
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull, reason: label);
      }

      Finder button(String label) => find.byWidgetPredicate(
        (widget) => widget is WebButton && widget.label == label,
      );
      try {
        await tester.pumpWidget(
          MaterialApp(
            theme: theme.build(Brightness.light),
            home: Scaffold(
              body: SingleChildScrollView(
                child: WorkspaceSettings(
                  controller: controller,
                  workspace: workspace,
                ),
              ),
            ),
          ),
        );
        await until(
          () => find.byType(TextField).evaluate().isNotEmpty,
          'instructions loaded through real gateway',
        );
        const updated = 'Native project fixture 🌱\nSecond instruction line.';
        await tester.enterText(find.byType(TextField), updated);
        await tester.pumpAndSettle();
        expect(tester.widget<WebButton>(button('Save')).onPressed, isNotNull);
        await tester.ensureVisible(button('Save'));
        await tester.tap(button('Save'));
        await until(
          () => find
              .text(
                'Project instructions saved. New chats in this project will use them.',
              )
              .evaluate()
              .isNotEmpty,
          'save acknowledgement',
        );
        expect(
          obj(
            (await gateway.request('$root/instructions'))['instructions'],
          )['text'],
          updated,
        );
        final limit = (originalInstructions['maxChars'] as num).toInt();
        await tester.enterText(
          find.byType(TextField),
          List.filled(limit + 1, 'x').join(),
        );
        await tester.pump();
        expect(tester.widget<WebButton>(button('Save')).onPressed, isNull);
        expect(
          obj(
            (await gateway.request('$root/instructions'))['instructions'],
          )['text'],
          updated,
        );
        await tester.enterText(find.byType(TextField), updated);
        await until(
          () => find.byType(Checkbox).evaluate().length == 5,
          'capability policy loaded',
        );
        final delegation = find
            .ancestor(of: find.text('Delegation'), matching: find.byType(Row))
            .first;
        final checkbox = find.descendant(
          of: delegation,
          matching: find.byType(Checkbox),
        );
        final before = tester.widget<Checkbox>(checkbox).value!;
        await tester.ensureVisible(checkbox);
        await tester.tap(checkbox);
        await until(
          () => tester.widget<Checkbox>(checkbox).value == !before,
          'server-confirmed capability',
        );
        expect(
          obj(
            (await gateway.request('$root/capabilities'))['capabilities'],
          )['delegation'],
          !before,
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
            reason: path,
          );
        }
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        controller.dispose();
        await gateway.request(
          '$root/instructions',
          method: 'PATCH',
          body: {'text': originalInstructions['text']},
        );
        await gateway.request(
          '$root/capabilities',
          method: 'PATCH',
          body: {'capabilities': originalCapabilities},
        );
        await gateway.call('unpair');
      }
    },
  );
}
