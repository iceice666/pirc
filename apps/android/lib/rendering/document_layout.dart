import 'dart:collection';
import 'document_offsets.dart';
import 'html_document_box.dart';
import 'document_element_scroll.dart';

import 'package:flutter/rendering.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

/// Collects the laid-out render boxes associated with native document nodes.
///
/// The controller reports only render objects supplied by the document
/// renderer. It does not infer boxes from DOM styles or create boxes for inline
/// text fragments.
class NativeDocumentLayoutController extends ChangeNotifier {
  static const int maximumElementCount = 5000;

  _RenderNativeDocumentLayoutRoot? _root;
  final Map<String, Set<_RenderNativeDocumentLayoutElement>> _elements = {};
  bool _notificationScheduled = false;
  bool _disposed = false;

  /// Captures the latest completed layout for [revision].
  ///
  /// Element rectangles are relative to the explicit document root. Scroll is
  /// included as viewport metadata and is not applied to the element boxes.
  Map<String, dynamic>? capture({
    required int revision,
    required int generation,
    required Size viewport,
    Offset scrollOffset = Offset.zero,
    Size? contentSize,
    Map<String, dynamic>? Function(String id)? elementScrollMetrics,
    List<Map<String, dynamic>> scrollEvents = const [],
  }) {
    if (_disposed) return null;
    final root = _root;
    if (root == null) return null;
    if (root.knownIds.length > maximumElementCount) {
      throw RangeError.range(
        root.knownIds.length,
        0,
        maximumElementCount,
        'knownIds',
        'At most $maximumElementCount native document element IDs are supported.',
      );
    }
    if (!root.attached ||
        !root.hasSize ||
        root.revision != revision ||
        root.laidOutRevision != revision ||
        root.pendingLayout) {
      return null;
    }

    if (!nativeDocumentMarginsAreSettled(root)) return null;
    final known = root.knownIds.toList()..sort();
    final boxes = <Map<String, dynamic>>[];

    for (final id in known) {
      if (root.noBoxIds.contains(id)) {
        boxes.add(<String, dynamic>{'id': id, 'kind': 'none'});
        continue;
      }

      final candidates = <_RenderNativeDocumentLayoutElement>[];
      for (final element
          in _elements[id] ?? const <_RenderNativeDocumentLayoutElement>{}) {
        if (element.attached &&
            element.revision == revision &&
            identical(_nearestRoot(element), root)) {
          candidates.add(element);
        }
      }

      // Ambiguous ownership must not expose a potentially unrelated box.
      if (candidates.length != 1) {
        boxes.add(<String, dynamic>{'id': id, 'kind': 'unsupported'});
        continue;
      }

      final element = candidates.single;
      if (element.pendingLayout) {
        return null;
      }
      if (!element.hasSize || element.laidOutRevision != revision) {
        boxes.add(<String, dynamic>{'id': id, 'kind': 'unsupported'});
        continue;
      }

      final surface = element.boxSurface?.call(element) ?? element;
      if (!surface.attached ||
          !surface.hasSize ||
          !identical(_nearestRoot(surface), root)) {
        boxes.add(<String, dynamic>{'id': id, 'kind': 'unsupported'});
        continue;
      }
      final Rect rect;
      try {
        rect = MatrixUtils.transformRect(
          surface.getTransformTo(root),
          Offset.zero & surface.size,
        );
      } on FlutterError {
        boxes.add(<String, dynamic>{'id': id, 'kind': 'unsupported'});
        continue;
      }

      final entry = <String, dynamic>{
        'id': id,
        'kind': 'box',
        'x': rect.left,
        'y': rect.top,
        'width': rect.width,
        'height': rect.height,
        'offsetWidth': surface.size.width.round(),
        'offsetHeight': surface.size.height.round(),
      };
      final offset = _offsetMetrics(element, surface, root);
      if (offset != null) entry['offset'] = offset;
      final client = _clientMetrics(surface);
      if (client != null) entry.addAll(client);
      final scroll = elementScrollMetrics?.call(id);
      if (scroll != null) entry['scroll'] = scroll;
      boxes.add(entry);
    }

    return <String, dynamic>{
      'revision': revision,
      'generation': generation,
      'viewport': <String, dynamic>{
        'width': viewport.width,
        'height': viewport.height,
        'scrollX': scrollOffset.dx,
        'scrollY': scrollOffset.dy,
        if (contentSize != null) ...{
          'contentWidth': contentSize.width,
          'contentHeight': contentSize.height,
        },
      },
      'boxes': boxes,
      if (scrollEvents.isNotEmpty) 'scrollEvents': scrollEvents,
    };
  }

