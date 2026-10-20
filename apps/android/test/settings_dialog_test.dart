import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/settings_dialog.dart';
import 'package:pirc_mobile/live/notification_settings.dart';
import 'package:pirc_mobile/live/memory_settings.dart';
import 'package:pirc_mobile/live/provider_editor.dart';
import 'package:pirc_mobile/live/provider_login.dart';
import 'package:pirc_mobile/live/workspace_page.dart';
import 'live_test.dart' show FakeGateway, theme;
import '../tool/parity/capture_fonts.dart' show loadParityFonts;

void configureSettings(FakeGateway g, LiveController c) {
  g.handler = (method, args) async {
    if (method == 'savePreferences') return {...c.preferences, ...args};
    if (method == 'pushStatus') return {'code': 'off'};
    if (method == 'permissions') return {'notifications': true};
    if (args['path'] == '/api/push') return {'subscriptions': []};
    if (args['path'] == '/api/providers') {
      throw PlatformException(
        code: 'HTTP_403',
        message: 'Device tokens cannot reach this route',
      );
    }
    if (args['path'] == '/api/devices') {
      throw PlatformException(
        code: 'HTTP_403',
        message: 'Device tokens cannot manage model backends or devices',
      );
    }
    if (args['path'] == '/api/models') {
      return {
        'models': [
          {'provider': 'local', 'id': 'chat-model', 'available': true},
        ],
      };
    }
    return {};
  };
}

Widget settingsHost(
  LiveController c, {
  double scale = 1,
  double keyboard = 0,
  VoidCallback? reset,
}) => MaterialApp(
  theme: theme.build(Brightness.light),
  builder: (context, child) => MediaQuery(
    data: MediaQuery.of(context).copyWith(
      textScaler: TextScaler.linear(scale),
      viewInsets: EdgeInsets.only(bottom: keyboard),
    ),
    child: child!,
  ),
  home: Scaffold(
    body: Builder(
      builder: (context) => TextButton(
        child: const Text('Open settings'),
        onPressed: () => showNativeSettings(
          context,
          controller: c,
          onResetLayout: reset ?? () {},
          onOpenChat: (_) {},
          onAppOptions: () {},
        ),
      ),
    ),
  ),
);
Future<void> choose(WidgetTester t, String label) async {
  final target = find.byKey(ValueKey('settings-tab-$label'));
  await t.ensureVisible(target);
  await t.tap(target);
  await t.pumpAndSettle();
}

