import '../l10n/app_i18n.dart';
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'checkpoints_state.dart';
import 'common.dart';
import 'files_pane.dart';
import 'gateway.dart';
import 'web_controls.dart';

class CheckpointsPane extends StatefulWidget {
  const CheckpointsPane({super.key, required this.controller});
  final LiveController controller;

  @override
  State<CheckpointsPane> createState() => _CheckpointsPaneState();
}

class _CheckpointsPaneState extends State<CheckpointsPane> {
  late final state = CheckpointsState(widget.controller);
  bool reviewObservational = false;
  String side = 'before';

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    state.setActive(TickerMode.valuesOf(context).enabled);
  }

  @override
  void dispose() {
    state.dispose();
    super.dispose();
  }

  TextStyle text(
    double size, {
    String color = 'text.primary',
    FontWeight weight = FontWeight.w400,
    double height = 1.4,
  }) => webText(context, size: size, color: color, weight: weight).copyWith(
    height: height,
  );

  BoxDecoration box({String color = 'web.bg-layer', double radius = 10}) =>
      BoxDecoration(
        color: palette(context)[color],
        borderRadius: BorderRadius.circular(radius),
        boxShadow: [BoxShadow(color: palette(context)['web.line'], spreadRadius: 1)],
      );

  Widget gap([double height = 8]) => SizedBox(height: height);

  Widget note(String message, {String color = 'text.muted'}) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 3),
    child: Text(message, style: text(12.5, color: color, height: 1.5)),
  );

  Widget alert(String message, {bool danger = false}) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
    decoration: BoxDecoration(
      color: palette(context)[danger ? 'status.dangerSoft' : 'status.warningSoft'],
      borderRadius: BorderRadius.circular(8),
    ),
    child: Text(
      message,
      style: text(12.5, color: danger ? 'status.danger' : 'text.warning', height: 1.45),
    ),
  );

  String display(dynamic value) {
    if (value == null) return tr('Unknown');
    if (value is String) return value;
    if (value is bool || value is num) return '$value';
    if (value is List) {
      return value.map(display).where((item) => item.isNotEmpty).join(', ');
    }
    if (value is Map) {
      return value.entries.map((entry) => '${entry.key}: ${display(entry.value)}').join(' · ');
    }
    return '$value';
  }

  List<String> details(dynamic value) {
    if (value == null) return const [];
    if (value is Map) {
      return value.entries.map((entry) => '${entry.key}: ${display(entry.value)}').toList();
    }
    if (value is List) return value.map(display).where((item) => item.isNotEmpty).toList();
    return ['$value'];
  }

  List<String> gapDetails(dynamic value) {
    if (value == true) return [tr('Some observed changes were not captured.')];
    if (value == false || value == null) return const [];
    return details(value);
  }

  bool isClosed(Json capture) => capture['state'] != 'capturing';
  bool canSelectOperation(Json operation) =>
      operation['state'] == 'observed' && operation['after'] != null;

  String jobStatusLabel(String status) => switch (status) {
    'preparing' => tr('Preparing workspace…'),
    'ready' => tr('Ready'),
    'opened' => tr('Opened'),
    'stale' => tr('Stale'),
    'failed' => tr('Failed'),
    'interrupted' => tr('Interrupted'),
    _ => status,
  };

  String created(Json capture) {
    final value = capture['created'];
    if (value is num) {
      final date = DateTime.fromMillisecondsSinceEpoch(value.toInt()).toLocal();
      return '${date.year}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')} ${date.hour.toString().padLeft(2, '0')}:${date.minute.toString().padLeft(2, '0')}';
    }
    return value is String ? value : '';
  }

  Widget captureRow(Json capture) {
    final closed = isClosed(capture);
    final run = obj(capture['run']);
    final runLabel = run.isEmpty ? '' : display(run['id'] ?? run['status'] ?? run['name']);
    final gaps = gapDetails(capture['gaps']);
    final coverage = display(capture['coverage']);
    final selected = state.selectedCaptureId == capture['id'];
    return Container(
      key: ValueKey('checkpoint-capture-${capture['id']}'),
      decoration: box(color: selected ? 'web.bg-active' : 'web.bg-layer'),
      padding: const EdgeInsets.fromLTRB(10, 7, 10, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            onTap: closed ? () => state.selectCapture(capture) : null,
            borderRadius: BorderRadius.circular(6),
            child: Row(
              children: [
                Icon(
                  closed ? LucideIcons.circleCheck : LucideIcons.clock3,
                  size: 15,
                  color: palette(context)[closed ? 'status.success' : 'text.muted'],
                ),
                const SizedBox(width: 7),
                Expanded(
                  child: Text(
                    runLabel.isEmpty
                        ? tr('Run {0}', [capture['run'] ?? capture['id']])
                        : tr('Run {0}', [runLabel]),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: text(13, weight: FontWeight.w600),
                  ),
                ),
                const SizedBox(width: 6),
                _chip(closed ? tr('Closed') : tr('Open'),
                    color: closed ? 'status.success' : 'text.muted'),
              ],
            ),
          ),
          if (created(capture).isNotEmpty) ...[
            gap(4),
            Text(created(capture), style: text(11.5, color: 'text.muted')),
          ],
          if (coverage.isNotEmpty) ...[
            gap(5),
            Text('${tr('Observed coverage')}: $coverage', style: text(11.5, color: 'text.secondary')),
          ],
          if (capture['pinned'] == true) ...[
            gap(4),
            Text(tr('This capture is pinned.'), style: text(11.5, color: 'text.secondary')),
          ],
          if (gaps.isNotEmpty) ...[
            gap(6),
            alert('${tr('Coverage gaps')}: ${gaps.join(' · ')}'),
          ],
          if (!closed) ...[
            gap(5),
            Text(tr('Only closed runs can be recovered.'), style: text(11.5, color: 'text.muted')),
          ],
        ],
      ),
    );
  }

  Widget _chip(String label, {String color = 'text.secondary'}) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
    decoration: BoxDecoration(
      color: palette(context)['web.bg-hover'],
      borderRadius: BorderRadius.circular(999),
    ),
    child: Text(label, style: text(10.5, color: color, weight: FontWeight.w500)),
  );

  Widget operationRow(Json operation) {
    final selected = state.selectedOperationId == operation['id'];
    final selectable = canSelectOperation(operation);
    final before = obj(operation['before']), after = obj(operation['after']);
    return InkWell(
      key: ValueKey('checkpoint-operation-${operation['id']}'),
      onTap: selectable ? () {
        setState(() {
          side = 'before';
          reviewObservational = false;
        });
        state.selectOperation(operation);
        unawaited(state.loadFile('before'));
      } : null,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        decoration: box(color: selected ? 'web.bg-active' : 'web.bg-layer'),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        child: Row(
          children: [
            Icon(selected ? LucideIcons.circleCheck : LucideIcons.circle,
                size: 15,
                color: palette(context)[selected ? 'accent.default' : 'text.muted']),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('${operation['path'] ?? tr('Unknown path')}',
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: text(12.5, weight: FontWeight.w500)),
                  gap(3),
                  Text(
                    '${display(operation['state'])} · ${versionLabel(before)} → ${versionLabel(after)}',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: text(10.5, color: 'text.muted'),
                  ),
                  if (!selectable) ...[
                    gap(3),
                    Text(tr('Only observed file operations with a recorded result can be recovered.'),
                        style: text(10.5, color: 'text.muted')),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  String versionLabel(Json value) {
    if (value.isEmpty) return tr('Unknown');
    final kind = '${value['kind'] ?? tr('Unknown')}';
    if (kind == 'excluded') return tr('Excluded');
    if (kind == 'absent') return tr('Absent');
    return value['executable'] == true ? tr('File · executable') : tr('File');
  }

  Widget consent() => Container(
    decoration: box(color: 'web.bg-hover', radius: 8),
    child: Material(
      type: MaterialType.transparency,
      child: CheckboxListTile(
        key: const ValueKey('checkpoint-observational-consent'),
        value: reviewObservational,
        onChanged: state.offline || !state.enabled
            ? null
            : (value) => setState(() {
                reviewObservational = value == true;
                state.preview = null;
                state.previewFor = null;
              }),
        controlAffinity: ListTileControlAffinity.leading,
        dense: true,
        contentPadding: const EdgeInsets.symmetric(horizontal: 8),
        title: Text(tr('I reviewed this observational checkpoint and consent to recovery.'),
            style: text(12, height: 1.4)),
      ),
    ),
  );

  Widget originLink() {
    final origin = state.recoveryOrigin;
    if (origin == null) return const SizedBox.shrink();
    return Container(
      key: ValueKey('checkpoint-origin-${origin['jobId']}'),
      decoration: box(color: 'accent.soft'),
      padding: const EdgeInsets.all(9),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            tr('This recovery conversation is linked to its original session and checkpoint.'),
            style: text(11.5, color: 'text.secondary', height: 1.45),
          ),
          gap(5),
          Align(
            alignment: Alignment.centerLeft,
            child: WebButton(
              tr('Open original session'),
              icon: LucideIcons.arrowLeft,
              onPressed: state.offline || widget.controller.busy
                  ? null
                  : () => unawaited(
                      widget.controller.open('${origin['sessionId']}'),
                    ),
            ),
          ),
        ],
      ),
    );
  }

  Widget previewCard() {
    final preview = state.preview;
    if (preview == null) return const SizedBox.shrink();
    final exclusions = details(preview['exclusions']);
    final coverage = display(preview['coverage']);
    return Container(
      key: const ValueKey('checkpoint-preview'),
      decoration: box(color: 'accent.soft'),
      padding: const EdgeInsets.all(10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(LucideIcons.shieldCheck, size: 15, color: palette(context)['accent.default']),
              const SizedBox(width: 6),
              Expanded(child: Text(tr('Recovery preview'), style: text(13, weight: FontWeight.w600))),
              _chip(tr('Version {0}', [preview['revision']]), color: 'accent.default'),
            ],
          ),
          gap(6),
          Text(tr('Workspace copy size: {0}', [formatBytes(preview['copiedBytes'])]),
              style: text(11.5, color: 'text.secondary')),
          if (coverage.isNotEmpty) ...[
            gap(4),
            Text('${tr('Observed coverage')}: $coverage', style: text(11.5, color: 'text.secondary')),
          ],
          if (exclusions.isNotEmpty) ...[
            gap(7),
            Text(tr('Excluded files'), style: text(11.5, weight: FontWeight.w600)),
            for (final item in exclusions)
              Text('• $item', style: text(11, color: 'text.muted', height: 1.4)),
          ],
          gap(7),
          Text(tr('Preparation creates a separate workspace. The original workspace is not changed.'),
              style: text(11.5, color: 'text.secondary', height: 1.45)),
        ],
      ),
    );
  }

  Widget manifest(Json job, {bool allowKeepCurrentReview = true}) {
    final manifest = obj(job['manifest']);
    final paths = rows(manifest['paths']);
    final exclusions = details(manifest['exclusions']);
    final unresolved = state.hasUnresolved(job);
    return Container(
      decoration: box(color: 'web.bg-hover', radius: 8),
      padding: const EdgeInsets.all(9),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(tr('Review paths'), style: text(12, weight: FontWeight.w600)),
          if (paths.isEmpty && exclusions.isEmpty)
            note(tr('No path conflicts or exclusions were reported.')),
          for (final path in paths) ...[
            gap(5),
            Container(
              decoration: box(radius: 6),
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text('${path['path'] ?? tr('Unknown path')}',
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: text(11.5, weight: FontWeight.w500)),
                      ),
                      const SizedBox(width: 6),
                      _chip(statusLabel('${path['status']}'),
                          color: path['status'] == 'conflict' || path['status'] == 'excluded'
                              ? 'text.warning'
                              : 'status.success'),
                    ],
                  ),
                  if (path['status'] == 'conflict') ...[
                    gap(3),
                    Text(tr('Current content changed after this checkpoint.'),
                        style: text(10.5, color: 'text.muted')),
                  ],
                  if (path['status'] == 'excluded') ...[
                    gap(3),
                    Text(tr('This path is excluded from the recovery copy.'),
                        style: text(10.5, color: 'text.muted')),
                  ],
                ],
              ),
            ),
          ],
          if (exclusions.isNotEmpty) ...[
            gap(6),
            Text(tr('Exclusions'), style: text(11.5, weight: FontWeight.w600)),
            for (final item in exclusions)
              Text('• $item', style: text(10.5, color: 'text.muted', height: 1.4)),
          ],
          if (unresolved && allowKeepCurrentReview) ...[
            gap(8),
            alert(tr('Continuing keeps the current workspace versions for unresolved paths.')),
            Material(
              type: MaterialType.transparency,
              child: CheckboxListTile(
                key: ValueKey('checkpoint-keep-current-${job['id']}'),
                value: state.reviewedKeepCurrent['${job['id']}'] == true,
                onChanged: (value) => state.setKeepCurrentReviewed('${job['id']}', value == true),
                controlAffinity: ListTileControlAffinity.leading,
                dense: true,
                contentPadding: EdgeInsets.zero,
                title: Text(tr('I reviewed the conflicts and exclusions; keep current versions.'),
                    style: text(11.5, height: 1.4)),
              ),
            ),
          ],
        ],
      ),
    );
  }

  String statusLabel(String status) => switch (status) {
    'inverse_reviewed_observation' => tr('Reviewed observation'),
    'review_observational' => tr('Review observation'),
    'conflict' => tr('Conflict'),
    'excluded' => tr('Excluded'),
    _ => status,
  };

  Widget jobCard(Json job) {
    final selected = job['id'] == state.selectedJobId;
    final jobState = '${job['state'] ?? 'unknown'}';
    final ready = jobState == 'ready';
    final continuationSessionId = obj(job['continuation'])['sessionId'];
    final hasContinuation = continuationSessionId is String &&
        continuationSessionId.isNotEmpty;
    final canOpenExisting = jobState == 'opened' && hasContinuation;
    final retryOpened = jobState == 'opened' && !hasContinuation;
    final unresolved = state.hasUnresolved(job);
    final keepReviewed = state.reviewedKeepCurrent['${job['id']}'] == true;
    final canContinue = state.canMutate && (ready || retryOpened) &&
        (!unresolved || keepReviewed);
    return Container(
      key: ValueKey('checkpoint-job-${job['id']}'),
      decoration: box(color: selected ? 'web.bg-active' : 'web.bg-layer'),
      padding: const EdgeInsets.all(9),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            onTap: () {
              setState(() => side = 'before');
              state.selectJob(job);
            },
            child: Row(
              children: [
                Icon(
                  jobState == 'ready' ? LucideIcons.circleCheck :
                      jobState == 'failed' || jobState == 'stale' ? LucideIcons.circleAlert : LucideIcons.loaderCircle,
                  size: 14,
                  color: palette(context)[jobState == 'ready' ? 'status.success' : 'text.secondary'],
                ),
                const SizedBox(width: 6),
                Expanded(child: Text(tr('Recovery workspace'), style: text(12, weight: FontWeight.w600))),
                _chip(jobStatusLabel(jobState), color: jobState == 'ready' ? 'status.success' : 'text.secondary'),
              ],
            ),
          ),
          if (job['reservedBytes'] != null) ...[
            gap(4),
            Text(tr('Reserved space: {0}', [formatBytes(job['reservedBytes'])]),
                style: text(10.5, color: 'text.muted')),
          ],
          if (jobState == 'preparing') ...[
            gap(6),
            Text(tr('Preparing an independent workspace…'), style: text(11.5, color: 'text.secondary')),
          ],
          if (jobState == 'stale') ...[
            gap(6),
            alert(tr('This recovery preview is stale. Refresh checkpoints and preview again.'), danger: true),
          ],
          if (jobState == 'failed' || jobState == 'interrupted') ...[
            gap(6),
            alert('${tr('Recovery did not finish')}${job['error'] == null ? '.' : ': ${job['error']}'}', danger: true),
          ],
          if (ready || jobState == 'opened') ...[
            gap(7),
            manifest(job, allowKeepCurrentReview: !canOpenExisting),
            gap(7),
            if (ready)
              Text(tr('Continue opens a new blank conversation linked to this recovery. It does not copy the old prompt, history, or memory.'),
                  style: text(11.5, color: 'text.secondary', height: 1.45)),
            if (retryOpened)
              Text(tr('Retry will link this prepared recovery to the same blank conversation. It will not create another workspace copy.'),
                  style: text(11.5, color: 'text.secondary', height: 1.45)),
            gap(6),
            Align(
              alignment: Alignment.centerLeft,
              child: WebButton(
                canOpenExisting
                    ? tr('Open recovery conversation')
                    : retryOpened
                    ? tr('Retry opening recovery conversation')
                    : unresolved
                    ? tr('Keep current and continue')
                    : tr('Continue in new conversation'),
                icon: canOpenExisting ? LucideIcons.externalLink : LucideIcons.arrowRight,
                primary: true,
                onPressed: (canOpenExisting && !state.offline || canContinue) &&
                        !state.continuing &&
                        !widget.controller.busy
                    ? () => _continue(job)
                    : null,
              ),
            ),
          ],
        ],
      ),
    );
  }

  Future<void> _continue(Json job) async {
    final original = state.session;
    final opened = await state.continueRecovery(job);
    if (!opened || !mounted || original == null) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      SnackBar(
        content: Text(tr('Opened the blank recovery conversation.')),
        action: SnackBarAction(
          label: tr('Return to original'),
          onPressed: () => unawaited(widget.controller.open(original)),
        ),
      ),
    );
  }

  List<(String, String)> get fileSides => [
    ('before', tr('Before')),
    ('after', tr('Agent')),
    ('current', tr('Current')),
    ('candidate', tr('Result')),
  ];

  Widget fileReview() {
    final selectedJob = state.selectedJob;
    final operation = state.selectedOperation;
    if (operation == null) return const SizedBox.shrink();
    final jobId = selectedJob?['id'] as String?;
    final available = side == 'before' || side == 'after' || jobId != null;
    final file = available ? state.fileFor(side, jobId: (side == 'current' || side == 'candidate') ? jobId : null) : null;
    final tabs = fileSides;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          decoration: box(color: 'web.bg-hover', radius: 8),
          padding: const EdgeInsets.all(3),
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                for (final item in tabs) ...[
                  if (item != tabs.first) const SizedBox(width: 2),
                  TextButton(
                    key: ValueKey('checkpoint-file-side-${item.$1}'),
                    onPressed: (item.$1 == 'current' || item.$1 == 'candidate') && jobId == null
                        ? null
                        : () {
                            setState(() => side = item.$1);
                            unawaited(state.loadFile(item.$1,
                                jobId: item.$1 == 'current' || item.$1 == 'candidate' ? jobId : null));
                          },
                    style: TextButton.styleFrom(
                      minimumSize: Size.zero,
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      backgroundColor: side == item.$1 ? palette(context)['web.bg-layer'] : Colors.transparent,
                      foregroundColor: palette(context)[side == item.$1 ? 'text.primary' : 'text.muted'],
                      textStyle: text(11.5, weight: FontWeight.w500),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                    ),
                    child: Text(item.$2),
                  ),
                ],
              ],
            ),
          ),
        ),
        gap(6),
        if (!available)
          note(tr('Prepare a recovery workspace to review the current and result files.'))
        else if (state.fileError != null)
          alert(state.fileError!, danger: true)
        else if (state.fileLoading.contains(_uiFileKey(side, jobId)))
          note(tr('Loading file…'))
        else if (file == null)
          note(tr('Choose a file version to review.'))
        else if (file['excluded'] == true || file['side'] == 'excluded')
          alert(tr('This file is excluded from the recovery preview.'))
        else if (file['binary'] == true)
          alert(tr('Binary files are listed but cannot be shown as text.'))
        else if (file['absent'] == true || file['text'] == null)
          note(tr('This file version is absent.'))
        else ...[
          if (file['truncated'] == true) alert(tr('This text preview is truncated.')),
          NativeFileSource(
            key: ValueKey('checkpoint-file-${state.selectedCaptureId}-${state.selectedOperationId}-${jobId ?? ''}-$side'),
            file: {
              'path': '${file['path'] ?? operation['path'] ?? ''}',
              'content': '${file['text']}',
              'truncated': file['truncated'] == true,
            },
          ),
        ],
      ],
    );
  }

  String _uiFileKey(String value, String? jobId) =>
      '${state.selectedCaptureId}:${state.selectedOperationId}:${jobId ?? ''}:$value';

  Widget content() {
    if (state.offline) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          originLink(),
          alert(tr('The connection is offline. Checkpoints are read-only until it reconnects.')),
        ],
      );
    }
    if (state.loading && state.data == null) return note(tr('Loading checkpoints…'));
    if (state.error != null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          originLink(),
          alert(state.error!, danger: true),
          gap(),
          Align(
            alignment: Alignment.centerLeft,
            child: WebButton(tr('Refresh checkpoints'), icon: LucideIcons.refreshCw,
                onPressed: state.loading ? null : state.load),
          ),
        ],
      );
    }
    if (!state.enabled) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          originLink(),
          alert(tr('Checkpoints are disabled for this workspace on this node. Set PIRC_CHECKPOINT_WORKSPACES to enable them.')),
          gap(),
          Align(
            alignment: Alignment.centerLeft,
            child: WebButton(tr('Refresh checkpoints'), icon: LucideIcons.refreshCw,
                onPressed: state.loading ? null : state.load),
          ),
        ],
      );
    }
    final selectedCapture = state.selectedCapture;
    final operations = rows(selectedCapture?['operations']);
    final operation = state.selectedOperation;
    final jobs = state.selectedJobs;
    final previewMatches = state.preview != null && state.previewFor == '${state.session}:${state.selectedCaptureId}:${state.selectedOperationId}';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        originLink(),
        Row(
          children: [
            Expanded(child: Text(tr('Closed runs'), style: text(12.5, weight: FontWeight.w600))),
            WebIconButton(LucideIcons.refreshCw, tr('Refresh checkpoints'),
                onPressed: state.loading ? null : state.load),
          ],
        ),
        note(tr('Checkpoints capture observed changes. They may omit files or details; review coverage before recovery.')),
        if (state.stale) ...[gap(5), alert(tr('Checkpoint data changed. Refresh before continuing.'))],
        if (state.captures.isEmpty && !state.loading)
          note(tr('No checkpoints are available for this session.'))
        else ...[
          for (final capture in state.captures) ...[
            gap(6),
            captureRow(capture),
          ],
        ],
        if (state.more) ...[
          gap(6),
          Align(
            alignment: Alignment.centerLeft,
            child: WebButton(
              state.loadingMore ? tr('Loading more…') : tr('Load more checkpoints'),
              icon: LucideIcons.chevronsDown,
              onPressed: state.loading ? null : () => unawaited(state.loadMore()),
            ),
          ),
        ],
        if (selectedCapture != null) ...[
          gap(12),
          Text(tr('Choose one file operation'), style: text(12.5, weight: FontWeight.w600)),
          note(tr('Select one path from a closed run. Recovery applies only to this selected operation.')),
          if (selectedCapture['operationsTruncated'] == true) ...[
            gap(5),
            alert(tr('Only the first 100 operations are listed. This operation list is incomplete.')),
          ],
          if (operations.isEmpty)
            note(tr('This checkpoint has no recoverable file operations.'))
          else ...[
            for (final op in operations) ...[
              gap(5),
              operationRow(op),
            ],
          ],
        ],
        if (operation != null) ...[
          gap(10),
          Container(
            decoration: box(color: 'web.bg-layer'),
            padding: const EdgeInsets.all(9),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(tr('Review before preparing'), style: text(12.5, weight: FontWeight.w600)),
                gap(5),
                Text('${operation['path']}', style: text(11.5, color: 'text.secondary')),
                gap(7),
                consent(),
                gap(7),
                Align(
                  alignment: Alignment.centerLeft,
                  child: WebButton(
                    tr('Preview recovery'),
                    icon: LucideIcons.scanEye,
                    onPressed: reviewObservational && state.enabled && !state.offline && !state.previewing
                        ? () => unawaited(state.createPreview(reviewObservational: reviewObservational))
                        : null,
                  ),
                ),
                if (state.previewing) ...[gap(5), note(tr('Building a fresh preview…'))],
                if (state.preview != null && !previewMatches) ...[gap(5), alert(tr('This preview no longer matches your selection. Preview again.'))],
                gap(8),
                fileReview(),
                if (previewMatches) ...[
                  gap(8),
                  previewCard(),
                  gap(7),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: WebButton(
                      state.preparing ? tr('Preparing workspace…') : tr('Prepare recovery workspace'),
                      icon: LucideIcons.copyPlus,
                      primary: true,
                      onPressed: state.canMutate && reviewObservational && !state.preparing && state.stale == false
                          ? () => unawaited(state.prepareWorkspace(reviewObservational: reviewObservational))
                          : null,
                    ),
                  ),
                ],
                if (!state.canMutate && !state.offline) ...[
                  gap(7),
                  Text(tr('Take control of this session before preparing or continuing recovery.'),
                      style: text(11.5, color: 'text.muted')),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: WebButton(
                      tr('Take control'),
                      icon: LucideIcons.hand,
                      onPressed: widget.controller.busy ? null : () => unawaited(widget.controller.takeControl()),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
        if (jobs.isNotEmpty) ...[
          gap(12),
          Text(tr('Recovery workspaces'), style: text(12.5, weight: FontWeight.w600)),
          note(tr('Each recovery workspace is prepared independently and can be reviewed before opening a new conversation.')),
          for (final job in jobs) ...[
            gap(6),
            jobCard(job),
          ],
        ],
        if (state.continuing) ...[gap(6), note(tr('Opening the new conversation…'))],
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return AnimatedBuilder(
      animation: state,
      builder: (context, _) => Padding(
        padding: const EdgeInsets.only(top: 2),
        child: content(),
      ),
    );
  }
}

String formatBytes(dynamic value) {
  if (value is! num) return tr('Unknown');
  if (value < 1024) return tr('{0} B', [value]);
  if (value < 1024 * 1024) return tr('{0} KB', [(value / 1024).toStringAsFixed(1)]);
  return tr('{0} MB', [(value / (1024 * 1024)).toStringAsFixed(1)]);
}