  Map<String, dynamic>? _offsetMetrics(
    _RenderNativeDocumentLayoutElement element,
    RenderBox surface,
    _RenderNativeDocumentLayoutRoot root,
  ) {
    final spec = element.offsetSpec;
    if (spec == null) return null;
    if (spec.origin == NativeDocumentOffsetOrigin.zero) {
      return {'top': 0, 'left': 0, 'parentId': null};
    }
    RenderBox? measuredAncestor(String? id) {
      if (id == null ||
          !root.knownIds.contains(id) ||
          root.noBoxIds.contains(id)) {
        return null;
      }
      final owners = (_elements[id] ?? {}).where(
        (candidate) =>
            candidate.attached && identical(_nearestRoot(candidate), root),
      );
      if (owners.length != 1) return null;
      final owner = owners.single;
      if (owner.pendingLayout ||
          !owner.hasSize ||
          owner.laidOutRevision != root.revision ||
          owner.revision != root.revision) {
        return null;
      }
      RenderObject? current = element.parent;
      while (current != null &&
          !identical(current, owner) &&
          !identical(current, root)) {
        current = current.parent;
      }
      if (!identical(current, owner)) return null;
      final box = owner.boxSurface?.call(owner) ?? owner;
      return box.attached && box.hasSize && identical(_nearestRoot(box), root)
          ? box
          : null;
    }

    // The parent must be a unique current measured ancestor even when a
    // browser body rule selects the root as the coordinate origin.
    if (spec.parentId != null && measuredAncestor(spec.parentId) == null) {
      return null;
    }
    final position = _unscrolledOrigin(surface, root);
    if (position == null) return null;
    var origin = Offset.zero;
    if (spec.origin != NativeDocumentOffsetOrigin.initialContainingBlock) {
      final ancestor = measuredAncestor(spec.originId);
      if (ancestor == null) return null;
      final measured = _unscrolledOrigin(ancestor, root);
      if (measured == null) return null;
      origin = measured;
      if (spec.origin == NativeDocumentOffsetOrigin.paddingEdge) {
        final border = _borderInsets(ancestor);
        if (border == null) return null;
        origin += Offset(border.left, border.top);
      }
    }
    final offset = position - origin;
    if (!offset.dx.isFinite ||
        !offset.dy.isFinite ||
        offset.dx.abs() > 9007199254740990 ||
        offset.dy.abs() > 9007199254740990) {
      return null;
    }
    // CSSOM long rounding ties toward positive infinity, including negatives.
    return {
      'top': (offset.dy + .5).floor(),
      'left': (offset.dx + .5).floor(),
      'parentId': spec.parentId,
    };
  }

  void _attachRoot(_RenderNativeDocumentLayoutRoot root) {
    if (_disposed || identical(_root, root)) return;
    _root = root;
    _scheduleNotification();
  }

  void _detachRoot(_RenderNativeDocumentLayoutRoot root) {
    if (_disposed || !identical(_root, root)) return;
    _root = null;
    _scheduleNotification();
  }

  void _rootChanged(_RenderNativeDocumentLayoutRoot root) {
    if (_disposed || !identical(_root, root)) return;
    _scheduleNotification();
  }

  void _attachElement(_RenderNativeDocumentLayoutElement element) {
    if (_disposed) return;
    (_elements[element.id] ??=
            HashSet<_RenderNativeDocumentLayoutElement>.identity())
        .add(element);
    _scheduleNotification();
  }

  void _detachElement(_RenderNativeDocumentLayoutElement element) {
    if (_disposed) return;
    final owners = _elements[element.id];
    if (owners == null || !owners.remove(element)) return;
    if (owners.isEmpty) _elements.remove(element.id);
    _scheduleNotification();
  }

  void _elementChanged() {
    if (_disposed) return;
    _scheduleNotification();
  }

  void _scheduleNotification() {
    if (_disposed || _notificationScheduled) return;
    _notificationScheduled = true;
    SchedulerBinding.instance.addPostFrameCallback((_) {
      _notificationScheduled = false;
      if (!_disposed) notifyListeners();
    });
    SchedulerBinding.instance.ensureVisualUpdate();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _root = null;
    _elements.clear();
    super.dispose();
  }
}

