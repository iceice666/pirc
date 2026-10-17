import 'dart:math' as math;

import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

import 'html_document_flex.dart';

class _DocumentContainingBlock {
  const _DocumentContainingBlock({
    required this.width,
    required this.height,
    required this.isActive,
  });

  final double? width;
  final double? height;
  final bool isActive;
}

_DocumentContainingBlock? _findDocumentContainingBlock(RenderObject? ancestor) {
  while (ancestor != null) {
    if (ancestor is _RenderDocumentBox) {
      return _DocumentContainingBlock(
        width: ancestor.contentWidth,
        height: ancestor.contentHeight,
        isActive: ancestor._hasActiveContext,
      );
    }
    if (ancestor is _RenderNativeDocumentContainingBlock) {
      return _DocumentContainingBlock(
        width: ancestor.contentWidth,
        height: ancestor.contentHeight,
        isActive: ancestor._hasActiveContext,
      );
    }
    ancestor = ancestor.parent;
  }
  return null;
}

void _markLayoutSubtree(RenderObject node) {
  if (node is RenderBox) node.markNeedsLayout();
  node.visitChildren(_markLayoutSubtree);
}

/// CSS dimensions for an ordinary block box.
///
/// [horizontalEdges] and [verticalEdges] are the element's fixed padding and
/// border widths. Percentage padding is represented separately because CSS
/// resolves every padding side against the containing block's content width.
/// If [lengthsAreContentBox] is true, explicit width, height, min, and max
/// lengths describe the content box and the corresponding edges are added
/// exactly once. Otherwise, lengths already describe the outer border box.
///
/// With [applySizing] false, this render object leaves child constraints alone
/// and publishes the sizing context used by descendants.
class NativeDocumentBox extends SingleChildRenderObjectWidget {
  const NativeDocumentBox({
    super.key,
    required super.child,
    this.width,
    this.height,
    this.minWidth,
    this.maxWidth,
    this.minHeight,
    this.maxHeight,
    this.applySizing = true,
    this.fillWidth = true,
    this.tightAllocationIsAuthoritative = false,
    this.lengthsAreContentBox = false,
    this.horizontalEdges = 0,
    this.verticalEdges = 0,
    this.percentagePadding = EdgeInsets.zero,
    this.geometryOwner,
  });

  final NativeFlexLength? width;
  final NativeFlexLength? height;
  final NativeFlexLength? minWidth;
  final NativeFlexLength? maxWidth;
  final NativeFlexLength? minHeight;
  final NativeFlexLength? maxHeight;
  final double horizontalEdges;
  final double verticalEdges;
  final bool fillWidth;
  final bool applySizing;
  final bool tightAllocationIsAuthoritative;
  final bool lengthsAreContentBox;

  /// Fractional percentage padding, where `0.1` represents `10%`.
  ///
  /// The [NativeDocumentPercentagePadding] child performs the physical inset;
  /// this value lets this box include those insets in content-box conversion
  /// and in the containing-block content dimensions without adding them twice
  /// to the child layout.
  final EdgeInsets percentagePadding;

  /// Optional identity used by the geometry collector to select this
  /// element's own sizing surface through nested native boxes.
  final Object? geometryOwner;

  @override
  RenderObject createRenderObject(BuildContext context) =>
      _RenderDocumentBox(this);

  @override
  void updateRenderObject(
    BuildContext context,
    covariant RenderObject renderObject,
  ) {
    (renderObject as _RenderDocumentBox).update(this);
  }
}

/// Establishes a definite viewport or grid-area basis for percentage children.
///
/// Full documents supply their viewport explicitly. Grid items can instead use
/// the finite maximum constraints supplied by their placement. This publishes
/// the containing block without sizing the child; ordinary NativeDocumentBox
/// auto heights remain indefinite.
class NativeDocumentContainingBlock extends SingleChildRenderObjectWidget {
  const NativeDocumentContainingBlock({
    super.key,
    required super.child,
    this.width,
    this.height,
  });

  final double? width;
  final double? height;

  @override
  RenderObject createRenderObject(BuildContext context) =>
      _RenderNativeDocumentContainingBlock(width, height);

