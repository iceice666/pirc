import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/backend_api.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/provider_login.dart';
import 'live_test.dart' show FakeGateway, theme;

const provider = <String, dynamic>{
  'id': 'copilot',
  'name': 'GitHub Copilot',
  'providerId': 'github',
  'connected': false,
  'requiresPolicyConsent': false,
  'usesCallbackServer': false,
  'modelCount': 3,
};

Json pendingLogin({
  String id = 'login-1',
  String providerId = 'copilot',
  Json? auth,
  List<Json> prompts = const [],
}) => {
  'id': id,
  'providerId': providerId,
  'status': 'pending',
  'auth':
      auth ??
      {'url': 'https://accounts.example/login', 'userCode': 'ABCD-EFGH'},
  'prompts': prompts,
  'expiresAt': DateTime.now().millisecondsSinceEpoch + 300000,
};

Widget shell(
  LiveController controller, {
  List<Json> providers = const [provider],
  bool locked = false,
  ValueChanged<bool>? onActiveChanged,
  ValueChanged<bool>? onBusyChanged,
  Future<void> Function(String)? onLogout,
  Future<void> Function()? onSucceeded,
}) => MaterialApp(
  theme: theme.build(Brightness.light),
  home: Scaffold(
    body: SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: ProviderLogin(
        controller: controller,
        providers: providers,
        locked: locked,
        onActiveChanged: onActiveChanged ?? (_) {},
        onBusyChanged: onBusyChanged ?? (_) {},
        onLogout: onLogout ?? (_) async {},
        onSucceeded: onSucceeded ?? () async {},
      ),
    ),
  ),
);

Future<void> tapLabel(WidgetTester tester, String label) async {
  final button = find.widgetWithText(TextButton, label);
  await tester.ensureVisible(button);
  await tester.pump();
  await tester.tap(button);
  await tester.pump();
}

Json lastRequest(FakeGateway gateway, String path, {String? method}) => gateway
    .calls
    .where(
      (call) =>
          call.$1 == 'request' &&
          call.$2['path'] == path &&
          (method == null || call.$2['method'] == method),
    )
    .last
    .$2;

Json browserUrlCase(String name) {
  final fixture = obj(
    jsonDecode(
      File(
        '../../fixtures/mobile-parity/provider-validation.json',
      ).readAsStringSync(),
    ),
  );
  return rows(fixture['cases']).singleWhere((item) => item['name'] == name);
}

