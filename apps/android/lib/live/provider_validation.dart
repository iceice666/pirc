import '../l10n/app_i18n.dart';
import 'package:flutter/services.dart';

/// Numeric editing values accepted by the browser number control. A trailing
/// decimal point is retained while typing (the browser exposes its integer).
num? providerNumber(String text) {
  if (!RegExp(
    r'^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$',
  ).hasMatch(text)) {
    return null;
  }
  final value = num.tryParse(text);
  return value != null && value.isFinite ? value : null;
}

String? providerTokenError(String text) {
  if (text.isEmpty) return null;
  final value = providerNumber(text);
  if (value == null) return tr("Enter a number.");
  if (value < 1) return tr("Enter a value greater than or equal to 1.");
  if (value % 1 != 0) return tr("Enter a whole number.");
  return null;
}

/// Match the URL field's syntax gate, not the server's endpoint policy. In
/// particular, a syntactically valid non-HTTP URL is not rejected here.
String? providerUrlError(String input) {
  var value = input
      .replaceAll(RegExp(r'[\r\n]'), '')
      .replaceAll(RegExp(r'^[\t\f ]+|[\t\f ]+$'), '');
  if (value.isEmpty) return tr("Enter a URL.");
  final invalid = tr("Enter a valid URL.");
  final scheme = RegExp(r'^([a-zA-Z][a-zA-Z0-9+.-]*):').firstMatch(value);
  if (scheme == null) return invalid;
  final protocol = scheme.group(1)!.toLowerCase();
  if (const ['http', 'https', 'ftp', 'ws', 'wss'].contains(protocol)) {
    final rest = value
        .substring(scheme.end)
        .replaceAll(r'\', '/')
        .replaceFirst(RegExp(r'^/+'), '');
    value = '$protocol://$rest';
    final uri = Uri.tryParse(value);
    if (uri == null || uri.host.isEmpty || uri.port > 65535) return invalid;
  } else {
    final uri = Uri.tryParse(value);
    if (uri == null ||
        !uri.hasScheme ||
        (uri.hasAuthority && uri.port > 65535)) {
      return invalid;
    }
  }
  return null;
}

final providerNumericFormatter = TextInputFormatter.withFunction((
  oldValue,
  newValue,
) {
  if (!newValue.composing.isCollapsed) return newValue;
  return FilteringTextInputFormatter.allow(
    RegExp(r'[0-9eE+.\-]'),
  ).formatEditUpdate(oldValue, newValue);
});
