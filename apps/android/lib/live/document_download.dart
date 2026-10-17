import 'dart:typed_data';
import 'gateway.dart';

const nativeDocumentDownloadLimit = 32 * 1024 * 1024;

String? documentHeader(Json headers, String name) {
  for (final entry in headers.entries) {
    if (entry.key.toLowerCase() == name.toLowerCase()) return '${entry.value}';
  }
  return null;
}

bool documentIsAttachment(Json headers) =>
    documentHeader(
      headers,
      'content-disposition',
    )?.split(';').first.trim().toLowerCase() ==
    'attachment';

String documentDownloadName(String url, Json headers, {String? hint}) {
  final disposition = documentHeader(headers, 'content-disposition') ?? '';
  String? name;
  final encoded = RegExp(
    r"(?:^|;)\s*filename\*\s*=\s*([^;]+)",
    caseSensitive: false,
  ).firstMatch(disposition)?.group(1)?.trim();
  if (encoded != null) {
    final value = encoded.startsWith('"') && encoded.endsWith('"')
        ? encoded.substring(1, encoded.length - 1)
        : encoded;
    final parts = value.split("'");
    if (parts.length >= 3) {
      try {
        final data = parts.skip(2).join("'");
        if (parts.first.toLowerCase() == 'utf-8') {
          name = Uri.decodeComponent(data);
        }
      } on FormatException {
        /* Fall back to the regular parameter. */
      }
    }
  }
  if (name == null) {
    final match = RegExp(
      r'(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;]*))',
      caseSensitive: false,
    ).firstMatch(disposition);
    name =
        match?.group(1)?.replaceAllMapped(RegExp(r'\\(.)'), (m) => m[1]!) ??
        match?.group(2)?.trim();
  }
  name ??= hint?.isNotEmpty == true
      ? hint
      : Uri.tryParse(url)?.pathSegments.lastOrNull;
  final base = (name ?? 'download')
      .split(RegExp(r'[/\\]'))
      .last
      .replaceAll(RegExp(r'[\x00-\x1f\x7f-\x9f]'), '')
      .trim();
  if (base.isEmpty || base == '.' || base == '..') return 'download';
  return String.fromCharCodes(base.runes.take(180));
}

class NativeDocumentDownload {
  NativeDocumentDownload({
    required this.bytes,
    required this.name,
    required String mimeType,
  }) : mimeType = mimeType.split(';').first.trim().toLowerCase() {
    if (bytes.length > nativeDocumentDownloadLimit) {
      throw StateError('下載內容超過 32 MiB 限制。');
    }
  }
  factory NativeDocumentDownload.response(Json response, {String? hint}) {
    final raw = response['bytes'];
    final bytes = raw is Uint8List
        ? raw
        : Uint8List.fromList((raw as List).cast<int>());
    return NativeDocumentDownload(
      bytes: bytes,
      name: documentDownloadName(
        '${response['finalUrl']}',
        obj(response['headersRelevant']),
        hint: hint,
      ),
      mimeType: '${response['mimeType'] ?? 'application/octet-stream'}'
          .split(';')
          .first
          .trim(),
    );
  }
  factory NativeDocumentDownload.dataUri(String source, {String? hint}) {
    if (source.length > nativeDocumentDownloadLimit * 4 ~/ 3 + 4096) {
      throw StateError('下載內容超過 32 MiB 限制。');
    }
    final uri = UriData.parse(source);
    return NativeDocumentDownload(
      bytes: uri.contentAsBytes(),
      name: documentDownloadName('', const {}, hint: hint),
      mimeType: uri.mimeType,
    );
  }
  final Uint8List bytes;
  final String name, mimeType;
  Future<bool> save(Gateway gateway, String pairingStamp) async {
    final result = await gateway.call('saveDocument', {
      'bytes': bytes,
      'name': name,
      'mimeType': mimeType,
      'pairingStamp': pairingStamp,
    });
    return result != null;
  }
}