Future<void> cleanup(
  WidgetTester tester,
  LiveController controller,
  FakeGateway gateway,
) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pump();
  controller.dispose();
  await gateway.stream.close();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('Copilot login requires consent and sends consent with request', (
    tester,
  ) async {
    final gateway = FakeGateway();
    final controller = LiveController(gateway);
    final option = <String, dynamic>{
      ...provider,
      'requiresPolicyConsent': true,
    };
    gateway.handler = (method, args) async {
      if (method == 'request' &&
          args['path'] == '/api/provider-auth/sessions') {
        return pendingLogin();
      }
      return gateway.normal(method, args);
    };

    await tester.pumpWidget(shell(controller, providers: [option]));
    await tapLabel(tester, 'Log in');
    expect(
      find.text(
        'Logging in enables the policies for all known GitHub Copilot models in your account.',
      ),
      findsOneWidget,
    );
    expect(
      gateway.calls.where(
        (call) =>
            call.$1 == 'request' &&
            call.$2['path'] == '/api/provider-auth/sessions',
      ),
      isEmpty,
    );

    await tapLabel(tester, 'I agree, log in');
    expect(
      lastRequest(
        gateway,
        '/api/provider-auth/sessions',
        method: 'POST',
      )['body'],
      {'providerId': 'copilot', 'policyConsent': true},
    );
    expect(find.text('ABCD-EFGH'), findsOneWidget);

    await cleanup(tester, controller, gateway);
  });

  testWidgets('only validated HTTPS authorization URLs can be opened', (
    tester,
  ) async {
    final gateway = FakeGateway();
    final controller = LiveController(gateway);
    gateway.handler = (method, args) async {
      if (method == 'request' &&
          args['path'] == '/api/provider-auth/sessions') {
        return pendingLogin(
          auth: {
            'url': 'http://accounts.example/login',
            'userCode': 'ABCD-EFGH',
          },
        );
      }
      return gateway.normal(method, args);
    };

    await tester.pumpWidget(shell(controller));
    await tapLabel(tester, 'Log in');
    expect(
      find.text('The provider returned an unsupported authorization URL.'),
      findsOneWidget,
    );
    expect(find.text('Open authorization page'), findsNothing);
    expect(gateway.calls.where((call) => call.$1 == 'external'), isEmpty);

    await cleanup(tester, controller, gateway);
  });

  testWidgets('valid authorization URL opens through the native gateway', (
    tester,
  ) async {
    final gateway = FakeGateway();
    final controller = LiveController(gateway);
    gateway.handler = (method, args) async {
      if (method == 'request' &&
          args['path'] == '/api/provider-auth/sessions') {
        return pendingLogin(
          auth: {
            'url': 'https://accounts.example/device?client=mobile',
            'userCode': 'ABCD-EFGH',
          },
        );
      }
      return gateway.normal(method, args);
    };

    await tester.pumpWidget(shell(controller));
    await tapLabel(tester, 'Log in');
    await tapLabel(tester, 'Open authorization page');
    final opened = gateway.calls.singleWhere((call) => call.$1 == 'external');
    expect(opened.$2['url'], 'https://accounts.example/device?client=mobile');

    await cleanup(tester, controller, gateway);
  });

  testWidgets('authorization link rejects the browser-captured port overflow', (
    tester,
  ) async {
    final oracle = browserUrlCase('port max plus one');
    expect(obj(oracle['newURL'])['success'], isFalse);
    final authUrl = '${oracle['raw']}'.replaceFirst('http://', 'https://');
    final gateway = FakeGateway();
    final controller = LiveController(gateway);
    gateway.handler = (method, args) async {
      if (method == 'request' &&
          args['path'] == '/api/provider-auth/sessions') {
        return pendingLogin(auth: {'url': authUrl, 'userCode': 'ABCD-EFGH'});
      }
      return gateway.normal(method, args);
    };

    await tester.pumpWidget(shell(controller));
    await tapLabel(tester, 'Log in');
    expect(
      find.text('The provider returned an unsupported authorization URL.'),
      findsOneWidget,
    );
    expect(find.text('Open authorization page'), findsNothing);
    expect(gateway.calls.where((call) => call.$1 == 'external'), isEmpty);

    await cleanup(tester, controller, gateway);
  });

  testWidgets('authorization link accepts the browser-captured port maximum', (
    tester,
  ) async {
    final oracle = browserUrlCase('port max 65535');
    expect(obj(oracle['newURL'])['success'], isTrue);
    final authUrl = '${oracle['raw']}'.replaceFirst('http://', 'https://');
    final gateway = FakeGateway();
    final controller = LiveController(gateway);
    gateway.handler = (method, args) async {
      if (method == 'request' &&
          args['path'] == '/api/provider-auth/sessions') {
        return pendingLogin(auth: {'url': authUrl, 'userCode': 'ABCD-EFGH'});
      }
      return gateway.normal(method, args);
    };

    await tester.pumpWidget(shell(controller));
    await tapLabel(tester, 'Log in');
    await tapLabel(tester, 'Open authorization page');
    final opened = gateway.calls.singleWhere((call) => call.$1 == 'external');
    expect(opened.$2['url'], authUrl);

    await cleanup(tester, controller, gateway);
  });

  testWidgets('polling success clears active state and refreshes models', (
    tester,
  ) async {
    final gateway = FakeGateway();
    final controller = LiveController(gateway);
    final active = <bool>[];
    final busy = <bool>[];
    var succeeded = 0;
    var polls = 0;
    gateway.handler = (method, args) async {
      if (method == 'request' &&
          args['path'] == '/api/provider-auth/sessions') {
        return pendingLogin();
      }
      if (method == 'request' &&
          args['path'] == '/api/provider-auth/sessions/login-1') {
        polls++;
        return {
          ...pendingLogin(),
          'status': 'succeeded',
          'auth': null,
          'prompts': const [],
        };
      }
      return gateway.normal(method, args);
    };

    await tester.pumpWidget(
      shell(
        controller,
        onActiveChanged: active.add,
        onBusyChanged: busy.add,
        onSucceeded: () async => succeeded++,
      ),
    );
    await tapLabel(tester, 'Log in');
    expect(active, [true]);
    expect(busy, [true, false]);

    await tester.pump(const Duration(seconds: 1));
    await tester.pump();
    expect(polls, 1);
    expect(find.text('Connected. 3 models are now available.'), findsOneWidget);
    expect(active, [true, false]);
    expect(succeeded, 1);

    await cleanup(tester, controller, gateway);
  });

  testWidgets('text login prompts keep exact entry and web input origin', (
    tester,
  ) async {
    final gateway = FakeGateway(), controller = LiveController(gateway);
    final prompt = <String, dynamic>{
      'id': 'code',
      'kind': 'text',
      'message': 'Enter authorization code',
      'allowEmpty': false,
    };
    gateway.handler = (method, args) async => method == 'request'
        ? pendingLogin(prompts: [prompt])
        : gateway.normal(method, args);
    await tester.pumpWidget(shell(controller));
    await tapLabel(tester, 'Log in');
    final finder = find.byType(TextField);
    final field = tester.widget<TextField>(finder);
    expect(field.obscureText, isFalse);
    expect(field.autocorrect, isFalse);
    expect(field.enableSuggestions, isFalse);
    final editable = tester
        .state<EditableTextState>(
          find.descendant(of: finder, matching: find.byType(EditableText)),
        )
        .renderEditable;
    final caret = editable.getLocalRectForCaret(const TextPosition(offset: 0));
    expect(
      editable.localToGlobal(caret.topLeft).dx - tester.getRect(finder).left,
      12,
    );
    await tester.enterText(finder, 'aB-0_l.9');
    await tapLabel(tester, 'Continue');
    expect(
      lastRequest(
        gateway,
        '/api/provider-auth/sessions/login-1/input',
        method: 'POST',
      )['body'],
      {'promptId': 'code', 'value': 'aB-0_l.9'},
    );
    await cleanup(tester, controller, gateway);
  });

  testWidgets('manual answers are masked, cleared, and never echoed on error', (
    tester,
  ) async {
    const answer = 'private-code-92817';
    final gateway = FakeGateway();
    final controller = LiveController(gateway);
    final prompt = <String, dynamic>{
      'id': 'callback',
      'kind': 'manual',
      'message': 'Paste the callback address',
      'allowEmpty': false,
    };
    gateway.handler = (method, args) async {
      if (method != 'request') return gateway.normal(method, args);
      if (args['path'] == '/api/provider-auth/sessions') {
        return pendingLogin(prompts: [prompt]);
      }
      if (args['path'] == '/api/provider-auth/sessions/login-1/input') {
        throw PlatformException(code: 'HTTP_401', message: 'Rejected $answer');
      }
      if (args['path'] == '/api/provider-auth/sessions/login-1') {
        return pendingLogin(prompts: [prompt]);
      }
      return gateway.normal(method, args);
    };

    await tester.pumpWidget(shell(controller));
    await tapLabel(tester, 'Log in');
    final field = tester.widget<TextField>(find.byType(TextField));
    expect(field.obscureText, isTrue);
    await tester.enterText(find.byType(TextField), answer);
    await tapLabel(tester, 'Finish login');
    await tester.pump();

    final request = lastRequest(
      gateway,
      '/api/provider-auth/sessions/login-1/input',
      method: 'POST',
    );
    expect(request['body'], {'promptId': 'callback', 'value': answer});
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      '',
    );
    expect(find.textContaining(answer), findsNothing);
    expect(find.text(backendFailure), findsOneWidget);

    await cleanup(tester, controller, gateway);
  });

  testWidgets('a pending answer can be cancelled before its request returns', (
    tester,
  ) async {
    final gateway = FakeGateway();
    final controller = LiveController(gateway);
    final answer = Completer<Json>();
    final prompt = <String, dynamic>{
      'id': 'code',
      'kind': 'text',
      'message': 'Enter authorization code',
      'allowEmpty': false,
    };
    gateway.handler = (method, args) async {
      if (method != 'request') return gateway.normal(method, args);
      if (args['path'] == '/api/provider-auth/sessions') {
        return pendingLogin(prompts: [prompt]);
      }
      if (args['path'] == '/api/provider-auth/sessions/login-1/input') {
        return answer.future;
      }
      if (args['path'] == '/api/provider-auth/sessions/login-1' &&
          args['method'] == 'DELETE') {
        return {'status': 'cancelled'};
      }
      return gateway.normal(method, args);
    };

    await tester.pumpWidget(shell(controller));
    await tapLabel(tester, 'Log in');
    await tester.enterText(
      find.byKey(const ValueKey('provider-login-input-code')),
      'one-time-code',
    );
    await tapLabel(tester, 'Continue');
    expect(
      tester
          .widget<TextButton>(find.widgetWithText(TextButton, 'Cancel login'))
          .onPressed,
      isNotNull,
    );

    await tapLabel(tester, 'Cancel login');
    expect(
      lastRequest(
        gateway,
        '/api/provider-auth/sessions/login-1',
        method: 'DELETE',
      )['method'],
      'DELETE',
    );
    expect(find.text('Waiting for authorization'), findsNothing);

    answer.complete(pendingLogin(prompts: [prompt]));
    await tester.pump();
    await tester.pump();
    expect(find.text('Enter authorization code'), findsNothing);
    expect(find.text('Continue'), findsNothing);

    await cleanup(tester, controller, gateway);
  });

  testWidgets('skipping select prompt omits the answer value', (tester) async {
    final gateway = FakeGateway();
    final controller = LiveController(gateway);
    final prompt = <String, dynamic>{
      'id': 'region',
      'kind': 'select',
      'message': 'Choose a region',
      'allowEmpty': false,
      'options': [
        {'id': 'us', 'label': 'United States'},
      ],
    };
    gateway.handler = (method, args) async {
      if (method != 'request') return gateway.normal(method, args);
      if (args['path'] == '/api/provider-auth/sessions') {
        return pendingLogin(prompts: [prompt]);
      }
      if (args['path'] == '/api/provider-auth/sessions/login-1/input') {
        return pendingLogin(prompts: const []);
      }
      return gateway.normal(method, args);
    };

    await tester.pumpWidget(shell(controller));
    await tapLabel(tester, 'Log in');
    await tapLabel(tester, 'Skip selection');
    expect(
      lastRequest(
        gateway,
        '/api/provider-auth/sessions/login-1/input',
        method: 'POST',
      )['body'],
      {'promptId': 'region'},
    );

    await cleanup(tester, controller, gateway);
  });

  testWidgets('logout delegates busy locking to the parent settings action', (
    tester,
  ) async {
    final gateway = FakeGateway();
    final controller = LiveController(gateway);
    final busy = <bool>[];
    final loggedOut = <String>[];
    final connectedProvider = <String, dynamic>{...provider, 'connected': true};

    await tester.pumpWidget(
      shell(
        controller,
        providers: [connectedProvider],
        onBusyChanged: busy.add,
        onLogout: (id) async => loggedOut.add(id),
      ),
    );
    await tapLabel(tester, 'Log out GitHub Copilot');
    expect(loggedOut, ['github']);
    expect(busy, isEmpty);

    await cleanup(tester, controller, gateway);
  });

  testWidgets(
    'late login from a changed account is not accepted or cancelled',
    (tester) async {
      final gateway = FakeGateway();
      final controller = LiveController(gateway)
        ..origin = 'https://gateway-a.example'
        ..clientId = 'client-a';
      final response = Completer<Json>();
      gateway.handler = (method, args) async {
        if (method == 'request' &&
            args['path'] == '/api/provider-auth/sessions') {
          return response.future;
        }
        return gateway.normal(method, args);
      };

      await tester.pumpWidget(shell(controller));
      await tapLabel(tester, 'Log in');
      controller
        ..origin = 'https://gateway-b.example'
        ..clientId = 'client-b';
      response.complete(pendingLogin());
      await tester.pump();
      await tester.pump();

      expect(find.text('Preparing the login…'), findsNothing);
      expect(
        gateway.calls.where(
          (call) =>
              call.$1 == 'request' &&
              call.$2['method'] == 'DELETE' &&
              call.$2['path'] == '/api/provider-auth/sessions/login-1',
        ),
        isEmpty,
      );
      expect(find.text('Log in'), findsOneWidget);

      await cleanup(tester, controller, gateway);
    },
  );

  testWidgets('old busy completion cannot unlock a newer account login', (
    tester,
  ) async {
    final oldGateway = FakeGateway();
    final oldController = LiveController(oldGateway)
      ..origin = 'https://gateway-a.example'
      ..clientId = 'client-a';
    final oldResponse = Completer<Json>();
    oldGateway.handler = (method, args) async {
      if (method == 'request' &&
          args['path'] == '/api/provider-auth/sessions') {
        return oldResponse.future;
      }
      return oldGateway.normal(method, args);
    };

    final newGateway = FakeGateway();
    final newController = LiveController(newGateway)
      ..origin = 'https://gateway-b.example'
      ..clientId = 'client-b';
    final newResponse = Completer<Json>();
    newGateway.handler = (method, args) async {
      if (method == 'request' &&
          args['path'] == '/api/provider-auth/sessions') {
        return newResponse.future;
      }
      return newGateway.normal(method, args);
    };

    final busy = <bool>[];
    await tester.pumpWidget(shell(oldController, onBusyChanged: busy.add));
    await tapLabel(tester, 'Log in');
    await tester.pumpWidget(shell(newController, onBusyChanged: busy.add));
    await tapLabel(tester, 'Log in');
    expect(busy.last, isTrue);

    oldResponse.complete(pendingLogin(id: 'old-login'));
    await tester.pump();
    await tester.pump();
    expect(busy.last, isTrue);
    expect(newGateway.calls.where((call) => call.$1 == 'request').length, 1);
    expect(
      tester
          .widget<TextButton>(find.widgetWithText(TextButton, 'Log in'))
          .onPressed,
      isNull,
    );

    newResponse.complete(pendingLogin(id: 'new-login'));
    await tester.pump();
    await tester.pump();
    expect(busy.last, isFalse);
    expect(find.text('ABCD-EFGH'), findsOneWidget);

    await tester.pumpWidget(const SizedBox());
    await tester.pump();
    oldController.dispose();
    newController.dispose();
    await oldGateway.stream.close();
    await newGateway.stream.close();
  });
}
