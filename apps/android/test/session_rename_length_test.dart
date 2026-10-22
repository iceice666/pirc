import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/session_row.dart';
import 'package:pirc_mobile/live/web_length_formatter.dart';
import 'live_test.dart' show FakeGateway, theme;

class RenameGateway extends FakeGateway {
  final savedNames = <String>[];
  @override
  Future<dynamic> call(String method, [Json args = const {}]) {
    if (method == 'request' && args['method'] == 'PATCH') {
      final name = obj(args['body'])['name'] as String;
      // Match the pinned node API's z.string().trim().min(1).max(200).
      if (name.trim().isEmpty || name.trim().length > 200) {
        throw PlatformException(code: 'HTTP_400', message: 'Name is too long');
      }
      savedNames.add(name);
      snapshot['session'] = {...obj(snapshot['session']), 'name': name};
      return Future.value({'session': snapshot['session']});
    }
    return super.call(method, args);
  }
}

void main() {
  test('rename UTF-16 replacements match seven actual Chrome input cases', () {
    final fixture =
        jsonDecode(
              File(
                '../../fixtures/mobile-parity/session-rename-length.json',
              ).readAsStringSync(),
            )
            as Map;
    const formatter = WebLengthFormatter(200);
    for (final entry in fixture['cases'] as List) {
      final old = entry['old'] as String, insert = entry['insert'] as String;
      final start = entry['start'] as int, end = entry['end'] as int;
      final actual = formatter.formatEditUpdate(
        TextEditingValue(
          text: old,
          selection: TextSelection(baseOffset: start, extentOffset: end),
        ),
        TextEditingValue(
          text: old.replaceRange(start, end, insert),
          selection: TextSelection.collapsed(offset: start + insert.length),
        ),
      );
      expect(actual.text, entry['value'], reason: entry['name']);
      expect(
        actual.selection.extentOffset,
        entry['selection'],
        reason: entry['name'],
      );
    }
  });
  for (final width in [390.0, 768.0]) {
    for (final brightness in Brightness.values) {
      testWidgets(
        'rename emoji input and actual PATCH $width ${brightness.name}',
        (t) async {
          t.view.devicePixelRatio = 1;
          t.view.physicalSize = Size(width, 780);
          addTearDown(t.view.reset);
          final g = RenameGateway();
          g.snapshot['session'] = {
            'id': 's',
            'name': 'Original',
            'workspaceId': 'host:chats',
          };
          final c = LiveController(g, showing: 'engine')
            ..booting = false
            ..origin = 'https://gateway.example'
            ..sessions = [obj(g.snapshot['session'])]
            ..workspaces = [
              {
                'id': 'host:chats',
                'hostId': 'host',
                'kind': 'directory',
                'displayName': 'Workspace',
              },
            ]
            ..nodes = [
              {'id': 'host'},
            ];
          await t.pumpWidget(
            MaterialApp(
              theme: theme.build(brightness),
              home: Scaffold(
                body: SessionRow(
                  controller: c,
                  session: obj(g.snapshot['session']),
                  active: true,
                  onOpen: () {},
                ),
              ),
            ),
          );
          await t.pumpAndSettle();
          await t.tap(find.byTooltip('Rename Original'));
          await t.pumpAndSettle();
          final input = find.byKey(const ValueKey('rename-s'));
          await t.enterText(input, '😀' * 101);
          expect(t.widget<TextField>(input).controller!.text, '😀' * 100);
          await t.testTextInput.receiveAction(TextInputAction.done);
          await t.pumpAndSettle();
          expect(g.savedNames, ['😀' * 100]);
          expect(obj(g.snapshot['session'])['name'], '😀' * 100);
          expect(find.byKey(const ValueKey('rename-s')), findsNothing);
          expect(find.text('Name is too long'), findsNothing);
          expect(t.takeException(), isNull);
          await t.pumpWidget(const SizedBox());
          c.dispose();
          await g.stream.close();
        },
      );
    }
  }
}
