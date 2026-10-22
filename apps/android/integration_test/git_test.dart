import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/side_panel.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/git_pane.dart';
import 'package:pirc_mobile/live/diff_view.dart';
import 'package:pirc_mobile/live/files_pane.dart';
import 'package:pirc_mobile/theme.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'real Android Git staged/working diff, file navigation and history',
    (t) async {
      expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), isTrue);
      const id = String.fromEnvironment('PIRC_GIT_SESSION');
      expect(id.isNotEmpty, isTrue, reason: 'Run isolated helper with --git.');
      final g = Gateway();
      await g.call('pair', {
        'link': const String.fromEnvironment('PIRC_PAIR_LINK'),
      });
      await g.call('completeOnboarding');
      final c = LiveController(g, showing: 'engine'),
          theme = await PircTheme.load();
      Future<void> until(bool Function() ready, String step) async {
        for (var i = 0; i < 150 && !ready(); i++) {
          await t.pump(const Duration(milliseconds: 200));
        }
        expect(ready(), isTrue, reason: step);
        await t.pump();
        expect(t.takeException(), isNull, reason: step);
      }

      Future<void> tap(Finder f) async {
        await t.ensureVisible(f);
        await t.pumpAndSettle();
        expect(f.hitTestable(), findsOneWidget);
        await t.tap(f);
        await t.pumpAndSettle();
      }

      try {
        await t.pumpWidget(MobileApp(theme: theme, controller: c));
        await until(
          () => !c.booting && c.workspaces.any((w) => w['id'] == 'git:fixture'),
          'boot Git workspace',
        );
        await tap(find.text('Work'));
        await tap(find.text('Native Git workspace').first);
        await until(
          () => find.text('Native Git fixture').evaluate().isNotEmpty,
          'workspace sessions',
        );
        await tap(find.text('Native Git fixture'));
        await until(
          () =>
              c.sessionId == id &&
              c.state.isNotEmpty &&
              find.byType(NativeSidePanel).evaluate().isNotEmpty,
          'open engineering session and present panel controls',
        );
        await tap(find.byKey(const ValueKey('panel-tab-git')));
        await until(
          () =>
              find.byType(GitPane).evaluate().isNotEmpty &&
              find
                  .byKey(const ValueKey('git-file-src/main.ts-true'))
                  .evaluate()
                  .isNotEmpty,
          'staged and working groups',
        );
        await tap(find.byKey(const ValueKey('git-file-src/main.ts-true')));
        await until(
          () => find.byType(NativeDiffView).evaluate().isNotEmpty,
          'staged diff',
        );
        expect(
          t.widget<NativeDiffView>(find.byType(NativeDiffView)).diff,
          contains('+export const value = "staged";'),
        );
        await tap(find.byTooltip('Open file'));
        await until(
          () => find.byType(NativeFileSource).evaluate().isNotEmpty,
          'open actual file',
        );
        expect(
          t
              .widget<NativeFileSource>(find.byType(NativeFileSource))
              .file['content'],
          contains('"working"'),
        );
        await tap(find.byKey(const ValueKey('panel-tab-git')));
        await tap(find.byTooltip('Back'));
        await tap(find.byKey(const ValueKey('git-file-src/main.ts-false')));
        await until(
          () => find.byType(NativeDiffView).evaluate().isNotEmpty,
          'working diff',
        );
        expect(
          t.widget<NativeDiffView>(find.byType(NativeDiffView)).diff,
          contains('+export const value = "working";'),
        );
        await tap(find.byTooltip('Back'));
        await tap(find.byKey(const ValueKey('git-file-notes.txt-false')));
        await until(
          () => find.byType(NativeDiffView).evaluate().isNotEmpty,
          'untracked diff',
        );
        expect(
          t.widget<NativeDiffView>(find.byType(NativeDiffView)).diff,
          contains('+Untracked native note'),
        );
        await tap(find.byTooltip('Back'));
        await tap(find.byKey(const ValueKey('git-view-history')));
        await until(
          () => find.text('Add history fixture').evaluate().isNotEmpty,
          'real Git history',
        );
        await tap(find.text('Add history fixture'));
        await until(
          () => find.byType(NativeDiffView).evaluate().isNotEmpty,
          'commit detail',
        );
        expect(
          t.widget<NativeDiffView>(find.byType(NativeDiffView)).diff,
          contains('+Second commit'),
        );
        await tap(find.byTooltip('Back'));
        expect(find.text('Initial native fixture'), findsOneWidget);
        debugPrint(
          'REAL_GATEWAY:git-native-staged-working-untracked-file-history',
        );
      } finally {
        await t.pumpWidget(const SizedBox());
        await g.call('unwatch');
      }
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