  @override
  void updateRenderObject(
    BuildContext context,
    covariant RenderObject renderObject,
  ) {
    (renderObject as _RenderNativeDocumentContainingBlock).update(
      width,
      height,
    );
  }
}

class _RenderNativeDocumentContainingBlock extends RenderProxyBox {
  _RenderNativeDocumentContainingBlock(this.explicitWidth, this.explicitHeight);

  double? explicitWidth;
  double? explicitHeight;
  double? contentWidth;
  double? contentHeight;
  bool _layoutContextActive = false;
  int _dryContextDepth = 0;

  bool get _hasActiveContext => _layoutContextActive || _dryContextDepth > 0;

  void update(double? width, double? height) {
    if (explicitWidth == width && explicitHeight == height) return;
    explicitWidth = width;
    explicitHeight = height;
    markNeedsLayout();
  }

  double? _widthFor(BoxConstraints constraints) =>
      explicitWidth ??
      (constraints.maxWidth.isFinite ? constraints.maxWidth : null);

  double? _heightFor(BoxConstraints constraints) =>
      explicitHeight ??
      (constraints.maxHeight.isFinite ? constraints.maxHeight : null);

  void _setContext(double? width, double? height) {
    final changed = contentWidth != width || contentHeight != height;
    contentWidth = width;
    contentHeight = height;
    if (changed && (child?.hasSize ?? false)) {
      invokeLayoutCallback<BoxConstraints>((_) => _markLayoutSubtree(child!));
    }
  }

  @override
  void performLayout() {
    _setContext(_widthFor(constraints), _heightFor(constraints));
    _layoutContextActive = true;
    try {
      if (child == null) {
        size = constraints.smallest;
      } else {
        child!.layout(constraints, parentUsesSize: true);
        size = constraints.constrain(child!.size);
      }
    } finally {
      _layoutContextActive = false;
    }
  }

  @override
  Size computeDryLayout(BoxConstraints constraints) {
    final oldWidth = contentWidth;
    final oldHeight = contentHeight;
    contentWidth = _widthFor(constraints);
    contentHeight = _heightFor(constraints);
    _dryContextDepth++;
    try {
      return constraints.constrain(
        child?.getDryLayout(constraints) ?? Size.zero,
      );
    } finally {
      _dryContextDepth--;
      contentWidth = oldWidth;
      contentHeight = oldHeight;
    }
  }

  @override
  double? computeDryBaseline(
    BoxConstraints constraints,
    TextBaseline baseline,
  ) {
    final oldWidth = contentWidth;
    final oldHeight = contentHeight;
    contentWidth = _widthFor(constraints);
    contentHeight = _heightFor(constraints);
    _dryContextDepth++;
    try {
      return child?.getDryBaseline(constraints, baseline);
    } finally {
      _dryContextDepth--;
      contentWidth = oldWidth;
      contentHeight = oldHeight;
    }
  }

  @override
  double computeMinIntrinsicWidth(double height) =>
      child?.getMinIntrinsicWidth(height) ?? 0;

  @override
  double computeMaxIntrinsicWidth(double height) =>
      child?.getMaxIntrinsicWidth(height) ?? 0;

  @override
  double computeMinIntrinsicHeight(double width) =>
      child?.getMinIntrinsicHeight(width) ?? 0;

  @override
  double computeMaxIntrinsicHeight(double width) =>
      child?.getMaxIntrinsicHeight(width) ?? 0;
}

class _RenderDocumentBox extends RenderProxyBox {
  _RenderDocumentBox(this.spec);

  NativeDocumentBox spec;

  /// The content dimensions this box publishes to its descendants.
  double? contentWidth;
  double? contentHeight;

  /// The dimensions of this box's own containing block. Percentage padding
  /// uses its containing block's width on all four sides.
  double? containingBlockWidth;
  double? containingBlockHeight;

  bool _layoutContextActive = false;
  int _dryContextDepth = 0;

  void update(NativeDocumentBox next) {
    spec = next;
    markNeedsLayout();
  }

  _DocumentContainingBlock? get _ancestorContainingBlock =>
      _findDocumentContainingBlock(parent);

