import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:pirc_mobile/live/composer_attachments.dart';
import 'package:pirc_mobile/live/gateway.dart';

import 'live_test.dart' show theme;

final _rasterPreview = Uint8List.fromList(
  base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  ),
);
final _svgPreview = Uint8List.fromList(
  utf8.encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
    '<rect width="10" height="10" fill="red"/></svg>',
  ),
);

Json _attachment({
  required String id,
  required String name,
  String kind = 'image',
  String mimeType = 'image/png',
  Uint8List? previewBytes,
  bool uploading = false,
}) => {
  'id': id,
  'name': name,
  'kind': kind,
  'mimeType': mimeType,
  'size': 1,
  'previewBytes': ?previewBytes,
  'uploading': uploading,
};

Widget _app({
  required List<Json> attachments,
  required ValueChanged<Json> onRemove,
}) => MaterialApp(
  theme: theme.build(Brightness.light),
  home: Scaffold(
    body: ComposerAttachmentStrip(attachments: attachments, onRemove: onRemove),
  ),
);

void main() {
  testWidgets('raster and SVG previews render as 36 px cover thumbnails', (
    t,
  ) async {
    final attachments = [
      _attachment(
        id: 'raster',
        name: 'photo.png',
        previewBytes: _rasterPreview,
      ),
      _attachment(
        id: 'svg',
        name: 'diagram.svg',
        mimeType: 'image/svg+xml',
        previewBytes: _svgPreview,
      ),
    ];
    await t.pumpWidget(_app(attachments: attachments, onRemove: (_) {}));
    await t.pumpAndSettle();

    expect(find.byType(Image), findsOneWidget);
    final image = t.widget<Image>(find.byType(Image));
    expect(image.fit, BoxFit.cover);
    expect(t.getSize(find.byType(Image)), const Size(36, 36));
    expect(find.byType(SvgPicture), findsOneWidget);
    final svg = t.widget<SvgPicture>(find.byType(SvgPicture));
    expect(svg.fit, BoxFit.cover);
    expect(t.getSize(find.byType(SvgPicture)), const Size(36, 36));
    expect(find.byIcon(LucideIcons.image), findsNothing);
    expect(t.takeException(), isNull);
  });

  testWidgets('bad raster preview falls back to a safe image placeholder', (
    t,
  ) async {
    await t.pumpWidget(
      _app(
        attachments: [
          _attachment(
            id: 'broken',
            name: 'broken.png',
            previewBytes: Uint8List.fromList([1, 2, 3]),
          ),
        ],
        onRemove: (_) {},
      ),
    );
    await t.pumpAndSettle();

    expect(find.byType(Image), findsOneWidget);
    expect(find.byIcon(LucideIcons.image), findsOneWidget);
    expect(t.takeException(), isNull);
  });

  testWidgets(
    'pending image remains previewed and removable after file-kind completion',
    (t) async {
      var attachments = [
        _attachment(
          id: 'upload-1',
          name: 'photo.png',
          previewBytes: _rasterPreview,
          uploading: true,
        ),
      ];
      final removed = <Json>[];
      Widget app() => _app(attachments: attachments, onRemove: removed.add);

      await t.pumpWidget(app());
      await t.pump();
      expect(find.text('Uploading…'), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.byTooltip('Remove photo.png'), findsNothing);
      expect(find.byType(Image), findsOneWidget);

      attachments = [
        _attachment(
          id: 'upload-1',
          name: 'photo.png',
          kind: 'file',
          previewBytes: _rasterPreview,
        ),
      ];
      await t.pumpWidget(app());
      await t.pumpAndSettle();
      expect(find.text('photo.png'), findsOneWidget);
      expect(find.text('Uploading…'), findsNothing);
      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(find.byTooltip('Remove photo.png'), findsOneWidget);
      expect(find.byType(Image), findsOneWidget);

      await t.tap(find.byTooltip('Remove photo.png'));
      await t.pumpAndSettle();
      expect(removed, hasLength(1));
      expect(removed.single['id'], 'upload-1');
    },
  );

  for (final width in [390.0, 768.0]) {
    for (final scale in [1.0, 2.0]) {
      testWidgets('long attachment name truncates at $width px, scale $scale', (
        t,
      ) async {
        t.view.devicePixelRatio = 1;
        t.view.physicalSize = Size(width, 240);
        addTearDown(t.view.reset);
        final name = List.filled(24, 'attachment').join('-');
        await t.pumpWidget(
          MediaQuery(
            data: MediaQueryData(
              size: Size(width, 240),
              textScaler: TextScaler.linear(scale),
            ),
            child: _app(
              attachments: [
                _attachment(id: 'long-name', name: name, kind: 'file'),
              ],
              onRemove: (_) {},
            ),
          ),
        );
        await t.pump();

        final label = t.widget<Text>(find.text(name));
        expect(label.maxLines, 1);
        expect(label.overflow, TextOverflow.ellipsis);
        final paragraph = t.renderObject<RenderParagraph>(find.text(name));
        expect(paragraph.didExceedMaxLines, isTrue);
        expect(
          t
              .getSize(
                find.byKey(
                  const ValueKey('composer-attachment-chip-long-name'),
                ),
              )
              .width,
          lessThanOrEqualTo(200),
        );
        expect(
          t.getSize(find.byKey(const Key('composer-attachments-strip'))).height,
          60,
        );
        expect(t.takeException(), isNull);
      });
    }
  }
}
