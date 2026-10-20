/// Routes query-based links handled by the Pirc web app at its root URL.
///
/// This parser does not resolve or canonicalize URLs. Callers pass the
/// absolute canonical document URL produced by the native URL resolver and
/// the absolute URL of the app root. It returns null unless the document URL
/// has the same HTTP(S) scheme, host, and port, and names the exact root path
/// or its `index.html` alias. Deep SPA fallback paths can be enabled explicitly.
library;

import '../l10n/app_i18n.dart';

import 'dart:convert';

/// Builds the URL used when the web app replaces its address with
/// `?key=${encodeURIComponent(value)}`.
///
/// The native shell keeps the response URL's origin and pathname, replaces
/// the complete query, and drops any fragment just like
/// `history.replaceState(state, '', '?key=...')`. [canonicalUrl] must be an
/// absolute HTTP(S) URL. [key] is a trusted route-query name supplied by the
/// caller; only [value] receives `encodeURIComponent` encoding.
String nativePircReplaceRouteQuery(
  String canonicalUrl, {
  required String key,
  required String value,
}) {
  final uri = _parseWebUri(canonicalUrl);
  if (uri == null || uri.userInfo.isNotEmpty) {
    throw FormatException(tr("Expected an absolute HTTP(S) canonical URL."));
  }

  var pathEnd = canonicalUrl.length;
  final queryIndex = canonicalUrl.indexOf('?');
  final fragmentIndex = canonicalUrl.indexOf('#');
  if (queryIndex >= 0 && queryIndex < pathEnd) pathEnd = queryIndex;
  if (fragmentIndex >= 0 && fragmentIndex < pathEnd) pathEnd = fragmentIndex;

  return '${canonicalUrl.substring(0, pathEnd)}?'
      '$key=${_encodeUriComponent(value)}';
}

/// The web app's notification/shared-link target, if the query names one.
sealed class NativeAppDocumentRouteTarget {
  const NativeAppDocumentRouteTarget();
}

final class NativeAppSessionRouteTarget extends NativeAppDocumentRouteTarget {
  const NativeAppSessionRouteTarget(this.sessionId);

  final String sessionId;
}

final class NativeAppSchedulesRouteTarget extends NativeAppDocumentRouteTarget {
  const NativeAppSchedulesRouteTarget({this.scheduleId});

  final String? scheduleId;
}

final class NativeAppMemoryRouteTarget extends NativeAppDocumentRouteTarget {
  const NativeAppMemoryRouteTarget();
}

/// One decoded query entry, retaining its original encoded spelling and order.
class NativeAppDocumentQueryParameter {
  const NativeAppDocumentQueryParameter({
    required this.name,
    required this.value,
    required this.rawName,
    required this.rawValue,
  });

  /// Percent-decoded name, following `URLSearchParams` form-query decoding.
  final String name;

  /// Percent-decoded value. A key without `=` has an empty value.
  final String value;

  final String rawName;
  final String rawValue;
}

/// A Pirc web-app route plus the original URL metadata needed by callers.
///
/// The web app chooses the first nonempty `session` value before considering
/// `open=schedules` or `open=memory`. `workspace` is read independently after
/// that target and therefore takes precedence for the visible page while a
/// session target may still identify the session behind it.
class NativeAppDocumentRoute {
  NativeAppDocumentRoute._({
    required this.canonicalUrl,
    required this.appRootUrl,
    required this.hasQuery,
    required this.rawQuery,
    required this.rawFragment,
    required this.isIndexAlias,
    required this.isSpaFallbackPath,
    required this.queryParameters,
    required this.unknownQueryParameters,
    required this.hasSessionParameter,
    required this.target,
    required this.workspaceId,
  });

  static const _knownQueryNames = <String>{
    'session',
    'workspace',
    'open',
    'schedule',
  };

