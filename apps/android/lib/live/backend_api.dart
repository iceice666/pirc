import '../l10n/app_i18n.dart';
import 'package:flutter/services.dart';
import 'gateway.dart';

const backendFailure =
    'Unable to update backend settings. Check the connection and try again.';

String safeBackendText(dynamic message, String fallback) {
  if (message is! String ||
      message.isEmpty ||
      message.length > 200 ||
      RegExp(
        r'bearer|token|secret|api[_-]?key|[=:{}]|https?://',
        caseSensitive: false,
      ).hasMatch(message)) {
    return fallback;
  }
  return message;
}

/// Only curated, sanitized errors cross the backend settings boundary.
class BackendException implements Exception {
  const BackendException(this.message, {this.status});
  final String message;
  final int? status;
  String get code => status == null ? 'BACKEND' : 'HTTP_$status';
  @override
  String toString() => message;
}

String backendError(Object error) =>
    error is BackendException ? tr(error.message) : tr(backendFailure);

Future<Json> backendRequest(
  LiveController controller,
  String path, {
  String method = 'GET',
  dynamic body,
}) async {
  try {
    return await controller.gateway.request(path, method: method, body: body);
  } on PlatformException catch (error) {
    final match = RegExp(r'^HTTP_(\d{3})$').firstMatch(error.code);
    final status = match == null ? null : int.parse(match.group(1)!);
    throw BackendException(
      status == null
          ? backendFailure
          : safeBackendText(
              error.message,
              tr(
                "Backend request failed ({0}). Check your settings and try again.",
                [status],
              ),
            ),
      status: status,
    );
  } catch (_) {
    throw const BackendException(backendFailure);
  }
}
