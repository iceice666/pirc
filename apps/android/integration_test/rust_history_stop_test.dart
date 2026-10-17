// Real public Rust prompts, full pinned 145-message prefix, and its stop record.
// This does not replace the original exact-145 history baseline acceptance.
import 'history_test.dart' show registerHistoryReadingTest;

void main() => registerHistoryReadingTest(stopped: true);
