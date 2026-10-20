import '../l10n/app_i18n.dart';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'common.dart';
import 'gateway.dart';
import 'web_controls.dart';

/// The horizontally scrolling attachment row above the composer input.
class ComposerAttachmentStrip extends StatelessWidget {
  const ComposerAttachmentStrip({
    super.key,
    required this.attachments,
    required this.onRemove,
  });

  final List<Json> attachments;
  final ValueChanged<Json> onRemove;

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return SizedBox(
      key: const Key('composer-attachments-strip'),
      height: 60,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
        children: [
          for (final attachment in attachments)
            _ComposerAttachmentChip(
              key: ValueKey(attachment['id'] ?? attachment['name']),
              attachment: attachment,
              onRemove: () => onRemove(attachment),
            ),
        ],
      ),
    );
  }
}

class _ComposerAttachmentChip extends StatelessWidget {
  const _ComposerAttachmentChip({
    super.key,
    required this.attachment,
    required this.onRemove,
  });

  final Json attachment;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    final colors = palette(context);
    final name = '${attachment['name'] ?? 'File'}';
    final pending = attachment['uploading'] == true;
    final style = webText(context, size: 12);
    final bytes = attachment['previewBytes'];
    final thumbnailWidth = bytes is Uint8List && bytes.isNotEmpty ? 36.0 : 22.0;
    final label = TextPainter(
      text: TextSpan(text: pending ? tr("Uploading…") : name, style: style),
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
      maxLines: 1,
    )..layout();
    // CSS shrink factors are weighted by each item's basis. Freeze items
    // at their automatic minima, then redistribute the remaining overflow.
    final basis = [thumbnailWidth, label.width, pending ? 15.0 : 22.0];
    final minima = [
      thumbnailWidth == 36 ? 36.0 : 0.0,
      0.0,
      pending ? 0.0 : 14.0,
    ];
    final widths = List<double>.of(basis);
    final frozen = <int>{};
    for (var pass = 0; pass < 3; pass++) {
      final available =
          170 - frozen.fold<double>(0, (sum, i) => sum + widths[i]);
      final total = [
        for (var i = 0; i < 3; i++)
          if (!frozen.contains(i)) basis[i],
      ].fold<double>(0, (sum, value) => sum + value);
      final factor = total == 0 ? 1.0 : (available / total).clamp(0.0, 1.0);
      var clamped = false;
      for (var i = 0; i < 3; i++) {
        if (frozen.contains(i)) continue;
        widths[i] = basis[i] * factor;
        if (widths[i] < minima[i]) {
          widths[i] = minima[i];
          frozen.add(i);
          clamped = true;
        }
      }
      if (!clamped) break;
    }
    final removeWidth = widths[2];
    label.dispose();

    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: Container(
        key: ValueKey('composer-attachment-chip-${attachment['id'] ?? name}'),
        constraints: const BoxConstraints(maxWidth: 200),
        height: 48,
        padding: const EdgeInsets.fromLTRB(6, 6, 8, 6),
        decoration: BoxDecoration(
          color: colors['web.bg-subtle'],
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox(
              key: ValueKey(
                'composer-attachment-thumbnail-${attachment['id'] ?? name}',
              ),
              width: widths[0],
              height: thumbnailWidth,
              child: FittedBox(
                fit: BoxFit.contain,
                child: _AttachmentThumbnail(attachment: attachment),
              ),
            ),
            const SizedBox(width: 8),
            Flexible(
              child: Text(
                pending ? tr("Uploading…") : name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: style,
              ),
            ),
            const SizedBox(width: 8),
            if (pending)
              SizedBox(
                width: widths[2],
                height: 15,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: colors['text.primary'],
                ),
              )
            else
              IconButton(
                tooltip: tr("Remove {0}", [name]),
                onPressed: onRemove,
                icon: const Icon(LucideIcons.x, size: 14),
                style: IconButton.styleFrom(
                  minimumSize: Size(removeWidth, 22),
                  maximumSize: Size(removeWidth, 22),
                  padding: EdgeInsets.zero,
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  foregroundColor: colors['text.primary'],
                  backgroundColor: Colors.transparent,
                  hoverColor: colors['web.bg-hover-strong'],
                  shape: const CircleBorder(),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _AttachmentThumbnail extends StatelessWidget {
  const _AttachmentThumbnail({required this.attachment});

  final Json attachment;

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    final image = attachment['kind'] == 'image';
    final bytes = attachment['previewBytes'];
    if (bytes is! Uint8List || bytes.isEmpty) {
      return _fallback(context, image: image);
    }

    final mimeType = '${attachment['mimeType'] ?? ''}'.toLowerCase();
    final name = '${attachment['name'] ?? ''}'.toLowerCase();
    final isSvg = mimeType == 'image/svg+xml' || name.endsWith('.svg');
    final fallback = _fallback(context, image: true);

    return ClipRRect(
      borderRadius: BorderRadius.circular(8),
      child: SizedBox(
        width: 36,
        height: 36,
        child: isSvg
            ? SvgPicture.memory(
                bytes,
                width: 36,
                height: 36,
                fit: BoxFit.cover,
                errorBuilder: (_, _, _) => fallback,
              )
            : Image.memory(
                bytes,
                width: 36,
                height: 36,
                fit: BoxFit.cover,
                errorBuilder: (_, _, _) => fallback,
              ),
      ),
    );
  }

  Widget _fallback(BuildContext context, {required bool image}) => SizedBox(
    width: 22,
    height: 22,
    child: Icon(
      image ? LucideIcons.image : LucideIcons.file,
      size: 22,
      color: palette(context)['text.primary'],
    ),
  );
}
