import 'sankey_model.dart';

/// Parses the CSV subset accepted by the pinned Mermaid Sankey parser.
///
/// Quoted fields may contain commas and doubled quotes. The upstream lexer is
/// ASCII-only; non-ASCII input is rejected explicitly rather than being
/// silently changed by this parser. Link order and duplicate links are kept.
NativeSankeyDiagram parseNativeMermaidSankey(String source) {
  if (source.length > 50000) {
    throw const FormatException('Sankey input exceeds 50000 characters.');
  }
  final normalized = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  final lines = normalized
      .split('\n')
      .map((line) => line.trim())
      .where((line) => line.isNotEmpty)
      .toList(growable: false);
  if (lines.isEmpty ||
      !RegExp(
        r'^sankey(?:-beta)?$',
        caseSensitive: false,
      ).hasMatch(lines.first)) {
    throw const FormatException('Expected a sankey or sankey-beta header.');
  }

  final nodes = <NativeSankeyNode>[];
  final nodeIndices = <String, int>{};
  final flows = <NativeSankeyFlow>[];
  for (var lineIndex = 1; lineIndex < lines.length; lineIndex++) {
    final row = _parseCsvRow(lines[lineIndex], lineIndex + 1);
    if (row.length != 3) {
      throw FormatException(
        'Sankey row ${lineIndex + 1} must have source, target, and value fields.',
      );
    }
    final sourceId = row[0].trim();
    final targetId = row[1].trim();
    final numberText = row[2].trim();
    if (sourceId.isEmpty || targetId.isEmpty) {
      throw FormatException(
        'Sankey row ${lineIndex + 1} has an empty node id.',
      );
    }
    final value = double.tryParse(numberText);
    if (value == null || !value.isFinite || value < 0) {
      throw FormatException(
        'Sankey row ${lineIndex + 1} has an unsupported flow value: $numberText',
      );
    }
    for (final field in [sourceId, targetId]) {
      nodeIndices.putIfAbsent(field, () {
        final index = nodes.length;
        nodes.add(NativeSankeyNode(id: field, index: index));
        return index;
      });
    }
    flows.add(
      NativeSankeyFlow(
        sourceId: sourceId,
        targetId: targetId,
        value: value,
        index: flows.length,
      ),
    );
  }
  if (flows.isEmpty) {
    throw const FormatException('Sankey needs at least one flow row.');
  }
  return NativeSankeyDiagram(nodes: nodes, flows: flows);
}

List<String> _parseCsvRow(String line, int lineNumber) {
  final fields = <String>[];
  var index = 0;
  while (true) {
    final buffer = StringBuffer();
    final quoted = index < line.length && line[index] == '"';
    if (quoted) {
      index++;
      var closed = false;
      while (index < line.length) {
        final character = line[index++];
        if (character == '"') {
          if (index < line.length && line[index] == '"') {
            buffer.write('"');
            index++;
          } else {
            closed = true;
            break;
          }
        } else {
          _requireSourceAscii(character, lineNumber);
          buffer.write(character);
        }
      }
      if (!closed) {
        throw FormatException(
          'Unclosed quoted field on Sankey row $lineNumber.',
        );
      }
      if (index < line.length && line[index] != ',') {
        throw FormatException(
          'Unexpected text after a quoted field on Sankey row $lineNumber.',
        );
      }
    } else {
      while (index < line.length && line[index] != ',') {
        final character = line[index++];
        if (character == '"') {
          throw FormatException(
            'Unexpected quote in an unquoted field on Sankey row $lineNumber.',
          );
        }
        _requireSourceAscii(character, lineNumber);
        buffer.write(character);
      }
    }
    fields.add(buffer.toString());
    if (index == line.length) break;
    // The parser's CSV grammar retains a trailing empty field; numeric
    // conversion below then rejects its NaN value.
    index++;
    if (index == line.length) {
      fields.add('');
      break;
    }
  }
  return fields;
}

void _requireSourceAscii(String character, int lineNumber) {
  final code = character.codeUnitAt(0);
  if (code < 0x20 || code > 0x7e) {
    throw FormatException(
      'Sankey row $lineNumber contains characters outside the pinned ASCII parser subset.',
    );
  }
}
