import 'dart:convert';
import 'dart:io';
import 'package:flutter/services.dart';

/// macOS's PingFang, a downloadable mobile asset: `null` where it is not
/// installed (GitHub's macOS runners). The asset directory's version suffix
/// changes with macOS releases (`com_apple_MobileAsset_Font7`, `Font8`, …),
/// so look in all of them, newest first.
File? pingFangFont() {
  final assets = Directory('/System/Library/AssetsV2');
  if (!assets.existsSync()) return null;
  final directories =
      assets
          .listSync()
          .whereType<Directory>()
          .where(
            (dir) =>
                RegExp(r'/com_apple_MobileAsset_Font\d+$').hasMatch(dir.path),
          )
          .toList()
        ..sort((a, b) => b.path.compareTo(a.path));
  for (final directory in directories) {
    for (final file in directory.listSync(recursive: true).whereType<File>()) {
      if (file.path.endsWith('/PingFang.ttc')) return file;
    }
  }
  return null;
}

/// PingFang-dependent geometry tests are skipped where it is not installed
/// (`testWidgets(..., skip: noPingFang)`); run them on a Mac that has it to
/// compare against the browser reference.
final bool noPingFang = pingFangFont() == null;

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
