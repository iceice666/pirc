import 'dart:math' as math;
import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

/// The document root can reach visible positioned paint outside flow ancestors.
abstract interface class NativeDocumentPositionedHitTarget {
  bool hitTestPositioned(BoxHitTestResult result, {required Offset position});
}

/// A live containing-block basis, published only during actual native layout.
abstract interface class NativeDocumentPositioningBasis {
  double? get positioningWidth;
  double? get positioningHeight;
  bool get positioningActive;
}

class NativeAbsoluteLength {
  const NativeAbsoluteLength(this.value, [this.percent = false]);
  final double value;
  final bool percent;
  double resolve(double basis) => percent ? value * basis / 100 : value;
  static NativeAbsoluteLength? parse(String? text, double font, Size viewport) {
    final match = RegExp(
      r'^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(px|%|em|pt|vw|vh|vmin|vmax)?$',
    ).firstMatch(text?.trim().toLowerCase() ?? '');
    if (match == null) return null;
    final n = double.parse(match[1]!);
    if (!n.isFinite || (match[2] == null && n != 0)) return null;
    return switch (match[2]) {
      '%' => NativeAbsoluteLength(n, true),
      'em' => NativeAbsoluteLength(n * font),
      'pt' => NativeAbsoluteLength(n * 96 / 72),
      'vw' => NativeAbsoluteLength(n * viewport.width / 100),
      'vh' => NativeAbsoluteLength(n * viewport.height / 100),
      'vmin' => NativeAbsoluteLength(
        n * math.min(viewport.width, viewport.height) / 100,
      ),
      'vmax' => NativeAbsoluteLength(
        n * math.max(viewport.width, viewport.height) / 100,
      ),
      _ => NativeAbsoluteLength(n),
    };
  }
}

/// Physical positioned axes. Both-auto static-position axes need flow markers
/// and are deliberately not accepted by this first native positioning surface.
class NativeAbsolutePositionSpec {
  NativeAbsolutePositionSpec._(this.styles, this.lengths, this.direction);
  final Map<String, String> styles;
  final Map<String, NativeAbsoluteLength?> lengths;
  final TextDirection direction;
  static NativeAbsolutePositionSpec? parse(
    Map<String, String> styles, {
    required double fontSize,
    required Size viewport,
    TextDirection direction = TextDirection.ltr,
  }) {
    if (styles['position']?.trim().toLowerCase() != 'absolute') return null;
    final values = <String, String>{...styles};
    final shorthand = values['inset']?.trim().split(RegExp(r'\s+'));
    if (shorthand != null) {
      if (shorthand.isEmpty || shorthand.length > 4) return null;
      final t = shorthand[0],
          r = shorthand.length > 1 ? shorthand[1] : t,
          b = shorthand.length > 2 ? shorthand[2] : t,
          l = shorthand.length > 3 ? shorthand[3] : r;
      for (final pair in [
        ('top', t),
        ('right', r),
        ('bottom', b),
        ('left', l),
      ]) {
        values.putIfAbsent(pair.$1, () => pair.$2);
      }
    }
    final lengths = <String, NativeAbsoluteLength?>{};
    for (final name in [
      'left',
      'right',
      'top',
      'bottom',
      'width',
      'height',
      'min-width',
      'max-width',
      'min-height',
      'max-height',
      for (final side in ['left', 'right', 'top', 'bottom']) ...[
        'margin-$side',
        'padding-$side',
        'border-$side-width',
      ],
    ]) {
      final raw = values[name]?.trim().toLowerCase();
      if (raw == null && name.startsWith('margin-')) {
        lengths[name] = const NativeAbsoluteLength(0);
        continue;
      }
      if (raw == null ||
          raw == 'auto' ||
          (raw == 'none' && name.startsWith('max-'))) {
        lengths[name] = null;
        continue;
      }
      final length = NativeAbsoluteLength.parse(raw, fontSize, viewport);
      if (length == null) return null;
      if (!name.startsWith('margin-') &&
          !['left', 'right', 'top', 'bottom'].contains(name) &&
          length.value < 0) {
        return null;
      }
      lengths[name] = length;
    }
    if (lengths['left'] == null && lengths['right'] == null ||
        lengths['top'] == null && lengths['bottom'] == null) {
      return null;
    }
    for (final name in [
      'inset-inline',
      'inset-block',
      'inset-inline-start',
      'inset-inline-end',
      'inset-block-start',
      'inset-block-end',
    ]) {
      if (values.containsKey(name) &&
          values[name] != 'auto' &&
          NativeAbsoluteLength.parse(values[name], fontSize, viewport)?.value !=
              0) {
        return null;
      }
    }
    if (int.tryParse(values['z-index'] ?? '0') case final int z when z < 0) {
      return null;
    }
    return NativeAbsolutePositionSpec._(values, lengths, direction);
  }

