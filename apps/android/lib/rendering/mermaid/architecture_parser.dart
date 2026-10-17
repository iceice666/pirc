import 'architecture_model.dart';

/// Parses the native, intentionally bounded subset of Mermaid 11.17.2
/// `architecture-beta` into semantic groups, services, junctions and edges.
///
/// The statement forms and edge fields follow the pinned Mermaid Architecture
/// parser/DB. Config directives and external Iconify namespaces are rejected
/// with a diagnostic because their browser-side expansion cannot be represented
/// by the native vector renderer.
NativeMermaidArchitectureDiagram parseNativeMermaidArchitecture(String source) {
  final normalized = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  if (normalized.length > 50000) {
    throw const FormatException(
      'Mermaid architecture exceeds the default 50000 character limit',
    );
  }
  return _ArchitectureParser(normalized).parse();
}

class _ArchitectureParser {
  _ArchitectureParser(this.source);

  final String source;
  final groups = <NativeMermaidArchitectureGroup>[];
  final services = <NativeMermaidArchitectureService>[];
  final junctions = <NativeMermaidArchitectureJunction>[];
  final edges = <NativeMermaidArchitectureEdge>[];
  final alignments = <NativeMermaidArchitectureAlignment>[];
  final ids = <String, ({String kind, int line})>{};
  final groupLines = <String, int>{};
  bool headerSeen = false;
  String title = '';
  String accessibleTitle = '';
  String accessibleDescription = '';

  static final _id = RegExp(r'^[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?');
  static final _icon = RegExp(r'^\(([\w:-]+)\)');
  static final _parent = RegExp(
    r'^in[\t ]+([A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?)$',
  );
  static final _statementPrefix = RegExp(
    r'^(group|service|junction|align)[\t ]+',
  );
  static final _edge = RegExp(
    r"""^([A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?)(\{group\})?[\t ]*:[\t ]*([LRTB])[\t ]*([<>])?[\t ]*(--|-[\t ]*\[(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\[\]\r\n]+)\][\t ]*-)[\t ]*([<>])?[\t ]*([LRTB])[\t ]*:[\t ]*([A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?)(\{group\})?$""",
  );
  static final _alignment = RegExp(
    r'^align[\t ]+(row|column)[\t ]+([A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?(?:[\t ]+[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?)+)$',
  );

  NativeMermaidArchitectureDiagram parse() {
    final lines = source.split('\n');
    for (var index = 0; index < lines.length; index++) {
      final lineNumber = index + 1;
      var line = lines[index].trim();
      if (line.isEmpty) continue;
      if (line.startsWith('%%{')) {
        invalid('Mermaid configuration directives are unsupported', lineNumber);
      }
      if (line.startsWith('---')) {
        invalid('YAML frontmatter is unsupported', lineNumber);
      }
      line = _stripComment(line).trimRight();
      if (line.isEmpty) continue;

      if (!headerSeen) {
        if (line != 'architecture-beta') {
          invalid('Expected architecture-beta header', lineNumber);
        }
        headerSeen = true;
        continue;
      }

      if (line == 'architecture-beta') {
        invalid('Duplicate architecture-beta header', lineNumber);
      }
      if (_parseTitle(line)) continue;
      if (_parseAccessibility(line, lineNumber)) continue;

      final statement = _statementPrefix.firstMatch(line);
      if (statement != null) {
        final declaration = line.substring(statement.end);
        switch (statement.group(1)) {
          case 'group':
            _parseGroup(declaration, lineNumber);
            break;
          case 'service':
            _parseService(declaration, lineNumber);
            break;
          case 'junction':
            _parseJunction(declaration, lineNumber);
            break;
          case 'align':
            _parseAlignment(line, lineNumber);
            break;
        }
      } else if (_edge.hasMatch(line)) {
        _parseEdge(line, lineNumber);
      } else {
        invalid('Unsupported architecture statement "$line"', lineNumber);
      }
    }

    if (!headerSeen) {
      throw const FormatException('Missing Mermaid architecture-beta header');
    }
    _validateMembershipsAndReferences();
    return NativeMermaidArchitectureDiagram(
      groups: groups,
      services: services,
      junctions: junctions,
      edges: edges,
      alignments: alignments,
      title: title,
      accessibleTitle: accessibleTitle,
      accessibleDescription: accessibleDescription,
    );
  }

