// Copies vendor libraries into index.html between <!-- VENDOR:name --> markers,
// so the game stays a single file with no CDN requests.
// Usage: node tools/inline-vendor.js
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const htmlPath = path.join(root, 'index.html');
const VENDORS = { peerjs: 'vendor/peerjs-1.5.5.min.js' };

let html = fs.readFileSync(htmlPath, 'utf8');
for (const [name, file] of Object.entries(VENDORS)) {
  const code = fs.readFileSync(path.join(root, file), 'utf8')
    .replace(/\n?\/\/# sourceMappingURL=.*$/m, '')
    .trim();
  if (/<\/script/i.test(code)) throw new Error(`${file} contains </script and cannot be inlined`);
  const re = new RegExp(`(<!-- VENDOR:${name} -->)[\\s\\S]*?(<!-- /VENDOR:${name} -->)`);
  if (!re.test(html)) throw new Error(`Marker for ${name} not found in index.html`);
  html = html.replace(re, (_, open, close) => `${open}\n<script>${code}</script>\n${close}`);
  console.log(`inlined ${file} (${code.length} bytes)`);
}
fs.writeFileSync(htmlPath, html);
