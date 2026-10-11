import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('seamless --version prints the package version', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'bin', 'seamless.js'), '--version'], { encoding: 'utf8' });
  assert.equal(out.trim(), pkg.version);
});

test('the published package includes everything the CLI loads at runtime', () => {
  const shipped = (file) => pkg.files.some((entry) => file === entry || file.startsWith(`${entry}/`));
  assert.ok(shipped(pkg.bin.seamless));
  assert.ok(shipped('providers.json'));
  for (const file of fs.readdirSync(path.join(ROOT, 'src'))) assert.ok(shipped(`src/${file}`), file);
});