  String _stripComment(String line) {
    var quote = '';
    var bracketDepth = 0;
    var escaped = false;
    for (var index = 0; index < line.length; index++) {
      final char = line[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char == r'\') {
        escaped = true;
        continue;
      }
      if (quote.isNotEmpty) {
        if (char == quote) quote = '';
        continue;
      }
      if (char == '"' || char == "'") {
        quote = char;
      } else if (char == '[') {
        bracketDepth++;
      } else if (char == ']' && bracketDepth > 0) {
        bracketDepth--;
      } else if (char == '%' &&
          index + 1 < line.length &&
          line[index + 1] == '%' &&
          bracketDepth == 0) {
        return line.substring(0, index);
      }
    }
    return line;
  }

  bool _parseTitle(String line) {
    final match = RegExp(r'^title(?:[\t ]+([^\r\n]*))?$').firstMatch(line);
    if (match == null) return false;
    title = (match.group(1) ?? '').trim();
    return true;
  }

  bool _parseAccessibility(String line, int lineNumber) {
    final accTitle = RegExp(r'^accTitle[\t ]*:[\t ]*(.*)$').firstMatch(line);
    if (accTitle != null) {
      accessibleTitle = accTitle
          .group(1)!
          .trim()
          .replaceAll(RegExp(r'[\t ]{2,}'), ' ');
      return true;
    }
    final accDescr = RegExp(r'^accDescr[\t ]*:[\t ]*(.*)$').firstMatch(line);
    if (accDescr != null) {
      accessibleDescription = accDescr
          .group(1)!
          .trim()
          .replaceAll(RegExp(r'[\t ]{2,}'), ' ');
      return true;
    }
    if (RegExp(r'^accDescr\s*\{').hasMatch(line)) {
      final description = StringBuffer();
      var current = line.substring(line.indexOf('{') + 1);
      var close = current.indexOf('}');
      while (true) {
        if (close >= 0) {
          description.write(current.substring(0, close));
          if (current.substring(close + 1).trim().isNotEmpty) {
            invalid('Unexpected content after accDescr block', lineNumber);
          }
          break;
        }
        description.writeln(current);
        // A multiline block is consumed from the original source in the main
        // loop; keeping this form explicit avoids silently reinterpreting it.
        invalid('Multiline accDescr blocks are unsupported', lineNumber);
      }
      accessibleDescription = description
          .toString()
          .replaceAll(RegExp(r'^\s*', multiLine: true), '')
          .replaceAll(RegExp(r'\s+$', multiLine: true), '')
          .replaceAll(RegExp(r'[\t ]{2,}'), ' ')
          .replaceAll(RegExp(r'[\n\r]{2,}'), '\n');
      return true;
    }
    return false;
  }

  void _parseGroup(String declaration, int line) {
    final parsed = _parseDeclaration(declaration, line, 'group');
    _register(parsed.id, 'group', line);
    final group = NativeMermaidArchitectureGroup(
      id: parsed.id,
      icon: _parseIcon(parsed.iconName, parsed.id, line),
      title: parsed.title,
      parentId: parsed.parentId,
      sourceLine: line,
    );
    groups.add(group);
    groupLines[group.id] = line;
  }

  void _parseService(String declaration, int line) {
    final parsed = _parseDeclaration(declaration, line, 'service');
    _register(parsed.id, 'service', line);
    services.add(
      NativeMermaidArchitectureService(
        id: parsed.id,
        icon: _parseIcon(parsed.iconName, parsed.id, line),
        title: parsed.title,
        parentId: parsed.parentId,
        sourceLine: line,
      ),
    );
  }

  void _parseJunction(String declaration, int line) {
    var rest = declaration.trim();
    final idMatch = _id.matchAsPrefix(rest);
    if (idMatch == null) invalid('Expected junction id', line);
    final id = idMatch.group(0)!;
    rest = rest.substring(id.length).trim();
    String? parentId;
    if (rest.isNotEmpty) {
      final parent = _parent.firstMatch(rest);
      if (parent == null) invalid('Malformed junction declaration', line);
      parentId = parent.group(1);
    }
    _register(id, 'junction', line);
    junctions.add(
      NativeMermaidArchitectureJunction(
        id: id,
        parentId: parentId,
        sourceLine: line,
      ),
    );
  }