  bool get _hasActiveContext => _layoutContextActive || _dryContextDepth > 0;

  double? _percentWidthForDescendants(BoxConstraints constraints) {
    final ancestor = _ancestorContainingBlock;
    if (ancestor != null) {
      return ancestor.width;
    }
    if (constraints.hasTightWidth) return constraints.maxWidth;
    return constraints.maxWidth.isFinite ? constraints.maxWidth : null;
  }

  double? _percentHeightForDescendants(BoxConstraints constraints) {
    final ancestor = _ancestorContainingBlock;
    if (ancestor != null) {
      return ancestor.height;
    }
    // A finite max-height is only a limit. It does not make the root's auto
    // height definite for CSS percentage-height descendants.
    return constraints.hasTightHeight ? constraints.maxHeight : null;
  }

  double? _dryContainingBlockWidth(BoxConstraints constraints) {
    final ancestor = _ancestorContainingBlock;
    if (ancestor != null) {
      return ancestor.isActive ? ancestor.width : null;
    }
    if (constraints.hasTightWidth) return constraints.maxWidth;
    return constraints.maxWidth.isFinite ? constraints.maxWidth : null;
  }

  double? _dryContainingBlockHeight(BoxConstraints constraints) {
    final ancestor = _ancestorContainingBlock;
    if (ancestor != null) {
      return ancestor.isActive ? ancestor.height : null;
    }
    return constraints.hasTightHeight ? constraints.maxHeight : null;
  }

  EdgeInsets _resolvedPercentagePadding(double? containingWidth) {
    if (containingWidth == null ||
        !containingWidth.isFinite ||
        containingWidth < 0) {
      return EdgeInsets.zero;
    }
    double side(double fraction) =>
        fraction.isFinite ? math.max(0.0, fraction * containingWidth) : 0;
    return EdgeInsets.fromLTRB(
      side(spec.percentagePadding.left),
      side(spec.percentagePadding.top),
      side(spec.percentagePadding.right),
      side(spec.percentagePadding.bottom),
    );
  }

  double _horizontalEdges(double? containingWidth) =>
      math.max(0.0, spec.horizontalEdges) +
      _resolvedPercentagePadding(containingWidth).horizontal;

  double _verticalEdges(double? containingWidth) =>
      math.max(0.0, spec.verticalEdges) +
      _resolvedPercentagePadding(containingWidth).vertical;

  double? _resolve(NativeFlexLength? value, double? extent) =>
      value?.resolve(extent != null && extent.isFinite ? extent : null);

  double? _outerLength(NativeFlexLength? value, double? basis, double edges) {
    final resolved = _resolve(value, basis);
    if (resolved == null || !spec.lengthsAreContentBox) return resolved;
    return resolved + edges;
  }

  (double, double) _axis({
    required double incomingMin,
    required double incomingMax,
    required NativeFlexLength? preferred,
    required NativeFlexLength? minimum,
    required NativeFlexLength? maximum,
    required double? percentageBasis,
    required double edges,
    required bool fill,
    bool tightAllocationIsAuthoritative = true,
  }) {
    // Flex/grid parents already provide the authoritative border-box size.
    if (tightAllocationIsAuthoritative && incomingMin == incomingMax) {
      return (incomingMin, incomingMax);
    }

    final lower = math.max(
      edges,
      _outerLength(minimum, percentageBasis, edges) ?? 0,
    );
    final upper = math.max(
      lower,
      _outerLength(maximum, percentageBasis, edges) ?? double.infinity,
    );
    final authored = _outerLength(preferred, percentageBasis, edges);
    final target =
        authored ?? (fill && incomingMax.isFinite ? incomingMax : null);
    if (target != null) {
      // Explicit CSS sizes may overflow the available parent width after
      // padding and borders. Keep the child at its authored size; the parent
      // proxy can clip its own size while measurement selects the decorated
      // child surface.
      final used = target.clamp(lower, upper).toDouble();
      return (used, used);
    }
    final min = math.max(incomingMin, lower);
    return (min, math.max(min, math.min(incomingMax, upper)));
  }

