import { defineConfig } from 'vite';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function stripTrailingWhitespace(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      stripTrailingWhitespace(path);
      continue;
    }
    if (!/\.(html|css|js)$/.test(path)) continue;
    const original = readFileSync(path, 'utf8');
    const stripped = original.replace(/[ \t]+$/gm, '');
    if (stripped !== original) {
      writeFileSync(path, stripped);
    }
  }
}

export default defineConfig({
  root: 'src/ui',
  base: '/',
  build: {
    outDir: '../../public',
    emptyOutDir: true,
    sourcemap: false,
  },
  plugins: [{
    name: 'strip-ui-trailing-whitespace',
    closeBundle() {
      stripTrailingWhitespace('public');
    },
  }],
});
