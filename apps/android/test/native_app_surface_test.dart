import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/native_app_surface.dart';

class _SurfaceHarness extends StatefulWidget {
  const _SurfaceHarness({super.key});

  @override
  State<_SurfaceHarness> createState() => _SurfaceHarnessState();
}

class _SurfaceHarnessState extends State<_SurfaceHarness> {
  final surfaceKey = GlobalKey<NativeAppSurfaceState>();
  final scrollController = ScrollController();
  Object activeIdentity = 'entry-a';
  Set<Object> retainedIdentities = <Object>{'entry-a', 'entry-b'};
  Object accountIdentity = 'account-1';
  bool visible = true;
  bool hostOwnsBack = false;
  bool baseCanPop = false;
  int navigationChanges = 0;
  int basePopAttempts = 0;
  int hostPopAttempts = 0;

  void select(String identity) => setState(() => activeIdentity = identity);

  void setRetained(Set<Object> identities) => setState(() {
    retainedIdentities = identities;
  });

  void setAccount(Object account) => setState(() => accountIdentity = account);

  void setVisible(bool next) => setState(() => visible = next);

  void setHostOwnsBack(bool next) => setState(() => hostOwnsBack = next);

  void setBaseCanPop(bool next) => setState(() => baseCanPop = next);

  @override
  void dispose() {
    scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final content = Stack(
      children: [
        const Positioned.fill(
          child: ColoredBox(
            color: Colors.white,
            child: Center(child: Text('visible-other-window')),
          ),
        ),
        NativeAppSurface(
          key: surfaceKey,
          activeIdentity: activeIdentity,
          retainedIdentities: retainedIdentities,
          accountIdentity: accountIdentity,
          visible: visible,
          onNavigationChanged: () => navigationChanges++,
          child: Scaffold(
            body: PopScope<void>(
              canPop: baseCanPop,
              onPopInvokedWithResult: (didPop, _) {
                if (!didPop) basePopAttempts++;
              },
              child: SingleChildScrollView(
                controller: scrollController,
                child: const SizedBox(
                  height: 2000,
                  child: Text('App root content'),
                ),
              ),
            ),
          ),
        ),
      ],
    );
    return MaterialApp(
      home: PopScope<void>(
        canPop: !hostOwnsBack,
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop && hostOwnsBack) hostPopAttempts++;
        },
        child: content,
      ),
    );
  }
}

class _CounterDialog extends StatefulWidget {
  const _CounterDialog({required this.identity});

  final String identity;

  @override
  State<_CounterDialog> createState() => _CounterDialogState();
}

class _CounterDialogState extends State<_CounterDialog> {
  final text = TextEditingController();
  int count = 0;

  @override
  void dispose() {
    text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Dialog(
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text('dialog-${widget.identity}-count-$count'),
          TextField(
            key: Key('dialog-text-${widget.identity}'),
            controller: text,
          ),
          TextButton(
            key: Key('dialog-increment-${widget.identity}'),
            onPressed: () => setState(() => count++),
            child: const Text('Increment'),
          ),
        ],
      ),
    ),
  );
}

Future<void> _showCounterDialog(
  WidgetTester tester,
  _SurfaceHarnessState harness,
  String identity,
) async {
  final context = harness.surfaceKey.currentState!.appContext;
  expect(context, isNotNull);
  unawaited(
    showDialog<void>(
      context: context!,
      useRootNavigator: false,
      builder: (_) => _CounterDialog(identity: identity),
    ),
  );
  await tester.pumpAndSettle();
}

int _enabledPopHandlerCount(WidgetTester tester) => tester
    .widgetList<NavigatorPopHandler<void>>(
      find.byType(NavigatorPopHandler<void>, skipOffstage: false),
    )
    .where((handler) => handler.enabled)
    .length;

