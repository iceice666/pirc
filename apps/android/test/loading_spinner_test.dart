import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/timeline_tools.dart';
import 'package:pirc_mobile/live/web_controls.dart';
import 'package:pirc_mobile/live/jobs_menu.dart';
import 'package:pirc_mobile/live/jobs_state.dart';
import 'jobs_parity_test.dart' show controller;
import 'live_test.dart' show FakeGateway, theme;

Widget shell(Widget child, {bool visible = true, bool reduced = false}) =>
    MaterialApp(
      theme: theme.build(Brightness.light),
      home: MediaQuery(
        data: MediaQueryData(disableAnimations: reduced),
        child: TickerMode(
          enabled: visible,
          child: Scaffold(body: child),
        ),
      ),
    );
void main() {
  testWidgets('running tool rotates once each second and stops when complete', (
    t,
  ) async {
    await t.pumpWidget(shell(const TimelineStatus('running')));
    final transition = find.descendant(
      of: find.byType(WebSpinner),
      matching: find.byType(RotationTransition),
    );
    double turns() => t.widget<RotationTransition>(transition).turns.value;
    expect(turns(), 0);
    await t.pump(const Duration(milliseconds: 250));
    expect(turns(), closeTo(.25, .001));
    await t.pump(const Duration(milliseconds: 500));
    expect(turns(), closeTo(.75, .001));
    await t.pump(const Duration(milliseconds: 500));
    expect(turns(), closeTo(.25, .001));
    await t.pumpWidget(shell(const TimelineStatus('done')));
    expect(find.byType(WebSpinner), findsNothing);
    await t.pumpWidget(shell(const TimelineStatus('failed')));
    expect(find.byType(WebSpinner), findsNothing);
    await t.pumpWidget(const SizedBox.shrink());
    expect(t.takeException(), isNull);
  });
  testWidgets('hidden and reduced-motion loaders do not keep ticking', (
    t,
  ) async {
    Widget page({bool visible = true, bool reduced = false}) =>
        shell(const WebSpinner(), visible: visible, reduced: reduced);
    double turns() => t
        .widget<RotationTransition>(
          find.descendant(
            of: find.byType(WebSpinner),
            matching: find.byType(RotationTransition),
          ),
        )
        .turns
        .value;
    await t.pumpWidget(page());
    await t.pump(const Duration(milliseconds: 250));
    expect(turns(), closeTo(.25, .001));
    await t.pumpWidget(page(visible: false));
    final paused = turns();
    await t.pump(const Duration(milliseconds: 500));
    expect(turns(), paused);
    await t.pumpWidget(page());
    await t.pump(const Duration(milliseconds: 250));
    expect(turns(), isNot(paused));
    await t.pumpWidget(page(reduced: true));
    expect(turns(), 0);
    await t.pump(const Duration(seconds: 2));
    expect(turns(), 0);
    expect(t.binding.hasScheduledFrame, isFalse);
    await t.pumpWidget(const SizedBox.shrink());
    expect(t.takeException(), isNull);
  });
  testWidgets('background stopping indicator is animated until task settles', (
    t,
  ) async {
    final g = FakeGateway(), c = controller(g), jobs = JobsState(c);
    jobs.data = {
      'backgroundTasks': [
        {
          'id': 'one',
          'status': 'stopping',
          'command': 'command one',
          'startedAt': 1000,
        },
      ],
    };
    try {
      await t.pumpWidget(shell(JobsList(jobs: jobs)));
      expect(find.bySemanticsLabel('Stopping'), findsOneWidget);
      double turns() => t
          .widget<RotationTransition>(
            find.descendant(
              of: find.byType(WebSpinner),
              matching: find.byType(RotationTransition),
            ),
          )
          .turns
          .value;
      final before = turns();
      await t.pump(const Duration(milliseconds: 50));
      expect(turns(), isNot(before));
      jobs.data = {
        'backgroundTasks': [
          {
            'id': 'one',
            'status': 'completed',
            'command': 'command one',
            'startedAt': 1000,
            'endedAt': 2000,
          },
        ],
      };
      await t.pumpWidget(shell(JobsList(jobs: jobs)));
      expect(find.byType(WebSpinner), findsNothing);
    } finally {
      await t.pumpWidget(const SizedBox.shrink());
      jobs.dispose();
      c.dispose();
      await g.stream.close();
    }
  });
}
