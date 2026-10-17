import 'package:html/dom.dart' as dom;

enum NativeDocumentOffsetOrigin {
  initialContainingBlock,
  borderBox,
  paddingEdge,
  zero,
}

/// Selects a measured, unscrolled origin for CSSOM offset coordinates.
/// The parent exposed to scripts can differ from the origin (static body uses
/// the root border origin in Chromium). Absence of a spec means unsupported.
class NativeDocumentOffsetSpec {
  const NativeDocumentOffsetSpec({
    required this.parentId,
    required this.origin,
    this.originId,
  });

  final String? parentId;
  final NativeDocumentOffsetOrigin origin;
  final String? originId;
}

/// Resolve offset-parent semantics before html/body are converted to native
/// block wrappers. This never derives geometry from CSS declarations: actual
/// border origins, border insets and scroll compensation come from render boxes.
Map<String, NativeDocumentOffsetSpec> nativeDocumentOffsetSpecs({
  required dom.Document document,
  required Map<dom.Element, Map<String, String>> stylesByElement,
}) {
  final result = <String, NativeDocumentOffsetSpec>{};
  final root = document.documentElement;
  final body = document.body;
  if (root == null || body == null) return result;
  String? id(dom.Element element) => element.attributes['data-pirc-script-id'];
  Map<String, String> styles(dom.Element element) =>
      stylesByElement[element] ?? const {};
  String value(dom.Element element, String property, String fallback) =>
      (styles(element)[property] ?? fallback).trim().toLowerCase();

  bool ordinary(dom.Element element) {
    final css = styles(element);
    final position = value(element, 'position', 'static');
    if (position != 'static' && position != 'relative') return false;
    if (position == 'relative') {
      for (final entry in css.entries) {
        if (const {
              'top',
              'left',
              'right',
              'bottom',
              'inset',
            }.contains(entry.key) ||
            entry.key.startsWith('inset-')) {
          if (!RegExp(
            r'^(?:auto|[+-]?0(?:\.0+)?(?:px|%|em|rem)?)$',
          ).hasMatch(entry.value.trim().toLowerCase())) {
            return false;
          }
        }
      }
    }
    for (final property in const [
      'transform',
      'translate',
      'rotate',
      'scale',
      'perspective',
      'filter',
      'backdrop-filter',
      'contain',
      'will-change',
    ]) {
      if (!const {
        'none',
        'normal',
        'auto',
      }.contains(value(element, property, 'none'))) {
        return false;
      }
    }
    if (!const {
      'normal',
      '1',
      '1.0',
      '100%',
    }.contains(value(element, 'zoom', 'normal'))) {
      return false;
    }
    if (value(element, 'writing-mode', 'horizontal-tb') != 'horizontal-tb' ||
        value(element, 'float', 'none') != 'none' ||
        !const {'auto', '1'}.contains(value(element, 'column-count', 'auto')) ||
        value(element, 'column-width', 'auto') != 'auto') {
      return false;
    }
    final display = value(element, 'display', '');
    if (display == 'contents' ||
        display.startsWith('table') ||
        const {
          'table',
          'thead',
          'tbody',
          'tfoot',
          'tr',
          'td',
          'th',
          'caption',
        }.contains(element.localName)) {
      return false;
    }
    // SVG and MathML have their own coordinate spaces and HTMLElement rules.
    if (element.namespaceUri != null &&
        element.namespaceUri != 'http://www.w3.org/1999/xhtml') {
      return false;
    }
    return true;
  }

  for (final element in document.querySelectorAll('*')) {
    final elementId = id(element);
    if (elementId == null) continue;
    if (identical(element, body)) {
      result[elementId] = const NativeDocumentOffsetSpec(
        parentId: null,
        origin: NativeDocumentOffsetOrigin.zero,
      );
      continue;
    }
    dom.Element? current = element;
    var supported = true;
    while (current != null) {
      if (!ordinary(current)) {
        supported = false;
        break;
      }
      current = current.parent;
    }
    if (!supported) continue;
    if (identical(element, root)) {
      result[elementId] = const NativeDocumentOffsetSpec(
        parentId: null,
        origin: NativeDocumentOffsetOrigin.initialContainingBlock,
      );
      continue;
    }
    var ancestor = element.parent;
    while (ancestor != null &&
        !identical(ancestor, body) &&
        value(ancestor, 'position', 'static') != 'relative') {
      ancestor = ancestor.parent;
    }
    if (ancestor == null) continue;
    final parentId = id(ancestor);
    if (parentId == null) continue;
    final staticBody =
        identical(ancestor, body) &&
        value(body, 'position', 'static') == 'static';
    final originId = staticBody ? id(root) : parentId;
    if (originId == null) continue;
    result[elementId] = NativeDocumentOffsetSpec(
      parentId: parentId,
      originId: originId,
      origin: identical(ancestor, body)
          ? NativeDocumentOffsetOrigin.borderBox
          : NativeDocumentOffsetOrigin.paddingEdge,
    );
  }
  return result;
}
