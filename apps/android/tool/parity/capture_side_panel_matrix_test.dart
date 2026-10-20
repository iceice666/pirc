import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/panels.dart';
import 'package:pirc_mobile/live/side_panel.dart';

import '../../test/live_test.dart' show FakeGateway, theme;
import 'capture_fonts.dart';

const _matrixPath = '../../fixtures/mobile-parity/side-panel-matrix.json';
const _outputPath = 'build/parity/side-panel-matrix-native.json';
const _progressPath = 'build/parity/side-panel-matrix-native.ndjson';
const _pngPath = 'build/parity/side-panel-matrix-native';

Map<String, dynamic> _map(Object? value) =>
    (value as Map).map((key, value) => MapEntry('$key', value));
double _number(Object? value) => (value as num).toDouble();

Map<String, double> _rect(Rect rect) => {
  'x': rect.left,
  'y': rect.top,
  'width': rect.width,
  'height': rect.height,
  'top': rect.top,
  'right': rect.right,
  'bottom': rect.bottom,
  'left': rect.left,
};

Rect _globalRect(RenderBox box) => Rect.fromPoints(
  box.localToGlobal(Offset.zero),
  box.localToGlobal(Offset(box.size.width, box.size.height)),
);

Rect? _intersection(Rect rect, List<Rect> clips) {
  var clipped = rect;
  for (final clip in clips) {
    clipped = clipped.intersect(clip);
    if (clipped.isEmpty) return null;
  }
  return clipped;
}

bool? _tristateValue(ui.Tristate value) =>
    value == ui.Tristate.none ? null : value == ui.Tristate.isTrue;

Map<String, dynamic> _semanticsMetadata(WidgetTester tester, Element element) {
  try {
    final node = tester.getSemantics(
      find.byElementPredicate((candidate) => identical(candidate, element)),
    );
    final data = node.getSemanticsData();
    return {
      'semanticsLabel': data.label.isEmpty ? null : data.label,
      'semanticsHint': data.attributedHint.string.isEmpty
          ? null
          : data.attributedHint.string,
      'semanticsTooltip': data.tooltip.isEmpty ? null : data.tooltip,
      'semanticsValue': data.attributedValue.string.isEmpty
          ? null
          : data.attributedValue.string,
      'semanticsRole': data.role == SemanticsRole.none ? null : data.role.name,
      'semanticsSelected': _tristateValue(data.flagsCollection.isSelected),
      'semanticsEnabled': _tristateValue(data.flagsCollection.isEnabled),
      'semanticsTextField': data.flagsCollection.isTextField,
    };
  } catch (_) {
    return {
      'semanticsLabel': null,
      'semanticsHint': null,
      'semanticsTooltip': null,
      'semanticsValue': null,
      'semanticsRole': null,
      'semanticsSelected': null,
      'semanticsEnabled': null,
      'semanticsTextField': null,
    };
  }
}

List<Rect> _clipRects(WidgetTester tester, RenderBox box, Rect contentRect) {
  final screen = tester.view.physicalSize / tester.view.devicePixelRatio;
  final result = <Rect>[contentRect, Offset.zero & screen];
  RenderObject? ancestor = box.parent;
  while (ancestor != null) {
    if (ancestor is RenderBox &&
        ancestor is RenderAbstractViewport &&
        ancestor.hasSize) {
      result.add(_globalRect(ancestor));
    }
    ancestor = ancestor.parent;
  }
  return result;
}

Map<String, dynamic> _visibleSelection(
  RenderBox renderBox,
  String text,
  List<Rect> clips,
  Iterable<ui.TextBox> Function(TextSelection) getBoxesForSelection,
) {
  final tokens = <Map<String, dynamic>>[];
  final visibleBoxes = <Map<String, double>>[];
  final tokenPattern = RegExp(r'\s+|[^\s]+', unicode: true);
  for (final match in tokenPattern.allMatches(text)) {
    final boxes = getBoxesForSelection(
      TextSelection(baseOffset: match.start, extentOffset: match.end),
    );
    final raw = <Map<String, double>>[];
    final visible = <Map<String, double>>[];
    for (final textBox in boxes) {
      final global = MatrixUtils.transformRect(
        renderBox.getTransformTo(null),
        textBox.toRect(),
      );
      final rawRect = _rect(global);
      raw.add(rawRect);
      final clipped = _intersection(global, clips);
      if (clipped != null) visible.add(_rect(clipped));
    }
    if (visible.isEmpty) continue;
    visibleBoxes.addAll(visible);
    tokens.add({
      'text': match.group(0),
      'textRects': raw,
      'visibleTextRects': visible,
    });
  }
  return {
    'visibleTokens': tokens,
    'visibleTextRects': visibleBoxes,
    'visibleText': tokens.map((token) => token['text']).join(),
  };
}

