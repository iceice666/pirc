import 'dart:convert';
import 'package:html/parser.dart' as html;
import 'package:html/dom.dart' as dom;

const nativeFragmentAttribute = 'data-pirc-native-fragment';

class NativeDocumentFragmentTarget {
  const NativeDocumentFragmentTarget.anchor(this.anchor) : top = false;
  const NativeDocumentFragmentTarget.top() : anchor = null, top = true;
  final String? anchor;
  final bool top;
}

/// Private rendering aliases keep duplicate IDs/names in DOM order without
/// changing the original attributes used by CSS, forms or the scripting DOM.
class NativeDocumentFragmentIndex {
  NativeDocumentFragmentIndex(String source, String nonce) {
    final fragment = html.parseFragment(source);
    _annotate(fragment.querySelectorAll('*'), nonce);
    _annotatedHtml = fragment.outerHtml;
  }

  /// Annotates the renderer's existing DOM clone without serializing another
  /// copy of inline script sources. The caller serializes its body afterwards.
  NativeDocumentFragmentIndex.fromDocument(
    dom.Document document,
    String nonce,
  ) {
    _annotate(document.querySelectorAll('*'), nonce);
  }

  void _annotate(Iterable<dom.Element> elements, String nonce) {
    var sequence = 0;
    for (final element in elements) {
      element.attributes.remove(nativeFragmentAttribute);
      final id = element.attributes['id'];
      final name = element.localName == 'a' ? element.attributes['name'] : null;
      if ((id == null || id.isEmpty) && (name == null || name.isEmpty)) {
        continue;
      }
      final alias = 'pirc-$nonce-fragment-${++sequence}';
      element.attributes[nativeFragmentAttribute] = alias;
      final nativeId = element.attributes['data-pirc-script-id'];
      if (nativeId != null) _nativeIds[alias] = nativeId;
      if (id != null && id.isNotEmpty) _ids.putIfAbsent(id, () => alias);
      if (name != null && name.isNotEmpty) {
        _names.putIfAbsent(name, () => alias);
      }
    }
  }

  String? _annotatedHtml;
  String get annotatedHtml =>
      _annotatedHtml ??
      (throw StateError('Serialize the annotated document clone directly'));
  final _ids = <String, String>{},
      _names = <String, String>{},
      _nativeIds = <String, String>{};
  String? nativeIdFor(String alias) => _nativeIds[alias];
  String? anchorFor(String value) => _ids[value] ?? _names[value];

  NativeDocumentFragmentTarget? select(String raw) {
    if (raw.isEmpty) return const NativeDocumentFragmentTarget.top();
    final literal = anchorFor(raw);
    if (literal != null) return NativeDocumentFragmentTarget.anchor(literal);
    final decoded = decodeNativeDocumentFragment(raw);
    final anchor = anchorFor(decoded);
    if (anchor != null) return NativeDocumentFragmentTarget.anchor(anchor);
    if (decoded.toLowerCase() == 'top') {
      return const NativeDocumentFragmentTarget.top();
    }
    return null;
  }
}

String decodeNativeDocumentFragment(String value) {
  final bytes = <int>[0];
  var position = 0;
  while (position < value.length) {
    if (value.codeUnitAt(position) == 0x25 && position + 2 < value.length) {
      final pair = value.substring(position + 1, position + 3);
      if (RegExp(r'^[0-9a-fA-F]{2}$').hasMatch(pair)) {
        bytes.add(int.parse(pair, radix: 16));
        position += 3;
        continue;
      }
    }
    final next = value.indexOf('%', position + 1);
    final end = next < 0 ? value.length : next;
    bytes.addAll(utf8.encode(value.substring(position, end)));
    position = end;
  }
  // A prefix avoids Dart's BOM stripping; URL fragments preserve U+FEFF.
  return utf8.decode(bytes, allowMalformed: true).substring(1);
}
