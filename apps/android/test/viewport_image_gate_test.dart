import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/viewport_image_gate.dart';

void main() {
  for (final dpr in [1.0, 3.0]) {
    testWidgets('far image waits for viewport proximity at DPR $dpr', (
      t,
    ) async {
      t.view.devicePixelRatio = dpr;
      t.view.physicalSize = Size(390 * dpr, 800 * dpr);
      addTearDown(t.view.reset);
      final scroll = ScrollController();
      var starts = 0;
      await t.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              controller: scroll,
              child: Column(
                children: [
                  const SizedBox(height: 4000),
                  ViewportImageGate(
                    preloadDistance: 1250,
                    placeholder: const SizedBox(width: 70, height: 20),
                    builder: (_) {
                      starts++;
                      return const SizedBox(width: 200, height: 100);
                    },
                  ),
                  const SizedBox(height: 1000),
                ],
              ),
            ),
          ),
        ),
      );
      await t.pumpAndSettle();
      expect(starts, 0);
      scroll.jumpTo(1800);
      await t.pumpAndSettle();
      expect(starts, 0);
      scroll.jumpTo(2000);
      await t.pumpAndSettle();
      expect(starts, 1);
      scroll.jumpTo(0);
      await t.pumpAndSettle();
      expect(starts, 1);
      await t.pumpWidget(const SizedBox());
      scroll.dispose();
    });
  }
  testWidgets('hidden owner defers loading until restored', (t) async {
    var enabled = false, starts = 0;
    late StateSetter update;
    await t.pumpWidget(
      MaterialApp(
        home: StatefulBuilder(
          builder: (context, setState) {
            update = setState;
            return TickerMode(
              enabled: enabled,
              child: ViewportImageGate(
                preloadDistance: 1250,
                placeholder: const SizedBox(width: 70, height: 20),
                builder: (_) {
                  starts++;
                  return const SizedBox(width: 200, height: 100);
                },
              ),
            );
          },
        ),
      ),
    );
    await t.pumpAndSettle();
    expect(starts, 0);
    update(() => enabled = true);
    await t.pumpAndSettle();
    expect(starts, 1);
  });
  testWidgets('offstage subtree does not resolve without a scroll viewport', (
    t,
  ) async {
    var hidden = true, starts = 0;
    late StateSetter update;
    await t.pumpWidget(
      MaterialApp(
        home: StatefulBuilder(
          builder: (context, setState) {
            update = setState;
            return Offstage(
              offstage: hidden,
              child: ViewportImageGate(
                preloadDistance: 1250,
                placeholder: const SizedBox(width: 70, height: 20),
                builder: (_) {
                  starts++;
                  return const SizedBox(width: 200, height: 100);
                },
              ),
            );
          },
        ),
      ),
    );
    await t.pumpAndSettle();
    expect(starts, 0);
    update(() => hidden = false);
    await t.pumpAndSettle();
    expect(starts, 1);
  });
  testWidgets('inner scroll visibility is checked as well as the screen', (
    t,
  ) async {
    var starts = 0;
    final inner = ScrollController();
    await t.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: Alignment.topLeft,
            child: SizedBox(
              height: 100,
              child: SingleChildScrollView(
                controller: inner,
                child: Column(
                  children: [
                    const SizedBox(height: 1400),
                    ViewportImageGate(
                      preloadDistance: 1250,
                      placeholder: const SizedBox(width: 70, height: 20),
                      builder: (_) {
                        starts++;
                        return const SizedBox(width: 200, height: 100);
                      },
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await t.pumpAndSettle();
    expect(starts, 0);
    inner.jumpTo(100);
    await t.pumpAndSettle();
    expect(starts, 1);
    await t.pumpWidget(const SizedBox());
    inner.dispose();
  });
}