String _color(Color? color) => color == null
    ? ''
    : '#${color.toARGB32().toRadixString(16).padLeft(8, '0')}';

TextStyle? _spanStyle(InlineSpan span) => span is TextSpan ? span.style : null;

Map<String, dynamic> _paragraph(RenderParagraph paragraph) {
  final box = paragraph;
  final span = box.text;
  final style = _spanStyle(span);
  final baseSize = style?.fontSize;
  final renderedSize = baseSize == null ? null : box.textScaler.scale(baseSize);
  final text = span.toPlainText(includeSemanticsLabels: false);
  final selectionBoxes = text.isEmpty
      ? <ui.TextBox>[]
      : box.getBoxesForSelection(
          TextSelection(baseOffset: 0, extentOffset: text.length),
        );
  return {
    'text': text,
    'rect': _rect(_globalRect(box)),
    'style': {
      'fontFamily': style?.fontFamily,
      'fontSize': baseSize,
      'renderedFontSize': renderedSize,
      'fontWeight': style?.fontWeight?.value,
      'lineHeightFactor': style?.height,
      'letterSpacing': style?.letterSpacing,
      'color': _color(style?.color),
    },
    'selectionBoxes': [
      for (final textBox in selectionBoxes)
        {
          'x': MatrixUtils.transformRect(
            box.getTransformTo(null),
            textBox.toRect(),
          ).left,
          'y': MatrixUtils.transformRect(
            box.getTransformTo(null),
            textBox.toRect(),
          ).top,
          'width': textBox.right - textBox.left,
          'height': textBox.bottom - textBox.top,
        },
    ],
    'textScale': box.textScaler.scale(1),
  };
}

String _elementLabel(Element element) {
  final parts = <String>[];
  void visit(Element current) {
    final widget = current.widget;
    if (widget is Text) {
      final text = widget.data ?? widget.textSpan?.toPlainText();
      if (text != null && text.trim().isNotEmpty) parts.add(text.trim());
    } else if (widget is RichText) {
      final text = widget.text.toPlainText(includeSemanticsLabels: false);
      if (text.trim().isNotEmpty) parts.add(text.trim());
    }
    current.visitChildren(visit);
  }

  visit(element);
  return parts.toSet().join(' ');
}

String _controlTextKey(Object? value) => '${value ?? ''}'
    .replaceAll(RegExp(r'[\uE000-\uF8FF\uFFFC]'), ' ')
    .replaceAll(RegExp(r'\s+'), ' ')
    .trim()
    .toLowerCase();

bool _sameControlRect(Object? first, Object? second) {
  if (first is! Map || second is! Map) return false;
  return ['x', 'y', 'width', 'height'].every((key) {
    final a = first[key], b = second[key];
    return a is num && b is num && (a - b).abs() < .01;
  });
}

Map<String, dynamic>? _elementTextStyle(Element element) {
  Map<String, dynamic>? result;
  void visit(Element current) {
    if (result != null) return;
    final widget = current.widget;
    if (widget is RichText) {
      final spanStyle = _spanStyle(widget.text);
      final style = spanStyle ?? DefaultTextStyle.of(current).style;
      final size = style.fontSize;
      result = {
        'fontFamily': style.fontFamily,
        'fontSize': size,
        'renderedFontSize': size == null
            ? null
            : MediaQuery.textScalerOf(current).scale(size),
        'fontWeight': style.fontWeight?.value,
        'lineHeightFactor': style.height,
        'letterSpacing': style.letterSpacing,
        'color': _color(style.color),
      };
      return;
    }
    current.visitChildren(visit);
  }

  visit(element);
  return result;
}

bool _isControl(Widget widget) =>
    widget is TextButton ||
    widget is ElevatedButton ||
    widget is OutlinedButton ||
    widget is IconButton ||
    widget is InkWell ||
    widget is TextField ||
    widget is DropdownButton ||
    widget is PopupMenuButton ||
    (widget is Semantics && widget.properties.textField == true);

