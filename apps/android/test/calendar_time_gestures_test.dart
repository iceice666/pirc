import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/calendar_time_gestures.dart';

void main() {
  test('drag snapping works in both directions', () {
    expect(calendarDragMinutes(56), 60);
    expect(calendarDragMinutes(-14), -15);
    expect(calendarDragMinutes(6), 0);
    expect(calendarDragMinutes(8), 15);
  });

  testWidgets('long press move and resize emit draft deltas only', (
    tester,
  ) async {
    final moves = <Offset>[];
    final resizes = <double>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: SizedBox(
              width: 180,
              height: 84,
              child: CalendarTimeGestures(
                onMove: moves.add,
                onResize: resizes.add,
                resizeLabel: 'End time',
                handleColor: Colors.blue,
                child: const ColoredBox(color: Colors.lightBlue),
              ),
            ),
          ),
        ),
      ),
    );
    final card = find.byType(CalendarTimeGestures);
    final origin = tester.getTopLeft(card);
    final gesture = await tester.startGesture(origin + const Offset(30, 15));
    await tester.pump(const Duration(milliseconds: 600));
    await gesture.moveBy(const Offset(116, 56));
    await tester.pump();
    await gesture.up();
    await tester.pumpAndSettle();
    expect(moves, [const Offset(116, 56)]);
    expect(resizes, isEmpty);
    final resize = await tester.startGesture(
      tester.getCenter(find.byKey(const ValueKey('calendar-resize-handle'))),
    );
    // Cross the drag slop first; only subsequent movement contributes.
    await resize.moveBy(const Offset(0, 24));
    await tester.pump();
    await resize.moveBy(const Offset(0, 28));
    await tester.pump();
    await resize.up();
    await tester.pumpAndSettle();
    expect(moves, hasLength(1));
    expect(resizes, [28]);
  });

  testWidgets('ordinary swipes scroll instead of moving events', (
    tester,
  ) async {
    var moved = false;
    final scroll = ScrollController();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ListView(
            controller: scroll,
            children: [
              SizedBox(
                height: 100,
                child: CalendarTimeGestures(
                  onMove: (_) => moved = true,
                  onResize: (_) {},
                  resizeLabel: 'End time',
                  handleColor: Colors.blue,
                  child: const ColoredBox(color: Colors.lightBlue),
                ),
              ),
              const SizedBox(height: 1500),
            ],
          ),
        ),
      ),
    );
    await tester.dragFrom(const Offset(80, 30), const Offset(0, -120));
    await tester.pumpAndSettle();
    expect(moved, isFalse);
    expect(scroll.offset, greaterThan(0));
    await tester.pumpWidget(const SizedBox());
    scroll.dispose();
  });

  testWidgets('system pointer cancellation discards the move', (tester) async {
    var moved = false;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 180,
            height: 84,
            child: CalendarTimeGestures(
              onMove: (_) => moved = true,
              onResize: (_) {},
              resizeLabel: 'End time',
              handleColor: Colors.blue,
              child: const ColoredBox(color: Colors.lightBlue),
            ),
          ),
        ),
      ),
    );
    final gesture = await tester.startGesture(const Offset(30, 15));
    await tester.pump(const Duration(milliseconds: 600));
    await gesture.moveBy(const Offset(0, 56));
    await tester.pump();
    await gesture.cancel();
    await tester.pumpAndSettle();
    expect(moved, isFalse);
  });
}