  BoxConstraints _inner(
    BoxConstraints constraints, {
    required double? containingWidth,
    required double? containingHeight,
  }) {
    NativeFlexLength? width = spec.width;
    if (!spec.fillWidth &&
        width == null &&
        !constraints.hasTightWidth &&
        child != null) {
      // A flex item's automatic cross size is shrink-to-fit. Core's inner
      // block sizing can otherwise fill the entire loose width before its
      // decoration is measured, even when the parent requests flex-start.
      final minimum = child!.getMinIntrinsicWidth(double.infinity);
      final preferred = child!.getMaxIntrinsicWidth(double.infinity);
      final available = constraints.maxWidth;
      final fit = math.min(math.max(minimum, available), preferred);
      if (fit.isFinite) width = NativeFlexLength.pixels(fit);
    }
    final horizontalEdges = _horizontalEdges(containingWidth);
    final verticalEdges = _verticalEdges(containingWidth);
    final w = _axis(
      incomingMin: constraints.minWidth,
      incomingMax: constraints.maxWidth,
      preferred: width,
      minimum: spec.minWidth,
      maximum: spec.maxWidth,
      percentageBasis: containingWidth,
      edges: horizontalEdges,
      fill: spec.fillWidth,
    );
    final h = _axis(
      incomingMin:
          constraints.hasTightHeight &&
              !spec.tightAllocationIsAuthoritative &&
              _outerLength(spec.height, containingHeight, verticalEdges) == null
          ? 0.0
          : constraints.minHeight,
      incomingMax: constraints.maxHeight,
      preferred: spec.height,
      minimum: spec.minHeight,
      maximum: spec.maxHeight,
      percentageBasis: containingHeight,
      edges: verticalEdges,
      fill: false,
      tightAllocationIsAuthoritative: spec.tightAllocationIsAuthoritative,
    );
    return BoxConstraints(
      minWidth: w.$1,
      maxWidth: w.$2,
      minHeight: h.$1,
      maxHeight: h.$2,
    );
  }

  ({double? width, double? height}) _publishedContentSize(
    BoxConstraints constraints,
    BoxConstraints childConstraints, {
    required double? containingWidth,
    required double? containingHeight,
  }) {
    final edgesWidth = _horizontalEdges(containingWidth);
    final edgesHeight = _verticalEdges(containingWidth);

    double? publishedWidth;
    if (constraints.hasTightWidth) {
      publishedWidth = constraints.maxWidth;
    } else {
      final authored = _outerLength(spec.width, containingWidth, edgesWidth);
      if (authored != null) {
        publishedWidth = authored;
      } else if (!spec.applySizing) {
        // Intrinsic-only wrappers leave the existing child width alone but
        // still describe the available block containing width to descendants.
        if (constraints.maxWidth.isFinite) {
          publishedWidth = constraints.maxWidth;
        }
      } else if (childConstraints.hasTightWidth) {
        publishedWidth = childConstraints.maxWidth;
      } else if (spec.fillWidth && constraints.maxWidth.isFinite) {
        publishedWidth = childConstraints.maxWidth;
      }
    }

    double? publishedHeight;
    if (constraints.hasTightHeight && spec.tightAllocationIsAuthoritative) {
      publishedHeight = constraints.maxHeight;
    } else {
      final authored = _outerLength(spec.height, containingHeight, edgesHeight);
      if (authored != null) {
        publishedHeight = authored;
      } else if (spec.tightAllocationIsAuthoritative &&
          childConstraints.hasTightHeight) {
        publishedHeight = childConstraints.maxHeight;
      }
    }

    return (
      width: publishedWidth == null
          ? null
          : math.max(0.0, publishedWidth - edgesWidth),
      height: publishedHeight == null
          ? null
          : math.max(0.0, publishedHeight - edgesHeight),
    );
  }

  bool _setContext({
    required double? nextContainingWidth,
    required double? nextContainingHeight,
    required double? nextContentWidth,
    required double? nextContentHeight,
  }) {
    final changed =
        containingBlockWidth != nextContainingWidth ||
        containingBlockHeight != nextContainingHeight ||
        contentWidth != nextContentWidth ||
        contentHeight != nextContentHeight;
    containingBlockWidth = nextContainingWidth;
    containingBlockHeight = nextContainingHeight;
    contentWidth = nextContentWidth;
    contentHeight = nextContentHeight;
    return changed;
  }

