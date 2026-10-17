import 'dart:math' as math;
import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

/// The pinned flex-wrap image rows stretch each item's box to its row height.
/// Image content still uses contain; Flutter Wrap alone does not stretch boxes.
class TimelineImageWrap extends MultiChildRenderObjectWidget {
  const TimelineImageWrap({super.key, required super.children});
  @override
  RenderObject createRenderObject(BuildContext context) =>
      RenderTimelineImageWrap(Directionality.of(context));
  @override
  void updateRenderObject(
    BuildContext context,
    RenderTimelineImageWrap renderObject,
  ) {
    renderObject.direction = Directionality.of(context);
  }
}

class _ImageParentData extends ContainerBoxParentData<RenderBox> {}

class RenderTimelineImageWrap extends RenderBox
    with
        ContainerRenderObjectMixin<RenderBox, _ImageParentData>,
        RenderBoxContainerDefaultsMixin<RenderBox, _ImageParentData> {
  RenderTimelineImageWrap(this._direction);
  TextDirection _direction;
  set direction(TextDirection value) {
    if (_direction == value) return;
    _direction = value;
    markNeedsLayout();
  }

  @override
  void setupParentData(RenderBox child) {
    if (child.parentData is! _ImageParentData) {
      child.parentData = _ImageParentData();
    }
  }

  Size _measure(BoxConstraints constraints, {required bool dry}) {
    final runs = <List<(RenderBox, Size)>>[];
    var run = <(RenderBox, Size)>[],
        width = 0.0,
        height = 0.0,
        totalHeight = 0.0,
        maxWidth = 0.0;
    var child = firstChild;
    final loose = BoxConstraints(
      maxWidth: constraints.maxWidth,
      maxHeight: 280,
    );
    void finishRun() {
      if (run.isEmpty) return;
      runs.add(run);
      maxWidth = math.max(maxWidth, width);
      totalHeight += height + (runs.length > 1 ? 8 : 0);
      run = [];
      width = height = 0;
    }

    while (child != null) {
      final current = child;
      final dimensions = dry
          ? current.getDryLayout(loose)
          : (current..layout(loose, parentUsesSize: true)).size;
      final next = width + (run.isEmpty ? 0 : 8) + dimensions.width;
      if (run.isNotEmpty && next > constraints.maxWidth) finishRun();
      width += (run.isEmpty ? 0 : 8) + dimensions.width;
      height = math.max(height, dimensions.height);
      run.add((current, dimensions));
      child = (current.parentData! as _ImageParentData).nextSibling;
    }
    finishRun();
    final measured = constraints.constrain(Size(maxWidth, totalHeight));
    if (!dry) {
      var top = 0.0;
      for (final line in runs) {
        final lineHeight = line.fold<double>(
          0,
          (value, entry) => math.max(value, entry.$2.height),
        );
        var left = 0.0;
        for (final (box, dimensions) in line) {
          box.layout(
            BoxConstraints.tightFor(
              width: dimensions.width,
              height: lineHeight,
            ),
            parentUsesSize: true,
          );
          (box.parentData! as _ImageParentData).offset = Offset(
            _direction == TextDirection.ltr
                ? left
                : measured.width - left - dimensions.width,
            top,
          );
          left += dimensions.width + 8;
        }
        top += lineHeight + 8;
      }
    }
    return measured;
  }

  @override
  void performLayout() {
    size = _measure(constraints, dry: false);
  }

  @override
  Size computeDryLayout(BoxConstraints constraints) =>
      _measure(constraints, dry: true);
  @override
  double computeMinIntrinsicWidth(double height) {
    var result = 0.0, child = firstChild;
    while (child != null) {
      result = math.max(result, child.getMinIntrinsicWidth(height));
      child = (child.parentData! as _ImageParentData).nextSibling;
    }
    return result;
  }

  @override
  double computeMaxIntrinsicWidth(double height) {
    var result = 0.0, child = firstChild;
    while (child != null) {
      result += child.getMaxIntrinsicWidth(height);
      child = (child.parentData! as _ImageParentData).nextSibling;
      if (child != null) result += 8;
    }
    return result;
  }

  @override
  void paint(PaintingContext context, Offset offset) =>
      defaultPaint(context, offset);
  @override
  bool hitTestChildren(BoxHitTestResult result, {required Offset position}) =>
      defaultHitTestChildren(result, position: position);
}
