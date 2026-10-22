import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:pirc_mobile/live/markdown_image.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/files_pane.dart';
import 'package:pirc_mobile/live/side_panel.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/theme.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'real Android file panel: directory, Markdown, source ranges, SVG and binary',
    (t) async {
      expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), isTrue);
      const id = String.fromEnvironment('PIRC_FILES_SESSION'),
          link = String.fromEnvironment('PIRC_PAIR_LINK');
      expect(
        id.isNotEmpty,
        isTrue,
        reason: 'Run the isolated helper with --files.',
      );
      final g = Gateway();
      await g.call('pair', {'link': link});
      await g.call('completeOnboarding');
      final originalPreferences = obj(await g.call('preferences'));
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

      Future<void> tap(Finder target) async {
        await t.ensureVisible(target);
        await t.pumpAndSettle();
        expect(target.hitTestable(), findsOneWidget);
        await t.tap(target);
        await t.pumpAndSettle();
      }

      try {
        await g.call('savePreferences', {
          'panelWidth': 512,
          'detailsOpen': true,
          'sidebarCollapsed': true,
        });
        final persisted = obj(await g.call('preferences'));
        expect(persisted['panelWidth'], 512);
        expect(persisted['detailsOpen'], true);
        expect(persisted['sidebarCollapsed'], true);
        await t.pumpWidget(MobileApp(theme: theme, controller: c));
        await until(
          () => !c.booting && c.sessions.any((s) => s['id'] == id),
          'boot fixture session',
        );
        await tap(find.text('Native files fixture'));
        await until(
          () =>
              c.sessionId == id &&
              c.state.isNotEmpty &&
              find.byType(NativeSidePanel).evaluate().isNotEmpty,
          'open chat and present its panel action',
        );
        expect(
          find.byType(NativeSidePanel),
          findsOneWidget,
        ); // a session is its panes (plan 12 decision 4)
        await until(
          () =>
              find.byType(FilesPane).evaluate().isNotEmpty &&
              find.text('README.md').evaluate().isNotEmpty,
          'root directory',
        );
        expect(find.text('工作面板'), findsNothing);
        expect(find.byKey(const ValueKey('panel-tab-git')), findsNothing);
        expect(find.byKey(const ValueKey('panel-tab-context')), findsOneWidget);
        await tap(find.text('README.md'));
        await until(
          () => find
              .textContaining('the implementation', findRichText: true)
              .evaluate()
              .isNotEmpty,
          'Markdown rendered',
        );
        final linkText = find.textContaining(
          'the implementation',
          findRichText: true,
        );
        await t.ensureVisible(linkText);
        await t.pumpAndSettle();
        final paragraph = t.renderObject<RenderParagraph>(
          find.byWidgetPredicate(
            (w) =>
                w is RichText &&
                w.text.toPlainText().contains('the implementation'),
          ),
        );
        // Real touch selection and Android clipboard, including text/code
        // across blocks. The menu must use the same document-wide region.
        final word = paragraph
            .getBoxesForSelection(
              const TextSelection(baseOffset: 0, extentOffset: 1),
            )
            .first
            .toRect();
        await t.longPressAt(paragraph.localToGlobal(word.center));
        await t.pumpAndSettle();
        await tap(find.text('Select all'));
        await tap(find.text('Copy'));
        final copied = await Clipboard.getData(Clipboard.kTextPlain);
        final expectedClipboard = utf8.decode(
          base64Decode(
            const String.fromEnvironment('PIRC_FILES_CLIPBOARD_BASE64'),
          ),
        );
        expect(expectedClipboard, isNotEmpty);
        expect(
          copied?.text,
          expectedClipboard,
          reason: 'Exact pinned-web clipboard text',
        );
        final start = paragraph.text.toPlainText().indexOf(
          'the implementation',
        );
        final box = paragraph
            .getBoxesForSelection(
              TextSelection(baseOffset: start, extentOffset: start + 1),
            )
            .first;
        await t.tapAt(paragraph.localToGlobal(box.toRect().center));
        await t.pumpAndSettle();
        await until(
          () => find.byType(NativeFileSource).evaluate().isNotEmpty,
          'source link',
        );
        final source = t.widget<NativeFileSource>(
          find.byType(NativeFileSource),
        );
        expect(source.file['path'], 'src/main.ts');
        expect(source.line, 2);
        expect(source.endLine, 4);
        expect(source.file['content'], contains('Hello Flutter'));
        await tap(find.byTooltip('Back to folder'));
        await until(
          () => find.text('..').evaluate().isNotEmpty,
          'source parent directory',
        );
        await tap(find.text('..'));
        await until(
          () => find.text('architecture.svg').evaluate().isNotEmpty,
          'root again',
        );
        for (final (label, line, end) in [
          ('../src/main.ts:2-4', 2, 4),
          ('../src/main.ts:3', 3, 3),
        ]) {
          await tap(find.text('docs'));
          await until(
            () => find.text('links.md').evaluate().isNotEmpty,
            'link fixture directory',
          );
          await tap(find.text('links.md'));
          await until(
            () => find.text(label).evaluate().isNotEmpty,
            'native Markdown file link',
          );
          await tap(find.text(label));
          await until(
            () => find.byType(NativeFileSource).evaluate().isNotEmpty,
            'automatic file link target',
          );
          final linked = t.widget<NativeFileSource>(
            find.byType(NativeFileSource),
          );
          expect(linked.file['path'], 'src/main.ts');
          expect(linked.line, line);
          expect(linked.endLine, end);
          await tap(find.byTooltip('Back to folder'));
          await until(
            () => find.text('..').evaluate().isNotEmpty,
            'linked file folder',
          );
          await tap(find.text('..'));
          await until(
            () => find.text('docs').evaluate().isNotEmpty,
            'link fixture root',
          );
        }
        await tap(find.text('docs'));
        await until(
          () => find.text('images.md').evaluate().isNotEmpty,
          'image fixture directory',
        );
        await tap(find.text('images.md'));
        await until(
          () => find
              .descendant(
                of: find.byType(NativeMarkdownImage),
                matching: find.byType(SvgPicture),
              )
              .evaluate()
              .isNotEmpty,
          'authenticated redirected native SVG',
        );
        final svg = find.descendant(
          of: find.byType(NativeMarkdownImage),
          matching: find.byType(SvgPicture),
        );
        expect(t.getSize(svg), const Size(300, 140));
        await tap(svg);
        await until(
          () => find.byType(NativeFileSource).evaluate().isNotEmpty,
          'image link target',
        );
        expect(
          t.widget<NativeFileSource>(find.byType(NativeFileSource)).line,
          4,
        );
        await tap(find.byTooltip('Back to folder'));
        await until(
          () => find.text('..').evaluate().isNotEmpty,
          'image target folder',
        );
        await tap(find.text('..'));
        await until(
          () => find.text('architecture.svg').evaluate().isNotEmpty,
          'root after image',
        );
        await tap(find.text('architecture.svg'));
        await until(
          () => find.textContaining('300 × 180').evaluate().isNotEmpty,
          'native SVG decoded dimensions',
        );
        expect(find.byType(NativeFileImage), findsOneWidget);
        await tap(find.byTooltip('Show source'));
        expect(find.byType(NativeFileSource), findsOneWidget);
        await tap(find.byTooltip('Show rendered'));
        await until(
          () => find.byType(NativeFileImage).evaluate().isNotEmpty,
          'SVG restored',
        );
        await tap(find.byTooltip('Back to folder'));
        await until(
          () => find.text('data.bin').evaluate().isNotEmpty,
          'binary entry',
        );
        await tap(find.text('data.bin'));
        await until(
          () => find.text('Binary file — not shown.').evaluate().isNotEmpty,
          'binary response',
        );
        // The context pane needs a run, sent from a room now (plan 12
        // decision 4): not exercised from the engine any more.
        debugPrint(
          'REAL_GATEWAY:files-native-directory-markdown-lines-svg-binary',
        );
      } finally {
        await g.call('savePreferences', originalPreferences);
        await t.pumpWidget(const SizedBox());
        await g.call('unwatch');
      }
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