  void _invalidateChildLayout() {
    final current = child;
    if (current == null) return;
    // Intermediate proxies can otherwise skip layout when their constraints
    // are unchanged, hiding a changed percentage basis from descendants.
    void invalidate(RenderObject node) {
      if (node is RenderBox) node.markNeedsLayout();
      node.visitChildren(invalidate);
    }

    invalidate(current);
  }

  void _withDryContext<T>(
    BoxConstraints constraints,
    BoxConstraints childConstraints,
    double? containingWidth,
    double? containingHeight,
    T Function() callback,
  ) {
    final oldContainingWidth = containingBlockWidth;
    final oldContainingHeight = containingBlockHeight;
    final oldContentWidth = contentWidth;
    final oldContentHeight = contentHeight;
    final next = _publishedContentSize(
      constraints,
      childConstraints,
      containingWidth: containingWidth,
      containingHeight: containingHeight,
    );
    containingBlockWidth = containingWidth;
    containingBlockHeight = containingHeight;
    contentWidth = next.width;
    contentHeight = next.height;
    _dryContextDepth++;
    try {
      callback();
    } finally {
      _dryContextDepth--;
      containingBlockWidth = oldContainingWidth;
      containingBlockHeight = oldContainingHeight;
      contentWidth = oldContentWidth;
      contentHeight = oldContentHeight;
    }
  }

  @override
  void performLayout() {
    final cbWidth = _percentWidthForDescendants(constraints);
    final cbHeight = _percentHeightForDescendants(constraints);
    final childConstraints = spec.applySizing
        ? _inner(
            constraints,
            containingWidth: cbWidth,
            containingHeight: cbHeight,
          )
        : constraints;
    final next = _publishedContentSize(
      constraints,
      childConstraints,
      containingWidth: cbWidth,
      containingHeight: cbHeight,
    );
    if (_setContext(
      nextContainingWidth: cbWidth,
      nextContainingHeight: cbHeight,
      nextContentWidth: next.width,
      nextContentHeight: next.height,
    )) {
      invokeLayoutCallback<BoxConstraints>((_) => _invalidateChildLayout());
    }
    _layoutContextActive = true;
    try {
      if (child == null) {
        size = constraints.smallest;
      } else {
        child!.layout(childConstraints, parentUsesSize: true);
        size = constraints.constrain(child!.size);
      }
    } finally {
      _layoutContextActive = false;
    }
  }

  @override
  Size computeDryLayout(BoxConstraints constraints) {
    final cbWidth = _dryContainingBlockWidth(constraints);
    final cbHeight = _dryContainingBlockHeight(constraints);
    final childConstraints = spec.applySizing
        ? _inner(
            constraints,
            containingWidth: cbWidth,
            containingHeight: cbHeight,
          )
        : constraints;
    Size result = Size.zero;
    _withDryContext(constraints, childConstraints, cbWidth, cbHeight, () {
      result = constraints.constrain(
        child?.getDryLayout(childConstraints) ?? Size.zero,
      );
    });
    return result;
  }

  @override
  double? computeDryBaseline(
    BoxConstraints constraints,
    TextBaseline baseline,
  ) {
    final cbWidth = _dryContainingBlockWidth(constraints);
    final cbHeight = _dryContainingBlockHeight(constraints);
    final childConstraints = spec.applySizing
        ? _inner(
            constraints,
            containingWidth: cbWidth,
            containingHeight: cbHeight,
          )
        : constraints;
    double? result;
    _withDryContext(constraints, childConstraints, cbWidth, cbHeight, () {
      result = child?.getDryBaseline(childConstraints, baseline);
    });
    return result;
  }

