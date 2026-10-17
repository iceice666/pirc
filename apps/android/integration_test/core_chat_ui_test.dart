// Core first-run/chat UI flow against the isolated real_gateway.ts helper.
// Run only on a fresh isolated Android app install so onboarding and pairing
// are exercised through their actual screens.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/permissions.dart';
import 'package:pirc_mobile/live/mobile_tabs.dart';
import 'package:pirc_mobile/theme.dart';

class _ObservedGateway extends Gateway {
  final methods = <String>[];
  final commands = <Json>[];
  final requests = <Json>[];

  @override
  Future<dynamic> call(String method, [Json args = const {}]) {
    methods.add(method);
    if (method == 'command') commands.add(obj(args['payload']));
    if (method == 'request') requests.add(args);
    return super.call(method, args);
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'first-run pairing, model, send, Unicode rename and deletion use the real UI',
    (tester) async {
      expect(
        const bool.fromEnvironment('PIRC_REAL_GATEWAY'),
        isTrue,
        reason: 'Run only against the isolated local real_gateway.ts helper.',
      );
      const pairingLink = String.fromEnvironment('PIRC_PAIR_LINK');
      expect(
        pairingLink.isNotEmpty,
        isTrue,
        reason: 'Missing private pairing link.',
      );

      final gateway = _ObservedGateway();
      final controller = LiveController(gateway);
      final theme = await PircTheme.load();
      String? createdChatId;
      var deletedThroughUi = false;

      Future<void> until(bool Function() ready, String step) async {
        for (var i = 0; i < 200 && !ready(); i++) {
          await tester.pump(const Duration(milliseconds: 200));
        }
        expect(
          ready(),
          isTrue,
          reason:
              '$step: ${controller.error ?? controller.actionError ?? controller.connection}; '
              'selected=${controller.selectedModel?["provider"]}/${controller.selectedModel?["id"]}; '
              'snapshot=${controller.state["modelProvider"]}/${controller.state["modelId"]}; '
              'held=${controller.control["held"]}; busy=${controller.busy}',
        );
        expect(tester.takeException(), isNull, reason: step);
      }

      Future<void> tap(Finder target) async {
        // Controller receipts can arrive before Flutter rebuilds the new screen.
        await tester.pumpAndSettle();
        expect(target, findsOneWidget);
        await tester.ensureVisible(target);
        await tester.pumpAndSettle();
        expect(target.hitTestable(), findsOneWidget);
        await tester.tap(target);
        await tester.pumpAndSettle();
      }

      try {
        await tester.pumpWidget(
          MobileApp(theme: theme, controller: controller),
        );
        await until(() => !controller.booting, 'first boot');
        expect(
          controller.onboardingComplete,
          isFalse,
          reason: 'Use fresh app data to exercise first-run onboarding.',
        );
        expect(
          controller.origin,
          isNull,
          reason: 'Use an unpaired app install.',
        );
        expect(find.byType(PermissionPage), findsOneWidget);

        final notificationStatus = find.byKey(
          const Key('permission-status-notifications'),
        );
        await until(() {
          if (notificationStatus.evaluate().isEmpty) return false;
          return tester.widget<Text>(notificationStatus).data != '正在確認…';
        }, 'permission status');
        final notificationsWereUnavailable =
            tester.widget<Text>(notificationStatus).data == '尚未開啟';

        // The first-run screen explicitly allows continuing without either OS
        // permission; no permission request or direct onboarding bridge call is
        // made by the test.
        final finishGuide = find.byKey(const Key('finish-onboarding'));
        await tester.scrollUntilVisible(
          finishGuide,
          300,
          scrollable: find.byType(Scrollable).first,
        );
        await tester.pumpAndSettle();
        await tap(finishGuide);
        await until(
          () => find.byType(PairingScreen).evaluate().isNotEmpty,
          'skip optional permissions',
        );
        expect(controller.onboardingComplete, isTrue);
        expect(gateway.methods, contains('completeOnboarding'));
        expect(gateway.methods, isNot(contains('requestNotifications')));
        debugPrint(
          'CORE_CHAT_UI:permission-status-before-skip=${notificationsWereUnavailable ? 'unavailable' : 'available'}',
        );

        final pairingField = find.descendant(
          of: find.byType(PairingScreen),
          matching: find.byType(TextField),
        );
        await tester.enterText(pairingField, pairingLink);
        await tap(find.widgetWithText(FilledButton, '連接'));
        await until(
          () => controller.origin != null && !controller.busy,
          'pair from the PairingScreen field',
        );
        expect(gateway.methods, contains('pair'));
        expect(controller.origin, startsWith('http://'));
        await until(
          () => controller.workspaces.any((w) => w['kind'] == 'chat'),
          'load the paired chat workspace',
        );

        // Pairing may select a pre-existing engineering fixture. Navigate
        // through the same visible list/Chat controls a user would use.
        await until(() => !controller.initializing, 'finish paired startup');
        await tester.pumpAndSettle();
        final back = find.byTooltip('Back to the list');
        if (back.evaluate().isNotEmpty) await tap(back);
        if (controller.mode != 'chat') {
          await tap(
            find.descendant(
              of: find.byType(MobileTabs),
              matching: find.text('Chat'),
            ),
          );
        }
        await until(
          () => find.text('New chat').evaluate().isNotEmpty,
          'show chat list',
        );

        // Create a disposable chat with the visible New chat control.
        await tap(find.text('New chat'));
        await until(
          () => controller.sessionId != null && controller.canWrite,
          'create and acquire the new chat through the sidebar',
        );
        createdChatId = controller.sessionId;
        await until(
          () => controller.models.any((model) => model['available'] != false),
          'load model choices',
        );
        final availableModels = controller.models
            .where((model) => model['available'] != false)
            .toList();
        final currentlySelected = controller.selectedModel;
        final selectedModel = availableModels.firstWhere(
          (model) =>
              model['id'] != currentlySelected?['id'] ||
              model['provider'] != currentlySelected?['provider'],
          orElse: () => availableModels.first,
        );
        final modelLabel =
            '${selectedModel['displayName'] ?? selectedModel['name'] ?? selectedModel['id']}';
        await tap(find.byTooltip('Model'));
        final modelOption = find.widgetWithText(MenuItemButton, modelLabel);
        await until(
          () => modelOption.evaluate().isNotEmpty,
          'open model choices',
        );
        String modelTrace() {
          final current = controller.selectedModel;
          final commands = gateway.commands
              .where((command) => command['type'] == 'set_model')
              .map((command) => '${command['provider']}/${command['modelId']}')
              .toList();
          return 'selected=${current?['provider']}/${current?['id']} '
              'snapshot=${controller.state['modelProvider']}/${controller.state['modelId']} '
              'running=${controller.running} '
              'runStatus=${obj(controller.state['run'])['status']} '
              'held=${controller.control['held']} busy=${controller.busy} '
              'canWrite=${controller.canWrite} setModelCommands=$commands';
        }

        String? lastModelTrace;
        void traceModelState() {
          final next = modelTrace();
          if (next == lastModelTrace) return;
          lastModelTrace = next;
          debugPrint('CORE_CHAT_MODEL:$next');
        }

        controller.addListener(traceModelState);
        traceModelState();
        await tap(modelOption);
        traceModelState();
        try {
          await until(
            () =>
                controller.selectedModel?['id'] == selectedModel['id'] &&
                controller.canWrite,
            'select ${selectedModel['provider']}/${selectedModel['id']} in the composer',
          );
        } catch (_) {
          try {
            final snapshot = obj(
              await gateway.request('${sessionPath(createdChatId!)}/snapshot'),
            );
            final serverModel = obj(obj(snapshot['agent'])['model']);
            debugPrint(
              'CORE_CHAT_MODEL:server=${serverModel['provider']}/${serverModel['id']}',
            );
          } catch (error) {
            debugPrint(
              'CORE_CHAT_MODEL:server-read-failed=${error.runtimeType}',
            );
          }
          rethrow;
        } finally {
          controller.removeListener(traceModelState);
        }

        const prompt = 'Core chat UI integration message';
        await tester.enterText(find.byKey(const Key('live-draft')), prompt);
        await tester.pump();
        await tap(find.byTooltip('Send message'));
        await until(
          () =>
              !controller.running &&
              controller.messages.any(
                (message) =>
                    message['role'] == 'user' &&
                    '${message['content']}'.contains(prompt),
              ) &&
              controller.messages.any(
                (message) =>
                    message['role'] == 'assistant' &&
                    '${message['content']}'.contains('本地固定回覆'),
              ),
          'stream the scripted assistant reply',
        );
        expect(
          gateway.commands.any(
            (command) =>
                command['type'] == 'set_model' &&
                command['modelId'] == selectedModel['id'] &&
                command['provider'] == selectedModel['provider'],
          ),
          isTrue,
          reason: 'The composer prompt should include the selected model.',
        );

        final chatId = createdChatId!;
        final chat = controller.sessions.firstWhere((s) => s['id'] == chatId);
        var chatName = '${chat['name']}';
        await tap(find.byTooltip('Back to the list'));
        await until(
          () => find.text(chatName).evaluate().isNotEmpty,
          'show the created chat in the sidebar',
        );
        var renameAction = find.byTooltip('Rename $chatName');
        if (renameAction.evaluate().isEmpty) {
          await tap(find.byTooltip('Actions for $chatName'));
          renameAction = find.byTooltip('Rename $chatName');
        }
        await tap(renameAction);
        final renameInput = find.byKey(ValueKey('rename-$chatId'));
        await tester.enterText(renameInput, '😀' * 101);
        expect(
          tester.widget<TextField>(renameInput).controller!.text,
          '😀' * 100,
        );
        // Use a real UI focus change to submit, rather than calling the
        // controller or the TextField's submission callback from the test.
        final sidebarSearch = find.byWidgetPredicate(
          (w) => w is TextField && w.decoration?.hintText == 'Search chats',
        );
        await tap(sidebarSearch);
        chatName = '😀' * 100;
        await until(
          () => controller.sessions.any(
            (s) => s['id'] == chatId && s['name'] == chatName,
          ),
          'save the Unicode rename through sidebar blur',
        );
        final renamed = await gateway.request('/api/sessions');
        expect(
          rows(
            renamed['sessions'],
          ).singleWhere((s) => s['id'] == chatId)['name'],
          chatName,
        );
        expect(
          gateway.requests.where(
            (r) => r['method'] == 'PATCH' && r['path'] == sessionPath(chatId),
          ),
          hasLength(1),
        );
        expect(find.byKey(ValueKey('rename-$chatId')), findsNothing);
        debugPrint('CORE_CHAT_UI:unicode-rename-200-utf16-verified');
        var deleteAction = find.byTooltip('Delete $chatName');
        if (deleteAction.evaluate().isEmpty) {
          await tap(find.byTooltip('Actions for $chatName'));
          deleteAction = find.byTooltip('Delete $chatName');
        }
        await tap(deleteAction);
        await tap(find.text('Delete chat and memories'));
        await until(
          () =>
              controller.sessionId == null &&
              !controller.sessions.any((s) => s['id'] == chatId),
          'delete the chat through the sidebar confirmation',
        );
        deletedThroughUi = true;

        final remaining = await gateway.request('/api/sessions');
        expect(
          rows(remaining['sessions']).any((session) => session['id'] == chatId),
          isFalse,
          reason: 'The deleted chat must be absent from the gateway list.',
        );
        await expectLater(
          gateway.request(sessionPath(chatId)),
          throwsA(
            isA<PlatformException>().having(
              (error) => error.code,
              'code',
              'HTTP_404',
            ),
          ),
        );
        debugPrint('CORE_CHAT_UI:pair-send-delete-verified');
      } finally {
        // Only test-failure cleanup uses a direct DELETE; the asserted path
        // above performs deletion through the sidebar confirmation UI.
        if (createdChatId != null && !deletedThroughUi) {
          try {
            await gateway.request(sessionPath(createdChatId), method: 'DELETE');
          } catch (_) {}
        }
        await tester.pumpWidget(const SizedBox());
        await tester.pump();
        try {
          await gateway.call('unwatch');
        } catch (_) {}
      }
    },
    timeout: const Timeout(Duration(minutes: 5)),
  );
}
