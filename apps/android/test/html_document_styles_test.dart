import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:html/parser.dart' as html;
import 'package:pirc_mobile/rendering/html_document_styles.dart';

void main() {
  test(
    'root variables inherit through descendant, negation and nth-child selectors',
    () {
      final document = html.parse(
        '<html data-native-css-nth-0-root="original"><body><div class="item"></div></body></html>',
      );
      final before = Map<String, String>.from(
        document.documentElement!.attributes,
      );
      final result = NativeDocumentStyleEngine(
        stylesheets: [
          NativeDocumentStylesheet('''
        :root { --accent: red; color:red; }
        html { color:blue; }
        :root:nth-child(1) > body .item { background-color:var(--accent); }
        :not(:root) { border-top-color:blue; }
      ''', baseUrl: 'https://example.test/style.css'),
        ],
        viewportWidth: 390,
        dark: false,
      ).apply(document);
      expect(
        result.stylesByElement[document.documentElement]!['color'],
        '#f00',
      );
      expect(
        result.stylesByElement[document.querySelector(
          '.item',
        )]!['background-color'],
        '#f00',
      );
      expect(
        result.stylesByElement[document.documentElement]!['border-top-color'],
        isNull,
      );
      expect(
        result.stylesByElement[document.querySelector(
          '.item',
        )]!['border-top-color'],
        '#00f',
      );
      expect(
        {...document.documentElement!.attributes}..remove('style'),
        before,
      );
      expect(result.diagnostics, isEmpty);
    },
  );

  test('font shorthand fields match the real control-style Chrome fixture', () {
    final fixture = _readFixture('html-control-styles.json');
    final expected = _readFixture('html-control-styles-expected.json');
    final document = html.parse(fixture['responseHtml'] as String);
    final capture = (expected['captures'] as List)
        .cast<Map<String, dynamic>>()
        .firstWhere(
          (entry) => entry['width'] == 390 && entry['colorScheme'] == 'light',
        );
    final parsed = NativeDocumentStyleEngine(
      stylesheets: [
        NativeDocumentStylesheet(
          document.querySelector('style')!.text,
          baseUrl: expected['origin'] as String,
        ),
      ],
      viewportWidth: 390,
      dark: false,
    ).apply(document);
    final bodyStyle = parsed.stylesByElement[document.body]!;
    expect(bodyStyle['font-family'], 'Arial, sans-serif');
    expect(bodyStyle['font-size'], '16px');
    expect(bodyStyle['line-height'], '1.4');
    final oracleBodyFont = capture['initialDocument']['bodyFont'] as String;
    expect(oracleBodyFont, '16px / 22.4px Arial, sans-serif');

    final controls =
        capture['initialDocument']['controls'] as Map<String, dynamic>;
    for (final controlId in ['textExplicit', 'textareaExplicit']) {
      final expectedComputed =
          controls[controlId]['computed'] as Map<String, dynamic>;
      final control = document.querySelector(
        '#${controlId == 'textExplicit' ? 'text-explicit' : 'textarea-explicit'}',
      )!;
      final style = parsed.stylesByElement[control]!;
      expect(style['font-family'], expectedComputed['font-family']);
      expect(style['font-size'], expectedComputed['font-size']);
      expect(style['font-style'], expectedComputed['font-style']);
      expect(style['font-weight'], 'normal');
      expect(expectedComputed['font-weight'], '400');
      expect(style['line-height'], expectedComputed['line-height']);
    }

    final inherited =
        parsed.stylesByElement[document.querySelector('#text-inherit')!]!;
    expect(inherited['font-family'], 'inherit');
    expect(inherited['font-size'], 'inherit');
    expect(inherited['font-weight'], 'inherit');
    expect(inherited['font-style'], 'inherit');
    expect(inherited['line-height'], 'inherit');
    expect(
      parsed.diagnostics.where(
        (diagnostic) =>
            diagnostic.property == 'font' &&
            diagnostic.code == 'unsupported-shorthand',
      ),
      isEmpty,
    );
  });

  test(
    'font shorthand parses AST components and preserves quoted family lists',
    () {
      final document = html.parse('<p id="target"></p>');
      final result = NativeDocumentStyleEngine(
        stylesheets: [
          NativeDocumentStylesheet('''
          #target {
            font: italic small-caps 500 condensed 16px / 1.25 "A; B", "C, D", red, sans-serif;
          }
        ''', baseUrl: 'https://example.test/font.css'),
        ],
        viewportWidth: 390,
        dark: false,
      ).apply(document);
      final style = result.stylesByElement[document.querySelector('#target')]!;
      expect(style['font-style'], 'italic');
      expect(style['font-variant'], 'small-caps');
      expect(style['font-variant-caps'], 'small-caps');
      expect(style['font-weight'], '500');
      expect(style['font-stretch'], 'condensed');
      expect(style['font-size'], '16px');
      expect(style['line-height'], '1.25');
      expect(style['font-family'], '"A; B", "C, D", red, sans-serif');
      expect(result.diagnostics, isEmpty);
    },
  );

  test(
    'font shorthand resets omitted longhands and honors cascade priority',
    () {
      final document = html.parse('''
      <p id="reset"></p>
      <p id="priority"></p>
    ''');
      final result = NativeDocumentStyleEngine(
        stylesheets: [
          NativeDocumentStylesheet('''
          #reset {
            font-style: italic;
            font-size: 9px;
            font-weight: 700;
            font-variant: small-caps;
            font-stretch: condensed;
            line-height: 1.5;
          }
          #reset {
            font: 18px Arial;
          }
          #priority {
            font: 12px Arial !important;
            font: 14px Georgia;
            font-size: 20px;
            font-size: 24px !important;
            line-height: 30px !important;
          }
        ''', baseUrl: 'https://example.test/font.css'),
        ],
        viewportWidth: 390,
        dark: false,
      ).apply(document);

      final reset = result.stylesByElement[document.querySelector('#reset')]!;
      expect(reset['font-family'], 'Arial');
      expect(reset['font-size'], '18px');
      expect(reset['font-style'], 'normal');
      expect(reset['font-weight'], 'normal');
      expect(reset['font-variant'], 'normal');
      expect(reset['font-stretch'], 'normal');
      expect(reset['line-height'], 'normal');
      expect(reset['font-size-adjust'], 'none');
      expect(reset['font-kerning'], 'auto');

      final priority =
          result.stylesByElement[document.querySelector('#priority')]!;
      expect(priority['font-family'], 'Arial');
      expect(priority['font-size'], '24px');
      expect(priority['font-weight'], 'normal');
      expect(priority['line-height'], '30px');
    },
  );

  test('invalid font shorthand does not replace earlier valid font values', () {
    final document = html.parse('<p id="target"></p>');
    final result = NativeDocumentStyleEngine(
      stylesheets: [
        NativeDocumentStylesheet('''
          #target {
            font: italic 13px / 1.2 "A; B", serif;
            font: bold 14px;
          }
        ''', baseUrl: 'https://example.test/font.css'),
      ],
      viewportWidth: 390,
      dark: false,
    ).apply(document);
    final style = result.stylesByElement[document.querySelector('#target')]!;
    expect(style['font-family'], '"A; B", serif');
    expect(style['font-size'], '13px');
    expect(style['font-style'], 'italic');
    expect(style['line-height'], '1.2');
    expect(
      result.diagnostics.where(
        (diagnostic) =>
            diagnostic.property == 'font' &&
            diagnostic.code == 'unsupported-shorthand',
      ),
      hasLength(1),
    );
  });

  test('grid row and column shorthands expand supported line placements', () {
    final document = html.parse('''
      <p id="full"></p>
      <p id="span"></p>
      <p id="priority"></p>
      <p id="invalid"></p>
    ''');
    final result = NativeDocumentStyleEngine(
      stylesheets: [
        NativeDocumentStylesheet('''
          #full { grid-column: 1 / -1; grid-row: 2; }
          #span { grid-column: span 2; grid-row: span 3 / 7; }
          #priority {
            grid-column: 1 / -1 !important;
            grid-column-start: 2;
            grid-column-end: 5;
          }
          #invalid { grid-column: 4 / 8; grid-column: 0 / -1; }
        ''', baseUrl: 'https://example.test/grid.css'),
      ],
      viewportWidth: 390,
      dark: false,
    ).apply(document);

    Map<String, String> styleFor(String id) =>
        result.stylesByElement[document.querySelector('#$id')]!;

    expect(styleFor('full')['grid-column-start'], '1');
    expect(styleFor('full')['grid-column-end'], '-1');
    expect(styleFor('full')['grid-row-start'], '2');
    expect(styleFor('full')['grid-row-end'], 'auto');
    expect(styleFor('span')['grid-column-start'], 'span 2');
    expect(styleFor('span')['grid-column-end'], 'auto');
    expect(styleFor('span')['grid-row-start'], 'span 3');
    expect(styleFor('span')['grid-row-end'], '7');
    expect(styleFor('priority')['grid-column-start'], '1');
    expect(styleFor('priority')['grid-column-end'], '-1');
    expect(styleFor('invalid')['grid-column-start'], '4');
    expect(styleFor('invalid')['grid-column-end'], '8');
    expect(
      result.diagnostics.where(
        (diagnostic) =>
            diagnostic.property == 'grid-column' &&
            diagnostic.code == 'unsupported-shorthand',
      ),
      hasLength(1),
    );
  });

  test('border-radius shorthand expands corner radii and respects cascade', () {
    final document = html.parse('''
      <p id="one"></p>
      <p id="two"></p>
      <p id="three"></p>
      <p id="four"></p>
      <p id="priority"></p>
      <p id="invalid"></p>
    ''');
    final result = NativeDocumentStyleEngine(
      stylesheets: [
        NativeDocumentStylesheet('''
          #one { border-radius: 5px; }
          #two { border-radius: 2px 4px; }
          #three { border-radius: 1em 2em 3em; }
          #four { border-radius: 2px 4px 6px 8px / 10% 12% 14% 16%; }
          #priority {
            border-radius: 1px 2px 3px 4px !important;
            border-radius: 5px;
            border-top-left-radius: 9px !important;
          }
          #invalid { border-radius: 7px; border-radius: none; }
        ''', baseUrl: 'https://example.test/radius.css'),
      ],
      viewportWidth: 390,
      dark: false,
    ).apply(document);

    Map<String, String> styleFor(String id) =>
        result.stylesByElement[document.querySelector('#$id')]!;

    expect(styleFor('one')['border-top-left-radius'], '5px');
    expect(styleFor('one')['border-bottom-left-radius'], '5px');
    expect(styleFor('two')['border-top-left-radius'], '2px');
    expect(styleFor('two')['border-top-right-radius'], '4px');
    expect(styleFor('two')['border-bottom-right-radius'], '2px');
    expect(styleFor('two')['border-bottom-left-radius'], '4px');
    expect(styleFor('three')['border-top-left-radius'], '1em');
    expect(styleFor('three')['border-top-right-radius'], '2em');
    expect(styleFor('three')['border-bottom-right-radius'], '3em');
    expect(styleFor('three')['border-bottom-left-radius'], '2em');
    expect(styleFor('four')['border-top-left-radius'], '2px 10%');
    expect(styleFor('four')['border-top-right-radius'], '4px 12%');
    expect(styleFor('four')['border-bottom-right-radius'], '6px 14%');
    expect(styleFor('four')['border-bottom-left-radius'], '8px 16%');
    expect(styleFor('priority')['border-top-left-radius'], '9px');
    expect(styleFor('priority')['border-top-right-radius'], '2px');
    expect(styleFor('priority')['border-bottom-right-radius'], '3px');
    expect(styleFor('priority')['border-bottom-left-radius'], '4px');
    expect(styleFor('invalid')['border-top-left-radius'], '7px');
    expect(styleFor('invalid')['border-bottom-right-radius'], '7px');
    expect(
      result.diagnostics.where(
        (diagnostic) =>
            diagnostic.property == 'border-radius' &&
            diagnostic.code == 'unsupported-shorthand',
      ),
      hasLength(1),
    );
  });

  test('complete selectors and cascade priority are applied to the DOM', () {
    final document = html.parse('''
      <html><body>
        <div id="card" class="card" style="color:purple">
          <span class="before"></span>
          <em id="target" data-kind="active" style="font-family: 'A; B', serif">
            Text
          </em>
        </div>
      </body></html>
    ''');
    final result = NativeDocumentStyleEngine(
      stylesheets: [
        NativeDocumentStylesheet('''
          .card { color: red; }
          #card { color: blue; }
          #card { color: green; }
          #card { color: black !important; }
          #card > span.before + em[data-kind="active"] { margin-left: 13px; }
          ''', baseUrl: 'https://example.test/style.css'),
      ],
      viewportWidth: 390,
      dark: false,
    ).apply(document);

    final card = document.querySelector('#card')!;
    final target = document.querySelector('#target')!;
    expect(result.stylesByElement[card]!['color'], '#000');
    expect(result.stylesByElement[target]!['margin-left'], '13px');
    expect(result.stylesByElement[target]!['font-family'], "'A; B', serif");
    expect(card.attributes['style'], contains('color: #000 !important'));
    expect(result.diagnostics, isEmpty);
  });

  test(
    'numeric nth-child counts element siblings and preserves specificity',
    () {
      final document = html.parse('''
      <section id="group">
        <span id="first" class="target">First</span>
        <span id="second" class="target">Second</span>
        <span id="excluded" class="target excluded">Excluded</span>
      </section>
    ''');
      final result = NativeDocumentStyleEngine(
        stylesheets: [
          NativeDocumentStylesheet('''
          #group > span.target { color: red; }
          #group > span:nth-child(2) { background-color: blue; }
          #group > span.target:not(.excluded):nth-child(2) { color: green; }
          #group > span.target:not(.excluded) { margin-left: 4px; }
        ''', baseUrl: 'https://example.test/style.css'),
        ],
        viewportWidth: 390,
        dark: false,
      ).apply(document);

      final firstStyle =
          result.stylesByElement[document.querySelector('#first')]!;
      final secondStyle =
          result.stylesByElement[document.querySelector('#second')]!;
      final excludedStyle =
          result.stylesByElement[document.querySelector('#excluded')]!;
      expect(firstStyle['color'], '#f00');
      expect(secondStyle['color'], '#008000');
      expect(secondStyle['background-color'], '#00f');
      expect(secondStyle['margin-left'], '4px');
      expect(excludedStyle.containsKey('margin-left'), isFalse);
      expect(result.diagnostics, isEmpty);
    },
  );

  test('media conditions and inherited custom properties resolve', () {
    final document = html.parse('''
      <div class="wrapper" style="--tone: #123456">
        <p id="target">Text</p>
      </div>
    ''');
    final result = NativeDocumentStyleEngine(
      stylesheets: [
        NativeDocumentStylesheet('''
          .wrapper { --accent: rgb(22, 44, 66); }
          #target {
            color: var(--accent);
            background-color: var(--tone, blue);
            border-top-color: var(--missing, var(--tone, #abcdef));
          }
          @media (min-width: 500px) and (max-width: 800px) {
            #target { margin-left: 17px; }
          }
          @media (prefers-color-scheme: dark) {
            #target { color: white; }
          }
          ''', baseUrl: 'https://example.test/style.css'),
      ],
      viewportWidth: 600,
      dark: false,
    ).apply(document);

    final target = document.querySelector('#target')!;
    final style = result.stylesByElement[target]!;
    expect(style['color'], 'rgb(22, 44, 66)');
    expect(style['background-color'], '#123456');
    expect(style['border-top-color'], '#123456');
    expect(style['margin-left'], '17px');
    expect(result.diagnostics, isEmpty);
  });

  test('box and border shorthands preserve winning longhand order', () {
    final document = html.parse('''
      <p id="target" style="padding-top: 3px">Text</p>
      <button id="font-target">Button</button>
    ''');
    final result = NativeDocumentStyleEngine(
      stylesheets: [
        NativeDocumentStylesheet('''
          #target { padding: 1px 2px; border: 2px solid red !important; }
          #target { padding-left: 6px; padding-right: 9px !important; }
          #font-target { font: inherit; }
          ''', baseUrl: 'https://example.test/style.css'),
      ],
      viewportWidth: 390,
      dark: false,
    ).apply(document);

    final target = document.querySelector('#target')!;
    final targetStyle = result.stylesByElement[target]!;
    expect(targetStyle['padding-top'], '3px');
    expect(targetStyle['padding-right'], '9px');
    expect(targetStyle['padding-bottom'], '1px');
    expect(targetStyle['padding-left'], '6px');
    expect(targetStyle['border-top-width'], '2px');
    expect(targetStyle['border-right-style'], 'solid');
    expect(targetStyle['border-bottom-color'], '#f00');
    expect(
      target.attributes['style'],
      contains('border-top-color: #f00 !important'),
    );

    final fontTarget = document.querySelector('#font-target')!;
    final fontStyle = result.stylesByElement[fontTarget]!;
    expect(fontStyle['font-family'], 'inherit');
    expect(fontStyle['font-size'], 'inherit');
    expect(fontStyle['line-height'], 'inherit');
    expect(
      result.diagnostics,
      contains(
        isA<NativeDocumentStyleDiagnostic>().having(
          (diagnostic) => diagnostic.code,
          'code',
          'partial-shorthand-reset',
        ),
      ),
    );
  });

  test(
    'invalid color declarations do not replace earlier valid declarations',
    () {
      final document = html.parse('<p id="target">Text</p>');
      final result = NativeDocumentStyleEngine(
        stylesheets: [
          NativeDocumentStylesheet('''
          #target {
            color: rgb(21, 22, 23);
            color: not-a-real-color;
            border-top-color: #abcdef;
            border-top-color: not-a-real-color;
          }
          ''', baseUrl: 'https://example.test/style.css'),
        ],
        viewportWidth: 390,
        dark: false,
      ).apply(document);

      final style = result.stylesByElement[document.querySelector('#target')]!;
      expect(style['color'], 'rgb(21, 22, 23)');
      expect(style['border-top-color'], '#abcdef');
      expect(
        result.diagnostics.where(
          (diagnostic) => diagnostic.code == 'invalid-color-value',
        ),
        hasLength(2),
      );
    },
  );

  test(
    'background shorthand expands while later longhands retain precedence',
    () {
      final document = html.parse(
        '<p id="target" style="background: red; background-color: blue"></p>',
      );
      final target = document.querySelector('#target')!;
      final result = NativeDocumentStyleEngine(
        stylesheets: const [],
        viewportWidth: 390,
        dark: false,
      ).apply(document);

      final style = result.stylesByElement[target]!;
      expect(style['background'], '#f00');
      expect(style['background-color'], '#00f');
      final serialized = result.styleAttributesByElement[target]!;
      expect(
        serialized.indexOf('background: #f00'),
        lessThan(serialized.indexOf('background-color: #00f')),
      );
      expect(style['background-image'], 'none');
      expect(style['background-repeat'], 'repeat');
      expect(result.diagnostics, isEmpty);
    },
  );

  test(
    'leading imports keep their URL and media while late imports are rejected',
    () {
      const sheet = NativeDocumentStylesheet(
        '''
      @import url("css/base.css") screen and (min-width: 500px);
      p { color: red; }
      @import "late.css";
      ''',
        baseUrl: 'https://example.test/page/styles.css',
        media: '(prefers-color-scheme: dark)',
      );
      final imports = NativeDocumentStyleEngine.importsOf(sheet);

      expect(imports, hasLength(2));
      expect(imports.first.href, 'css/base.css');
      expect(imports.first.url, 'https://example.test/page/css/base.css');
      expect(imports.first.supported, isTrue);
      expect(imports.first.media, contains('(prefers-color-scheme: dark)'));
      expect(imports.first.media, contains('(min-width: 500px)'));
      expect(imports.last.href, 'late.css');
      expect(imports.last.supported, isFalse);
      expect(imports.last.reason, contains('before'));
    },
  );

  test(
    'CSS URL imports unescape tokens and defer restricted hosts to native',
    () {
      const escaped = NativeDocumentStylesheet(
        r'@import url("css\2f base.css");',
        baseUrl: 'https://example.test/page/style.css',
      );
      final decoded = NativeDocumentStyleEngine.importsOf(escaped).single;
      expect(decoded.href, 'css/base.css');

      const ipv6 = NativeDocumentStylesheet(
        '@import "theme.css";',
        baseUrl: 'https://[::1]/page/style.css',
      );
      final restricted = NativeDocumentStyleEngine.importsOf(ipv6).single;
      expect(restricted.url, isNull);
      expect(restricted.supported, isTrue);
    },
  );

  test('unsupported selectors and shorthands report diagnostics', () {
    final document = html.parse('<p id="target">Text</p>');
    final result = NativeDocumentStyleEngine(
      stylesheets: [
        NativeDocumentStylesheet('''
          #target { color: red; background: blue; animation: fade 1s; }
          #target:future-pseudo { color: green; }
          #target::before { content: "generated"; }
          ''', baseUrl: 'https://example.test/style.css'),
      ],
      viewportWidth: 390,
      dark: false,
    ).apply(document);

    final target = document.querySelector('#target')!;
    expect(result.stylesByElement[target]!['color'], '#f00');
    expect(result.stylesByElement[target]!['background-color'], '#00f');
    expect(result.stylesByElement[target]!.containsKey('animation'), isFalse);
    expect(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      containsAll(['unsupported-shorthand', 'unsupported-selector']),
    );
  });
}

Map<String, dynamic> _readFixture(String name) {
  var directory = Directory.current.absolute;
  while (true) {
    final file = File('${directory.path}/fixtures/mobile-parity/$name');
    if (file.existsSync()) {
      return jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
    }
    final parent = directory.parent;
    if (parent.path == directory.path) break;
    directory = parent;
  }
  throw FileSystemException('Could not locate mobile parity fixture', name);
}
