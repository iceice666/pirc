import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/workspace_page.dart';
import 'package:pirc_mobile/live/mobile_tabs.dart';
import 'package:pirc_mobile/live/workspace_settings.dart';
import 'package:pirc_mobile/live/web_controls.dart';
import '../../test/live_test.dart' show FakeGateway, theme;

class WorkspaceMatrixGateway extends FakeGateway {
  WorkspaceMatrixGateway(this.fixture);
  final Json fixture;
  @override
  dynamic normal(String method, Json args) {
    if (method == 'request') {
      final path = '${args['path']}';
      for (final kind in ['nodes', 'workspaces', 'sessions', 'models']) {
        if (path == '/api/$kind') return {kind: fixture[kind]};
      }
      if (path.endsWith('/instructions')) {
        return {'instructions': fixture['instructions']};
      }
      if (path.endsWith('/capabilities')) {
        return {'capabilities': fixture['capabilities']};
      }
      if (path.endsWith('/project-config')) {
        return {'project': fixture['projectConfig']};
      }
      if (path == '/api/memory') {
        return {
          'stats': {},
          'proposals': [],
          'user': [],
          'notes': [],
          'removed': [],
        };
      }
      if (path == '/api/schedules') return {'schedules': []};
      return <String, dynamic>{};
    }
    if (method == 'watch') {
      final selected = rows(
        fixture['sessions'],
      ).firstWhere((s) => s['id'] == args['sessionId']);
      snapshot = {
        'session': selected,
        'messages': [],
        'widgets': {},
        'queue': [],
        'interactions': [],
        'runnerEpoch': 'fixture',
      };
      publish('${selected['id']}');
      return '';
    }
    if (method == 'preferences') {
      return {
        'appearance': fixture['captureTheme'],
        'mode': 'work',
        'showSettled': false,
      };
    }
    return super.normal(method, args);
  }
}

