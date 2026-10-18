import 'package:flutter/rendering.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';
import 'package:html/dom.dart' as dom;
import 'document_computed_styles.dart';
import 'document_layout.dart';

/// DOM identity/cascade metadata; geometry always comes from completed layout.
class NativeDocumentScrollAnchorNode {
  NativeDocumentScrollAnchorNode({
    required this.id,
    required this.parent,
    required this.excluded,
    required this.candidate,
    required this.scrollContainer,
    required this.position,
    required this.suppression,
  });
  final String id;
  final String? parent;
  final bool excluded, candidate, scrollContainer;
  final String position;
  final Map<String, String?> suppression;
}

Map<String, NativeDocumentScrollAnchorNode> nativeDocumentScrollAnchorNodes({
  required dom.Document document,
  required Map<dom.Element, Map<String, String>> stylesByElement,
  required Map<String, NativeDocumentComputedStyleSpec> computedStyles,
}) {
  final result = <String, NativeDocumentScrollAnchorNode>{};
  final excluded = <dom.Element, bool>{};
  for (final e in document.querySelectorAll('*')) {
    final id = e.attributes['data-pirc-script-id'];
    final css = stylesByElement[e] ?? const <String, String>{};
    final spec = computedStyles[id];
    final display = spec?.values['display'];
    final position = spec?.values['position'] ?? 'static';
    final inheritAnchor =
        css['overflow-anchor'] == 'inherit' && e.parent != null
        ? (stylesByElement[e.parent] ??
              const <String, String>{})['overflow-anchor']
        : css['overflow-anchor'];
    final blocked =
        (excluded[e.parent] ?? false) ||
        inheritAnchor == 'none' ||
        display == 'none' ||
        position == 'fixed' ||
        position == 'sticky' ||
        !const {'', 'none'}.contains(css['transform'] ?? '') ||
        !const {
          '',
          'horizontal-tb',
          'initial',
          'inherit',
          'unset',
        }.contains(css['writing-mode'] ?? '');
    excluded[e] = blocked;
    if (id == null || spec == null) continue;
    var ancestor = e.parent;
    while (ancestor != null &&
        !ancestor.attributes.containsKey('data-pirc-script-id')) {
      ancestor = ancestor.parent;
    }
    result[id] = NativeDocumentScrollAnchorNode(
      id: id,
      parent: ancestor?.attributes['data-pirc-script-id'],
      excluded: blocked,
      candidate: display != null && (display != 'inline' || spec.isReplaced),
      scrollContainer: [
        'overflow',
        'overflow-x',
        'overflow-y',
      ].any((key) => const {'auto', 'scroll', 'hidden'}.contains(css[key])),
      position: position,
      suppression: {
        for (final key in const [
          'top',
          'right',
          'bottom',
          'left',
          'width',
          'height',
          'min-width',
          'max-width',
          'min-height',
          'max-height',
          'margin-top',
          'margin-right',
          'margin-bottom',
          'margin-left',
          'padding-top',
          'padding-right',
          'padding-bottom',
          'padding-left',
        ])
          key: spec.lengths[key],
        'position': position,
        'transform': css['transform'] ?? 'none',
      },
    );
  }
  return result;
}

/// A document-owned position preserves its scroll activity during compensation.
/// The host publishes layout only after the corrected native frame is painted.
class NativeDocumentScrollController extends ScrollController {
  void correctAnchorOffset(double target) {
    if (positions.length != 1) return;
    final position = this.position;
    if (position is _DocumentAnchorScrollPosition) {
      position.correctAnchorOffset(target);
    }
  }

  @override
  ScrollPosition createScrollPosition(
    ScrollPhysics physics,
    ScrollContext context,
    ScrollPosition? oldPosition,
  ) => _DocumentAnchorScrollPosition(
    physics: physics,
    context: context,
    initialPixels: initialScrollOffset,
    keepScrollOffset: keepScrollOffset,
    oldPosition: oldPosition,
    debugLabel: debugLabel,
  );
}