  /// Parses a canonical absolute URL only when it names [appRootUrl] or its
  /// `index.html` alias, unless [allowSpaFallback] enables app-prefix paths.
  ///
  /// [appRootUrl] is an absolute HTTP(S) URL that identifies the app root,
  /// including its path when the app is hosted below `/`. Query and fragment
  /// components are not allowed on the root URL. This intentionally declines
  /// same-origin paths such as `/index.php`, `/api/...`, or subpages are
  /// rejected by default. With [allowSpaFallback], paths below the app root
  /// prefix are accepted except for its `/api` namespace. Callers should still
  /// verify that the response is the actual Pirc shell before applying a
  /// route; this parser only checks the canonical URL.
  ///
  /// The URL is not resolved, normalized, or redirected here. Malformed URLs
  /// return null. Query decoding follows `URLSearchParams`, including keeping
  /// malformed percent escapes literal and replacing malformed UTF-8.
  /// Duplicate supported query keys use their first value.
  static NativeAppDocumentRoute? parse(
    String canonicalUrl, {
    required String appRootUrl,
    bool allowSpaFallback = false,
  }) {
    final documentUri = _parseWebUri(canonicalUrl);
    final rootUri = _parseWebUri(appRootUrl);
    if (documentUri == null || rootUri == null) return null;
    if (documentUri.userInfo.isNotEmpty || rootUri.userInfo.isNotEmpty) {
      return null;
    }

    final rootParts = _UrlParts.read(appRootUrl);
    if (rootParts == null ||
        rootParts.hasQuery ||
        rootParts.rawFragment != null) {
      return null;
    }
    final rootPath = _effectivePath(rootUri);
    final documentPath = _effectivePath(documentUri);
    final indexPath = rootPath.endsWith('/')
        ? '${rootPath}index.html'
        : '$rootPath/index.html';
    final isRootPath = documentPath == rootPath;
    final isIndexAlias = documentPath == indexPath;
    if (documentUri.scheme != rootUri.scheme ||
        documentUri.host.toLowerCase() != rootUri.host.toLowerCase() ||
        documentUri.port != rootUri.port) {
      return null;
    }

    final appPrefix = rootPath.endsWith('/') ? rootPath : '$rootPath/';
    final relativePath = documentPath.startsWith(appPrefix)
        ? documentPath.substring(appPrefix.length)
        : null;
    final inApiNamespace = _isApiPath(relativePath);
    final isSpaFallbackPath =
        allowSpaFallback &&
        !isRootPath &&
        !isIndexAlias &&
        relativePath != null &&
        relativePath.isNotEmpty &&
        !inApiNamespace;
    if (!isRootPath && !isIndexAlias && !isSpaFallbackPath) return null;

    final parts = _UrlParts.read(canonicalUrl);
    if (parts == null) return null;
    final parameters = _decodeQuery(parts.rawQuery);

    String? firstValue(String name) {
      for (final parameter in parameters) {
        if (parameter.name == name) return parameter.value;
      }
      return null;
    }

    final session = firstValue('session');
    final open = firstValue('open');
    final schedule = firstValue('schedule');
    final workspace = firstValue('workspace');

    final NativeAppDocumentRouteTarget? target;
    if (session != null && session.isNotEmpty) {
      target = NativeAppSessionRouteTarget(session);
    } else if (open == 'schedules') {
      target = NativeAppSchedulesRouteTarget(
        scheduleId: schedule == null || schedule.isEmpty ? null : schedule,
      );
    } else if (open == 'memory') {
      target = const NativeAppMemoryRouteTarget();
    } else {
      target = null;
    }

    final workspaceId = workspace == null || workspace.isEmpty
        ? null
        : workspace;
    return NativeAppDocumentRoute._(
      canonicalUrl: canonicalUrl,
      appRootUrl: appRootUrl,
      hasQuery: parts.hasQuery,
      rawQuery: parts.rawQuery,
      rawFragment: parts.rawFragment,
      isIndexAlias: isIndexAlias,
      isSpaFallbackPath: isSpaFallbackPath,
      queryParameters: List.unmodifiable(parameters),
      unknownQueryParameters: List.unmodifiable(
        parameters.where(
          (parameter) => !_knownQueryNames.contains(parameter.name),
        ),
      ),
      hasSessionParameter: parameters.any(
        (parameter) => parameter.name == 'session',
      ),
      target: target,
      workspaceId: workspaceId,
    );
  }

  final String canonicalUrl;
  final String appRootUrl;

  /// Whether the original URL had a `?`, including an explicitly empty query.
  final bool hasQuery;

  /// The exact encoded query text without its leading `?`.
  final String rawQuery;

