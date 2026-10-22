import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/checkpoints_pane.dart';
import 'package:pirc_mobile/live/gateway.dart';

import 'live_test.dart' show FakeGateway, theme;

void main() {
  for (final brightness in Brightness.values) {
    for (final (size, scale, keyboard) in [
      (const Size(360, 640), 1.0, 0.0),
      (const Size(360, 640), 2.0, 240.0),
      (const Size(740, 360), 2.0, 140.0),
      (const Size(820, 900), 2.0, 0.0),
    ]) {
      testWidgets(
        'checkpoint conflict review $brightness $size ${scale}x keyboard=$keyboard',
        (t) async {
          await t.binding.setSurfaceSize(size);
          addTearDown(() => t.binding.setSurfaceSize(null));
          final gateway = FakeGateway();
          final version = {
            'kind': 'file',
            'hash': 'hash',
            'size': 10,
            'executable': false,
          };
          final capture = {
            'id': 'capture',
            'state': 'observational',
            'run': 'r',
            'created': 1790000000000,
            'coverage':
                'observational: shared workspace, shell and external writers uncovered',
            'gaps': true,
            'operations': [
              {
                'id': 'operation',
                'path': 'lib/long_directory_name/example_with_long_name.dart',
                'state': 'observed',
                'before': version,
                'after': version,
              },
            ],
          };
          final job = {
            'id': 'job',
            'captureId': 'capture',
            'state': 'ready',
            'revision': 2,
            'operations': ['operation'],
            'reservedBytes': 4096,
            'manifest': {
              'paths': [
                {
                  'path': 'lib/long_directory_name/example_with_long_name.dart',
                  'status': 'conflict',
                  'before': version,
                  'after': version,
                  'current': version,
                  'candidate': version,
                },
              ],
              'exclusions': {'private': 'denied'},
              'copiedBytes': 1024,
              'coverage': 'observational',
            },
          };
          gateway.handler = (method, args) async {
            if (method != 'request') return gateway.normal(method, args);
            final path = '${args['path']}';
            if (path == '/api/sessions/source/checkpoints') {
              return {
                'version': 1,
                'enabled': true,
                'captures': [capture],
                'jobs': [job],
                'more': false,
              };
            }
            if (path.contains('/file?')) {
              return {
                'path': 'example.dart',
                'side': Uri.parse(path).queryParameters['side'],
                'text': 'final answer = 42;\n',
                'binary': false,
                'absent': false,
                'truncated': false,
              };
            }
            if (path.endsWith('/recoveries/job')) return job;
            return gateway.normal(method, args);
          };
          final controller = LiveController(gateway)
            ..sessionId = 'source'
            ..origin = 'https://gateway.example'
            ..clientId = 'phone'
            ..connection = 'live'
            ..control = {'held': true, 'generation': 3}
            ..state = {
              'session': {'id': 'source', 'workspaceId': 'w'},
              'run': {'status': 'succeeded'},
              'runnerStatus': 'stopped',
            };
          addTearDown(() async {
            await t.pumpWidget(const SizedBox.shrink());
            controller.dispose();
            await gateway.stream.close();
          });
          await t.pumpWidget(
            MaterialApp(
              theme: theme.build(brightness),
              home: MediaQuery(
                data: MediaQueryData(
                  size: size,
                  textScaler: TextScaler.linear(scale),
                  viewInsets: EdgeInsets.only(bottom: keyboard),
                ),
                child: Scaffold(
                  body: SingleChildScrollView(
                    padding: const EdgeInsets.all(12),
                    child: CheckpointsPane(controller: controller),
                  ),
                ),
              ),
            ),
          );
          await t.pumpAndSettle();
          expect(t.takeException(), isNull);
          await t.ensureVisible(find.text('Run r'));
          await t.pumpAndSettle();
          await t.tap(find.text('Run r'));
          await t.pumpAndSettle();
          expect(t.takeException(), isNull);
          final op = find.byKey(
            const ValueKey('checkpoint-operation-operation'),
          );
          await t.ensureVisible(op);
          await t.tap(op);
          await t.pumpAndSettle();
          expect(t.takeException(), isNull);
          final card = find.byKey(const ValueKey('checkpoint-job-job'));
          final header = find.descendant(
            of: card,
            matching: find.text('Recovery workspace'),
          );
          await t.ensureVisible(header);
          await t.tap(header);
          await t.pumpAndSettle();
          final keep = find.byKey(
            const ValueKey('checkpoint-keep-current-job'),
          );
          await t.ensureVisible(keep);
          await t.tap(keep);
          await t.pumpAndSettle();
          final action = find.widgetWithText(
            TextButton,
            'Keep current and continue',
          );
          await t.ensureVisible(action);
          await t.pumpAndSettle();
          expect(t.widget<TextButton>(action).onPressed, isNotNull);
          expect(t.takeException(), isNull);
          // This test only reviews; opening a conversation must remain explicit.
          expect(
            gateway.calls.where(
              (call) => '${call.$2['path']}'.endsWith('/continue'),
            ),
            isEmpty,
          );
        },
      );
    }
  }
}