void main() {
  testWidgets('retains each entry modal while hidden and pops only active', (
    tester,
  ) async {
    final key = GlobalKey<_SurfaceHarnessState>();
    await tester.pumpWidget(_SurfaceHarness(key: key));
    await tester.pumpAndSettle();
    final harness = key.currentState!;
    final surface = harness.surfaceKey.currentState!;

    // Retained but never visited identities do not allocate local Navigators.
    expect(
      find.byType(NavigatorPopHandler<void>, skipOffstage: false),
      findsOneWidget,
    );
    expect(_enabledPopHandlerCount(tester), 1);
    expect(harness.scrollController.positions, hasLength(1));

    await _showCounterDialog(tester, harness, 'a');
    await tester.tap(find.byKey(const Key('dialog-increment-a')));
    await tester.enterText(find.byKey(const Key('dialog-text-a')), 'saved A');
    await tester.pumpAndSettle();
    expect(surface.canPop, isTrue);
    final changesBeforePush = harness.navigationChanges;

    harness.select('entry-b');
    await tester.pumpAndSettle();
    expect(find.text('dialog-a-count-1'), findsNothing);
    expect(surface.appContext, isNotNull);
    expect(surface.canPop, isFalse);
    expect(_enabledPopHandlerCount(tester), 1);
    expect(
      find.byType(NavigatorPopHandler<void>, skipOffstage: false),
      findsNWidgets(2),
    );
    expect(harness.scrollController.positions, hasLength(1));

    await _showCounterDialog(tester, harness, 'b');
    await tester.tap(find.byKey(const Key('dialog-increment-b')));
    await tester.pumpAndSettle();
    expect(surface.canPop, isTrue);

    harness.select('entry-a');
    await tester.pumpAndSettle();
    expect(find.text('dialog-a-count-1'), findsOneWidget);
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('dialog-text-a')))
          .controller!
          .text,
      'saved A',
    );
    expect(find.text('dialog-b-count-1'), findsNothing);
    expect(harness.scrollController.positions, hasLength(1));
    expect(harness.navigationChanges, greaterThan(changesBeforePush));

    final changesBeforePop = harness.navigationChanges;
    expect(await surface.popOverlay(), isTrue);
    await tester.pumpAndSettle();
    expect(find.text('dialog-a-count-1'), findsNothing);
    expect(surface.canPop, isFalse);
    expect(harness.navigationChanges, greaterThan(changesBeforePop));
    expect(tester.takeException(), isNull);
  });

  testWidgets('account changes and pruned entries discard their modal stacks', (
    tester,
  ) async {
    final key = GlobalKey<_SurfaceHarnessState>();
    await tester.pumpWidget(_SurfaceHarness(key: key));
    await tester.pumpAndSettle();
    final harness = key.currentState!;
    final surface = harness.surfaceKey.currentState!;

    await _showCounterDialog(tester, harness, 'a');
    await tester.tap(find.byKey(const Key('dialog-increment-a')));
    await tester.pumpAndSettle();

    harness.select('entry-b');
    await tester.pumpAndSettle();
    await _showCounterDialog(tester, harness, 'b');
    await tester.tap(find.byKey(const Key('dialog-increment-b')));
    await tester.pumpAndSettle();

    harness.setRetained(<Object>{'entry-b'});
    await tester.pumpAndSettle();
    expect(find.text('dialog-b-count-1'), findsOneWidget);

    // Re-entering the pruned identity creates a fresh stack.
    harness.setRetained(<Object>{'entry-a', 'entry-b'});
    harness.select('entry-a');
    await tester.pumpAndSettle();
    expect(find.text('dialog-a-count-1'), findsNothing);
    expect(surface.canPop, isFalse);

    await _showCounterDialog(tester, harness, 'a');
    expect(find.text('dialog-a-count-0'), findsOneWidget);

    // Account replacement clears even the currently active Navigator.
    harness.setAccount('account-2');
    await tester.pumpAndSettle();
    expect(find.text('dialog-a-count-0'), findsNothing);
    expect(surface.canPop, isFalse);
    expect(surface.appContext, isNotNull);
    await _showCounterDialog(tester, harness, 'a');
    expect(find.text('dialog-a-count-0'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('hidden surfaces expose no context or pop capability', (
    tester,
  ) async {
    final key = GlobalKey<_SurfaceHarnessState>();
    await tester.pumpWidget(_SurfaceHarness(key: key));
    await tester.pumpAndSettle();
    final harness = key.currentState!;
    final surface = harness.surfaceKey.currentState!;

    await _showCounterDialog(tester, harness, 'a');
    expect(surface.canPop, isTrue);
    harness.setVisible(false);
    await tester.pumpAndSettle();
    expect(surface.appContext, isNull);
    expect(surface.canPop, isFalse);
    expect(_enabledPopHandlerCount(tester), 0);
    expect(await surface.popOverlay(), isFalse);

    harness.setVisible(true);
    await tester.pumpAndSettle();
    expect(find.text('dialog-a-count-0'), findsOneWidget);
    expect(surface.canPop, isTrue);
    expect(await surface.popOverlay(), isTrue);
    await tester.pumpAndSettle();
    expect(surface.canPop, isFalse);
    expect(find.text('dialog-a-count-0'), findsNothing);

    await _showCounterDialog(tester, harness, 'a');
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.text('dialog-a-count-0'), findsNothing);
    expect(find.text('App root content'), findsOneWidget);
    expect(surface.canPop, isFalse);
    expect(tester.takeException(), isNull);
  });

  testWidgets('system back reaches the local base route PopScope', (
    tester,
  ) async {
    final key = GlobalKey<_SurfaceHarnessState>();
    await tester.pumpWidget(_SurfaceHarness(key: key));
    await tester.pumpAndSettle();
    final harness = key.currentState!;
    final surface = harness.surfaceKey.currentState!;

    expect(surface.canPop, isFalse);
    expect(await surface.popOverlay(), isFalse);
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();

    expect(harness.basePopAttempts, 1);
    expect(find.text('App root content'), findsOneWidget);
    expect(surface.canPop, isFalse);
    expect(tester.takeException(), isNull);
  });

  testWidgets('host history and local base PopScope both see blocked back', (
    tester,
  ) async {
    final key = GlobalKey<_SurfaceHarnessState>();
    await tester.pumpWidget(_SurfaceHarness(key: key));
    await tester.pumpAndSettle();
    final harness = key.currentState!;

    harness.setHostOwnsBack(true);
    await tester.pumpAndSettle();
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();

    expect(harness.hostPopAttempts, 1);
    expect(harness.basePopAttempts, 1);
    expect(find.text('App root content'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('host-owned back does not pop the local root when allowed', (
    tester,
  ) async {
    final key = GlobalKey<_SurfaceHarnessState>();
    await tester.pumpWidget(_SurfaceHarness(key: key));
    await tester.pumpAndSettle();
    final harness = key.currentState!;

    harness.setHostOwnsBack(true);
    harness.setBaseCanPop(true);
    await tester.pumpAndSettle();
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();

    expect(harness.hostPopAttempts, 1);
    expect(find.text('App root content'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('snackbars stay with their local App surface', (tester) async {
    final key = GlobalKey<_SurfaceHarnessState>();
    await tester.pumpWidget(_SurfaceHarness(key: key));
    await tester.pumpAndSettle();
    final harness = key.currentState!;
    final surface = harness.surfaceKey.currentState!;
    final messengerA = ScaffoldMessenger.of(surface.appContext!);

    messengerA.showSnackBar(
      const SnackBar(
        content: Text('notice-from-a'),
        duration: Duration(days: 1),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('notice-from-a'), findsOneWidget);

    harness.select('entry-b');
    await tester.pumpAndSettle();
    final messengerB = ScaffoldMessenger.of(surface.appContext!);
    expect(messengerB, isNot(same(messengerA)));
    expect(find.text('notice-from-a'), findsNothing);

    messengerB.showSnackBar(
      const SnackBar(
        content: Text('notice-from-b'),
        duration: Duration(days: 1),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('notice-from-b'), findsOneWidget);
    expect(find.text('notice-from-a'), findsNothing);

    harness.select('entry-a');
    await tester.pumpAndSettle();
    expect(find.text('notice-from-a'), findsOneWidget);
    expect(find.text('notice-from-b'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('hidden surfaces keep owned context and local overlays', (
    tester,
  ) async {
    final key = GlobalKey<_SurfaceHarnessState>();
    await tester.pumpWidget(_SurfaceHarness(key: key));
    await tester.pumpAndSettle();
    final harness = key.currentState!;
    final surface = harness.surfaceKey.currentState!;

    harness.setVisible(false);
    await tester.pumpAndSettle();
    expect(surface.appContext, isNull);
    expect(surface.ownedAppContext, isNotNull);
    expect(find.text('visible-other-window'), findsOneWidget);

    unawaited(
      showDialog<void>(
        context: surface.ownedAppContext!,
        useRootNavigator: false,
        builder: (_) => const AlertDialog(content: Text('hidden-local-dialog')),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('hidden-local-dialog'), findsNothing);
    expect(find.text('visible-other-window'), findsOneWidget);

    harness.setVisible(true);
    await tester.pumpAndSettle();
    expect(find.text('hidden-local-dialog'), findsOneWidget);
    expect(surface.canPop, isTrue);

    await surface.popOverlay();
    await tester.pumpAndSettle();
    expect(find.text('hidden-local-dialog'), findsNothing);

    await _showCounterDialog(tester, harness, 'a');
    harness.setVisible(false);
    await tester.pumpAndSettle();
    await surface.closeOverlays();
    await tester.pumpAndSettle();
    expect(surface.appContext, isNull);
    expect(surface.ownedAppContext, isNotNull);
    expect(find.text('visible-other-window'), findsOneWidget);

    harness.setVisible(true);
    await tester.pumpAndSettle();
    expect(find.text('dialog-a-count-0'), findsNothing);
    expect(find.text('App root content'), findsOneWidget);
    expect(surface.canPop, isFalse);
    expect(tester.takeException(), isNull);
  });
}
