import 'package:flutter_test/flutter_test.dart';

/// Open a session's document in the Files pane: the engine shows a session
/// by its panes (plans/rewrite/12-android.md, decision 4), so content that
/// used to arrive as an assistant message is a file of its workspace (see
/// `FakeGateway.sessionDocuments`).
Future<void> openSessionDocument(WidgetTester tester, String id) async {
  final entry = find.text('$id.md');
  await tester.ensureVisible(entry.first);
  await tester.tap(entry.first);
  await tester.pumpAndSettle();
}