class _DocumentAnchorScrollPosition extends ScrollPositionWithSingleContext {
  _DocumentAnchorScrollPosition({
    required super.physics,
    required super.context,
    required super.initialPixels,
    required super.keepScrollOffset,
    super.oldPosition,
    super.debugLabel,
  });
  void correctAnchorOffset(double target) {
    final delta = target - pixels;
    if (delta == 0) return;
    forcePixels(target);
    // A ballistic activity restarts from the corrected position at its current
    // velocity; dragging/idle activities retain their normal state.
    activity?.applyNewDimensions();
    didUpdateScrollPositionBy(delta);
  }
}

/// Updated during the document cascade build, before its render objects lay out.
class NativeDocumentScrollAnchorData {
  Map<String, NativeDocumentScrollAnchorNode> nodes = const {};
  bool settled = true;
}

class NativeDocumentScrollAnchorViewport extends SingleChildRenderObjectWidget {
  const NativeDocumentScrollAnchorViewport({
    super.key,
    required this.controller,
    required this.layout,
    required this.data,
    required super.child,
  });
  final NativeDocumentScrollController controller;
  final NativeDocumentLayoutController layout;
  final NativeDocumentScrollAnchorData data;
  @override
  RenderObject createRenderObject(BuildContext context) =>
      RenderNativeDocumentScrollAnchorViewport(controller, layout, data);
  @override
  void updateRenderObject(
    BuildContext context,
    covariant RenderNativeDocumentScrollAnchorViewport renderObject,
  ) {
    renderObject.update(controller, layout, data);
  }
}

class RenderNativeDocumentScrollAnchorViewport extends RenderProxyBox {
  RenderNativeDocumentScrollAnchorViewport(
    this.controller,
    this.measurements,
    this.data,
  );
  NativeDocumentScrollController controller;
  NativeDocumentLayoutController measurements;
  NativeDocumentScrollAnchorData data;
  String? _anchor;
  bool _correcting = false;
  int _layoutEpoch = 0;
  double _pixels = 0;
  Size? _viewport;
  Map<String, NativeDocumentScrollAnchorNode> _previous = const {};
  Map<String, Rect> _previousBoxes = const {};

  void _scrolled() {
    if (_correcting) return;
    data.settled = false;
    markNeedsLayout();
    _anchor = null;
    final viewport = _viewport;
    if (viewport == null || controller.positions.length != 1) return;
    final position = controller.position;
    if (!position.hasPixels) return;
    _pixels = position.pixels;
    // Document-space boxes do not move when the user scrolls. Select against
    // the last completed frame, without measuring a possibly rebuilding tree
    // or walking all native surfaces on every drag/ballistic tick.
    _anchor = _select(
      _previousBoxes,
      _previous,
      Rect.fromLTWH(0, _pixels, viewport.width, viewport.height),
    );
  }

  void _bind() {
    controller.addListener(_scrolled);
  }

  void _unbind() {
    controller.removeListener(_scrolled);
    _anchor = null;
    _previous = const {};
    _previousBoxes = const {};
    _viewport = null;
  }

  void update(
    NativeDocumentScrollController c,
    NativeDocumentLayoutController l,
    NativeDocumentScrollAnchorData d,
  ) {
    if (!identical(c, controller) ||
        !identical(l, measurements) ||
        !identical(d, data)) {
      if (attached) _unbind();
      controller = c;
      measurements = l;
      data = d;
      if (attached) _bind();
    }
    markNeedsLayout();
  }

  @override
  void attach(PipelineOwner owner) {
    super.attach(owner);
    _bind();
  }

  @override
  void detach() {
    _unbind();
    super.detach();
  }

  @override
  void performLayout() {
    super.performLayout();
    final epoch = ++_layoutEpoch;
    data.settled = false;
    SchedulerBinding.instance.addPostFrameCallback((_) {
      if (!attached ||
          epoch != _layoutEpoch ||
          controller.positions.length != 1) {
        return;
      }
      if (data.nodes.isEmpty) {
        _anchor = null;
        _previous = const {};
        _previousBoxes = const {};
        data.settled = true;
        return;
      }
      final position = controller.position;
      if (!position.hasContentDimensions) return;
      final target = adjust(
        position,
        position.minScrollExtent,
        position.maxScrollExtent,
      );
      if (target == null) return;
      if (target != position.pixels) {
        _correcting = true;
        try {
          controller.correctAnchorOffset(target);
        } finally {
          _correcting = false;
        }
        // The following frame paints the corrected offset. Layout publication
        // must wait for it rather than acknowledging a not-yet-painted view.
        markNeedsLayout();
      } else {
        data.settled = true;
      }
    });
  }

