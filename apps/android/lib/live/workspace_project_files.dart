import '../l10n/app_i18n.dart';
import 'dart:async';
import 'dart:ui' show SemanticsRole;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'common.dart';
import 'gateway.dart';
import 'web_controls.dart';
import 'work_index.dart';

class WorkspaceProjectFiles extends StatefulWidget {
  const WorkspaceProjectFiles({
    super.key,
    required this.controller,
    required this.workspace,
  });

  final LiveController controller;
  final Json workspace;

  @override
  State<WorkspaceProjectFiles> createState() => _WorkspaceProjectFilesState();
}

class _ProjectFilesScope {
  const _ProjectFilesScope({
    required this.controller,
    required this.accountRevision,
    required this.origin,
    required this.clientId,
    required this.pairingStamp,
    required this.workspaceId,
    required this.available,
    required this.hostId,
  });

  factory _ProjectFilesScope.from(WorkspaceProjectFiles widget) {
    final controller = widget.controller;
    final workspace = _liveWorkspace(widget);
    return _ProjectFilesScope(
      controller: controller,
      accountRevision: controller.accountRevision,
      origin: controller.origin,
      clientId: controller.clientId,
      pairingStamp: controller.pairingStamp,
      workspaceId: '${widget.workspace['id'] ?? ''}',
      available: controller.catalog.of(workspace).projectFiles,
      hostId: '${workspace['hostId'] ?? ''}',
    );
  }

  final LiveController controller;
  final int accountRevision;
  final String? origin, clientId, pairingStamp;
  final String workspaceId, hostId;

  /// The workspace's mode offers shared project files.
  final bool available;

  @override
  bool operator ==(Object other) =>
      other is _ProjectFilesScope &&
      identical(controller, other.controller) &&
      accountRevision == other.accountRevision &&
      origin == other.origin &&
      clientId == other.clientId &&
      pairingStamp == other.pairingStamp &&
      workspaceId == other.workspaceId &&
      available == other.available &&
      hostId == other.hostId;

  @override
  int get hashCode => Object.hash(
    identityHashCode(controller),
    accountRevision,
    origin,
    clientId,
    pairingStamp,
    workspaceId,
    available,
    hostId,
  );
}

Json _liveWorkspace(WorkspaceProjectFiles widget) {
  final id = '${widget.workspace['id'] ?? ''}';
  for (final workspace in widget.controller.workspaces) {
    if ('${workspace['id'] ?? ''}' == id) return workspace;
  }
  return widget.workspace;
}

class _WorkspaceProjectFilesState extends State<WorkspaceProjectFiles> {
  List<Json>? files;
  int maxFiles = 50, maxBytes = 0;
  bool loading = false, busy = false;
  String? confirming, error, status;
  late _ProjectFilesScope _scope;
  late bool _wasOnline, _wasDeleting;
  int _generation = 0;

  Json get _workspace => _liveWorkspace(widget);
  bool get _online => workspaceOnline(_workspace, widget.controller.nodes);
  bool get _deleting => _workspace['deleting'] == true;
  bool get _available =>
      widget.controller.catalog.of(_workspace).projectFiles &&
      _online &&
      !_deleting;

  @override
  void initState() {
    super.initState();
    _scope = _ProjectFilesScope.from(widget);
    _wasOnline = _online;
    _wasDeleting = _deleting;
    widget.controller.addListener(_controllerChanged);
    if (_available) unawaited(_load());
  }