  ({String id, String? iconName, String? title, String? parentId})
  _parseDeclaration(String declaration, int line, String kind) {
    var rest = declaration.trim();
    final idMatch = _id.matchAsPrefix(rest);
    if (idMatch == null) invalid('Expected $kind id', line);
    final id = idMatch.group(0)!;
    rest = rest.substring(id.length).trimLeft();

    String? iconName;
    final icon = _icon.matchAsPrefix(rest);
    if (icon != null) {
      iconName = icon.group(1);
      rest = rest.substring(icon.end).trimLeft();
    }

    String? label;
    if (rest.startsWith('[')) {
      final titleEnd = _closingTitle(rest, line);
      label = _decodeTitle(rest.substring(1, titleEnd));
      rest = rest.substring(titleEnd + 1).trimLeft();
    }

    String? parentId;
    if (rest.isNotEmpty) {
      final parent = _parent.firstMatch(rest);
      if (parent == null) {
        invalid('Malformed $kind declaration for "$id"', line);
      }
      parentId = parent.group(1);
      rest = '';
    }
    if (rest.isNotEmpty) invalid('Unexpected content in $kind "$id"', line);
    return (id: id, iconName: iconName, title: label, parentId: parentId);
  }

  int _closingTitle(String value, int line) {
    var quote = '';
    var escaped = false;
    for (var i = 1; i < value.length; i++) {
      final char = value[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char == r'\') {
        escaped = true;
        continue;
      }
      if (quote.isNotEmpty) {
        if (char == quote) quote = '';
      } else if (char == '"' || char == "'") {
        quote = char;
      } else if (char == ']') {
        return i;
      }
    }
    invalid('Unterminated architecture label', line);
  }

  String _decodeTitle(String content) {
    var value = content.trim();
    if (value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'")))) {
      value = value.substring(1, value.length - 1);
      value = value.replaceAll(r'\"', '"').replaceAll(r"\'", "'");
    }
    return value.trim();
  }

  NativeMermaidArchitectureIcon? _parseIcon(
    String? icon,
    String ownerId,
    int line,
  ) {
    if (icon == null) return null;
    if (icon.contains(':')) {
      invalid(
        'Icon "$icon" uses a namespaced icon pack; only native architecture icons are supported',
        line,
      );
    }
    return switch (icon) {
      'cloud' => NativeMermaidArchitectureIcon.cloud,
      'database' => NativeMermaidArchitectureIcon.database,
      'disk' => NativeMermaidArchitectureIcon.disk,
      'internet' => NativeMermaidArchitectureIcon.internet,
      'server' => NativeMermaidArchitectureIcon.server,
      _ => throw FormatException(
        'Invalid Mermaid architecture at line $line: unknown built-in icon "$icon" on "$ownerId"',
      ),
    };
  }

  void _parseEdge(String lineText, int line) {
    final match = _edge.firstMatch(lineText)!;
    final sourceId = match.group(1)!;
    final sourceGroup = match.group(2) != null;
    final sourceDirection = _direction(match.group(3)!, line);
    final lhsArrow = match.group(4);
    final dash = match.group(5)!;
    final rhsArrow = match.group(6);
    final targetDirection = _direction(match.group(7)!, line);
    final targetId = match.group(8)!;
    final targetGroup = match.group(9) != null;
    String? edgeTitle;
    if (dash != '--') {
      final start = dash.indexOf('[');
      final end = dash.lastIndexOf(']');
      if (start < 0 || end <= start) invalid('Malformed edge label', line);
      edgeTitle = _decodeTitle(dash.substring(start + 1, end));
    }
    edges.add(
      NativeMermaidArchitectureEdge(
        sourceId: sourceId,
        sourceDirection: sourceDirection,
        sourceInto: lhsArrow != null,
        sourceGroup: sourceGroup,
        targetId: targetId,
        targetDirection: targetDirection,
        targetInto: rhsArrow != null,
        targetGroup: targetGroup,
        title: edgeTitle,
        sourceLine: line,
      ),
    );
    if (edges.length > 500) {
      invalid('Architecture diagram exceeds the 500 edge safety limit', line);
    }
  }

  NativeMermaidArchitectureDirection _direction(
    String value,
    int line,
  ) => switch (value) {
    'L' => NativeMermaidArchitectureDirection.left,
    'R' => NativeMermaidArchitectureDirection.right,
    'T' => NativeMermaidArchitectureDirection.top,
    'B' => NativeMermaidArchitectureDirection.bottom,
    _ => throw FormatException(
      'Invalid Mermaid architecture at line $line: invalid port direction "$value"',
    ),
  };