  double? value(String name, double basis) => lengths[name]?.resolve(basis);
  double edge(String side, double width) {
    final padding = value('padding-$side', width) ?? 0;
    final border =
        const {
          'none',
          'hidden',
        }.contains(styles['border-$side-style'] ?? 'none')
        ? 0
        : value('border-$side-width', width) ?? 3;
    return padding + border;
  }

  double outer(String axis, double value, double basis) =>
      styles['box-sizing'] == 'border-box'
      ? value
      : value +
            (axis == 'width'
                ? edge('left', basis) + edge('right', basis)
                : edge('top', basis) + edge('bottom', basis));
  double clamp(String axis, double target, Size basis) {
    final size = axis == 'width' ? basis.width : basis.height;
    final edges = axis == 'width'
        ? edge('left', basis.width) + edge('right', basis.width)
        : edge('top', basis.width) + edge('bottom', basis.width);
    final low = math.max(
      edges,
      outer(axis, value('min-$axis', size) ?? 0, basis.width),
    );
    final rawMax = value('max-$axis', size);
    final high = rawMax == null
        ? double.infinity
        : math.max(low, outer(axis, rawMax, basis.width));
    return target.clamp(low, high).toDouble();
  }

  double? authored(String axis, Size basis) {
    final raw = value(axis, axis == 'width' ? basis.width : basis.height);
    return raw == null
        ? null
        : clamp(axis, outer(axis, raw, basis.width), basis);
  }

  double available(String axis, Size basis) {
    final horizontal = axis == 'width',
        size = horizontal ? basis.width : basis.height;
    final start = horizontal ? 'left' : 'top',
        end = horizontal ? 'right' : 'bottom';
    return math.max(
      0,
      size -
          (value(start, size) ?? 0) -
          (value(end, size) ?? 0) -
          (value('margin-$start', basis.width) ?? 0) -
          (value('margin-$end', basis.width) ?? 0),
    );
  }

  bool stretch(String axis) =>
      lengths[axis] == null &&
      lengths[axis == 'width' ? 'left' : 'top'] != null &&
      lengths[axis == 'width' ? 'right' : 'bottom'] != null;
  double offset(String axis, double extent, Size basis) {
    final horizontal = axis == 'width',
        size = horizontal ? basis.width : basis.height;
    final a = horizontal ? 'left' : 'top', b = horizontal ? 'right' : 'bottom';
    final start = value(a, size), end = value(b, size);
    var first = value('margin-$a', basis.width),
        last = value('margin-$b', basis.width);
    if (start != null && end != null) {
      final free = size - start - end - extent - (first ?? 0) - (last ?? 0);
      if (first == null && last == null) {
        first = horizontal && free < 0
            ? (direction == TextDirection.ltr ? 0 : free)
            : free / 2;
        last = free - first;
      } else if (first == null) {
        first = free;
      } else {
        last ??= free;
      }
    }
    if (start != null &&
        !(horizontal && end != null && direction == TextDirection.rtl)) {
      return start + (first ?? 0);
    }
    return size - (end ?? 0) - (last ?? 0) - extent;
  }

  int get zIndex => int.tryParse(styles['z-index'] ?? '0') ?? 0;
}

class NativeAbsoluteEntry {
  const NativeAbsoluteEntry({required this.spec, required this.child});
  final NativeAbsolutePositionSpec spec;
  final Widget child;
}

