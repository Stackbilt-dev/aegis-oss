// Markdown renderer tests — verifies the client-side script output
// Tests the JS functions by extracting and evaluating them

import { describe, it, expect } from 'vitest';
import { markdownRendererScript } from '../src/markdown.js';

// The markdown renderer returns JS source code. We evaluate it to test the functions.
const script = markdownRendererScript();
const fn = new Function(`${script}; return { escapeHtml, renderMarkdown, renderInline, renderTable };`);
const { escapeHtml, renderMarkdown, renderInline } = fn();

describe('markdownRendererScript', () => {
  it('returns a non-empty string', () => {
    expect(typeof script).toBe('string');
    expect(script.length).toBeGreaterThan(100);
  });

  it('contains key function definitions', () => {
    expect(script).toContain('function escapeHtml');
    expect(script).toContain('function renderMarkdown');
    expect(script).toContain('function renderInline');
    expect(script).toContain('function renderTable');
  });
});

describe('escapeHtml', () => {
  it('escapes ampersands', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes angle brackets', () => {
    expect(escapeHtml('<div>')).toBe('&lt;div&gt;');
  });

  it('escapes quotes', () => {
    expect(escapeHtml('"hello" \'world\'')).toBe('&quot;hello&quot; &#039;world&#039;');
  });

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });
});

describe('renderInline', () => {
  it('renders inline code', () => {
    expect(renderInline('use `foo()` here')).toContain('<code>foo()</code>');
  });

  it('renders bold text', () => {
    expect(renderInline('**bold**')).toContain('<strong>bold</strong>');
  });

  it('renders italic text', () => {
    expect(renderInline('*italic*')).toContain('<em>italic</em>');
  });

  it('renders bold+italic', () => {
    const result = renderInline('***both***');
    expect(result).toContain('<strong><em>both</em></strong>');
  });

  it('renders strikethrough', () => {
    expect(renderInline('~~deleted~~')).toContain('<del>deleted</del>');
  });

  it('renders links with target=_blank', () => {
    const result = renderInline('[click](https://example.com)');
    expect(result).toContain('href="https://example.com"');
    expect(result).toContain('target="_blank"');
  });
});

describe('renderMarkdown', () => {
  it('renders headers', () => {
    expect(renderMarkdown('# Title')).toContain('<h1>');
    expect(renderMarkdown('## Subtitle')).toContain('<h2>');
    expect(renderMarkdown('### H3')).toContain('<h3>');
    expect(renderMarkdown('#### H4')).toContain('<h4>');
  });

  it('renders unordered lists', () => {
    const result = renderMarkdown('- item 1\n- item 2');
    expect(result).toContain('<ul>');
    expect(result).toContain('<li>');
    expect(result).toContain('item 1');
    expect(result).toContain('item 2');
  });

  it('renders ordered lists', () => {
    const result = renderMarkdown('1. first\n2. second');
    expect(result).toContain('<ol>');
    expect(result).toContain('<li>');
  });

  it('renders blockquotes', () => {
    const result = renderMarkdown('> quoted text');
    expect(result).toContain('<blockquote>');
    expect(result).toContain('quoted text');
  });

  it('renders horizontal rules', () => {
    expect(renderMarkdown('---')).toContain('<hr>');
    expect(renderMarkdown('***')).toContain('<hr>');
  });

  it('renders fenced code blocks', () => {
    const result = renderMarkdown('```js\nconst x = 1;\n```');
    expect(result).toContain('<pre>');
    expect(result).toContain('<code');
    expect(result).toContain('data-lang="js"');
    expect(result).toContain('const x = 1;');
  });

  it('escapes HTML in code blocks', () => {
    const result = renderMarkdown('```\n<script>alert("xss")</script>\n```');
    expect(result).not.toContain('<script>alert');
    expect(result).toContain('&lt;script&gt;');
  });

  it('renders empty lines as <br>', () => {
    const result = renderMarkdown('line 1\n\nline 2');
    expect(result).toContain('<br>');
  });

  it('renders regular text as paragraph lines', () => {
    const result = renderMarkdown('Hello world');
    expect(result).toContain('Hello world');
  });
});