  double _intrinsic(
    double natural,
    NativeFlexLength? preferred,
    NativeFlexLength? minimum,
    NativeFlexLength? maximum,
    double edges,
  ) {
    // Intrinsic queries have no definite containing block, so percentage
    // lengths remain unresolved. Fixed values still contribute their edges.
    double? outer(NativeFlexLength? value) {
      final resolved = value?.resolve(null);
      if (resolved == null) return null;
      return spec.lengthsAreContentBox ? resolved + edges : resolved;
    }

    final lower = math.max(edges, outer(minimum) ?? 0);
    final upper = math.max(lower, outer(maximum) ?? double.infinity);
    return (outer(preferred) ?? natural).clamp(lower, upper).toDouble();
  }

  @override
  double computeMinIntrinsicWidth(double height) => _intrinsic(
    child?.getMinIntrinsicWidth(height) ?? 0,
    spec.width,
    spec.minWidth,
    spec.maxWidth,
    math.max(0.0, spec.horizontalEdges),
  );

  @override
  double computeMaxIntrinsicWidth(double height) => _intrinsic(
    child?.getMaxIntrinsicWidth(height) ?? 0,
    spec.width,
    spec.minWidth,
    spec.maxWidth,
    math.max(0.0, spec.horizontalEdges),
  );

  double _intrinsicHeight(double width, bool maximum) {
    final edges = math.max(0.0, spec.verticalEdges);
    final horizontalEdges = math.max(0.0, spec.horizontalEdges);
    double? outerWidth(NativeFlexLength? value) {
      final resolved = value?.resolve(null);
      if (resolved == null) return null;
      return spec.lengthsAreContentBox ? resolved + horizontalEdges : resolved;
    }

    final lowerWidth = math.max(
      horizontalEdges,
      outerWidth(spec.minWidth) ?? 0,
    );
    final upperWidth = math.max(
      lowerWidth,
      outerWidth(spec.maxWidth) ?? double.infinity,
    );
    final authoredWidth = outerWidth(spec.width);
    final childWidth = (authoredWidth ?? width)
        .clamp(lowerWidth, upperWidth)
        .toDouble();
    final natural = maximum
        ? child?.getMaxIntrinsicHeight(childWidth) ?? 0
        : child?.getMinIntrinsicHeight(childWidth) ?? 0;
    return _intrinsic(
      natural,
      spec.height,
      spec.minHeight,
      spec.maxHeight,
      edges,
    );
  }

  @override
  double computeMinIntrinsicHeight(double width) =>
      _intrinsicHeight(width, false);

  @override
  double computeMaxIntrinsicHeight(double width) =>
      _intrinsicHeight(width, true);
}

/// Adds CSS percentage padding using the nearest NativeDocumentBox's
/// containing-block content width for all four sides.
class NativeDocumentPercentagePadding extends SingleChildRenderObjectWidget {
  const NativeDocumentPercentagePadding({
    super.key,
    required super.child,
    required this.fractions,
  });

  /// Fractions where `0.1` represents `10%`.
  final EdgeInsets fractions;

  @override
  RenderObject createRenderObject(BuildContext context) =>
      _RenderNativeDocumentPercentagePadding(fractions);

  @override
  void updateRenderObject(
    BuildContext context,
    covariant RenderObject renderObject,
  ) {
    (renderObject as _RenderNativeDocumentPercentagePadding).fractions =
        fractions;
  }
}

/// Applies percentage CSS margins using the ancestor containing block's
/// content width for all four sides.
class NativeDocumentPercentageMargin extends SingleChildRenderObjectWidget {
  const NativeDocumentPercentageMargin({
    super.key,
    required super.child,
    required this.fractions,
    this.fixed = EdgeInsets.zero,
  });

  /// Fractions where `0.1` represents `10%`.
  final EdgeInsets fractions;

  /// Fixed signed insets supplement percentage margins (for negative CSS
  /// horizontal margins, which the HTML core clamps to zero).
  final EdgeInsets fixed;

  @override
  RenderObject createRenderObject(BuildContext context) =>
      _RenderNativeDocumentPercentageMargin(fractions, fixed);

  @override
  void updateRenderObject(
    BuildContext context,
    covariant RenderObject renderObject,
  ) {
    (renderObject as _RenderNativeDocumentPercentageMargin)
      ..fractions = fractions
      ..fixed = fixed;
  }
}