  @override
  void didUpdateWidget(covariant WorkspaceProjectFiles oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_controllerChanged);
      widget.controller.addListener(_controllerChanged);
    }
    _syncScopeAndAvailability();
  }

  @override
  void dispose() {
    _generation++;
    widget.controller.removeListener(_controllerChanged);
    super.dispose();
  }

  void _controllerChanged() {
    if (!mounted) return;
    _syncScopeAndAvailability();
  }

  bool _syncScopeAndAvailability() {
    final nextScope = _ProjectFilesScope.from(widget);
    final nextOnline = _online;
    final nextDeleting = _deleting;
    if (nextScope == _scope &&
        nextOnline == _wasOnline &&
        nextDeleting == _wasDeleting) {
      return false;
    }

    _scope = nextScope;
    _wasOnline = nextOnline;
    _wasDeleting = nextDeleting;
    _generation++;
    setState(() {
      files = null;
      maxFiles = 50;
      maxBytes = 0;
      loading = false;
      busy = false;
      confirming = null;
      error = null;
      status = null;
    });
    if (_available) unawaited(_load());
    return true;
  }

  bool _isCurrent(_ProjectFilesScope scope, int generation) =>
      mounted &&
      _generation == generation &&
      _scope == scope &&
      _ProjectFilesScope.from(widget) == scope &&
      _available;

  String _requestError(Object cause) {
    if (cause is PlatformException) {
      if (const {
        'PROJECT_FILE_READ',
        'PICKER',
        'PICKER_READ',
        'BUSY',
      }.contains(cause.code)) {
        return cause.message ??
            tr("Unable to read the selected file. Choose it again.");
      }
      final match = RegExp(r'^HTTP_(\d{3})$').firstMatch(cause.code);
      if (match != null) {
        return cause.message ?? tr("Request failed ({0})", [match.group(1)]);
      }
    }
    return tr("Unable to reach the gateway. Try again.");
  }

  String _size(int bytes) {
    if (bytes < 1024) return tr("{0} B", [bytes]);
    if (bytes < 1024 * 1024) {
      return tr("{0} KB", [(bytes / 1024).toStringAsFixed(1)]);
    }
    return tr("{0} MB", [(bytes / (1024 * 1024)).toStringAsFixed(1)]);
  }

  void _applyListing(Json response) {
    files = rows(response['files']);
    maxFiles = (response['maxFiles'] as num?)?.toInt() ?? 50;
    maxBytes = (response['maxBytes'] as num?)?.toInt() ?? 0;
  }

  Future<void> _load() async {
    if (!_available || loading) return;
    final scope = _scope;
    final generation = _generation;
    setState(() {
      loading = true;
      error = null;
      status = null;
    });
    try {
      final response = await scope.controller.gateway.request(
        '/api/workspaces/${enc(scope.workspaceId)}/files',
      );
      if (!_isCurrent(scope, generation)) return;
      setState(() => _applyListing(response));
    } catch (cause) {
      if (_isCurrent(scope, generation)) {
        setState(() => error = _requestError(cause));
      }
    } finally {
      if (_isCurrent(scope, generation)) {
        setState(() => loading = false);
      }
    }
  }

  Future<void> _refresh(_ProjectFilesScope scope, int generation) async {
    final response = await scope.controller.gateway.request(
      '/api/workspaces/${enc(scope.workspaceId)}/files',
    );
    if (!_isCurrent(scope, generation)) return;
    setState(() => _applyListing(response));
  }

  void _showFileError(
    _ProjectFilesScope scope,
    int generation,
    String message,
  ) {
    if (_isCurrent(scope, generation)) setState(() => error = message);
  }

  Future<void> _upload() async {
    final scope = _scope;
    final generation = _generation;
    if (!_available || files == null || busy || files!.length >= maxFiles) {
      return;
    }
    final pickedMaxBytes = maxBytes;
    final tokens = <String>[];
    var uploaded = 0;
    setState(() {
      busy = true;
      error = null;
      status = null;
    });
    try {
      final pickedResult = await scope.controller.gateway
          .call('pickProjectFiles', {
            'workspaceId': scope.workspaceId,
            'pairingStamp': scope.pairingStamp,
            'maxBytes': pickedMaxBytes,
            'multiple': true,
          });
      final picked = pickedResult is List
          ? pickedResult.map(obj).toList(growable: false)
          : const <Json>[];
      for (final file in picked) {
        final token = file['fileToken'];
        if (token is String && token.isNotEmpty) tokens.add(token);
      }
      if (!_isCurrent(scope, generation) || picked.isEmpty) return;

      for (final file in picked) {
        if (!_isCurrent(scope, generation)) return;
        final name = '${file['name'] ?? ''}';
        final token = file['fileToken'];
        final bytes = file['bytes'];
        final rawSize = file['byteSize'];
        final byteSize = rawSize is num
            ? rawSize.toInt()
            : bytes is Uint8List
            ? bytes.lengthInBytes
            : null;
        if (file['error'] != null) {
          final message = '${file['error']}';
          _showFileError(scope, generation, '$name: $message');
          continue;
        }
        if (byteSize != null &&
            pickedMaxBytes > 0 &&
            byteSize > pickedMaxBytes) {
          _showFileError(
            scope,
            generation,
            tr("{0} is larger than the {1} limit.", [
              name,
              _size(pickedMaxBytes),
            ]),
          );
          continue;
        }
        if (byteSize == 0) {
          _showFileError(scope, generation, tr("{0} is empty.", [name]));
          continue;
        }
        if (name.isEmpty || (token is! String && bytes is! Uint8List)) {
          _showFileError(
            scope,
            generation,
            name.isEmpty
                ? tr("Unable to read the selected file.")
                : tr("{0}: Unable to read the selected file.", [name]),
          );
          continue;
        }
        try {
          await scope.controller.gateway.call('uploadProjectFile', {
            'workspaceId': scope.workspaceId,
            'name': name,
            'pairingStamp': scope.pairingStamp,
            'maxBytes': pickedMaxBytes,
            if (token is String) 'fileToken': token,
            if (token is! String && bytes is Uint8List) 'bytes': bytes,
          });
          if (!_isCurrent(scope, generation)) return;
          uploaded++;
        } catch (cause) {
          if (!_isCurrent(scope, generation)) return;
          _showFileError(scope, generation, '$name: ${_requestError(cause)}');
        }
      }
      if (!_isCurrent(scope, generation)) return;
      await _refresh(scope, generation);
      if (!_isCurrent(scope, generation)) return;
      if (uploaded > 0) {
        setState(
          () => status = tr(
            "{0} uploaded. Every chat in this project can read {1} now.",
            [
              uploaded == 1 ? '1 file' : '$uploaded files',
              uploaded == 1 ? 'it' : 'them',
            ],
          ),
        );
      }
    } catch (cause) {
      if (_isCurrent(scope, generation)) {
        setState(() => error = _requestError(cause));
      }
    } finally {
      try {
        await scope.controller.gateway.call('releaseProjectFiles', {
          'fileTokens': tokens,
        });
      } catch (_) {
        // File tokens are temporary native resources; a release failure must not
        // replace the upload result or revive an obsolete scope.
      }
      if (_isCurrent(scope, generation)) setState(() => busy = false);
    }
  }

  Future<void> _remove(String name) async {
    final scope = _scope;
    final generation = _generation;
    if (!_available || files == null || busy) return;
    setState(() {
      busy = true;
      confirming = null;
      error = null;
      status = null;
    });
    try {
      await scope.controller.gateway.request(
        '${_filesPathFor(scope)}?name=${enc(name)}',
        method: 'DELETE',
      );
      if (!_isCurrent(scope, generation)) return;
      await _refresh(scope, generation);
      if (!_isCurrent(scope, generation)) return;
      setState(() => status = tr("{0} removed.", [name]));
    } catch (cause) {
      if (_isCurrent(scope, generation)) {
        setState(() => error = _requestError(cause));
      }
    } finally {
      if (_isCurrent(scope, generation)) setState(() => busy = false);
    }
  }

  String _filesPathFor(_ProjectFilesScope scope) =>
      '/api/workspaces/${enc(scope.workspaceId)}/files';

  Widget _description(String text) => Padding(
    padding: const EdgeInsets.only(top: 8),
    child: Text(
      text,
      style: webText(
        context,
        size: 13,
        color: 'text.muted',
      ).copyWith(height: 1.55),
    ),
  );

  Widget _fileName(String name) => Expanded(
    child: Text(
      name,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      softWrap: false,
      style: webText(context, size: 14),
    ),
  );

  Widget _fileActions(String name) {
    if (confirming == name) {
      return Wrap(
        spacing: 6,
        children: [
          WebButton(
            tr("Remove"),
            key: ValueKey('project-file-confirm-remove-$name'),
            danger: true,
            disabledOpacity: .5,
            onPressed: busy ? null : () => _remove(name),
          ),
          WebButton(
            tr("Cancel"),
            key: ValueKey('project-file-cancel-remove-$name'),
            disabledOpacity: .5,
            onPressed: busy ? null : () => setState(() => confirming = null),
          ),
        ],
      );
    }
    return WebButton(
      tr("Remove…"),
      key: ValueKey('project-file-remove-$name'),
      disabledOpacity: .5,
      onPressed: busy ? null : () => setState(() => confirming = name),
    );
  }

  Widget _fileRow(Json file) {
    final name = '${file['name'] ?? ''}';
    final byteSize = (file['byteSize'] as num?)?.toInt() ?? 0;
    return LayoutBuilder(
      builder: (context, constraints) {
        final leading = Row(
          children: [
            _fileName(name),
            const SizedBox(width: 12),
            Text(
              _size(byteSize),
              style: webText(context, size: 13, color: 'text.secondary'),
            ),
          ],
        );
        final actions = _fileActions(name);
        if (constraints.maxWidth <
            260 * MediaQuery.textScalerOf(context).scale(1)) {
          return Padding(
            padding: const EdgeInsets.only(top: 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                leading,
                const SizedBox(height: 6),
                Align(alignment: Alignment.centerRight, child: actions),
              ],
            ),
          );
        }
        return Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Row(
            children: [
              _fileName(name),
              const SizedBox(width: 12),
              Text(
                _size(byteSize),
                style: webText(context, size: 13, color: 'text.secondary'),
              ),
              const SizedBox(width: 12),
              actions,
            ],
          ),
        );
      },
    );
  }

  Widget _uploadButton() => WebButton(
    busy ? tr("Working…") : tr("Upload files"),
    key: const ValueKey('project-files-upload'),
    fontSize: 13,
    backgroundColor: palette(context)['web.bg-hover'],
    disabledOpacity: .5,
    onPressed: busy || files == null || files!.length >= maxFiles
        ? null
        : _upload,
  );

  Widget _limitsRow() {
    final limit = tr("{0} / {1} files{2}", [
      files!.length,
      maxFiles,
      maxBytes > 0 ? ', up to ${_size(maxBytes)} each' : '',
    ]);
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Row(
        children: [
          Expanded(
            child: Text(
              limit,
              style: webText(context, size: 13, color: 'text.secondary'),
            ),
          ),
          const SizedBox(width: 12),
          _uploadButton(),
        ],
      ),
    );
  }

  Widget _feedback(String message, {required SemanticsRole role}) => Padding(
    padding: const EdgeInsets.only(top: 8),
    child: Semantics(
      role: role,
      child: Text(
        message,
        style: webText(
          context,
          size: 13,
          color: role == SemanticsRole.alert ? 'status.danger' : 'text.muted',
        ).copyWith(height: 1.55),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    if (!_available) return const SizedBox.shrink();
    final currentFiles = files ?? const <Json>[];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          tr("PROJECT FILES"),
          style: webText(
            context,
            size: 12,
            weight: FontWeight.w600,
            color: 'text.secondary',
          ).copyWith(height: kTextHeightNone, letterSpacing: .24),
        ),
        _description(
          tr(
            "Files every chat in this project can read, for example notes, documents or data the assistant should know about. The assistant cannot change them. They are kept on the project's node and shared with running chats at once: an upload, a replacement or a removal reaches chats already open. Uploading a file with the same name as an existing one replaces it.",
          ),
        ),
        if (loading)
          _feedback(tr("Loading project files…"), role: SemanticsRole.status)
        else if (files != null) ...[
          if (currentFiles.isEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 16),
              child: Text(
                tr("No files yet."),
                style: webText(context, size: 13, color: 'text.muted'),
              ),
            )
          else ...[
            const SizedBox(height: 10),
            Semantics(
              container: true,
              label: tr("Project files"),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [for (final file in currentFiles) _fileRow(file)],
              ),
            ),
          ],
          _limitsRow(),
        ],
        if (error != null) ...[
          _feedback(error!, role: SemanticsRole.alert),
          if (files == null)
            Align(
              alignment: Alignment.centerLeft,
              child: Padding(
                padding: const EdgeInsets.only(top: 4),
                child: WebButton(
                  tr("Retry"),
                  disabledOpacity: .5,
                  onPressed: loading ? null : _load,
                ),
              ),
            ),
        ],
        if (status != null) _feedback(status!, role: SemanticsRole.status),
      ],
    );
  }
}