Map<String, double> rectMap(Rect rect) => {
  'x': rect.left,
  'y': rect.top,
  'width': rect.width,
  'height': rect.height,
};
void main() {
  final fixture = obj(
    jsonDecode(
      File(
        '../../fixtures/mobile-parity/workspace-matrix.json',
      ).readAsStringSync(),
    ),
  );
  final measured = <Json>[];
  setUpAll(() async {
    for (final entry
        in jsonDecode(await rootBundle.loadString('FontManifest.json'))
            as List) {
      final loader = FontLoader(entry['family'] as String);
      for (final font in entry['fonts']) {
        loader.addFont(rootBundle.load(font['asset'] as String));
      }
      await loader.load();
    }
    for (final (family, path) in [
      ('Roboto', '/System/Library/Fonts/SFNS.ttf'),
      ('monospace', '/System/Library/Fonts/SFNSMono.ttf'),
    ]) {
      await (FontLoader(
        family,
      )..addFont(File(path).readAsBytes().then(ByteData.sublistView))).load();
    }
  });
  for (final state in rows(fixture['states'])) {
    for (final width in fixture['widths'] as List) {
      for (final brightness in Brightness.values) {
        for (final scale in fixture['textScales'] as List) {
          final id = '${state['id']}-$width-${brightness.name}-text$scale';
          testWidgets(id, (t) async {
            t.view.devicePixelRatio = 1;
            t.view.physicalSize = Size((width as num).toDouble(), 900);
            t.platformDispatcher.textScaleFactorTestValue = (scale as num)
                .toDouble();
            t.platformDispatcher.platformBrightnessTestValue = brightness;
            addTearDown(t.view.reset);
            addTearDown(t.platformDispatcher.clearTextScaleFactorTestValue);
            addTearDown(t.platformDispatcher.clearPlatformBrightnessTestValue);
            final g = WorkspaceMatrixGateway({
              ...fixture,
              'captureTheme': brightness.name,
            });
            final c = LiveController(g);
            final boundary = GlobalKey();
            await t.pumpWidget(
              RepaintBoundary(
                key: boundary,
                child: MobileApp(theme: theme, controller: c),
              ),
            );
            await t.pumpAndSettle();
            if (find
                .byTooltip('Back to the list')
                .hitTestable()
                .evaluate()
                .isNotEmpty) {
              await t.tap(find.byTooltip('Back to the list'));
              await t.pumpAndSettle();
            }
            final workspace = rows(
              fixture['workspaces'],
            ).firstWhere((w) => w['id'] == state['workspaceId']);
            final mode = find
                .text(workspace['kind'] == 'chat' ? 'Chat' : 'Work')
                .hitTestable();
            await t.tap(mode.first);
            await t.pumpAndSettle();
            await t.tap(
              find.text('${workspace['displayName']}').hitTestable().first,
            );
            await t.pumpAndSettle();
            if (state['tab'] == 'settings') {
              await t.tap(
                find
                    .descendant(
                      of: find.byType(WorkspacePage),
                      matching: find.text('Settings'),
                    )
                    .first,
              );
              await t.pumpAndSettle();
            }
            expect(t.takeException(), isNull, reason: id);
            final entries = <Json>[];
            final page = find.byType(WorkspacePage);
            void record(String name, Finder found) {
              if (found.evaluate().isNotEmpty) {
                entries.add({
                  'name': name,
                  'rect': rectMap(t.getRect(found.first)),
                });
              }
            }

            record('workspace', page);
            record('mobile-tabs', find.byType(MobileTabs));
            record('header', find.byKey(const Key('workspace-page-header')));
            record('tabs', find.byKey(const Key('workspace-page-tabs')));
            record('body', find.byKey(const Key('workspace-page-body')));
            record(
              'list-tools',
              find.byKey(const Key('workspace-page-list-tools')),
            );
            for (final title in [
              'PROJECT INSTRUCTIONS',
              'PROJECT CAPABILITIES',
              'WORKSPACE',
              'PROJECT CONFIG',
              'Hooks',
              'Environment',
              'Allowed paths',
            ]) {
              record(
                title,
                find.descendant(of: page, matching: find.text(title)),
              );
            }
            record(
              'textarea',
              find.byKey(const ValueKey('workspace-instructions-text')),
            );
            record(
              'settings-content',
              find.byKey(const ValueKey('workspace-settings-content')),
            );
            final settings = find.byType(WorkspaceSettings);
            if (settings.evaluate().isNotEmpty) {
              for (final button in ['Save', 'Trust', 'Revoke trust']) {
                record(
                  button,
                  find.descendant(
                    of: settings,
                    matching: find.byWidgetPredicate(
                      (w) => w is WebButton && w.label == button,
                    ),
                  ),
                );
              }
              for (final label in [
                'Device',
                'Sessions',
                'Write lease',
                'Default model',
                'Default thinking',
                'Allowed assistant features',
                'Delegation',
                'Memory search',
                'Remote recall',
                'Schedules',
                'Web search',
              ]) {
                record(
                  label,
                  find.descendant(of: settings, matching: find.text(label)),
                );
              }
              for (final key in [
                'delegation',
                'memory_search',
                'remote_recall',
                'schedules',
                'web_search',
              ]) {
                record(
                  'checkbox-$key',
                  find.byKey(ValueKey('capability-checkbox-$key')),
                );
              }
            }
            final row = {
              'id': id,
              'width': width,
              'theme': brightness.name,
              'textScale': scale,
              'state': state['id'],
              'elements': entries,
            };
            Future<void> capture(String suffix) async {
              await t.runAsync(() async {
                final img =
                    await (boundary.currentContext!.findRenderObject()
                            as RenderRepaintBoundary)
                        .toImage(pixelRatio: 1);
                final png = await img.toByteData(
                  format: ui.ImageByteFormat.png,
                );
                final dir = Directory('build/parity/workspace-matrix')
                  ..createSync(recursive: true);
                File(
                  '${dir.path}/$id-native-$suffix.png',
                ).writeAsBytesSync(png!.buffer.asUint8List());
                img.dispose();
              });
            }

            await capture('top');
            if (state['tab'] == 'settings') {
              final view = find
                  .descendant(
                    of: page,
                    matching: find.byType(SingleChildScrollView),
                  )
                  .first;
              final scrollable = find
                  .descendant(of: view, matching: find.byType(Scrollable))
                  .first;
              final position = t.state<ScrollableState>(scrollable).position;
              row['scroll'] = {
                'viewport': position.viewportDimension,
                'maxScrollExtent': position.maxScrollExtent,
              };
              position.jumpTo(position.maxScrollExtent);
              await t.pumpAndSettle();
              await capture('bottom');
            }
            measured.add(row);
            await t.pumpWidget(const SizedBox());
            await g.stream.close();
          });
        }
      }
    }
  }
  tearDownAll(
    () => File('build/parity/workspace-matrix/native-measurements.json')
        .writeAsStringSync(
          const JsonEncoder.withIndent('  ').convert({
            'reference': fixture['webRevision'],
            'capturedAt': DateTime.now().toUtc().toIso8601String(),
            'scope':
                'Actual native App shell; host SFNS/SFNSMono comparison fonts, no safe area/IME. Date.now is not frozen; relative session ages may differ.',
            'cases': measured,
          }),
        ),
  );
}