/// Establishes the explicit coordinate space and ID set for one document.
class NativeDocumentLayoutRoot extends SingleChildRenderObjectWidget {
  NativeDocumentLayoutRoot({
    super.key,
    required this.controller,
    required this.revision,
    required Set<String> knownIds,
    Set<String> noBoxIds = const <String>{},
    required super.child,
  }) : knownIds = Set<String>.unmodifiable(knownIds),
       noBoxIds = Set<String>.unmodifiable(noBoxIds);

  final NativeDocumentLayoutController controller;
  final int revision;
  final Set<String> knownIds;
  final Set<String> noBoxIds;

  @override
  RenderObject createRenderObject(BuildContext context) =>
      _RenderNativeDocumentLayoutRoot(
        controller: controller,
        revision: revision,
        knownIds: knownIds,
        noBoxIds: noBoxIds,
      );

  @override
  void updateRenderObject(
    BuildContext context,
    covariant RenderObject renderObject,
  ) {
    (renderObject as _RenderNativeDocumentLayoutRoot).update(
      controller: controller,
      revision: revision,
      knownIds: knownIds,
      noBoxIds: noBoxIds,
    );
  }
}

class _RenderNativeDocumentLayoutRoot extends RenderProxyBox {
  _RenderNativeDocumentLayoutRoot({
    required this.controller,
    required this.revision,
    required this.knownIds,
    required this.noBoxIds,
  });

  NativeDocumentLayoutController controller;
  int revision;
  Set<String> knownIds;
  Set<String> noBoxIds;
  int? laidOutRevision;
  bool pendingLayout = true;

  void update({
    required NativeDocumentLayoutController controller,
    required int revision,
    required Set<String> knownIds,
    required Set<String> noBoxIds,
  }) {
    final ownerChanged = !identical(this.controller, controller);
    final changed =
        this.revision != revision ||
        !_sameIds(this.knownIds, knownIds) ||
        !_sameIds(this.noBoxIds, noBoxIds);
    if (!ownerChanged && !changed) return;

    if (ownerChanged) this.controller._detachRoot(this);
    this.controller = controller;
    this.revision = revision;
    this.knownIds = Set<String>.unmodifiable(knownIds);
    this.noBoxIds = Set<String>.unmodifiable(noBoxIds);
    laidOutRevision = null;
    if (ownerChanged && attached) controller._attachRoot(this);
    markNeedsLayout();
    controller._rootChanged(this);
  }

  @override
  void markNeedsLayout() {
    pendingLayout = true;
    super.markNeedsLayout();
  }

  @override
  void attach(PipelineOwner owner) {
    super.attach(owner);
    pendingLayout = true;
    laidOutRevision = null;
    controller._attachRoot(this);
  }

  @override
  void detach() {
    pendingLayout = true;
    laidOutRevision = null;
    controller._detachRoot(this);
    super.detach();
  }

  @override
  void performLayout() {
    super.performLayout();
    pendingLayout = false;
    laidOutRevision = revision;
    controller._rootChanged(this);
  }
}

/// Associates an actual RenderBox with a native document element ID.
///
/// This is a transparent proxy: it leaves the child's constraints, size,
/// intrinsic dimensions, and baseline behavior unchanged.
class NativeDocumentLayoutElement extends SingleChildRenderObjectWidget {
  const NativeDocumentLayoutElement({
    super.key,
    required this.controller,
    required this.revision,
    required this.id,
    this.boxSurface,
    this.offsetSpec,
    required super.child,
  });

  final NativeDocumentLayoutController controller;
  final int revision;
  final String id;
  final RenderBox? Function(RenderBox)? boxSurface;
  final NativeDocumentOffsetSpec? offsetSpec;

  @override
  RenderObject createRenderObject(BuildContext context) =>
      _RenderNativeDocumentLayoutElement(
        controller: controller,
        revision: revision,
        id: id,
        boxSurface: boxSurface,
        offsetSpec: offsetSpec,
      );

  @override
  void updateRenderObject(
    BuildContext context,
    covariant RenderObject renderObject,
  ) {
    (renderObject as _RenderNativeDocumentLayoutElement).update(
      controller: controller,
      revision: revision,
      id: id,
      boxSurface: boxSurface,
      offsetSpec: offsetSpec,
    );
  }
}

class _RenderNativeDocumentLayoutElement extends RenderProxyBox {
  _RenderNativeDocumentLayoutElement({
    required this.controller,
    required this.revision,
    required this.id,
    this.boxSurface,
    this.offsetSpec,
  });

