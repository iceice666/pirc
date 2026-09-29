/**
 * In-page helpers for the browser tools. They run inside the page via
 * `page.evaluate`, so they must be self-contained (no closures, no imports).
 */

/**
 * Readable markdown for the page: the main/article element when it holds
 * most of the text, otherwise the body. Hidden elements, scripts and form
 * values are skipped, so password fields never appear.
 */
export function pageMarkdown(): string {
  // Runs in the page: DOM globals, untyped here (the gateway compiles without the DOM lib).
  const document = (globalThis as any).document;
  const location = (globalThis as any).location;
  const Node = (globalThis as any).Node;
  type Element = any;
  type HTMLElement = any;
  const SKIP = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'SVG',
    'CANVAS',
    'IFRAME',
    'OBJECT',
    'INPUT',
    'TEXTAREA',
    'SELECT',
    'BUTTON',
  ]);
  const BLOCK = new Set([
    'P',
    'DIV',
    'SECTION',
    'ARTICLE',
    'MAIN',
    'HEADER',
    'FOOTER',
    'NAV',
    'ASIDE',
    'FORM',
    'FIGURE',
    'FIGCAPTION',
    'DL',
    'DT',
    'DD',
    'DETAILS',
    'SUMMARY',
  ]);
  const body = document.body;
  if (!body) return '';
  const main = document.querySelector('main, article, [role="main"]') as HTMLElement | null;
  const root =
    main && (main.innerText || '').length > 0.3 * (body.innerText || '').length ? main : body;
  const visible = (el: Element) =>
    !(el as any).checkVisibility || (el as any).checkVisibility({ visibilityProperty: true });
  const abs = (href: string | null) => {
    if (!href) return '';
    try {
      return new URL(href, location.href).href;
    } catch {
      return href;
    }
  };
  const inline = (text: string) => text.replace(/\s+/g, ' ');

  const walk = (node: any, listDepth: number): string => {
    if (node.nodeType === Node.TEXT_NODE) return inline(node.textContent || '');
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as HTMLElement;
    const tag = el.tagName.toUpperCase();
    if (SKIP.has(tag) || !visible(el)) return '';
    const children = () =>
      Array.from(el.childNodes as ArrayLike<any>)
        .map((child) => walk(child, listDepth))
        .join('');
    switch (tag) {
      case 'BR':
        return '\n';
      case 'HR':
        return '\n\n---\n\n';
      case 'H1':
      case 'H2':
      case 'H3':
      case 'H4':
      case 'H5':
      case 'H6':
        return `\n\n${'#'.repeat(Number(tag[1]))} ${children().trim()}\n\n`;
      case 'A': {
        const text = children().trim();
        const href = abs(el.getAttribute('href'));
        if (!text) return '';
        return href && !href.startsWith('javascript:') ? `[${text}](${href})` : text;
      }
      case 'IMG': {
        const alt = (el.getAttribute('alt') || '').trim();
        return alt ? `![${inline(alt)}](${abs(el.getAttribute('src'))})` : '';
      }
      case 'STRONG':
      case 'B': {
        const text = children();
        return text.trim() ? `**${text.trim()}**` : text;
      }
      case 'EM':
      case 'I': {
        const text = children();
        return text.trim() ? `_${text.trim()}_` : text;
      }
      case 'CODE':
        return el.closest('pre') ? el.textContent || '' : `\`${el.textContent || ''}\``;
      case 'PRE':
        return `\n\n\`\`\`\n${(el.textContent || '').replace(/\n$/, '')}\n\`\`\`\n\n`;
      case 'BLOCKQUOTE':
        return `\n\n${children()
          .trim()
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')}\n\n`;
      case 'UL':
      case 'OL': {
        let n = 0;
        const items = Array.from(el.children as ArrayLike<any>)
          .filter((child) => child.tagName === 'LI')
          .map((li) => {
            n++;
            const text = Array.from(li.childNodes as ArrayLike<any>)
              .map((child) => walk(child, listDepth + 1))
              .join('')
              .trim()
              .replace(/\n{2,}/g, '\n');
            const bullet = tag === 'OL' ? `${n}.` : '-';
            return `${'  '.repeat(listDepth)}${bullet} ${text}`;
          });
        return `\n${items.join('\n')}\n`;
      }
      case 'TABLE': {
        const rows = Array.from(el.querySelectorAll('tr') as ArrayLike<any>).map((tr) =>
          Array.from(tr.children as ArrayLike<any>).map((cell) =>
            inline((cell as HTMLElement).innerText || '')
              .trim()
              .replace(/\|/g, '\\|'),
          ),
        );
        if (!rows.length) return '';
        const width = Math.max(...rows.map((row) => row.length));
        const line = (row: string[]) =>
          `| ${Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ')} |`;
        return `\n\n${[line(rows[0]!), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n')}\n\n`;
      }
      case 'LI':
        return `\n- ${children().trim()}\n`;
      default:
        return BLOCK.has(tag) ? `\n\n${children()}\n\n` : children();
    }
  };
  return walk(root, 0)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+(?=[^-\d\s])/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Values of password inputs in this frame, for masking snapshots. */
export function passwordValues(): string[] {
  const document = (globalThis as any).document;
  return Array.from(document.querySelectorAll('input[type="password" i]') as ArrayLike<any>)
    .map((input) => input.value as string)
    .filter(Boolean);
}
