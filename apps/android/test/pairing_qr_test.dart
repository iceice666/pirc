import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/pairing_qr.dart';

void main() {
  late Map<String, dynamic> reference;

  setUpAll(() {
    reference =
        jsonDecode(File('test/fixtures/pairing_qr_uqr.json').readAsStringSync())
            as Map<String, dynamic>;
  });

  test('matches pinned uqr ECC M matrices including quiet zone', () {
    expect(reference['generator'], 'uqr@0.1.3');
    expect(reference['errorCorrection'], 'M');
    expect(reference['quietZone'], 4);

    for (final entry in reference['cases'] as List<dynamic>) {
      final item = entry as Map<String, dynamic>;
      final expectedRows = (item['rows'] as List<dynamic>).cast<String>();
      final actualRows = pairingQrModules(item['data'] as String)
          .map((row) => row.map((dark) => dark ? '1' : '0').join())
          .toList(growable: false);
      expect(actualRows, expectedRows, reason: item['id'] as String);
      expect(actualRows.length, item['size'], reason: item['id'] as String);
      expect(item['version'], greaterThanOrEqualTo(1));
    }
  });

  testWidgets('painted module centers preserve source black and white values', (
    tester,
  ) async {
    final item = (reference['cases'] as List)[1] as Map<String, dynamic>;
    final data = item['data'] as String;
    await tester.pumpWidget(
      Directionality(
        textDirection: TextDirection.ltr,
        child: Center(child: PairingQr(data: data)),
      ),
    );
    final painter = tester
        .widget<CustomPaint>(find.byType(CustomPaint))
        .painter!;
    final mismatches = await tester.runAsync(() async {
      final recorder = ui.PictureRecorder();
      painter.paint(ui.Canvas(recorder), const Size(200, 200));
      final picture = recorder.endRecording();
      final image = await picture.toImage(200, 200);
      try {
        final bytes = await image.toByteData(
          format: ui.ImageByteFormat.rawRgba,
        );
        if (bytes == null) throw StateError('Missing raster bytes');
        final rows = (item['rows'] as List).cast<String>();
        var errors = 0;
        for (var row = 0; row < rows.length; row++) {
          for (var column = 0; column < rows.length; column++) {
            final x = ((column + .5) * 200 / rows.length).floor();
            final y = ((row + .5) * 200 / rows.length).floor();
            final offset = (y * 200 + x) * 4;
            final expected = rows[row][column] == '1' ? 0 : 255;
            if (bytes.getUint8(offset) != expected ||
                bytes.getUint8(offset + 1) != expected ||
                bytes.getUint8(offset + 2) != expected ||
                bytes.getUint8(offset + 3) != 255) {
              errors++;
            }
          }
        }
        return errors;
      } finally {
        image.dispose();
        picture.dispose();
      }
    });
    expect(mismatches, 0);
    expect(tester.takeException(), isNull);
  });

  testWidgets('renders a crisp square QR with image semantics', (tester) async {
    final semantics = tester.ensureSemantics();
    final cases = reference['cases'] as List<dynamic>;
    final item = cases[1] as Map<String, dynamic>;
    final data = item['data'] as String;

    await tester.pumpWidget(
      Directionality(
        textDirection: TextDirection.ltr,
        child: Center(
          child: SizedBox.square(dimension: 200, child: PairingQr(data: data)),
        ),
      ),
    );
    final customPaint = find.byType(CustomPaint);
    final qrRect = tester.getRect(customPaint);
    expect(qrRect.size, const Size(200, 200));
    expect(find.bySemanticsLabel('Pairing QR code'), findsOneWidget);
    expect(
      tester.renderObject<RenderCustomPaint>(customPaint).painter,
      isNotNull,
    );
    expect(
      tester.widget<ClipRRect>(find.byType(ClipRRect)).borderRadius,
      BorderRadius.circular(8),
    );
    expect(item['size'], greaterThan(41));
    semantics.dispose();
  });
}
