import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/attention.dart';

void main() {
  test('labels network-fetching bash memory origins like the web client', () {
    expect(
      describeOrigins(['assistant', 'tool:bash:network']),
      'From the assistant, tool output (bash fetching from the network)',
    );
  });
}
