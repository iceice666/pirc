import 'dart:math' as math;
import 'package:html/dom.dart' as dom;

/// Render-only top-margin overrides keyed by the original DOM's stable style
/// IDs. Author/computed styles remain unchanged. Root margins never collapse.
/// This supports nonempty in-flow block chains and nonnegative pixel margins.
/// Signed/percentage/font-relative margins, empty blocks and bottom-edge
/// collapse need a richer used-value/formatting-context model.
Map<String, double> nativeDocumentCollapsedTopMargins({
  required dom.Document document,
  required Map<dom.Element, Map<String, String>> stylesByElement,
}) {
  final overrides = <String, double>{};
  final root = document.documentElement;
  if (root == null) return overrides;
  const blockTags = {
    'html',
    'body',
    'div',
    'section',
    'article',
    'header',
    'footer',
    'main',
    'nav',
    'aside',
    'address',
    'form',
    'p',
    'pre',
    'blockquote',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'ul',
    'ol',
    'dl',
    'dt',
    'dd',
  };
  const defaultMarginTags = {
    'p',
    'pre',
    'blockquote',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'ul',
    'ol',
    'dl',
    'dd',
  };
  const metadata = {'head', 'style', 'script', 'link', 'meta', 'title', 'base'};
  Map<String, String> styles(dom.Element element) =>
      stylesByElement[element] ?? const {};
  String value(dom.Element element, String key, String fallback) =>
      (styles(element)[key] ?? fallback).trim().toLowerCase();
  String display(dom.Element element) => value(
    element,
    'display',
    metadata.contains(element.localName)
        ? 'none'
        : blockTags.contains(element.localName)
        ? 'block'
        : 'inline',
  );
  double? pixels(String source) {
    final match = RegExp(
      r'^\+?((?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+))(px)?$',
    ).firstMatch(source.trim().toLowerCase());
    if (match == null) return null;
    final number = double.tryParse(match[1]!);
    return number != null &&
            number.isFinite &&
            (match[2] != null || number == 0)
        ? number
        : null;
  }

  double? top(dom.Element element) {
    final key = element.attributes['data-pirc-document-style'];
    if (key != null && overrides.containsKey(key)) return overrides[key];
    final css = styles(element);
    final source =
        css['margin-top'] ?? css['margin']?.trim().split(RegExp(r'\s+')).first;
    if (source != null) return pixels(source);
    if (identical(element, document.body)) return 8;
    return defaultMarginTags.contains(element.localName) ? null : 0;
  }

  bool zeroTopEdge(dom.Element element) {
    if (pixels(value(element, 'padding-top', '0')) != 0) return false;
    final borderStyle = value(element, 'border-top-style', 'none');
    return const {'none', 'hidden'}.contains(borderStyle) ||
        pixels(value(element, 'border-top-width', '3px')) == 0;
  }

  bool ordinaryBlock(dom.Element element) =>
      display(element) == 'block' &&
      const {
        'static',
        'relative',
      }.contains(value(element, 'position', 'static')) &&
      value(element, 'float', 'none') == 'none' &&
      value(element, 'clear', 'none') == 'none' &&
      value(element, 'writing-mode', 'horizontal-tb') == 'horizontal-tb';
  bool normalWhitespace(dom.Element element) {
    dom.Element? current = element;
    while (current != null) {
      if (styles(current).containsKey('white-space')) {
        return const {
          'normal',
          'nowrap',
        }.contains(value(current, 'white-space', 'normal'));
      }
      if (current.localName == 'pre') return false;
      current = current.parent;
    }
    return true;
  }

  bool allowsChildCollapse(dom.Element element) {
    if (identical(element, root) ||
        !ordinaryBlock(element) ||
        !zeroTopEdge(element) ||
        !normalWhitespace(element)) {
      return false;
    }
    final parent = element.parent;
    if (parent != null &&
        const {
          'flex',
          'inline-flex',
          'grid',
          'inline-grid',
        }.contains(display(parent))) {
      return false;
    }
    final css = styles(element);
    final shorthand = value(
      element,
      'overflow',
      'visible',
    ).split(RegExp(r'\s+'));
    for (final side in ['x', 'y']) {
      final fallback = side == 'y' && shorthand.length > 1
          ? shorthand[1]
          : shorthand.first;
      if (!const {
        'visible',
        'clip',
      }.contains(value(element, 'overflow-$side', fallback))) {
        return false;
      }
    }
    return value(element, 'contain', 'none') == 'none' &&
        value(element, 'content-visibility', 'visible') == 'visible' &&
        value(element, 'column-count', 'auto') == 'auto' &&
        value(element, 'column-width', 'auto') == 'auto' &&
        !css.keys.any((key) => key.startsWith('margin-block'));
  }

  bool hasContent(dom.Element element) {
    if ((pixels(value(element, 'height', 'auto')) ?? 0) > 0 ||
        (pixels(value(element, 'min-height', '0')) ?? 0) > 0) {
      return true;
    }
    for (final node in element.nodes) {
      if (node is dom.Text && !RegExp(r'^[\t\n\r\f ]*$').hasMatch(node.text)) {
        return true;
      }
      if (node is! dom.Element || display(node) == 'none') continue;
      if (!const {
            'static',
            'relative',
          }.contains(value(node, 'position', 'static')) ||
          value(node, 'float', 'none') != 'none') {
        continue;
      }
      if (const {
            'img',
            'canvas',
            'input',
            'button',
            'textarea',
            'select',
            'video',
            'audio',
            'svg',
          }.contains(node.localName) ||
          hasContent(node)) {
        return true;
      }
    }
    return false;
  }

  dom.Element? firstChild(dom.Element element) {
    for (final node in element.nodes) {
      if (node is dom.Text && !RegExp(r'^[\t\n\r\f ]*$').hasMatch(node.text)) {
        return null;
      }
      if (node is! dom.Element || display(node) == 'none') continue;
      // Float/position/inline formatting can affect the first in-flow edge.
      return ordinaryBlock(node) ? node : null;
    }
    return null;
  }

  void visit(dom.Element element) {
    for (final child in element.children) {
      visit(child);
    }
    if (!allowsChildCollapse(element)) return;
    final child = firstChild(element);
    if (child == null || !hasContent(child)) return;
    final parentKey = element.attributes['data-pirc-document-style'];
    final childKey = child.attributes['data-pirc-document-style'];
    if (parentKey == null || childKey == null) return;
    final parentTop = top(element), childTop = top(child);
    if (parentTop == null || childTop == null || childTop == 0) return;
    overrides[parentKey] = math.max(parentTop, childTop);
    overrides[childKey] = 0;
  }

  visit(root);
  return overrides;
}