void main() {
  setUpAll(loadParityFonts);
  testWidgets('enlarged text preserves fixed settings tab rows', (t) async {
    t.view.physicalSize = const Size(390, 900);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.resetPhysicalSize);
    addTearDown(t.view.resetDevicePixelRatio);
    final g = FakeGateway(), c = LiveController(g);
    configureSettings(g, c);
    await t.pumpWidget(settingsHost(c, scale: 2));
    await t.tap(find.text('Open settings'));
    await t.pumpAndSettle();
    for (final label in settingsCategories) {
      expect(t.getSize(find.byKey(ValueKey('settings-tab-$label'))).height, 32);
    }
    await t.tap(find.text('Show done sessions'));
    await t.pumpAndSettle();
    expect(c.preferences['showSettled'], isTrue);
    await choose(t, 'About');
    expect(find.text('THIS BROWSER'), findsOneWidget);
    expect(t.takeException(), isNull);
    await t.pumpWidget(const SizedBox());
    c.dispose();
    await g.stream.close();
  });

  testWidgets('close focus ring follows touch and keyboard input mode', (
    t,
  ) async {
    final g = FakeGateway(), c = LiveController(g);
    configureSettings(g, c);
    await t.pumpWidget(settingsHost(c));
    await t.tap(find.text('Open settings'));
    await t.pumpAndSettle();
    final ring = find.byKey(const ValueKey('settings-close-focus-ring'));
    expect(ring, findsNothing);
    await t.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await t.pump();
    expect(ring, findsOneWidget);
    await t.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    await choose(t, 'Models');
    expect(ring, findsNothing);
    expect(t.takeException(), isNull);
    await t.pumpWidget(const SizedBox());
    c.dispose();
    await g.stream.close();
  });

  testWidgets(
    'paired-token Models 403 hides management controls while model listing remains available',
    (t) async {
      final g = FakeGateway(), c = LiveController(g);
      configureSettings(g, c);
      await t.pumpWidget(settingsHost(c));
      await t.tap(find.text('Open settings'));
      await t.pumpAndSettle();
      await choose(t, 'Models');

      expect(
        find.text(
          'Global settings for this single-user gateway. All model requests run on the gateway; endpoints must be reachable from there.',
        ),
        findsOneWidget,
      );
      expect(
        find.text(
          'Backend request failed (403). Check your settings and try again.',
        ),
        findsOneWidget,
      );
      expect(find.text('Retry settings'), findsOneWidget);
      expect(find.byType(ProviderLogin), findsNothing);
      expect(find.byType(ProviderEditor), findsNothing);
      expect(find.text('Add backend'), findsNothing);
      expect(find.text('Default model'), findsNothing);
      expect(find.text('Gateway default'), findsNothing);
      expect(find.text('Save default'), findsNothing);

      final providerRequests = g.calls.where((call) {
        final path = call.$2['path'];
        return path is String &&
            (path == '/api/providers' ||
                path.startsWith('/api/providers/') ||
                path.startsWith('/api/provider-auth/'));
      }).toList();
      expect(providerRequests, hasLength(1));
      expect(providerRequests.single.$2, {
        'method': 'GET',
        'path': '/api/providers',
        'body': null,
      });

      // The device credential is forbidden from managing providers, but the
      // gateway intentionally still serves the model choices used by chat.
      await c.refreshModels();
      expect(c.models, [
        {'provider': 'local', 'id': 'chat-model', 'available': true},
      ]);
      expect(
        g.calls.where((call) => call.$2['path'] == '/api/models'),
        hasLength(1),
      );
      expect(
        g.calls.where((call) {
          final path = call.$2['path'];
          final method = call.$2['method'];
          return path is String &&
              (path.startsWith('/api/providers/') ||
                  path.startsWith('/api/provider-auth/')) &&
              method != 'GET';
        }),
        isEmpty,
      );
      expect(t.takeException(), isNull);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );

  testWidgets(
    'categories keep mounted panels',
    (t) async {
      final g = FakeGateway(), c = LiveController(g);
      configureSettings(g, c);
      await t.pumpWidget(settingsHost(c));
      await t.tap(find.text('Open settings'));
      await t.pumpAndSettle();
      final memory = t.element(
        find.byType(MemorySettings, skipOffstage: false),
      );
      await choose(t, 'Models');
      expect(
        find.text(
          'Backend request failed (403). Check your settings and try again.',
        ),
        findsOneWidget,
      );
      await choose(t, 'Memory');
      expect(
        identical(
          memory,
          t.element(find.byType(MemorySettings, skipOffstage: false)),
        ),
        isTrue,
      );
      expect(
        g.calls.where((call) => call.$2['path'] == '/api/providers').length,
        1,
      );
      await t.tap(find.byTooltip('Close'));
      await t.pumpAndSettle();
      expect(find.byType(NativeSettingsDialog), findsNothing);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets(
    'roving keyboard navigation activates categories, Escape closes dialog',
    (t) async {
      final g = FakeGateway(), c = LiveController(g);
      configureSettings(g, c);
      await t.pumpWidget(settingsHost(c));
      await t.tap(find.text('Open settings'));
      await t.pumpAndSettle();
      final general = t.widget<TextButton>(
        find.byKey(const ValueKey('settings-tab-General')),
      );
      general.focusNode!.requestFocus();
      await t.pump();
      await t.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await t.pumpAndSettle();
      expect(find.text('MEMORY'), findsOneWidget);
      await t.sendKeyEvent(LogicalKeyboardKey.end);
      await t.pumpAndSettle();
      expect(find.text('THIS BROWSER'), findsOneWidget);
      await t.sendKeyEvent(LogicalKeyboardKey.escape);
      await t.pumpAndSettle();
      expect(find.byType(NativeSettingsDialog), findsNothing);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets(
    'Show done persists and initializes workspace; reset invokes shell',
    (t) async {
      final g = FakeGateway(), c = LiveController(g);
      configureSettings(g, c);
      var reset = 0;
      await t.pumpWidget(settingsHost(c, reset: () => reset++));
      await t.tap(find.text('Open settings'));
      await t.pumpAndSettle();
      await t.tap(find.byType(Checkbox));
      await t.pumpAndSettle();
      expect(c.preferences['showSettled'], true);
      await t.ensureVisible(find.widgetWithText(TextButton, 'Reset'));
      await t.tap(find.widgetWithText(TextButton, 'Reset'));
      await t.pump();
      expect(reset, 1);
      c.workspaces = [
        {'id': 'w', 'displayName': 'Workspace', 'kind': 'directory'},
      ];
      c.sessions = [
        {
          'id': 'done',
          'workspaceId': 'w',
          'name': 'Completed task',
          'settledAt': 123,
          'updatedAt': 123,
        },
      ];
      await t.pumpWidget(
        MaterialApp(
          theme: theme.build(Brightness.light),
          home: Scaffold(
            body: WorkspacePage(
              controller: c,
              workspaceId: 'w',
              onBack: () {},
              onOpen: (_) {},
            ),
          ),
        ),
      );
      await t.pumpAndSettle();
      expect(find.text('Completed task'), findsOneWidget);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets(
    'settings fits all breakpoints, large text and a visible keyboard',
    (t) async {
      addTearDown(t.view.reset);
      for (final width in [
        390.0,
        640.0,
        650.0,
        651.0,
        768.0,
        860.0,
        861.0,
        1024.0,
      ]) {
        for (final scale in [1.0, 2.0]) {
          t.view.devicePixelRatio = 1;
          t.view.physicalSize = Size(width, 844);
          final g = FakeGateway(), c = LiveController(g);
          configureSettings(g, c);
          await t.pumpWidget(settingsHost(c, scale: scale));
          await t.tap(find.text('Open settings'));
          await t.pumpAndSettle();
          await choose(t, 'Memory');
          expect(t.takeException(), isNull);
          await choose(t, 'Devices');
          expect(t.takeException(), isNull);
          await t.pumpWidget(const SizedBox());
          c.dispose();
          await g.stream.close();
        }
      }
      t.view.physicalSize = const Size(390, 844);
      final g = FakeGateway(), c = LiveController(g);
      configureSettings(g, c);
      await t.pumpWidget(settingsHost(c, keyboard: 320));
      await t.tap(find.text('Open settings'));
      await t.pumpAndSettle();
      await choose(t, 'Memory');
      expect(t.takeException(), isNull);
      expect(
        t.getRect(find.byKey(const Key('settings-frame'))).bottom,
        lessThanOrEqualTo(524),
      );
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets('late registration read does not restart polling in background', (
    t,
  ) async {
    final g = FakeGateway(), c = LiveController(g), pending = Completer<Json>();
    var reads = 0;
    g.handler = (method, args) async {
      if (method == 'permissions') return {'notifications': true};
      if (method == 'pushStatus') {
        reads++;
        return pending.future;
      }
      return {'subscriptions': []};
    };
    await t.pumpWidget(
      MaterialApp(
        theme: theme.build(Brightness.light),
        home: Scaffold(body: NativeNotificationSettings(controller: c)),
      ),
    );
    for (final state in [
      AppLifecycleState.inactive,
      AppLifecycleState.hidden,
      AppLifecycleState.paused,
    ]) {
      t.binding.handleAppLifecycleStateChanged(state);
    }
    pending.complete({'code': 'connecting'});
    await t.pump();
    await t.pump(const Duration(seconds: 6));
    expect(reads, 1);
    for (final state in [
      AppLifecycleState.hidden,
      AppLifecycleState.inactive,
      AppLifecycleState.resumed,
    ]) {
      t.binding.handleAppLifecycleStateChanged(state);
    }
    await t.pump();
    expect(reads, 2);
    await t.pumpWidget(const SizedBox());
    await t.pump(const Duration(seconds: 3));
    expect(reads, 2);
    c.dispose();
    await g.stream.close();
  });
  testWidgets(
    'notification actions use exact IDs, serialize mutations and report delivery',
    (t) async {
      final g = FakeGateway(), c = LiveController(g);
      var enabled = true;
      final pending = Completer<Json>();
      g.handler = (method, args) async {
        if (method == 'permissions') return {'notifications': true};
        if (method == 'pushStatus') {
          return {'code': enabled ? 'on' : 'off', 'subscriptionId': 'here'};
        }
        if (method == 'pushDisable') {
          enabled = false;
          return null;
        }
        if (args['path'] == '/api/push/test') return pending.future;
        if (args['path'] == '/api/push') {
          return {
            'subscriptions': [
              {
                'id': 'here',
                'kind': 'unifiedpush',
                'name': 'Phone',
                'host': 'push.local',
              },
              {
                'id': 'elsewhere',
                'kind': 'web',
                'name': 'Laptop',
                'host': 'push.local',
              },
            ],
          };
        }
        return {};
      };
      await t.pumpWidget(
        MaterialApp(
          theme: theme.build(Brightness.light),
          home: Scaffold(
            body: SingleChildScrollView(
              child: NativeNotificationSettings(controller: c),
            ),
          ),
        ),
      );
      await t.pumpAndSettle();
      expect(find.text('Phone (this phone)'), findsOneWidget);
      await t.tap(find.widgetWithText(TextButton, 'Remove').first);
      await t.pumpAndSettle();
      expect(g.calls.where((call) => call.$1 == 'pushDisable').length, 1);
      await t.tap(find.widgetWithText(TextButton, 'Remove').last);
      await t.pumpAndSettle();
      expect(
        g.calls.lastWhere((call) => call.$2['method'] == 'DELETE').$2['body'],
        {'id': 'elsewhere'},
      );
      await t.tap(find.widgetWithText(TextButton, 'Send a test'));
      await t.pump();
      expect(
        t
            .widget<TextButton>(find.widgetWithText(TextButton, 'Send a test'))
            .onPressed,
        isNull,
      );
      pending.complete({'delivered': 1});
      await t.pumpAndSettle();
      expect(find.text('Sent to 1 of 2.'), findsOneWidget);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
}