class _RenderNativeDocumentPercentageMargin extends RenderShiftedBox {
  _RenderNativeDocumentPercentageMargin(this._fractions, this._fixed)
    : super(null);

  EdgeInsets _fixed;
  set fixed(EdgeInsets value) {
    if (_fixed == value) return;
    _fixed = value;
    markNeedsLayout();
  }

  EdgeInsets _fractions;
  set fractions(EdgeInsets value) {
    if (_fractions == value) return;
    _fractions = value;
    markNeedsLayout();
  }

  EdgeInsets _margin({bool dry = false}) {
    final context = _findDocumentContainingBlock(parent);
    if (dry && !(context?.isActive ?? false)) return _fixed;
    final width = context?.width;
    if (width == null || !width.isFinite || width < 0) return _fixed;
    double side(double fraction) => fraction.isFinite ? fraction * width : 0;
    return EdgeInsets.fromLTRB(
          side(_fractions.left),
          side(_fractions.top),
          side(_fractions.right),
          side(_fractions.bottom),
        ) +
        _fixed;
  }

  @override
  void setupParentData(covariant RenderObject child) {
    if (child.parentData is! BoxParentData) {
      child.parentData = BoxParentData();
    }
  }

  @override
  void performLayout() {
    final margin = _margin();
    if (child == null) {
      size = constraints.constrain(
        Size(math.max(0.0, margin.horizontal), math.max(0.0, margin.vertical)),
      );
      return;
    }
    child!.layout(constraints.deflate(margin), parentUsesSize: true);
    size = constraints.constrain(
      Size(
        math.max(0.0, child!.size.width + margin.horizontal),
        math.max(0.0, child!.size.height + margin.vertical),
      ),
    );
    (child!.parentData! as BoxParentData).offset = Offset(
      margin.left,
      margin.top,
    );
  }

  @override
  Size computeDryLayout(BoxConstraints constraints) {
    final margin = _margin(dry: true);
    final childSize = child?.getDryLayout(constraints.deflate(margin));
    return constraints.constrain(
      Size(
        math.max(0.0, (childSize?.width ?? 0) + margin.horizontal),
        math.max(0.0, (childSize?.height ?? 0) + margin.vertical),
      ),
    );
  }

  @override
  double? computeDryBaseline(
    BoxConstraints constraints,
    TextBaseline baseline,
  ) {
    final margin = _margin(dry: true);
    final value = child?.getDryBaseline(constraints.deflate(margin), baseline);
    return value == null ? null : value + margin.top;
  }

  @override
  double computeMinIntrinsicWidth(double height) =>
      child?.getMinIntrinsicWidth(height) ?? 0;

  @override
  double computeMaxIntrinsicWidth(double height) =>
      child?.getMaxIntrinsicWidth(height) ?? 0;

  @override
  double computeMinIntrinsicHeight(double width) =>
      child?.getMinIntrinsicHeight(width) ?? 0;

  @override
  double computeMaxIntrinsicHeight(double width) =>
      child?.getMaxIntrinsicHeight(width) ?? 0;
}

/// Returns actual padding from the latest completed native layout.
/// Scroll viewports use this to retain trailing padding in overflow extents.
EdgeInsets? nativeDocumentPaddingInsets(RenderBox box) {
  if (!box.attached || !box.hasSize) return null;
  if (box is _RenderNativeDocumentPercentagePadding) return box.laidOutPadding;
  if (box is RenderPadding) {
    try {
      return box.padding.resolve(box.textDirection);
    } on Object {
      return null;
    }
  }
  return null;
}

class _RenderNativeDocumentPercentagePadding extends RenderShiftedBox {
  _RenderNativeDocumentPercentagePadding(this._fractions) : super(null);

  EdgeInsets _fractions;
  EdgeInsets? laidOutPadding;
  set fractions(EdgeInsets value) {
    if (_fractions == value) return;
    _fractions = value;
    markNeedsLayout();
  }

