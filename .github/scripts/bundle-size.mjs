#!/usr/bin/env node
/**
 * Bundle size report helper (see .github/workflows/bundle_size*.yml).
 *
 *   measure <package> <ref> <outDir>
 *     Records the size of thorvg.wasm and the esm bundle of every preset of
 *     packages/<package> into <outDir>/<package>.<ref>.json.
 *
 *   report <dir>
 *     Compares the main / pr JSON files in <dir> and prints a markdown table
 *     per package whose size changed.
 */

import fs from 'node:fs';
import path from 'node:path';

const UP = '🟥';
const DOWN = '🟩';

// ----------------------------------------------------------------- measure

function fileSize(file) {
  return fs.existsSync(file) ? fs.statSync(file).size : null;
}

function measure(pkgName, ref, outDir) {
  const pkgDir = path.resolve('packages', pkgName);
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));

  // exports["."] -> default, exports["./sw"] -> sw, ...; each entry points at
  // the esm bundle and thorvg.wasm sits next to it.
  const presets = [];
  for (const [subpath, entry] of Object.entries(pkg.exports)) {
    const js = typeof entry === 'string' ? entry : entry.import;
    if (!js) continue;
    presets.push({
      preset: subpath === '.' ? 'default' : subpath.replace('./', ''),
      wasm: fileSize(path.join(pkgDir, path.dirname(js), 'thorvg.wasm')),
      js: fileSize(path.join(pkgDir, js)),
    });
  }
  if (!presets.some((p) => p.wasm !== null && p.js !== null)) {
    throw new Error(`no build output under ${pkgDir}/dist; run the package build first`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${pkgName}.${ref}.json`), JSON.stringify({ package: pkg.name, presets }, null, 2));
  for (const p of presets) console.log(`${p.preset.padEnd(10)} wasm ${p.wasm}  js ${p.js}`);
}

// ------------------------------------------------------------------ report

// Artifact contents come from the PR build, so strip anything that could
// break out of a table cell before embedding it in the comment.
function sanitize(s) {
  return String(s ?? '').replace(/[^A-Za-z0-9 ._/+\-@]/g, '').slice(0, 64);
}

function fmt(n) {
  return n.toLocaleString('en-US');
}

function delta(base, pr, withPct) {
  const diff = pr - base;
  if (diff === 0) return '0';
  const sign = diff > 0 ? '+' : '';
  const pct = withPct ? ` (${sign}${((diff / base) * 100).toFixed(1)}%)` : '';
  return `${sign}${fmt(diff)}${pct} ${diff > 0 ? UP : DOWN}`;
}

function presetsOf(data) {
  const valid = (n) => Number.isInteger(n) && n >= 0;
  const map = new Map();
  for (const p of data.presets ?? []) {
    if (valid(p?.wasm) && valid(p?.js)) map.set(sanitize(p.preset), p);
  }
  return map;
}

function renderPackage(name, main, pr) {
  const names = [...new Set([...main.keys(), ...pr.keys()])];
  const rows = names.map((preset) => {
    const m = main.get(preset);
    const p = pr.get(preset);
    if (!m || !p) return `| ${preset} | n/a | n/a | n/a | n/a |`;
    const tm = m.wasm + m.js;
    const tp = p.wasm + p.js;
    if (tm === tp && m.wasm === p.wasm) return null;
    return `| ${preset} | ${fmt(tp)} | ${delta(tm, tp, true)} | ${delta(m.wasm, p.wasm)} | ${delta(m.js, p.js)} |`;
  });
  if (rows.every((r) => r === null)) return [];
  return [
    `### ${name}`,
    '',
    '| Preset | Total | Delta | Δ WASM | Δ JS |',
    '|--------|------:|------:|-------:|-----:|',
    ...rows.map((r, i) => r ?? `| ${names[i]} | ${fmt(pr.get(names[i]).wasm + pr.get(names[i]).js)} | 0 | 0 | 0 |`),
    '',
  ];
}

function report(dir) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  const results = new Map(); // package -> { main, pr }
  for (const file of files) {
    const m = /^(.+)\.(main|pr)\.json$/.exec(file);
    if (!m) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const key = sanitize(data.package || m[1]);
      results.set(key, { ...results.get(key), [m[2]]: data });
    } catch {
      // ignore unreadable artifacts; the package shows up as missing data
    }
  }

  const lines = ['## Bundle Size Report', ''];
  if (results.size === 0) {
    lines.push('No data collected.');
  } else {
    let changed = false;
    for (const [name, { main, pr }] of [...results].sort()) {
      if (!main || !pr) {
        lines.push(`### ${name}`, '', `No ${main ? 'PR' : 'main'} data collected.`, '');
        changed = true;
        continue;
      }
      const block = renderPackage(name, presetsOf(main), presetsOf(pr));
      if (block.length) changed = true;
      lines.push(...block);
    }
    if (!changed) lines.push('No size changes.');
  }
  console.log(lines.join('\n'));
}

// --------------------------------------------------------------------- cli

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === 'measure' && args.length === 3) measure(...args);
  else if (cmd === 'report' && args.length === 1) report(args[0]);
  else throw new Error('usage: bundle-size.mjs measure <package> <ref> <outDir> | report <dir>');
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