  /// The exact encoded fragment without its leading `#`, or null if absent.
  /// An empty string means the URL had a trailing `#`.
  final String? rawFragment;

  /// True when the accepted path was `<app-root>/index.html`.
  final bool isIndexAlias;

  /// True only for an opt-in deep path under the app root prefix.
  final bool isSpaFallbackPath;

  /// All query entries in original order, including duplicates and unknowns.
  final List<NativeAppDocumentQueryParameter> queryParameters;

  /// Entries whose keys are not interpreted by the web app route parser.
  final List<NativeAppDocumentQueryParameter> unknownQueryParameters;

  /// Whether `session` occurred in the query, even if its first value is
  /// empty. The mobile shell uses this to mirror the web list-open behavior.
  final bool hasSessionParameter;

  /// The notification/shared-link target selected by the web app precedence.
  final NativeAppDocumentRouteTarget? target;

  /// Nonempty first `workspace` value, independent of [target].
  final String? workspaceId;

  /// The workspace page is shown ahead of a selected/linked session target.
  bool get workspaceOverridesTarget => workspaceId != null;

  /// Resolves URL intent against the currently loaded gateway lists.
  ///
  /// A requested session is selected only if it is present in [sessions]; an
  /// unknown or absent session falls back to the first nonempty session ID.
  /// A workspace is selected only when [workspaces] contains its requested
  /// ID. The web app can keep a session selected behind a workspace or
  /// schedules page, so these results are deliberately independent.
  NativeAppDocumentSelection resolve({
    required List<Map<String, dynamic>> sessions,
    required List<Map<String, dynamic>> workspaces,
    required bool phone,
  }) {
    final requestedSession = target is NativeAppSessionRouteTarget
        ? (target as NativeAppSessionRouteTarget).sessionId
        : null;
    final sessionId = _knownOrFirstId(sessions, requestedSession);
    final workspaceId = _knownId(workspaces, this.workspaceId);
    final schedulesTarget = target is NativeAppSchedulesRouteTarget
        ? target as NativeAppSchedulesRouteTarget
        : null;
    final showSchedules = schedulesTarget != null && workspaceId == null;
    return NativeAppDocumentSelection(
      sessionId: sessionId,
      workspaceId: workspaceId,
      showSchedules: showSchedules,
      scheduleId: schedulesTarget?.scheduleId,
      showMemory: target is NativeAppMemoryRouteTarget,
      listOpen:
          phone &&
          !hasSessionParameter &&
          !showSchedules &&
          workspaceId == null,
    );
  }
}

/// The web app's route intent resolved against loaded session/workspace data.
class NativeAppDocumentSelection {
  const NativeAppDocumentSelection({
    required this.sessionId,
    required this.workspaceId,
    required this.showSchedules,
    required this.scheduleId,
    required this.showMemory,
    required this.listOpen,
  });

  final String? sessionId;
  final String? workspaceId;
  final bool showSchedules;

  /// Schedule focus from the URL. It remains available when a workspace page
  /// hides the schedules page; consumers should apply it only if
  /// [showSchedules] is true.
  final String? scheduleId;

  /// Memory opens its settings overlay even when the workspace page is shown.
  final bool showMemory;

  /// Whether the phone session list should start open over the selected page.
  final bool listOpen;
}

Uri? _parseWebUri(String value) {
  try {
    final uri = Uri.parse(value);
    if (!uri.hasScheme ||
        !uri.hasAuthority ||
        uri.host.isEmpty ||
        (uri.scheme != 'http' && uri.scheme != 'https')) {
      return null;
    }
    return uri;
  } on FormatException {
    return null;
  }
}

String _encodeUriComponent(String value) {
  final codeUnits = value.codeUnits;
  for (var index = 0; index < codeUnits.length; index++) {
    final unit = codeUnits[index];
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= codeUnits.length ||
          codeUnits[index + 1] < 0xdc00 ||
          codeUnits[index + 1] > 0xdfff) {
        throw FormatException(
          tr("URI component contains an unpaired surrogate."),
        );
      }
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw FormatException(
        tr("URI component contains an unpaired surrogate."),
      );
    }
  }

  final output = StringBuffer();
  for (final byte in utf8.encode(value)) {
    if (_isUriComponentByte(byte)) {
      output.writeCharCode(byte);
    } else {
      output
        ..write('%')
        ..write(byte.toRadixString(16).padLeft(2, '0').toUpperCase());
    }
  }
  return output.toString();
}