bool _isDescendantOf(Element element, Element ancestor) {
  var found = false;
  element.visitAncestorElements((candidate) {
    if (identical(candidate, ancestor)) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

bool? _controlEnabled(Widget widget) {
  if (widget is TextButton) return widget.onPressed != null;
  if (widget is ElevatedButton) return widget.onPressed != null;
  if (widget is OutlinedButton) return widget.onPressed != null;
  if (widget is IconButton) return widget.onPressed != null;
  if (widget is InkWell) return widget.onTap != null;
  if (widget is TextField) return widget.enabled;
  if (widget is DropdownButton) return widget.onChanged != null;
  if (widget is PopupMenuButton) return widget.enabled;
  return null;
}

Map<String, dynamic> _fixtureAtTime(
  Map<String, dynamic> fixture,
  DateTime now,
) {
  final copy = _map(jsonDecode(jsonEncode(fixture)));
  final delta = now.millisecondsSinceEpoch - (copy['now'] as num).toInt();

  void shiftInstants(Object? value) {
    if (value is List) {
      for (final child in value) {
        shiftInstants(child);
      }
      return;
    }
    if (value is! Map) return;
    for (final key in value.keys.toList()) {
      final child = value[key];
      if ((key == 'startedAt' || key == 'endedAt') && child is num) {
        value[key] = child + delta;
      } else {
        shiftInstants(child);
      }
    }
  }

  shiftInstants(copy);
  copy['now'] = now.millisecondsSinceEpoch;
  return copy;
}

List<Map<String, dynamic>> _collectParagraphs(
  WidgetTester tester,
  Finder root,
) {
  final found = <Map<String, dynamic>>[];
  final rootElement = tester.element(root);
  final rootObject = rootElement.renderObject;
  final contentRect = rootObject is RenderBox && rootObject.hasSize
      ? _globalRect(rootObject)
      : Rect.zero;
  void visit(Element element) {
    final widget = element.widget;
    if (widget is SelectableText) {
      final text = widget.data ?? widget.textSpan?.toPlainText();
      RenderBox? selectionRender;
      Iterable<ui.TextBox> Function(TextSelection)? getBoxesForSelection;
      String? renderedText;
      void findSelectionRenderer(Element child) {
        if (selectionRender != null) return;
        if (child.renderObject is RenderEditable) {
          final editable = child.renderObject! as RenderEditable;
          selectionRender = editable;
          renderedText = text;
          getBoxesForSelection = editable.getBoxesForSelection;
          return;
        }
        if (child.renderObject is RenderParagraph) {
          final paragraph = child.renderObject! as RenderParagraph;
          selectionRender = paragraph;
          renderedText = paragraph.text.toPlainText(
            includeSemanticsLabels: false,
          );
          getBoxesForSelection = paragraph.getBoxesForSelection;
          return;
        }
        child.visitChildren(findSelectionRenderer);
      }

      findSelectionRenderer(element);
      final actualSelectionRender = selectionRender;
      final actualRenderedText = renderedText;
      final selectionBoxesForText = getBoxesForSelection;
      final render = actualSelectionRender ?? element.renderObject;
      if (text != null &&
          text.trim().isNotEmpty &&
          render is RenderBox &&
          actualSelectionRender != null &&
          actualRenderedText != null &&
          selectionBoxesForText != null) {
        final style = widget.style;
        final clipRects = _clipRects(tester, render, contentRect);
        final boxes = selectionBoxesForText(
          TextSelection(baseOffset: 0, extentOffset: actualRenderedText.length),
        );
        found.add({
          'text': text,
          'sourceWidget': 'SelectableText',
          'rect': _rect(_globalRect(render)),
          'style': {
            'fontFamily': style?.fontFamily,
            'fontSize': style?.fontSize,
            'fontWeight': style?.fontWeight?.value,
            'lineHeightFactor': style?.height,
            'letterSpacing': style?.letterSpacing,
            'color': _color(style?.color),
          },
          'textScale': MediaQuery.textScalerOf(element).scale(1),
          'selectionRenderer': actualSelectionRender is RenderEditable
              ? 'RenderEditable'
              : actualSelectionRender is RenderParagraph
              ? 'RenderParagraph'
              : null,
          'selectionBoxes': [
            for (final textBox in boxes)
              {
                'x': MatrixUtils.transformRect(
                  actualSelectionRender.getTransformTo(null),
                  textBox.toRect(),
                ).left,
                'y': MatrixUtils.transformRect(
                  actualSelectionRender.getTransformTo(null),
                  textBox.toRect(),
                ).top,
                'width': textBox.right - textBox.left,
                'height': textBox.bottom - textBox.top,
              },
          ],
          'clipRects': clipRects.map(_rect).toList(),
          ..._visibleSelection(
            actualSelectionRender,
            actualRenderedText,
            clipRects,
            selectionBoxesForText,
          ),
        });
      }
      return;
    } else if (widget is RichText && element.renderObject is RenderParagraph) {
      final paragraph = element.renderObject! as RenderParagraph;
      final record = _paragraph(paragraph);
      final clipRects = _clipRects(tester, paragraph, contentRect);
      record['clipRects'] = clipRects.map(_rect).toList();
      record.addAll(
        _visibleSelection(
          paragraph,
          paragraph.text.toPlainText(includeSemanticsLabels: false),
          clipRects,
          paragraph.getBoxesForSelection,
        ),
      );
      if ('${record['text']}'.trim().isNotEmpty) found.add(record);
    }
    element.visitChildren(visit);
  }

  visit(rootElement);
  return found;
}

List<Map<String, dynamic>> _collectControls(WidgetTester tester, Finder root) {
  final found = <Map<String, dynamic>>[];
  final rootElement = tester.element(root);
  final rootObject = rootElement.renderObject;
  final contentRect = rootObject is RenderBox && rootObject.hasSize
      ? _globalRect(rootObject)
      : Rect.zero;
  void visit(Element element) {
    final widget = element.widget;
    if (_isControl(widget)) {
      final object = element.renderObject;
      if (object is RenderBox && object.hasSize) {
        final controlRect = _globalRect(object);
        final clipRects = _clipRects(tester, object, contentRect);
        final visibleRect = _intersection(controlRect, clipRects);
        final semantics = _semanticsMetadata(tester, element);
        final tooltip = widget is IconButton
            ? widget.tooltip
            : widget is PopupMenuButton
            ? widget.tooltip
            : null;
        found.add({
          '__element': element,
          'widget': widget.runtimeType.toString(),
          'key': widget.key?.toString(),
          'label': _elementLabel(element),
          'accessibleName': widget is TextField
              ? widget.decoration?.labelText ?? semantics['semanticsLabel']
              : tooltip ?? semantics['semanticsLabel'],
          'tooltip': tooltip ?? semantics['semanticsTooltip'],
          'semanticsLabel': semantics['semanticsLabel'],
          'semanticsHint': semantics['semanticsHint'],
          'semanticsRole': semantics['semanticsRole'],
          'semanticsSelected': semantics['semanticsSelected'],
          'semanticsEnabled': semantics['semanticsEnabled'],
          'semanticsTextField': semantics['semanticsTextField'],
          'enabled': widget is Semantics
              ? semantics['semanticsEnabled']
              : _controlEnabled(widget),
          'textStyle': _elementTextStyle(element),
          if (widget is TextField) ...{
            'value': widget.controller?.text,
            'placeholder': widget.decoration?.hintText,
            'readOnly': widget.readOnly,
            'obscureText': widget.obscureText,
            'maxLines': widget.maxLines,
            'keyboardType': widget.keyboardType.toString(),
          },
          if (widget is Semantics && widget.properties.textField == true) ...{
            'value': semantics['semanticsValue'],
            'placeholder': null,
            'readOnly': null,
            'obscureText': null,
            'maxLines': null,
            'keyboardType': null,
          },
          'rect': _rect(controlRect),
          'visibleRect': visibleRect == null ? null : _rect(visibleRect),
          'clipRects': clipRects.map(_rect).toList(),
        });
      }
    }
    element.visitChildren(visit);
  }

  visit(rootElement);
  // Keep a compound semantic text field as one user-facing record. If it wraps
  // a standard Flutter TextField, merge its accessible metadata into that
  // field instead of emitting a duplicate control.
  final duplicateSemanticFields = <Map<String, dynamic>>{};
  for (final compound in found.toList()) {
    if (compound['widget'] != 'Semantics' ||
        compound['semanticsTextField'] != true) {
      continue;
    }
    final ancestor = compound['__element'] as Element;
    for (final child in found) {
      if (child['widget'] != 'TextField' ||
          !_isDescendantOf(child['__element'] as Element, ancestor)) {
        continue;
      }
      for (final key in [
        'accessibleName',
        'semanticsLabel',
        'semanticsHint',
        'semanticsRole',
        'semanticsSelected',
        'semanticsEnabled',
        'semanticsTextField',
      ]) {
        child[key] ??= compound[key];
      }
      duplicateSemanticFields.add(compound);
      break;
    }
  }
  found.removeWhere(duplicateSemanticFields.contains);

  // Material buttons contain an InkWell for the same hit target. Keep the
  // semantic button record and avoid counting its internal gesture layer as a
  // second user-facing control; standalone InkWell rows remain in the capture.
  final controls = found.where((candidate) {
    if (candidate['widget'] != 'InkWell') return true;
    final candidateLabel = _controlTextKey(candidate['label']);
    return !found.any((other) {
      if (other['widget'] == 'InkWell') return false;
      return _sameControlRect(candidate['rect'], other['rect']) &&
          candidateLabel == _controlTextKey(other['label']);
    });
  });
  return controls.map((control) {
    final record = Map<String, dynamic>.of(control)..remove('__element');
    return record;
  }).toList();
}

List<Map<String, dynamic>> _collectIndicators(
  WidgetTester tester,
  Finder root,
) {
  final found = <Map<String, dynamic>>[];
  final rootElement = tester.element(root);
  final rootObject = rootElement.renderObject;
  final contentRect = rootObject is RenderBox && rootObject.hasSize
      ? _globalRect(rootObject)
      : Rect.zero;
  void visit(Element element) {
    final widget = element.widget;
    final isProgressSemantics =
        widget is Semantics &&
        widget.properties.role == SemanticsRole.progressBar;
    if (widget is ProgressIndicator || isProgressSemantics) {
      final object = element.renderObject;
      if (object is RenderBox && object.hasSize) {
        final indicatorRect = _globalRect(object);
        final clipRects = _clipRects(tester, object, contentRect);
        final visibleRect = _intersection(indicatorRect, clipRects);
        final value = widget is ProgressIndicator ? widget.value : null;
        final semantics = widget is Semantics ? widget : null;
        found.add({
          'widget': widget.runtimeType.toString(),
          'value': value,
          'valuePercent': value == null ? null : value * 100,
          'semanticsLabel': widget is ProgressIndicator
              ? widget.semanticsLabel
              : semantics?.properties.label,
          'semanticsValue': widget is ProgressIndicator
              ? widget.semanticsValue
              : semantics?.properties.value,
          'semanticsMinValue': semantics?.properties.minValue,
          'semanticsMaxValue': semantics?.properties.maxValue,
          'rect': _rect(indicatorRect),
          'visibleRect': visibleRect == null ? null : _rect(visibleRect),
          'clipRects': clipRects.map(_rect).toList(),
        });
      }
    }
    element.visitChildren(visit);
  }

  visit(rootElement);
  return found;
}

Map<String, dynamic> _requestRecord((String, Json) call) => {
  'method': call.$1,
  'path': call.$2['path'],
  'httpMethod': call.$2['method'] ?? 'GET',
  'body': call.$2['body'],
};

Map<String, int> _panelActivity(Json? panel) {
  final tasks = rows(
    panel?['backgroundTasks'],
  ).where((task) => task['status'] == 'running').length;
  final memory = obj(panel?['memoryRuntime'])['phase'] == null ? 0 : 1;
  return <String, int>{'tasks': tasks, 'memory': memory};
}

void main() {
  final matrix = _map(jsonDecode(File(_matrixPath).readAsStringSync()));
  final fixtureDirectory = Directory('../../fixtures/mobile-parity');
  final fixtures = <String, Map<String, dynamic>>{};
  for (final name in _map(matrix['contentFixtures']).values) {
    final path = '${fixtureDirectory.path}/$name';
    final fixture = _map(jsonDecode(File(path).readAsStringSync()));
    if (fixture['webRevision'] != matrix['webRevision']) {
      throw StateError('$name revision does not match the SidePanel matrix.');
    }
    fixtures['$name'] = fixture;
  }

  final chrome = fixtures['side-panel.json']!;
  final files = fixtures['files.json']!;
  final git = fixtures['git.json']!;
  final memory = fixtures['observational-memory.json']!;
  final tasks = fixtures['tasks.json']!;
  final terminal = fixtures['terminal.json']!;
  final browser = fixtures['browser.json']!;
  final completed = <Map<String, dynamic>>[];
  var fontsLoaded = false;

  setUpAll(() {
    Directory(_pngPath).createSync(recursive: true);
    File(_progressPath).writeAsStringSync('');
  });
  tearDownAll(() {
    File(_outputPath).writeAsStringSync(
      '${const JsonEncoder.withIndent('  ').convert({'schemaVersion': 1, 'fixtureId': matrix['id'], 'webRevision': matrix['webRevision'], 'caseCount': completed.length, 'cases': completed})}\n',
    );
  });

  for (final widthValue in matrix['widths'] as List) {
    final width = (widthValue as num).toInt();
    for (final viewValue in matrix['views'] as List) {
      final view = '$viewValue';
      for (final themeValue in matrix['themes'] as List) {
        final brightness = '$themeValue' == 'dark'
            ? Brightness.dark
            : Brightness.light;
        for (final scaleValue in matrix['textScales'] as List) {
          final scale = _number(scaleValue);
          final testId =
              '$width-$view-${brightness.name}-scale${scale.toStringAsFixed(0)}';

          testWidgets('SidePanel matrix $testId', (tester) async {
            if (!fontsLoaded) {
              await tester.runAsync(loadParityFonts);
              fontsLoaded = true;
            }
            debugDisableShadows = false;
            tester.view.devicePixelRatio = 1;
            tester.view.physicalSize = Size(
              width.toDouble(),
              _number(matrix['height']),
            );
            addTearDown(tester.view.reset);

            final gateway = FakeGateway();
            // Tasks show relative durations. Rebase their fixture timestamps
            // per capture so the displayed durations stay stable as the full
            // matrix runs, just as the Web harness freezes Date.now per page.
            final taskFixture = _fixtureAtTime(tasks, DateTime.now());
            final controller = LiveController(gateway)
              ..origin = 'http://parity.local'
              ..clientId = 'parity-client'
              ..sessionId = 's'
              ..control = {'held': true, 'generation': 3}
              ..state = {
                'run': {'status': 'idle'},
                'runnerStatus': 'ready',
              }
              ..connection = 'connected';

            gateway.handler = (method, args) async {
              if (method == 'request') {
                final path = '${args['path']}';
                final uri = Uri.parse(path);
                if (uri.path.endsWith('/panel/context')) {
                  return chrome['context'];
                }
                if (uri.path.endsWith('/panel/state')) {
                  return view == 'memory'
                      ? memory['panel']
                      : taskFixture['panel'];
                }
                if (uri.path.endsWith('/files/content')) {
                  final path = uri.queryParameters['path'];
                  for (final file in (files['files'] as Map).values) {
                    if (_map(file)['path'] == path) return file;
                  }
                  throw StateError('Unexpected file fixture path: $path');
                }
                if (uri.path.endsWith('/files')) {
                  return files['directory'];
                }
                if (uri.path.endsWith('/git/status')) {
                  return git['status'];
                }
                if (uri.path.endsWith('/git/log')) {
                  return git['log'];
                }
                if (uri.path.endsWith('/git/diff')) {
                  return git['diff'];
                }
                if (uri.path.contains('/git/commits/')) {
                  return git['commit'];
                }
                if (uri.path.contains('/panel/background/')) {
                  return taskFixture['output'];
                }
                if (uri.path.endsWith('/terminals')) {
                  return {'terminals': terminal['terminals']};
                }
                throw StateError('Unexpected SidePanel request: $path');
              }
              if (method == 'socketOpen') {
                final tag = '${args['tag']}';
                final path = '${args['path']}';
                scheduleMicrotask(() {
                  if (path.contains('/browser/stream')) {
                    gateway.stream.add({
                      'type': 'socketOpened',
                      'data': {'tag': tag},
                    });
                    for (final frame in [
                      {'type': 'state', 'state': browser['state']},
                      {'type': 'log', 'entries': browser['log']},
                      {
                        'type': 'frame',
                        'data': browser['image'],
                        'width': 640,
                        'height': 400,
                      },
                    ]) {
                      gateway.stream.add({
                        'type': 'socket',
                        'data': {'tag': tag, 'frame': frame},
                      });
                    }
                  } else if (path.contains('/terminals/')) {
                    gateway.stream.add({
                      'type': 'socket',
                      'data': {
                        'tag': tag,
                        'frame': {
                          'type': 'ready',
                          'replay': terminal['replay'],
                        },
                      },
                    });
                  }
                });
                return null;
              }
              if (method == 'socketClose' || method == 'socketSend') {
                return null;
              }
              throw StateError('Unexpected SidePanel gateway method: $method');
            };

            final nativeTab = view == 'terminal' ? 'terminals' : view;
            final overlay = width <= 860;
            final phone = width <= 650;
            final maxWidth = sidePanelMax(width.toDouble(), false);
            final panelWidth = overlay
                ? (phone ? width.toDouble() : 420.0)
                : 360.0.clamp(280, maxWidth).toDouble();
            final panelKey = GlobalKey();
            const activeContentKey = ValueKey('side-panel-active-content');
            final outputFile = File('$_pngPath/$testId.png');
            await tester.pumpWidget(
              RepaintBoundary(
                child: MaterialApp(
                  debugShowCheckedModeBanner: false,
                  locale: const Locale('en', 'US'),
                  theme: _captureTheme(brightness),
                  builder: (context, child) => MediaQuery(
                    data: MediaQuery.of(
                      context,
                    ).copyWith(textScaler: TextScaler.linear(scale)),
                    child: child!,
                  ),
                  home: Scaffold(
                    body: Stack(
                      children: [
                        Positioned(
                          top: 56,
                          right: overlay && !phone ? 8 : 0,
                          bottom: overlay && !phone ? 8 : 0,
                          width: panelWidth,
                          child: Builder(
                            builder: (context) => Container(
                              key: panelKey,
                              clipBehavior: Clip.antiAlias,
                              decoration: BoxDecoration(
                                borderRadius: overlay
                                    ? BorderRadius.vertical(
                                        top: const Radius.circular(20),
                                        bottom: Radius.circular(phone ? 0 : 20),
                                      )
                                    : null,
                                boxShadow: overlay
                                    ? [
                                        BoxShadow(
                                          color: Theme.of(context).dividerColor,
                                          spreadRadius: 1,
                                        ),
                                        BoxShadow(
                                          color: Colors.black.withValues(
                                            alpha: brightness == Brightness.dark
                                                ? .45
                                                : .12,
                                          ),
                                          offset: const Offset(0, 12),
                                          blurRadius: 40,
                                        ),
                                      ]
                                    : null,
                              ),
                              child: AnimatedBuilder(
                                animation: controller.panelData,
                                builder: (context, _) => NativeSidePanel(
                                  key: const ValueKey('native-side-panel'),
                                  tab: nativeTab,
                                  open: true,
                                  overlay: overlay,
                                  width: panelWidth,
                                  maxWidth: maxWidth,
                                  activity: _panelActivity(
                                    controller.panelData.value,
                                  ),
                                  touch: true,
                                  onSelect: (_) {},
                                  onResize: (_) {},
                                  child: KeyedSubtree(
                                    key: activeContentKey,
                                    child: WorkPanel(
                                      controller: controller,
                                      kind: nativeTab,
                                      onOpen: (_) {},
                                      onFile: (_) {},
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            );

            for (var frame = 0; frame < 12; frame++) {
              await tester.pump(const Duration(milliseconds: 50));
            }
            expect(tester.takeException(), isNull, reason: testId);
            expect(
              find.byKey(activeContentKey),
              findsOneWidget,
              reason: testId,
            );
            final rootFinder = find.byKey(panelKey);
            final activeFinder = find.byKey(activeContentKey);
            final panelBox = tester.renderObject<RenderBox>(rootFinder);
            final tabBox = tester.renderObject<RenderBox>(
              find.byKey(const Key('side-panel-tabs')),
            );
            final activeBox = tester.renderObject<RenderBox>(activeFinder);
            final nativeTabs = [
              for (final (id, label, _) in panelTabs)
                () {
                  final tabFinder = find.byKey(ValueKey('panel-tab-$id'));
                  expect(tabFinder, findsOneWidget, reason: '$testId $id tab');
                  final tabBox = tester.renderObject<RenderBox>(tabFinder);
                  final semantics = tester.getSemantics(tabFinder);
                  final semanticsData = semantics.getSemanticsData();
                  return {
                    'id': id,
                    'label': label,
                    'semanticsRole': semanticsData.role == SemanticsRole.none
                        ? null
                        : semanticsData.role.name,
                    'selected': id == nativeTab,
                    'semanticsSelected':
                        semantics.flagsCollection.isSelected ==
                        ui.Tristate.isTrue,
                    'rect': _rect(_globalRect(tabBox)),
                  };
                }(),
            ];
            // Web text/control records are scoped to [role=tabpanel]. Keep
            // native records scoped to that same active pane; tab controls are
            // recorded independently in tabs.items above.
            final paragraphs = _collectParagraphs(tester, activeFinder);
            final controls = _collectControls(tester, activeFinder);
            final indicators = _collectIndicators(tester, activeFinder);
            expect(
              paragraphs,
              isNotEmpty,
              reason: '$testId text measurement missing',
            );
            final requestCalls = gateway.calls
                .where((call) => call.$1 == 'request')
                .map(_requestRecord)
                .toList();
            final socketCalls = gateway.calls
                .where(
                  (call) => call.$1 == 'socketOpen' || call.$1 == 'socketSend',
                )
                .map(
                  (call) => {
                    'method': call.$1,
                    'tag': call.$2['tag'],
                    'path': call.$2['path'],
                  },
                )
                .toList();
            final socketFrames = gateway.calls
                .where((call) => call.$1 == 'socketOpen')
                .map((call) => '${call.$2['path']}')
                .toList();
            final id = testId;
            await tester.runAsync(() async {
              final image = await tester
                  .renderObject<RenderRepaintBoundary>(
                    find.byType(RepaintBoundary).first,
                  )
                  .toImage(pixelRatio: 1);
              try {
                final data = await image.toByteData(
                  format: ui.ImageByteFormat.png,
                );
                await outputFile.writeAsBytes(data!.buffer.asUint8List());
              } finally {
                image.dispose();
              }
            });
            final caseRecord = {
              'id': id,
              'config': {
                'width': width,
                'height': _number(matrix['height']),
                'theme': brightness.name,
                'scale': scale,
                'view': view,
                'nativeTab': nativeTab,
                'pointer': 'touch / coarse',
              },
              'source': {
                'component': 'NativeSidePanel + WorkPanel actual child pane',
                'layout':
                    'same production breakpoints and panel frame as web harness',
              },
              'runtimeFonts': {
                'themeFamily': _captureTheme(
                  brightness,
                ).textTheme.bodyMedium?.fontFamily,
                'comparisonAliases': [
                  'Arial',
                  'Roboto -> host Arial alias',
                  'Ahem -> host Arial alias',
                  'monospace -> Menlo host font',
                ],
                'bundledForApp': false,
              },
              'panel': _rect(_globalRect(panelBox)),
              'tabs': {
                'rect': _rect(_globalRect(tabBox)),
                'items': nativeTabs,
                'text': nativeTabs.map((tab) => tab['label']).toList(),
              },
              'activeContent': {
                'rect': _rect(_globalRect(activeBox)),
                'scrollables': _scrollMetrics(tester, activeFinder),
              },
              'textRuns': paragraphs,
              'controls': controls,
              'indicators': indicators,
              'canvasContent': view == 'terminal'
                  ? {'kind': 'xterm replay fixture', 'text': terminal['replay']}
                  : view == 'browser'
                  ? {
                      'kind': 'browser frame fixture',
                      'state': browser['state'],
                      'log': browser['log'],
                      'imageBytes': base64Decode('${browser['image']}').length,
                      'width': 640,
                      'height': 400,
                    }
                  : null,
              'apiRequests': requestCalls,
              'socketRequests': socketCalls,
              'socketPaths': socketFrames,
              'screenshot': outputFile.path,
              'visualParityAccepted': false,
            };
            completed.add(caseRecord);
            File(_progressPath).writeAsStringSync(
              '${jsonEncode(caseRecord)}\n',
              mode: FileMode.append,
            );
            await tester.pumpWidget(const SizedBox.shrink());
            controller.dispose();
            await gateway.stream.close();
            debugDisableShadows = true;
          });
        }
      }
    }
  }
}

ThemeData _captureTheme(Brightness brightness) {
  final base = theme.build(brightness);
  return base.copyWith(
    platform: TargetPlatform.android,
    textTheme: base.textTheme.apply(fontFamily: 'Arial'),
  );
}

List<Map<String, dynamic>> _scrollMetrics(WidgetTester tester, Finder subtree) {
  final scrollables = find.descendant(
    of: subtree,
    matching: find.byWidgetPredicate((widget) => widget is Scrollable),
  );
  final result = <Map<String, dynamic>>[];
  for (final finder in scrollables.evaluate()) {
    final context = finder;
    final widget = context.widget as Scrollable;
    final state = context.findAncestorStateOfType<ScrollableState>();
    final position = state?.position;
    result.add({
      'axis': widget.axisDirection.name,
      'pixels': position?.pixels,
      'maxScrollExtent': position?.maxScrollExtent,
      'viewportDimension': position?.viewportDimension,
    });
  }
  return result;
}