class NativeDocumentAbsoluteLayer extends MultiChildRenderObjectWidget {
  NativeDocumentAbsoluteLayer({
    super.key,
    required Widget flow,
    required List<NativeAbsoluteEntry> positioned,
    this.border = EdgeInsets.zero,
    this.initialContainingBlock,
    this.boxSurface,
  }) : super(
         children: [
           flow,
           for (final item in positioned)
             _AbsoluteItem(spec: item.spec, child: item.child),
         ],
       );
  final EdgeInsets border;
  final Size? initialContainingBlock;
  final ({RenderBox surface, Size size})? Function(RenderBox)? boxSurface;
  @override
  RenderObject createRenderObject(BuildContext context) =>
      _RenderAbsoluteLayer(border, initialContainingBlock, boxSurface);
  @override
  void updateRenderObject(
    BuildContext context,
    covariant RenderObject renderObject,
  ) {
    (renderObject as _RenderAbsoluteLayer)
      ..border = border
      ..initialContainingBlock = initialContainingBlock
      ..boxSurface = boxSurface
      ..markNeedsLayout();
  }
}

class _AbsoluteItem extends SingleChildRenderObjectWidget {
  const _AbsoluteItem({required this.spec, required super.child});
  final NativeAbsolutePositionSpec spec;
  @override
  RenderObject createRenderObject(BuildContext context) =>
      _RenderAbsoluteItem(spec);
  @override
  void updateRenderObject(
    BuildContext context,
    covariant _RenderAbsoluteItem renderObject,
  ) {
    renderObject
      ..spec = spec
      ..markNeedsLayout();
  }
}

class _RenderAbsoluteItem extends RenderProxyBox
    implements NativeDocumentPositioningBasis {
  _RenderAbsoluteItem(this.spec);
  NativeAbsolutePositionSpec spec;
  Size basis = Size.zero;
  void updateBasis(Size next) {
    if (basis == next) return;
    basis = next;
    void invalidate(RenderObject node) {
      node.markNeedsLayout();
      node.visitChildren(invalidate);
    }

    invalidate(this);
  }

  bool _active = false;
  @override
  double? get positioningWidth => basis.width;
  @override
  double? get positioningHeight => basis.height;
  @override
  bool get positioningActive => _active;
  @override
  void performLayout() {
    _active = true;
    try {
      super.performLayout();
    } finally {
      _active = false;
    }
  }
}

class _AbsoluteParentData extends ContainerBoxParentData<RenderBox> {}

