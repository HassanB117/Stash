const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['.git', 'data', 'node_modules']);
const SEARCH_DIRS = ['', 'lib', 'public', 'scripts', 'test'];

function collectJsFiles(dir, files) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectJsFiles(path.join(dir, entry.name), files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.js')) files.push(path.join(dir, entry.name));
  }
}

const files = [];
for (const relDir of SEARCH_DIRS) collectJsFiles(path.join(ROOT, relDir), files);

const uniqueFiles = [...new Set(files)].sort();
for (const file of uniqueFiles) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}

console.log(`Checked ${uniqueFiles.length} JavaScript file(s).`);
