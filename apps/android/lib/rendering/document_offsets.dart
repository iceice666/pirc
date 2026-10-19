import 'dart:ui' show Size, TextDirection;
import 'document_absolute_position.dart';
import 'document_transform.dart';
import 'document_relative_position.dart';
import 'document_computed_styles.dart';
import 'package:html/dom.dart' as dom;

enum NativeDocumentOffsetOrigin {
  initialContainingBlock,
  viewport,
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
    this.requiresPositionedSurface = false,
  });

  final String? parentId;
  final NativeDocumentOffsetOrigin origin;
  final String? originId;
  final bool requiresPositionedSurface;
}

/// Resolve offset-parent semantics before html/body are converted to native
/// block wrappers. This never derives geometry from CSS declarations: actual
/// border origins, border insets and scroll compensation come from render boxes.
Map<String, NativeDocumentOffsetSpec> nativeDocumentOffsetSpecs({
  required dom.Document document,
  required Map<dom.Element, Map<String, String>> stylesByElement,
  Map<String, NativeDocumentComputedStyleSpec> computedStyles = const {},
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
    if (!const {'static', 'relative', 'absolute', 'fixed'}.contains(position)) {
      return false;
    }
    if (const {'absolute', 'fixed'}.contains(position) &&
        NativeAbsolutePositionSpec.parse(
              css,
              fontSize: 16,
              viewport: Size.zero,
            ) ==
            null) {
      return false;
    }
    if (position == 'relative') {
      final spec = NativeDocumentRelativePositionSpec.parse(
        css,
        direction: TextDirection.ltr,
        computedLengths: computedStyles[id(element)]?.lengths ?? const {},
      );
      if (spec == null) return false;
      // Nonzero relative insets need the same native block surface that the
      // renderer wraps. Zero/auto inline positioning retains its old behavior.
      if (!spec.isNoOp && !_hasNativeRelativeBox(element, stylesByElement)) {
        return false;
      }
    }
    final transform = value(element, 'transform', 'none');
    if (transform != 'none' &&
        (NativeDocumentTransformSpec.parse(
                  transform,
                  origin: css['transform-origin'],
                ) ==
                null ||
            (!const {'absolute', 'fixed'}.contains(position) &&
                !_hasNativeRelativeBox(element, stylesByElement)))) {
      return false;
    }
    if (!const {
      '',
      'view-box',
      'border-box',
    }.contains(value(element, 'transform-box', ''))) {
      return false;
    }
    for (final property in const [
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
        value(element, 'column-count', 'auto') != 'auto' ||
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

  bool transformed(dom.Element element) =>
      value(element, 'transform', 'none') != 'none';
  bool positioned(dom.Element element) => const {
    'absolute',
    'fixed',
  }.contains(value(element, 'position', 'static'));
  for (final element in document.querySelectorAll('*')) {
    final elementId = id(element);
    if (elementId == null) continue;
    if (identical(element, body)) {
      result[elementId] = NativeDocumentOffsetSpec(
        requiresPositionedSurface: positioned(element),
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
    final fixed = value(element, 'position', 'static') == 'fixed';
    var ancestor = element.parent;
    if (fixed) {
      while (ancestor != null && !transformed(ancestor)) {
        ancestor = ancestor.parent;
      }
      if (ancestor == null) {
        result[elementId] = const NativeDocumentOffsetSpec(
          parentId: null,
          origin: NativeDocumentOffsetOrigin.viewport,
          requiresPositionedSurface: true,
        );
        continue;
      }
    } else {
      while (ancestor != null &&
          !identical(ancestor, body) &&
          value(ancestor, 'position', 'static') == 'static' &&
          !transformed(ancestor)) {
        ancestor = ancestor.parent;
      }
    }
    if (ancestor == null) continue;
    final parentId = id(ancestor);
    if (parentId == null) continue;
    final staticBody =
        identical(ancestor, body) &&
        value(body, 'position', 'static') == 'static';
    if (staticBody && !transformed(body) && positioned(element)) {
      result[elementId] = NativeDocumentOffsetSpec(
        parentId: parentId,
        origin: NativeDocumentOffsetOrigin.initialContainingBlock,
        requiresPositionedSurface: true,
      );
      continue;
    }
    final originId = staticBody && !positioned(element) ? id(root) : parentId;
    if (originId == null) continue;
    result[elementId] = NativeDocumentOffsetSpec(
      parentId: parentId,
      originId: originId,
      origin: identical(ancestor, body)
          ? NativeDocumentOffsetOrigin.borderBox
          : NativeDocumentOffsetOrigin.paddingEdge,
      requiresPositionedSurface: positioned(element),
    );
  }
  return result;
}

// The HTML core supplies these default block displays. Explicit native block,
// flex/grid and flow-root surfaces use NativeDocumentBox; inline fragments do
// not gain offset support merely because their inset syntax is recognized.
bool _hasNativeRelativeBox(
  dom.Element element,
  Map<dom.Element, Map<String, String>> stylesByElement,
) {
  final display = stylesByElement[element]?['display']?.trim().toLowerCase();
  if (const {'block', 'flex', 'grid', 'flow-root'}.contains(display)) {
    return true;
  }
  final parent = element.parent;
  if (const {'inline', 'inline-block', null}.contains(display) &&
      parent != null &&
      const {'flex', 'grid'}.contains(stylesByElement[parent]?['display']) &&
      !const {
        'img',
        'canvas',
        'audio',
        'video',
        'input',
        'select',
        'textarea',
      }.contains(element.localName)) {
    return true;
  }
  if (display == null || display.isEmpty) {
    return const {
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
      'figure',
      'figcaption',
      'details',
      'summary',
      'fieldset',
      'legend',
      'hr',
    }.contains(element.localName);
  }
  return false;
}
