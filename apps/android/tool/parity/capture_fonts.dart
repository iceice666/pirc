import 'dart:convert';
import 'dart:io';
import 'package:flutter/services.dart';

// Comparison-only host fonts. No font files are copied into the app.
Future<void> loadParityFonts() async {
  final manifest =
      jsonDecode(await rootBundle.loadString('FontManifest.json')) as List;
  for (final entry in manifest) {
    final loader = FontLoader(entry['family'] as String);
    for (final font in entry['fonts']) {
      loader.addFont(rootBundle.load(font['asset']));
    }
    await loader.load();
  }
  for (final family in ['Arial', 'Roboto', 'Ahem']) {
    final loader = FontLoader(family);
    for (final file in [
      'Arial.ttf',
      'Arial Bold.ttf',
      'Arial Italic.ttf',
      'Arial Bold Italic.ttf',
    ]) {
      loader.addFont(
        File(
          '/System/Library/Fonts/Supplemental/$file',
        ).readAsBytes().then(ByteData.sublistView),
      );
    }
    await loader.load();
  }
  await (FontLoader('monospace')..addFont(
        File(
          '/System/Library/Fonts/Menlo.ttc',
        ).readAsBytes().then(ByteData.sublistView),
      ))
      .load();
}