  void _parseAlignment(String lineText, int line) {
    final match = _alignment.firstMatch(lineText);
    if (match == null) invalid('Malformed align directive', line);
    final members = match.group(2)!.trim().split(RegExp(r'[\t ]+'));
    if (members.length < 2) {
      invalid('Align directive needs at least two members', line);
    }
    if (members.toSet().length != members.length) {
      invalid('Align directive repeats a member', line);
    }
    alignments.add(
      NativeMermaidArchitectureAlignment(
        direction: match.group(1)!,
        members: List.unmodifiable(members),
        sourceLine: line,
      ),
    );
  }

  void _register(String id, String kind, int line) {
    final previous = ids[id];
    if (previous != null) {
      invalid(
        '$kind id "$id" is already used by ${previous.kind} declared at line ${previous.line}',
        line,
      );
    }
    ids[id] = (kind: kind, line: line);
    if (ids.length > 200) {
      invalid(
        'Architecture diagram exceeds the 200 node/group safety limit',
        line,
      );
    }
  }

  void _validateMembershipsAndReferences() {
    final groupById = {for (final group in groups) group.id: group};
    final nodeParent = <String, String?>{};
    for (final group in groups) {
      final parent = group.parentId;
      if (parent == null) continue;
      final parentGroup = groupById[parent];
      if (parentGroup == null) {
        invalid(
          'Group "${group.id}" references missing parent group "$parent"',
          group.sourceLine,
        );
      }
      nodeParent[group.id] = parent;
    }
    // Diagnose cycles before declaration ordering, so a forward reference that
    // closes a cycle reports the structural error rather than only its order.
    for (final group in groups) {
      final visited = <String>{};
      String? current = group.id;
      while (current != null) {
        if (!visited.add(current)) {
          invalid(
            'Group membership cycle includes "$current"',
            group.sourceLine,
          );
        }
        current = nodeParent[current];
      }
    }
    // The source DB only accepts previously declared group parents.
    for (final group in groups) {
      final parent = group.parentId;
      if (parent != null && groupLines[parent]! >= group.sourceLine) {
        invalid(
          'Parent group "$parent" must be declared before nested group "${group.id}"',
          group.sourceLine,
        );
      }
    }
    for (final service in services) {
      _validateNodeParent(
        service.id,
        service.parentId,
        service.sourceLine,
        groupById,
      );
    }
    for (final junction in junctions) {
      _validateNodeParent(
        junction.id,
        junction.parentId,
        junction.sourceLine,
        groupById,
      );
    }
    final nodeIds = {
      ...services.map((n) => n.id),
      ...junctions.map((n) => n.id),
    };
    for (final edge in edges) {
      if (!nodeIds.contains(edge.sourceId)) {
        if (groupById.containsKey(edge.sourceId)) {
          invalid(
            'Edge endpoint "${edge.sourceId}" is a group; edges must connect services or junctions',
            edge.sourceLine,
          );
        }
        invalid(
          'Edge references missing service or junction "${edge.sourceId}"',
          edge.sourceLine,
        );
      }
      if (!nodeIds.contains(edge.targetId)) {
        if (groupById.containsKey(edge.targetId)) {
          invalid(
            'Edge endpoint "${edge.targetId}" is a group; edges must connect services or junctions',
            edge.sourceLine,
          );
        }
        invalid(
          'Edge references missing service or junction "${edge.targetId}"',
          edge.sourceLine,
        );
      }
    }
    for (final alignment in alignments) {
      for (final member in alignment.members) {
        if (!nodeIds.contains(member)) {
          invalid(
            'align ${alignment.direction} references unknown service or junction "$member"',
            alignment.sourceLine,
          );
        }
      }
    }
  }

  void _validateNodeParent(
    String nodeId,
    String? parentId,
    int line,
    Map<String, NativeMermaidArchitectureGroup> groupById,
  ) {
    if (parentId != null && !groupById.containsKey(parentId)) {
      invalid(
        'Node "$nodeId" references missing parent group "$parentId"',
        line,
      );
    }
  }

  Never invalid(String message, [int? line]) => throw FormatException(
    'Invalid Mermaid architecture${line == null ? '' : ' at line $line'}: $message',
  );
}