class _RenderAbsoluteLayer extends RenderBox
    with
        ContainerRenderObjectMixin<RenderBox, _AbsoluteParentData>,
        RenderBoxContainerDefaultsMixin<RenderBox, _AbsoluteParentData>
    implements NativeDocumentPositionedHitTarget {
  _RenderAbsoluteLayer(
    this.border,
    this.initialContainingBlock,
    this.boxSurface,
  );
  EdgeInsets border;
  Size? initialContainingBlock;
  ({RenderBox surface, Size size})? Function(RenderBox)? boxSurface;
  @override
  void setupParentData(RenderBox child) {
    if (child.parentData is! _AbsoluteParentData) {
      child.parentData = _AbsoluteParentData();
    }
  }

  @override
  void performLayout() {
    final flow = firstChild!;
    flow.layout(constraints, parentUsesSize: true);
    size = constraints.constrain(flow.size);
    (flow.parentData! as _AbsoluteParentData).offset = Offset.zero;
    final published = boxSurface?.call(flow);
    final surface = published?.surface ?? flow;
    final surfaceSize = published?.size ?? flow.size;
    final origin = MatrixUtils.transformPoint(
      surface.getTransformTo(this),
      Offset.zero,
    );
    final basis =
        initialContainingBlock ??
        Size(
          math.max(0, surfaceSize.width - border.horizontal),
          math.max(0, surfaceSize.height - border.vertical),
        );
    RenderBox? item = childAfter(flow);
    while (item != null) {
      final current = item as _RenderAbsoluteItem, spec = current.spec;
      if (current.basis != basis) {
        invokeLayoutCallback<BoxConstraints>((_) => current.updateBasis(basis));
      }
      final width =
          spec.authored('width', basis) ??
          (spec.stretch('width')
              ? spec.clamp('width', spec.available('width', basis), basis)
              : null);
      final height =
          spec.authored('height', basis) ??
          (spec.stretch('height')
              ? spec.clamp('height', spec.available('height', basis), basis)
              : null);
      double usedWidth;
      if (width != null) {
        usedWidth = width;
      } else {
        current._active = true;
        try {
          final preferred = current.getMaxIntrinsicWidth(double.infinity),
              minimum = current.getMinIntrinsicWidth(double.infinity);
          usedWidth = spec.clamp(
            'width',
            math.min(
              math.max(minimum, spec.available('width', basis)),
              preferred,
            ),
            basis,
          );
        } finally {
          current._active = false;
        }
      }
      current.layout(
        BoxConstraints(
          minWidth: usedWidth,
          maxWidth: usedWidth,
          minHeight: height ?? 0,
          maxHeight: height ?? double.infinity,
        ),
        parentUsesSize: true,
      );
      if (height == null) {
        final clamped = spec.clamp('height', current.size.height, basis);
        if (clamped != current.size.height) {
          current.layout(
            BoxConstraints.tight(Size(usedWidth, clamped)),
            parentUsesSize: true,
          );
        }
      }
      (current.parentData! as _AbsoluteParentData).offset = Offset(
        origin.dx +
            border.left +
            spec.offset('width', current.size.width, basis),
        origin.dy +
            border.top +
            spec.offset('height', current.size.height, basis),
      );
      item = childAfter(item);
    }
  }

  List<RenderBox> get _paintOrder {
    final items = <RenderBox>[];
    RenderBox? child = childAfter(firstChild!);
    while (child != null) {
      items.add(child);
      child = childAfter(child);
    }
    final order = {for (var i = 0; i < items.length; i++) items[i]: i};
    items.sort((a, b) {
      final z = (a as _RenderAbsoluteItem).spec.zIndex.compareTo(
        (b as _RenderAbsoluteItem).spec.zIndex,
      );
      return z == 0 ? order[a]!.compareTo(order[b]!) : z;
    });
    return [firstChild!, ...items];
  }

  @override
  void paint(PaintingContext context, Offset offset) {
    for (final child in _paintOrder) {
      context.paintChild(
        child,
        offset + (child.parentData! as _AbsoluteParentData).offset,
      );
    }
  }

  @override
  bool hitTest(BoxHitTestResult result, {required Offset position}) =>
      hitTestChildren(result, position: position);
  @override
  bool hitTestChildren(BoxHitTestResult result, {required Offset position}) {
    for (final child in _paintOrder.reversed) {
      final offset = (child.parentData! as _AbsoluteParentData).offset;
      if (result.addWithPaintOffset(
        offset: offset,
        position: position,
        hitTest: (result, p) => child.hitTest(result, position: p),
      )) {
        return true;
      }
    }
    return false;
  }

  @override
  void applyPaintTransform(RenderBox child, Matrix4 transform) {
    final offset = (child.parentData! as _AbsoluteParentData).offset;
    transform.translateByDouble(offset.dx, offset.dy, 0, 1);
  }

  @override
  bool hitTestPositioned(BoxHitTestResult result, {required Offset position}) {
    for (final child in _paintOrder.skip(1).toList().reversed) {
      if (result.addWithPaintOffset(
        offset: (child.parentData! as _AbsoluteParentData).offset,
        position: position,
        hitTest: (result, p) => child.hitTest(result, position: p),
      )) {
        return true;
      }
    }
    return false;
  }

  @override
  Rect get paintBounds {
    if (!hasSize) return Rect.zero;
    var bounds = Offset.zero & size;
    for (final child in _paintOrder) {
      if (child.hasSize) {
        bounds = bounds.expandToInclude(
          child.paintBounds.shift(
            (child.parentData! as _AbsoluteParentData).offset,
          ),
        );
      }
    }
    return bounds;
  }

  @override
  double? computeDistanceToActualBaseline(TextBaseline baseline) =>
      firstChild?.getDistanceToActualBaseline(baseline);
  @override
  double? computeDryBaseline(
    BoxConstraints constraints,
    TextBaseline baseline,
  ) => firstChild?.getDryBaseline(constraints, baseline);

  @override
  Size computeDryLayout(BoxConstraints constraints) =>
      constraints.constrain(firstChild!.getDryLayout(constraints));
  @override
  double computeMinIntrinsicWidth(double height) =>
      firstChild?.getMinIntrinsicWidth(height) ?? 0;
  @override
  double computeMaxIntrinsicWidth(double height) =>
      firstChild?.getMaxIntrinsicWidth(height) ?? 0;
  @override
  double computeMinIntrinsicHeight(double width) =>
      firstChild?.getMinIntrinsicHeight(width) ?? 0;
  @override
  double computeMaxIntrinsicHeight(double width) =>
      firstChild?.getMaxIntrinsicHeight(width) ?? 0;
}