  NativeDocumentLayoutController controller;
  int revision;
  String id;
  RenderBox? Function(RenderBox)? boxSurface;
  NativeDocumentOffsetSpec? offsetSpec;
  int? laidOutRevision;
  bool pendingLayout = true;

  void update({
    required NativeDocumentLayoutController controller,
    required int revision,
    required String id,
    RenderBox? Function(RenderBox)? boxSurface,
    NativeDocumentOffsetSpec? offsetSpec,
  }) {
    final ownerChanged = !identical(this.controller, controller);
    final registrationChanged = ownerChanged || this.id != id;
    final layoutChanged =
        registrationChanged ||
        this.revision != revision ||
        this.boxSurface != boxSurface ||
        this.offsetSpec != offsetSpec;
    if (registrationChanged) {
      this.controller._detachElement(this);
      this.controller = controller;
      this.id = id;
      if (attached) controller._attachElement(this);
    }
    if (!layoutChanged) return;
    this.boxSurface = boxSurface;
    this.offsetSpec = offsetSpec;
    this.revision = revision;
    laidOutRevision = null;
    markNeedsLayout();
    controller._elementChanged();
  }

  @override
  void markNeedsLayout() {
    pendingLayout = true;
    super.markNeedsLayout();
  }

  @override
  void attach(PipelineOwner owner) {
    super.attach(owner);
    pendingLayout = true;
    laidOutRevision = null;
    controller._attachElement(this);
  }

  @override
  void detach() {
    pendingLayout = true;
    laidOutRevision = null;
    controller._detachElement(this);
    super.detach();
  }

  @override
  void performLayout() {
    super.performLayout();
    pendingLayout = false;
    laidOutRevision = revision;
    controller._elementChanged();
  }
}

_RenderNativeDocumentLayoutRoot? _nearestRoot(RenderObject element) {
  RenderObject? current = element;
  while (current != null) {
    if (current is _RenderNativeDocumentLayoutRoot) return current;
    current = current.parent;
  }
  return null;
}

Offset? _unscrolledOrigin(RenderBox element, RenderBox root) {
  Offset? position;
  try {
    position = MatrixUtils.getAsTranslation(element.getTransformTo(root));
  } on FlutterError {
    return null;
  }
  if (position == null) return null;
  RenderObject? current = element.parent;
  while (current != null && !identical(current, root)) {
    position = position! + nativeDocumentScrollTranslation(current);
    current = current.parent;
  }
  return identical(current, root) ? position : null;
}

EdgeInsets? _borderInsets(RenderBox element) {
  final borders = <EdgeInsets>[];
  var unresolvedBorder = false;

  void visit(RenderObject current, {required bool isElement}) {
    if (!isElement && current is _RenderNativeDocumentLayoutElement) return;
    if (current is RenderDecoratedBox && current.decoration is BoxDecoration) {
      final decoration = current.decoration as BoxDecoration;
      final border = decoration.border;
      if (border != null) {
        final dimensions = border.dimensions;
        final direction = current.configuration.textDirection;
        if (direction == null && dimensions is! EdgeInsets) {
          unresolvedBorder = true;
        } else {
          try {
            final resolved = dimensions.resolve(direction ?? TextDirection.ltr);
            if (resolved.left > 0 ||
                resolved.top > 0 ||
                resolved.right > 0 ||
                resolved.bottom > 0) {
              borders.add(resolved);
            }
          } on Object {
            unresolvedBorder = true;
          }
        }
      }
    }
    current.visitChildren((child) => visit(child, isElement: false));
  }

  visit(element, isElement: true);
  if (unresolvedBorder || borders.length > 1) return null;
  return borders.isEmpty ? EdgeInsets.zero : borders.single;
}

Map<String, dynamic>? _clientMetrics(RenderBox element) {
  final border = _borderInsets(element);
  if (border == null) return null;
  final clientWidth = (element.size.width - border.left - border.right).clamp(
    0.0,
    double.infinity,
  );
  final clientHeight = (element.size.height - border.top - border.bottom).clamp(
    0.0,
    double.infinity,
  );
  return <String, dynamic>{
    'clientLeft': border.left.round(),
    'clientTop': border.top.round(),
    'clientWidth': clientWidth.round(),
    'clientHeight': clientHeight.round(),
  };
}

bool _sameIds(Set<String> left, Set<String> right) {
  if (identical(left, right)) return true;
  if (left.length != right.length) return false;
  return left.containsAll(right);
}