bool _isUriComponentByte(int byte) =>
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    (byte >= 0x30 && byte <= 0x39) ||
    const <int>{
      0x2d,
      0x5f,
      0x2e,
      0x21,
      0x7e,
      0x2a,
      0x27,
      0x28,
      0x29,
    }.contains(byte);

String _effectivePath(Uri uri) => uri.path.isEmpty ? '/' : uri.path;

bool _isApiPath(String? relativePath) {
  if (relativePath == null) return false;
  try {
    final decoded = Uri.decodeComponent(relativePath).replaceAll('\\', '/');
    final firstSegment = decoded
        .split('/')
        .firstWhere((segment) => segment.isNotEmpty, orElse: () => '');
    return firstSegment == 'api';
  } on FormatException {
    // Do not opt into fallback for a path the server could decode differently.
    return true;
  }
}

class _UrlParts {
  const _UrlParts({
    required this.hasQuery,
    required this.rawQuery,
    required this.rawFragment,
  });

  final bool hasQuery;
  final String rawQuery;
  final String? rawFragment;

  static _UrlParts? read(String url) {
    final fragmentIndex = url.indexOf('#');
    final beforeFragment = fragmentIndex < 0
        ? url
        : url.substring(0, fragmentIndex);
    final queryIndex = beforeFragment.indexOf('?');
    return _UrlParts(
      hasQuery: queryIndex >= 0,
      rawQuery: queryIndex < 0 ? '' : beforeFragment.substring(queryIndex + 1),
      rawFragment: fragmentIndex < 0 ? null : url.substring(fragmentIndex + 1),
    );
  }
}

List<NativeAppDocumentQueryParameter> _decodeQuery(String rawQuery) {
  if (rawQuery.isEmpty) return const [];
  final result = <NativeAppDocumentQueryParameter>[];
  for (final entry in rawQuery.split('&')) {
    if (entry.isEmpty) continue;
    final equals = entry.indexOf('=');
    final rawName = equals < 0 ? entry : entry.substring(0, equals);
    final rawValue = equals < 0 ? '' : entry.substring(equals + 1);
    result.add(
      NativeAppDocumentQueryParameter(
        name: _decodeQueryComponent(rawName),
        value: _decodeQueryComponent(rawValue),
        rawName: rawName,
        rawValue: rawValue,
      ),
    );
  }
  return result;
}

String _decodeQueryComponent(String raw) {
  final bytes = <int>[];
  final codePoints = raw.runes.toList(growable: false);
  for (var index = 0; index < codePoints.length; index++) {
    final codePoint = codePoints[index];
    if (codePoint == 0x2b) {
      bytes.add(0x20);
      continue;
    }
    if (codePoint == 0x25 && index + 2 < codePoints.length) {
      final high = _hexDigit(codePoints[index + 1]);
      final low = _hexDigit(codePoints[index + 2]);
      if (high != null && low != null) {
        bytes.add((high << 4) | low);
        index += 2;
        continue;
      }
    }
    bytes.addAll(utf8.encode(String.fromCharCode(codePoint)));
  }
  return utf8.decode(bytes, allowMalformed: true);
}

int? _hexDigit(int codePoint) {
  if (codePoint >= 0x30 && codePoint <= 0x39) return codePoint - 0x30;
  if (codePoint >= 0x41 && codePoint <= 0x46) return codePoint - 0x41 + 10;
  if (codePoint >= 0x61 && codePoint <= 0x66) return codePoint - 0x61 + 10;
  return null;
}

String? _knownId(List<Map<String, dynamic>> objects, String? requested) {
  if (requested == null || requested.isEmpty) return null;
  for (final object in objects) {
    if (object['id'] == requested) return requested;
  }
  return null;
}

String? _knownOrFirstId(List<Map<String, dynamic>> objects, String? requested) {
  final known = _knownId(objects, requested);
  if (known != null) return known;
  for (final object in objects) {
    final id = object['id'];
    if (id is String && id.isNotEmpty) return id;
  }
  return null;
}