  bool _suppressed(
    String id,
    Map<String, NativeDocumentScrollAnchorNode> nodes,
  ) {
    for (final entry in nodes.entries) {
      final old = _previous[entry.key];
      if (old != null &&
          (old.position == 'absolute') !=
              (entry.value.position == 'absolute')) {
        return true;
      }
    }
    String? current = id;
    final seen = <String>{};
    while (current != null && seen.add(current)) {
      final old = _previous[current], now = nodes[current];
      if (old == null ||
          now == null ||
          now.excluded ||
          old.parent != now.parent) {
        return true;
      }
      for (final entry in old.suppression.entries) {
        if (now.suppression[entry.key] != entry.value) return true;
      }
      current = now.parent;
    }
    return false;
  }

  String? _select(
    Map<String, Rect> boxes,
    Map<String, NativeDocumentScrollAnchorNode> nodes,
    Rect region,
  ) {
    final children = <String?, List<String>>{};
    for (final n in nodes.values) {
      (children[n.parent] ??= []).add(n.id);
    }
    final visited = <String>{};
    String? examine(String id) {
      if (!visited.add(id)) return null;
      final node = nodes[id]!;
      if (node.excluded) return null;
      final box = boxes[id];
      // Unmeasured inline containers still permit measured descendants. A node
      // with display:none is excluded above and cannot expose its descendants.
      if (box == null) {
        for (final child in children[id] ?? const <String>[]) {
          final found = examine(child);
          if (found != null) return found;
        }
        return null;
      }
      if (box.isEmpty || !box.overlaps(region)) return null;
      if (node.candidate &&
          (region.contains(box.topLeft) &&
              box.right <= region.right &&
              box.bottom <= region.bottom)) {
        return id;
      }
      if (!node.scrollContainer) {
        for (final child in children[id] ?? const <String>[]) {
          final found = examine(child);
          if (found != null) return found;
        }
      }
      return node.candidate ? id : null;
    }

    for (final id in children[null] ?? const <String>[]) {
      final found = examine(id);
      if (found != null) return found;
    }
    return null;
  }

  double? adjust(ScrollPosition position, double min, double max) {
    if (!attached ||
        !position.hasPixels ||
        !position.hasViewportDimension ||
        position.axisDirection != AxisDirection.down) {
      return null;
    }
    final width = constraints.maxWidth, height = position.viewportDimension;
    if (!width.isFinite || !height.isFinite || width <= 0 || height <= 0) {
      return null;
    }
    final nodes = data.nodes;
    final boxes = measurements.scrollAnchorBoxes({
      for (final node in nodes.values)
        if (!node.excluded) node.id,
    });
    if (boxes == null) {
      return null; // Provisional layout must not discard the anchor.
    }
    final viewport = Size(width, height);
    var target = position.pixels;
    var old = _viewport == viewport ? _anchor : null;
    if (old != null &&
        (!boxes.containsKey(old) || nodes[old]?.excluded != false)) {
      // A removed anchor is replaced before layout in the browser: surviving
      // nodes still have their last frame's positions. Selecting from the new
      // positions would anchor the wrong replacement (especially near an edge).
      old = _select(
        _previousBoxes,
        nodes,
        Rect.fromLTWH(0, _pixels, width, height),
      );
    }
    if (old != null &&
        _pixels > min &&
        boxes.containsKey(old) &&
        _previousBoxes.containsKey(old) &&
        !_suppressed(old, nodes)) {
      final delta = boxes[old]!.top - _previousBoxes[old]!.top;
      if (delta.isFinite) target = (_pixels + delta).clamp(min, max);
    }
    _anchor =
        old != null && boxes.containsKey(old) && nodes[old]?.excluded == false
        ? old
        : _select(boxes, nodes, Rect.fromLTWH(0, target, width, height));
    _previousBoxes = boxes;
    _pixels = target;
    _viewport = viewport;
    _previous = nodes;
    return target;
  }
}
