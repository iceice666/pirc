import 'dart:convert';
import 'dart:typed_data';

import '../rendering/html_file.dart';
import 'gateway.dart';

/// Adapts the Android attachment picker wire format to native HTML file inputs.
///
/// [isCurrent] should close over the owning document/account scope. A result
/// from a picker that outlives that scope is discarded, including a late error.
NativeHtmlFilePicker createNativeHtmlFilePicker(
  Gateway gateway, {
  bool Function()? isCurrent,
}) {
  bool current() => isCurrent?.call() ?? true;

  return (request) async {
    if (!current()) return null;

    dynamic response;
    try {
      response = await gateway.call('pickAttachments', <String, dynamic>{
        'multiple': request.multiple,
        'accept': List<String>.of(request.accept),
      });
    } catch (_) {
      if (!current()) return null;
      rethrow;
    }

    if (!current() || response == null) return null;
    if (response is! List) {
      throw const FormatException('Attachment picker response must be a list.');
    }

    return <NativeHtmlFile>[
      for (var index = 0; index < response.length; index++)
        _decodePickedFile(response[index], index),
    ];
  };
}

NativeHtmlFile _decodePickedFile(Object? value, int index) {
  if (value is! Map) {
    throw FormatException('Attachment picker item $index must be an object.');
  }
  final row = obj(value);
  final name = row['name'] is String && (row['name'] as String).isNotEmpty
      ? row['name'] as String
      : 'attachment';
  final error = row['error'];
  if (error != null) {
    throw FormatException('Could not read $name: $error');
  }
  final mimeType =
      row['mimeType'] is String && (row['mimeType'] as String).trim().isNotEmpty
      ? (row['mimeType'] as String).trim()
      : 'application/octet-stream';
  final rawBytes =
      row['bytes'] ?? row['bytesBase64'] ?? row['base64'] ?? row['dataBase64'];

  return NativeHtmlFile(
    name: name,
    mimeType: mimeType,
    bytes: _decodeBytes(rawBytes, name),
  );
}

Uint8List _decodeBytes(Object? value, String name) {
  if (value is Uint8List) return Uint8List.fromList(value);
  if (value is ByteData) {
    return Uint8List.fromList(
      value.buffer.asUint8List(value.offsetInBytes, value.lengthInBytes),
    );
  }
  if (value is List) {
    final bytes = <int>[];
    for (var index = 0; index < value.length; index++) {
      final byte = value[index];
      if (byte is! int || byte < 0 || byte > 255) {
        throw FormatException(
          'Attachment $name has an invalid byte at offset $index.',
        );
      }
      bytes.add(byte);
    }
    return Uint8List.fromList(bytes);
  }
  if (value is String) {
    try {
      return Uint8List.fromList(base64Decode(value));
    } on FormatException {
      throw FormatException('Attachment $name has invalid base64 bytes.');
    }
  }
  throw FormatException('Attachment $name did not include byte data.');
}
