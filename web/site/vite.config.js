import {defineConfig} from 'vite';
import {resolve} from 'node:path';

// mochi.css holds the MOCHI additions and must win ties over the base site styles, so it has to load after the
// bundled stylesheet that Vite injects. Move its <link> to the end of <head> once Vite has added its own tags.
const mochiCssLast = {
  name: 'mochi-css-last',
  transformIndexHtml: {
    order: 'post',
    handler(html) {
      const link = html.match(/<link[^>]*href="\/mochi\.css"[^>]*>\s*/);
      if (!link) return html;
      return html.replace(link[0], '').replace('</head>', `${link[0].trim()}\n</head>`);
    },
  },
};

export default defineConfig({
  plugins: [mochiCssLast],
  build: {rollupOptions: {input: Object.fromEntries(['', 'about', 'how-it-works', 'case-study', 'roadmap', 'docs', 'dashboard', 'check', 'tokenomics', 'guide'].map(r => [r || 'home', resolve(r, 'index.html')]))}},
});
