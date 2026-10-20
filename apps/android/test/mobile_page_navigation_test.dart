import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/mobile_tabs.dart';
import 'package:pirc_mobile/live/settings_dialog.dart';

import 'live_test.dart' show FakeGateway, theme;

class PageNavigationGateway extends FakeGateway {
  @override
  dynamic normal(String method, Json args) {
    if (method == 'request') {
      final path = '${args['path']}';
      if (path == '/api/workspaces') {
        return {
          'workspaces': [
            {
              'id': 'home:trip',
              'hostId': 'home',
              'displayName': 'Trip planning',
              'kind': 'directory',
            },
            {
              'id': 'home:files',
              'hostId': 'home',
              'displayName': 'Files',
              'kind': 'directory',
            },
          ],
        };
      }
      if (path == '/api/nodes') {
        return {
          'nodes': [
            {'id': 'home', 'online': true},
          ],
        };
      }
      if (path == '/api/sessions') {
        return {
          'sessions': [
            {
              'id': 'session-1',
              'name': 'Trip conversation',
              'workspaceId': 'home:trip',
              'updatedAt': 100,
            },
          ],
        };
      }
    }
    return super.normal(method, args);
  }
}

void _setPhone(WidgetTester tester) {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(390, 844);
  tester.view.viewPadding = const FakeViewPadding();
  tester.view.viewInsets = const FakeViewPadding();
  addTearDown(tester.view.reset);
}

Future<(PageNavigationGateway, LiveController)> _showPhone(
  WidgetTester tester,
) async {
  final gateway = PageNavigationGateway();
  final controller = LiveController(gateway);
  await tester.pumpWidget(MobileApp(theme: theme, controller: controller));
  await tester.pumpAndSettle();
  return (gateway, controller);
}

void main() {
  testWidgets('Settings is the selected phone tab while its dialog is open', (
    tester,
  ) async {
    _setPhone(tester);
    final (gateway, _) = await _showPhone(tester);
    addTearDown(() async => gateway.stream.close());

    final tabs = find.byType(MobileTabs);
    expect(tester.widget<MobileTabs>(tabs).current, 'work');
    await tester.tap(
      find.descendant(of: tabs, matching: find.text('Settings')),
    );
    await tester.pumpAndSettle();

    expect(find.byType(NativeSettingsDialog), findsOneWidget);
    expect(tester.widget<MobileTabs>(tabs).current, 'settings');

    await tester.tap(find.byTooltip('Close'));
    await tester.pumpAndSettle();
    expect(find.byType(NativeSettingsDialog), findsNothing);
    expect(tester.widget<MobileTabs>(tabs).current, 'work');
    expect(tester.takeException(), isNull);
  });
}
