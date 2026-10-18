import 'dart:math' as math;
import 'dart:ui';

class NativeDocumentRevealAction {
  const NativeDocumentRevealAction(this.elementId, this.destination);
  final String? elementId;
  final Offset destination;
}

/// Plans a standard fragment reveal against one completed native layout.
/// Every destination is computed before any native scroll action is applied.
List<NativeDocumentRevealAction> nativeDocumentRevealPlan(
  Map<String, dynamic> packet,
  String id,
  String rootId,
) {
  Never unavailable(String reason) =>
      throw UnsupportedError('Native fragment reveal: $reason');
  final boxes = {
    for (final raw in packet['boxes'] as List)
      raw['id'] as String: Map<String, dynamic>.from(raw as Map),
  };
  final target = boxes[id];
  if (target?['kind'] == 'none') return const [];
  if (target?['kind'] != 'box') unavailable('target has no proved native box');
  final proof = target!['scrollReveal'];
  if (proof is! Map || target['scrollGeometry'] is! Map) {
    unavailable('missing scrollport ancestry');
  }
  Map style(Map? owner) {
    final value = owner?['computedStyle'];
    if (value is! Map ||
        value['direction'] != 'ltr' ||
        value['writing-mode'] != 'horizontal-tb') {
      unavailable('unsupported writing mode');
    }
    return value;
  }

  double number(Object? value) {
    if (value is! num || !value.isFinite || value.abs() > 9007199254740990) {
      unavailable('invalid coordinate');
    }
    return value.toDouble();
  }

  double inset(Map css, String name, double basis, {bool padding = false}) {
    final value = css[name];
    if (padding && value == 'auto') return 0;
    if (value is! String) unavailable('unmeasured $name');
    final match = RegExp(
      r'^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(px|%)$',
    ).firstMatch(value);
    if (match == null || !padding && match[2] == '%') {
      unavailable('unresolved $name');
    }
    final result =
        double.parse(match[1]!) * (match[2] == '%' ? basis / 100 : 1);
    if (!result.isFinite || padding && result < 0) unavailable('invalid $name');
    return result;
  }

  final css = style(target);
  final margin = (
    left: inset(css, 'scroll-margin-left', 0),
    top: inset(css, 'scroll-margin-top', 0),
    right: inset(css, 'scroll-margin-right', 0),
    bottom: inset(css, 'scroll-margin-bottom', 0),
  );
  double nearest(
    double start,
    double end,
    double visibleStart,
    double visibleEnd,
  ) {
    if (end < start || visibleEnd < visibleStart) {
      unavailable('inverted reveal region');
    }
    if (start < visibleStart && end > visibleEnd) return 0;
    final larger = end - start > visibleEnd - visibleStart;
    if (start < visibleStart && !larger || end > visibleEnd && larger) {
      return start - visibleStart;
    }
    if (start < visibleStart && larger || end > visibleEnd && !larger) {
      return end - visibleEnd;
    }
    return 0;
  }

  Offset destination(
    Rect rect,
    Size port,
    Map css,
    Offset position,
    Map? range,
  ) {
    if (range == null) unavailable('missing native scroll limits');
    final left = inset(css, 'scroll-padding-left', port.width, padding: true),
        right =
            port.width -
            inset(css, 'scroll-padding-right', port.width, padding: true),
        top = inset(css, 'scroll-padding-top', port.height, padding: true),
        bottom =
            port.height -
            inset(css, 'scroll-padding-bottom', port.height, padding: true);
    if (right < left ||
        bottom < top ||
        rect.bottom + margin.bottom < rect.top - margin.top) {
      unavailable('inverted reveal region');
    }
    final x =
            position.dx +
            nearest(
              rect.left - margin.left,
              rect.right + margin.right,
              left,
              right,
            ),
        y = position.dy + rect.top - margin.top - top;
    final minX = number(range['minLeft']),
        maxX = number(range['maxLeft']),
        minY = number(range['minTop']),
        maxY = number(range['maxTop']);
    if (minX > maxX || minY > maxY) unavailable('inverted native limits');
    return Offset(
      number(x).roundToDouble().clamp(minX, maxX),
      number(y).roundToDouble().clamp(minY, maxY),
    );
  }

  Rect mapRect(Rect rect, Offset Function(Offset) map) {
    final points = [
      rect.topLeft,
      rect.topRight,
      rect.bottomLeft,
      rect.bottomRight,
    ].map(map).toList();
    return Rect.fromLTRB(
      points.map((p) => p.dx).reduce(math.min),
      points.map((p) => p.dy).reduce(math.min),
      points.map((p) => p.dx).reduce(math.max),
      points.map((p) => p.dy).reduce(math.max),
    );
  }

  final viewport = packet['viewport'] as Map,
      scroll = Offset(number(viewport['scrollX']), number(viewport['scrollY']));
  var absolute = Rect.fromLTWH(
    number(target['x']) - scroll.dx,
    number(target['y']) - scroll.dy,
    number(target['width']),
    number(target['height']),
  );
  final plan = <NativeDocumentRevealAction>[];
  for (final raw in proof['ports'] as List) {
    final port = raw as Map, owner = boxes[port['id']];
    if (owner?['kind'] != 'box' || owner?['scroll'] is! Map) {
      unavailable('scroll owner has no current native box');
    }
    final metrics = owner!['scroll'] as Map,
        axes = (port['axes'] as List).map(number).toList(),
        origin = (port['origin'] as List).map(number).toList();
    final ox = origin[0] - scroll.dx,
        oy = origin[1] - scroll.dy,
        det = axes[0] * axes[3] - axes[1] * axes[2];
    if (!det.isFinite || det.abs() < 1e-12) {
      unavailable('singular scroll transform');
    }
    final rect = mapRect(
      absolute,
      (p) => Offset(
        (axes[3] * (p.dx - ox) - axes[2] * (p.dy - oy)) / det,
        (-axes[1] * (p.dx - ox) + axes[0] * (p.dy - oy)) / det,
      ),
    );
    final size = Size(number(port['width']), number(port['height'])),
        current = Offset(number(metrics['left']), number(metrics['top']));
    final next = destination(
      rect,
      size,
      style(owner),
      current,
      metrics['range'] as Map?,
    );
    plan.add(NativeDocumentRevealAction(port['id'] as String, next));
    final moved = rect.shift(current - next),
        clip = moved.intersect(Offset.zero & size);
    absolute = mapRect(
      clip.width > 0 && clip.height > 0 ? clip : moved,
      (p) => Offset(
        ox + axes[0] * p.dx + axes[2] * p.dy,
        oy + axes[1] * p.dx + axes[3] * p.dy,
      ),
    );
  }
  if (proof['viewport'] == true) {
    final size = Size(number(viewport['width']), number(viewport['height'])),
        range = viewport['scrollRange'] as Map?;
    if (absolute.right + margin.right > size.width && range?['maxLeft'] == 0) {
      unavailable('root horizontal reveal has no native range');
    }
    plan.add(
      NativeDocumentRevealAction(
        null,
        destination(absolute, size, style(boxes[rootId]), scroll, range),
      ),
    );
  }
  return List.unmodifiable(plan);
}
