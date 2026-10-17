import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/rendering/html_keyboard_events.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('key-up letters retain browser key casing and physical code', () {
    final data = nativeHtmlKeyboardEventData(
      const KeyUpEvent(
        physicalKey: PhysicalKeyboardKey.keyA,
        logicalKey: LogicalKeyboardKey.keyA,
        timeStamp: Duration.zero,
      ),
    );
    expect(data['key'], 'a');
    expect(data['code'], 'KeyA');
    expect(data['keyCode'], 65);
    expect(data['repeat'], false);
  });
  test('numpad Enter and repeated composing keys carry distinct metadata', () {
    final data = nativeHtmlKeyboardEventData(
      const KeyRepeatEvent(
        physicalKey: PhysicalKeyboardKey.numpadEnter,
        logicalKey: LogicalKeyboardKey.numpadEnter,
        timeStamp: Duration.zero,
      ),
      isComposing: true,
    );
    expect(data['key'], 'Enter');
    expect(data['code'], 'NumpadEnter');
    expect(data['location'], 3);
    expect(data['repeat'], true);
    expect(data['isComposing'], true);
    expect(data['keyCode'], 13);
  });
}