  EdgeInsets _padding({bool dry = false}) {
    RenderObject? ancestor = parent;
    while (ancestor != null &&
        ancestor is! _RenderDocumentBox &&
        ancestor is! _RenderNativeDocumentContainingBlock) {
      ancestor = ancestor.parent;
    }
    final context = _findDocumentContainingBlock(parent);
    if (dry && !(context?.isActive ?? false)) return EdgeInsets.zero;
    final width = ancestor is _RenderDocumentBox
        ? ancestor.containingBlockWidth
        : ancestor is _RenderNativeDocumentContainingBlock
        ? ancestor.contentWidth
        : null;
    if (width == null || !width.isFinite || width < 0) return EdgeInsets.zero;
    double side(double fraction) =>
        fraction.isFinite ? math.max(0.0, fraction * width) : 0;
    return EdgeInsets.fromLTRB(
      side(_fractions.left),
      side(_fractions.top),
      side(_fractions.right),
      side(_fractions.bottom),
    );
  }

  BoxConstraints _deflate(BoxConstraints constraints, EdgeInsets padding) =>
      constraints.deflate(padding);

  @override
  void setupParentData(covariant RenderObject child) {
    if (child.parentData is! BoxParentData) {
      child.parentData = BoxParentData();
    }
  }

  @override
  void performLayout() {
    final padding = _padding();
    laidOutPadding = padding;
    if (child == null) {
      size = constraints.constrain(Size(padding.horizontal, padding.vertical));
      return;
    }
    child!.layout(_deflate(constraints, padding), parentUsesSize: true);
    size = constraints.constrain(
      Size(
        child!.size.width + padding.horizontal,
        child!.size.height + padding.vertical,
      ),
    );
    final parentData = child!.parentData! as BoxParentData;
    parentData.offset = Offset(padding.left, padding.top);
  }

  @override
  Size computeDryLayout(BoxConstraints constraints) {
    final padding = _padding(dry: true);
    final childSize = child?.getDryLayout(_deflate(constraints, padding));
    return constraints.constrain(
      Size(
        (childSize?.width ?? 0) + padding.horizontal,
        (childSize?.height ?? 0) + padding.vertical,
      ),
    );
  }

  @override
  double? computeDryBaseline(
    BoxConstraints constraints,
    TextBaseline baseline,
  ) {
    final padding = _padding(dry: true);
    final value = child?.getDryBaseline(
      _deflate(constraints, padding),
      baseline,
    );
    return value == null ? null : value + padding.top;
  }

  @override
  double computeMinIntrinsicWidth(double height) =>
      child?.getMinIntrinsicWidth(height) ?? 0;

  @override
  double computeMaxIntrinsicWidth(double height) =>
      child?.getMaxIntrinsicWidth(height) ?? 0;

  @override
  double computeMinIntrinsicHeight(double width) =>
      child?.getMinIntrinsicHeight(width) ?? 0;

  @override
  double computeMaxIntrinsicHeight(double width) =>
      child?.getMaxIntrinsicHeight(width) ?? 0;
}

/// Returns the decorated border-box surface owned by the native sizing wrapper
/// below a geometry marker. The marker itself may be wrapped in transparent
/// layout proxies. If the subtree is ambiguous, its marker is returned so
/// callers never accidentally measure a nested element's box.
RenderBox? nativeDocumentBoxSurface(RenderBox marker, {Object? owner}) {
  _RenderDocumentBox? found;
  var ambiguous = false;

  void visit(RenderObject object) {
    if (found != null && ambiguous) return;
    if (object is _RenderDocumentBox) {
      if (owner == null || identical(object.spec.geometryOwner, owner)) {
        if (found == null) {
          found = object;
        } else if (!identical(found, object)) {
          ambiguous = true;
        }
      }
      // Stop at each NativeDocumentBox: a nested native box belongs to a
      // different DOM element and must never replace this box's own surface.
      return;
    }
    object.visitChildren(visit);
  }

  visit(marker);
  if (ambiguous || found == null) return marker;
  final box = found!;
  // In intrinsic-only mode the native flow child may have a smaller
  // descendant surface than the CSS block box represented by the marker.
  // The marker is the authoritative outer block in that mode.
  if (!box.spec.applySizing) return marker;
  if (box.spec.applySizing && box.child != null) return box.child;
  return box;
}
