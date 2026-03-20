/**
 * Client-side markdown renderer — pure functions (no DOM access).
 * Extracted from ui.ts as part of Operation Atheist (#127).
 *
 * Returns JS source code for embedding in the chat page <script> tag.
 */

export function markdownRendererScript(): string {
  return `
      // ── Markdown renderer (pure — no DOM access) ─────
      function escapeHtml(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
      }

      function renderMarkdown(text) {
        // Phase 1: Extract fenced code blocks to protect them from markdown processing
        const codeBlocks = [];
        let processed = text.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, function(_, lang, code) {
          const idx = codeBlocks.length;
          codeBlocks.push('<pre><code' + (lang ? ' data-lang="' + lang + '"' : '') + '>' + escapeHtml(code.trim()) + '</code></pre>');
          return '\\x00CODEBLOCK' + idx + '\\x00';
        });

        // Phase 2: Split into lines and process block elements
        const lines = processed.split('\\n');
        const output = [];
        let i = 0;

        while (i < lines.length) {
          const line = lines[i];

          // Code block placeholder
          const cbMatch = line.match(/^\\x00CODEBLOCK(\\d+)\\x00$/);
          if (cbMatch) {
            output.push(codeBlocks[parseInt(cbMatch[1])]);
            i++;
            continue;
          }

          // Table: detect header row + separator row
          if (i + 1 < lines.length && lines[i + 1].match(/^\\s*\\|?[\\s:]*-{2,}[\\s:]*(?:\\|[\\s:]*-{2,}[\\s:]*)*\\|?\\s*$/)) {
            const tableLines = [];
            tableLines.push(line);
            i++; // skip separator
            i++; // move past separator
            while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
              tableLines.push(lines[i]);
              i++;
            }
            output.push(renderTable(tableLines));
            continue;
          }

          // Horizontal rule
          if (line.match(/^\\s*(-{3,}|\\*{3,}|_{3,})\\s*$/)) {
            output.push('<hr>');
            i++;
            continue;
          }

          // Headers
          const hMatch = line.match(/^(#{1,4})\\s+(.+)$/);
          if (hMatch) {
            const level = hMatch[1].length;
            output.push('<h' + level + '>' + renderInline(hMatch[2]) + '</h' + level + '>');
            i++;
            continue;
          }

          // Unordered list
          if (line.match(/^\\s*[-*+]\\s+/)) {
            const listItems = [];
            while (i < lines.length && lines[i].match(/^\\s*[-*+]\\s+/)) {
              listItems.push(lines[i].replace(/^\\s*[-*+]\\s+/, ''));
              i++;
            }
            output.push('<ul>' + listItems.map(li => '<li>' + renderInline(li) + '</li>').join('') + '</ul>');
            continue;
          }

          // Ordered list
          if (line.match(/^\\s*\\d+[.)\\s]\\s*/)) {
            const listItems = [];
            while (i < lines.length && lines[i].match(/^\\s*\\d+[.)\\s]\\s*/)) {
              listItems.push(lines[i].replace(/^\\s*\\d+[.)\\s]\\s*/, ''));
              i++;
            }
            output.push('<ol>' + listItems.map(li => '<li>' + renderInline(li) + '</li>').join('') + '</ol>');
            continue;
          }

          // Blockquote
          if (line.match(/^>\\s?/)) {
            const quoteLines = [];
            while (i < lines.length && lines[i].match(/^>\\s?/)) {
              quoteLines.push(lines[i].replace(/^>\\s?/, ''));
              i++;
            }
            output.push('<blockquote>' + renderInline(quoteLines.join('<br>')) + '</blockquote>');
            continue;
          }

          // Empty line
          if (line.trim() === '') {
            output.push('<br>');
            i++;
            continue;
          }

          // Regular paragraph line
          output.push(renderInline(line) + '<br>');
          i++;
        }

        return output.join('');
      }

      // Render inline markdown (bold, italic, code, links, strikethrough)
      function renderInline(text) {
        let html = escapeHtml(text);

        // Inline code (before other transforms to protect code content)
        html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');

        // Bold + italic: ***text***
        html = html.replace(/\\*\\*\\*(.+?)\\*\\*\\*/g, '<strong><em>$1</em></strong>');

        // Bold: **text**
        html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');

        // Italic: *text*
        html = html.replace(/(?<![\\w*])\\*([^*]+?)\\*(?![\\w*])/g, '<em>$1</em>');

        // Strikethrough: ~~text~~
        html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

        // Links: [text](url)
        html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

        // Auto-link bare URLs (but not inside href attributes)
        html = html.replace(/(?<!href="|">)(https?:\\/\\/[^\\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');

        return html;
      }

      // Render a markdown table (first row = header, rest = body)
      function renderTable(rows) {
        if (rows.length === 0) return '';
        const parseRow = (row) => row.replace(/^\\s*\\|/, '').replace(/\\|\\s*$/, '').split('|').map(c => c.trim());
        const headers = parseRow(rows[0]);
        const bodyRows = rows.slice(1).map(parseRow);

        let html = '<table><thead><tr>';
        headers.forEach(h => { html += '<th>' + renderInline(h) + '</th>'; });
        html += '</tr></thead><tbody>';
        bodyRows.forEach(row => {
          html += '<tr>';
          row.forEach((cell, ci) => { html += '<td>' + renderInline(cell || '') + '</td>'; });
          html += '</tr>';
        });
        html += '</tbody></table>';
        return html;
      }`;
}
