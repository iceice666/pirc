import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/conversation_composer.dart';
import '../../test/live_test.dart' show FakeGateway, theme;
import 'capture_fonts.dart';

void main() {
  testWidgets('attachment chips match pinned web shared fixture', (t) async {
    final fixture = jsonDecode(
      File('../../fixtures/mobile-parity/attachments.json').readAsStringSync(),
    );
    await t.runAsync(loadParityFonts);
    addTearDown(t.view.reset);
    final results = <Object>[];
    for (final width in fixture['widths']) {
      for (final brightness in Brightness.values) {
        t.view.devicePixelRatio = 1;
        t.view.physicalSize = Size((width as num).toDouble(), 400);
        final expected = jsonDecode(
          File(
            'build/parity/attachments-web-$width-${brightness.name}.json',
          ).readAsStringSync(),
        );
        final g = FakeGateway();
        final c = LiveController(g)
          ..sessionId = 's'
          ..connection = 'live'
          ..control = {'held': true}
          ..state = obj(fixture['state'])
          ..models = rows(fixture['models'])
          ..uploading = true;
        c.attachments = rows(fixture['attachments'])
            .map(
              (item) => {
                ...item,
                if (item['preview'] != null)
                  'previewBytes': Uri.parse(
                    item['preview'],
                  ).data!.contentAsBytes(),
              },
            )
            .toList();
        final text = TextEditingController(text: fixture['draft']);
        final data = theme.build(brightness);
        await t.pumpWidget(
          MaterialApp(
            theme: data.copyWith(
              textTheme: data.textTheme.apply(fontFamily: 'Arial'),
            ),
            home: Scaffold(
              body: Column(
                children: [
                  const Spacer(),
                  ConversationComposer(controller: c, text: text),
                ],
              ),
            ),
          ),
        );
        for (var i = 0; i < 8; i++) {
          await t.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 10)),
          );
          await t.pump(const Duration(milliseconds: 16));
        }
        for (var i = 0; i < c.attachments.length; i++) {
          final item = c.attachments[i], reference = expected[i];
          final chip = find.byKey(ValueKey(item['id']));
          if (chip.evaluate().isEmpty) {
            await t.drag(
              find.byKey(const Key('composer-attachments-strip')),
              const Offset(-240, 0),
            );
            await t.pump(const Duration(milliseconds: 300));
          }
          expect(
            chip,
            findsOneWidget,
            reason: 'chip ${item["id"]} at $width ${brightness.name}',
          );
          final box = find
              .descendant(of: chip, matching: find.byType(DecoratedBox))
              .first;
          final size = t.getSize(box);
          expect(size.height, 48);
          expect(
            size.width,
            closeTo((reference['box']['width'] as num).toDouble(), .04),
          );
          final thumbnail = t.getSize(
            find.byKey(ValueKey('composer-attachment-thumbnail-${item['id']}')),
          );
          expect(
            thumbnail.width,
            closeTo((reference['thumbnail']['width'] as num).toDouble(), .04),
          );
          expect(
            thumbnail.height,
            (reference['thumbnail']['height'] as num).toDouble(),
          );
          final image = find.descendant(
            of: chip,
            matching: find.byType(SvgPicture),
          );
          if (item['preview'] != null) {
            expect(t.getSize(image), const Size(36, 36));
          }
          final remove = find.descendant(
            of: chip,
            matching: find.byType(IconButton),
          );
          if (item['uploading'] == true) {
            expect(remove, findsNothing);
          } else {
            expect(
              t.getSize(remove).width,
              closeTo((reference['removeBox']['width'] as num).toDouble(), .04),
            );
          }
          results.add({
            'width': width,
            'theme': brightness.name,
            'id': item['id'],
            'nativeWidth': size.width,
            'webWidth': reference['box']['width'],
            'nativeHeight': size.height,
            'removeWidth': remove.evaluate().isEmpty
                ? null
                : t.getSize(remove).width,
            'webRemoveWidth': reference['removeBox']?['width'],
          });
        }
        expect(t.takeException(), isNull);
        await t.pumpWidget(const SizedBox.shrink());
        text.dispose();
        c.dispose();
        await g.stream.close();
      }
    }
    File(
      'build/parity/attachments-native.json',
    ).writeAsStringSync(const JsonEncoder.withIndent('  ').convert(results));
  });
}
