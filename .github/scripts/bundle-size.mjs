#!/usr/bin/env node
/**
 * Bundle size measurement and report rendering for thorvg.web packages.
 *
 *   node .github/scripts/bundle-size.mjs measure <package> <ref> <outDir>
 *     Scans packages/<package>/dist using the package.json "exports" map and
 *     writes <outDir>/<package>.<ref>.json with raw/gzip/brotli sizes of the
 *     WASM binary, the Emscripten glue JS and every module-system bundle
 *     (esm/cjs/umd) of each preset.  The glue is recorded for reference only:
 *     rollup inlines it into each bundle and it is not published on its own.
 *
 *   node .github/scripts/bundle-size.mjs report <dir>
 *     Reads every *.json produced by `measure` from <dir> and prints a
 *     markdown report comparing "main" against "pr" to stdout.
 *
 * No third-party dependencies: only Node built-ins are used, so it can run
 * before `pnpm install` and inside the report workflow.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const REPORT_HEADER = '## Bundle Size Report';
const WASM_FILE = 'thorvg.wasm';
const GLUE_FILE = 'thorvg.js';
const WORKER_FILE = 'thorvg.worker.js';
const MODULES = ['esm', 'cjs', 'umd'];

// ---------------------------------------------------------------------------
// measure
// ---------------------------------------------------------------------------

function fileSizes(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const buf = fs.readFileSync(filePath);
  return {
    file: path.basename(filePath),
    raw: buf.length,
    gzip: zlib.gzipSync(buf, { level: 9 }).length,
    brotli: zlib.brotliCompressSync(buf, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length,
  };
}

function resolveEntry(entry, key) {
  // exports["./sw"] may be a string or a conditions object.
  if (typeof entry === 'string') return key === 'import' ? entry : null;
  if (entry && typeof entry === 'object') {
    const value = entry[key];
    return typeof value === 'string' ? value : null;
  }
  return null;
}

function measure(pkgName, ref, outDir) {
  const pkgDir = path.resolve('packages', pkgName);
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    throw new Error(`package.json not found: ${pkgJsonPath}`);
  }
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const exportsMap = pkg.exports ?? { '.': { import: pkg.module, require: pkg.main } };

  const presets = [];
  for (const [subpath, entry] of Object.entries(exportsMap)) {
    const esmRel = resolveEntry(entry, 'import');
    const cjsRel = resolveEntry(entry, 'require');
    const anchor = esmRel ?? cjsRel;
    if (!anchor) continue;

    const dir = path.join(pkgDir, path.dirname(anchor));
    const preset = subpath === '.' ? 'default' : subpath.replace(/^\.\//, '');

    // UMD bundles are not listed in "exports"; derive from the esm file name
    // (lottie-player.esm.js -> lottie-player.js).
    const umdRel = esmRel ? esmRel.replace(/\.esm\.js$/, '.js') : null;

    const bundles = {};
    const esm = esmRel ? fileSizes(path.join(pkgDir, esmRel)) : null;
    const cjs = cjsRel ? fileSizes(path.join(pkgDir, cjsRel)) : null;
    const umd = umdRel && umdRel !== esmRel ? fileSizes(path.join(pkgDir, umdRel)) : null;
    if (esm) bundles.esm = esm;
    if (cjs) bundles.cjs = cjs;
    if (umd) bundles.umd = umd;

    presets.push({
      preset,
      wasm: fileSizes(path.join(dir, WASM_FILE)),
      glue: fileSizes(path.join(dir, GLUE_FILE)),
      worker: fileSizes(path.join(dir, WORKER_FILE)),
      bundles,
    });
  }

  const missing = presets.filter((p) => !p.wasm || !p.glue || Object.keys(p.bundles).length === 0);
  if (presets.length === 0 || missing.length === presets.length) {
    throw new Error(`no build output found under ${path.join(pkgDir, 'dist')}; run the package build first`);
  }
  for (const p of missing) {
    console.warn(`warning: preset "${p.preset}" is incomplete (wasm=${!!p.wasm} glue=${!!p.glue} bundles=${Object.keys(p.bundles).join(',') || 'none'})`);
  }

  const result = { package: pkg.name, ref, presets };
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${pkgName}.${ref}.json`);
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n');

  console.log(`${pkg.name} (${ref})`);
  for (const p of presets) {
    for (const mod of Object.keys(p.bundles)) {
      const t = total(p, mod);
      console.log(`  ${p.preset.padEnd(10)} ${mod.padEnd(4)} raw ${fmt(t.raw).padStart(10)}  gzip ${fmt(t.gzip).padStart(10)}`);
    }
  }
  console.log(`written ${outFile}`);
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

// The JSON files come from the PR build, so treat every string as untrusted
// before embedding it in a comment body (mirrors core's binary_size_report).
const SAFE_RE = /[^A-Za-z0-9 ._/+\-=(),:@]/g;
function sanitize(s, limit = 64) {
  return String(s ?? '').replace(/`/g, "'").replace(/\n/g, ' ').replace(SAFE_RE, '').slice(0, limit);
}

function sizeOrNull(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const raw = Number(entry.raw);
  const gzip = Number(entry.gzip);
  if (!Number.isInteger(raw) || !Number.isInteger(gzip) || raw < 0 || gzip < 0) return null;
  return { raw, gzip };
}

// Total = wasm + bundle (+ worker). The glue JS is already inlined in the
// bundle, so adding it would double count.
function total(preset, mod) {
  const parts = [preset.wasm, preset.worker, preset.bundles?.[mod]]
    .map(sizeOrNull)
    .filter(Boolean);
  return parts.reduce((acc, p) => ({ raw: acc.raw + p.raw, gzip: acc.gzip + p.gzip }), { raw: 0, gzip: 0 });
}

function fmt(n) {
  return n.toLocaleString('en-US');
}

function delta(base, pr) {
  const diff = pr - base;
  const pct = base ? (diff / base) * 100 : 0;
  const sign = diff > 0 ? '+' : '';
  return `${sign}${fmt(diff)} (${sign}${pct.toFixed(2)}%)`;
}

function loadResults(dir) {
  const results = new Map(); // package -> { main?: data, pr?: data }
  if (!fs.existsSync(dir)) return results;
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const m = /^(.+)\.(main|pr)\.json$/.exec(name);
    if (!m) continue;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (!data || !Array.isArray(data.presets)) continue;
    const key = sanitize(data.package || m[1]);
    if (!results.has(key)) results.set(key, {});
    results.get(key)[m[2]] = data;
  }
  return results;
}

function presetMap(data) {
  const map = new Map();
  for (const p of data?.presets ?? []) {
    if (p && typeof p === 'object') map.set(sanitize(p.preset), p);
  }
  return map;
}

const UP = '🟥';   // size increased
const DOWN = '🟩'; // size decreased

function signed(n) {
  return (n > 0 ? '+' : '') + fmt(n);
}

function pct(base, diff) {
  if (!base) return '';
  const v = (diff / base) * 100;
  return ` (${v > 0 ? '+' : ''}${v.toFixed(1)}%)`;
}

// "+211 (+0.2%) 🟥" / "-1,204 (-0.1%) 🟩" / "0". The icon sits at the end so
// it lines up in right-aligned columns regardless of the number's width.
function deltaCell(base, pr, withPct = true) {
  const diff = pr - base;
  if (diff === 0) return '0';
  return `${signed(diff)}${withPct ? pct(base, diff) : ''} ${diff > 0 ? UP : DOWN}`;
}

// The module system used for the headline numbers; esm/cjs/umd differ by a
// few hundred bytes only, the per-module totals are in the breakdown.
function primaryModule(m, p) {
  return MODULES.find((mod) => sizeOrNull(m?.bundles?.[mod]) && sizeOrNull(p?.bundles?.[mod])) ?? null;
}

function presetRows(main, pr) {
  const names = [...new Set([...main.keys(), ...pr.keys()])];
  return names.map((preset) => {
    const m = main.get(preset);
    const p = pr.get(preset);
    const mod = m && p ? primaryModule(m, p) : null;
    const wasm = mod ? { main: sizeOrNull(m.wasm), pr: sizeOrNull(p.wasm) } : null;
    if (!mod || !wasm.main || !wasm.pr) return { preset, m, p, ok: false };
    const js = { main: sizeOrNull(m.bundles[mod]), pr: sizeOrNull(p.bundles[mod]) };
    const tot = { main: total(m, mod), pr: total(p, mod) };
    return {
      preset, m, p, ok: true, mod, wasm, js, tot,
      dWasm: wasm.pr.raw - wasm.main.raw,
      dJs: js.pr.raw - js.main.raw,
      dTotal: tot.pr.raw - tot.main.raw,
      dGzip: tot.pr.gzip - tot.main.gzip,
    };
  });
}

function renderBreakdown(rows) {
  const modules = [
    '| Preset | Module | main | PR | Delta | main (gzip) | PR (gzip) | Delta (gzip) |',
    '|--------|--------|-----:|---:|------:|------------:|----------:|-------------:|',
  ];
  const files = [
    '| Preset | File | main | PR | Delta | main (gzip) | PR (gzip) |',
    '|--------|------|-----:|---:|------:|------------:|----------:|',
  ];

  for (const { preset, m, p } of rows) {
    const mods = [...new Set([...Object.keys(m?.bundles ?? {}), ...Object.keys(p?.bundles ?? {})])]
      .filter((x) => MODULES.includes(x))
      .sort((a, b) => MODULES.indexOf(a) - MODULES.indexOf(b));

    // The preset name is written once per group; following rows leave it blank.
    let modLabel = `**${preset}**`;
    for (const mod of mods) {
      const label = modLabel;
      modLabel = '';
      if (!sizeOrNull(m?.bundles?.[mod]) || !sizeOrNull(p?.bundles?.[mod]) || !sizeOrNull(m?.wasm) || !sizeOrNull(p?.wasm)) {
        modules.push(`| ${label} | ${mod} | n/a | n/a | n/a | n/a | n/a | n/a |`);
        continue;
      }
      const tm = total(m, mod);
      const tp = total(p, mod);
      modules.push(
        `| ${label} | ${mod} | ${fmt(tm.raw)} | ${fmt(tp.raw)} | ${deltaCell(tm.raw, tp.raw)} ` +
          `| ${fmt(tm.gzip)} | ${fmt(tp.gzip)} | ${deltaCell(tm.gzip, tp.gzip)} |`,
      );
    }

    const entries = [
      ['wasm', m?.wasm, p?.wasm],
      ['glue', m?.glue, p?.glue],
      ['worker', m?.worker, p?.worker],
      ...mods.map((mod) => [mod, m?.bundles?.[mod], p?.bundles?.[mod]]),
    ];
    let fileLabel = `**${preset}**`;
    for (const [kind, fm, fp] of entries) {
      const sm = sizeOrNull(fm);
      const sp = sizeOrNull(fp);
      if (!sm && !sp) continue;
      const label = fileLabel;
      fileLabel = '';
      const file = sanitize(fp?.file ?? fm?.file ?? kind);
      if (!sm || !sp) {
        files.push(`| ${label} | ${file} | ${sm ? fmt(sm.raw) : 'n/a'} | ${sp ? fmt(sp.raw) : 'n/a'} | n/a | ${sm ? fmt(sm.gzip) : 'n/a'} | ${sp ? fmt(sp.gzip) : 'n/a'} |`);
        continue;
      }
      files.push(`| ${label} | ${file} | ${fmt(sm.raw)} | ${fmt(sp.raw)} | ${deltaCell(sm.raw, sp.raw)} | ${fmt(sm.gzip)} | ${fmt(sp.gzip)} |`);
    }
  }

  return [
    '<details>',
    '<summary>Per-module / per-file breakdown</summary>',
    '',
    '**Total per module system** (thorvg.wasm + bundle)',
    '',
    ...modules,
    '',
    '**Files** (thorvg.js is inlined into each bundle and not published separately)',
    '',
    ...files,
    '',
    '</details>',
  ];
}

// One line per direction: which packages/presets grew or shrank, and the
// largest move of each. Details are in the folded tables below.
function renderOverview(summaries) {
  const lines = [];
  const describe = (pick, sign) => {
    const parts = [];
    for (const { name, ok } of summaries) {
      const hits = ok.filter(pick);
      if (hits.length === 0) continue;
      const worst = hits.reduce((a, r) => (Math.abs(r.dTotal) > Math.abs(a.dTotal) ? r : a), hits[0]);
      const d = worst.dTotal;
      const change = `${signed(d)}${pct(worst.tot.main.raw, d).replace(' (', ', ').replace(')', '')}`;
      const largest = hits.length > 1 ? `largest ${worst.preset} ${change}` : change;
      parts.push(`${name}: ${hits.map((r) => r.preset).join(', ')} (${largest})`);
    }
    if (parts.length) lines.push(`- ${sign} ${parts.join('; ')}`);
  };
  describe((r) => r.dTotal > 0, `${UP} Increased:`);
  describe((r) => r.dTotal < 0, `${DOWN} Decreased:`);

  const unchanged = summaries.filter((x) => !x.missing && x.ok.length > 0 && x.changed.length === 0).map((x) => x.name);
  const missing = summaries.filter((x) => x.missing).map((x) => `${x.name} (${x.missing})`);
  if (lines.length === 0 && unchanged.length > 0 && missing.length === 0) return ['No size changes.'];
  if (unchanged.length) lines.push(`- Unchanged: ${unchanged.join(', ')}`);
  if (missing.length) lines.push(`- No data: ${missing.join(', ')}`);
  return lines;
}

function renderPackage(name, sizes) {
  if (!sizes.main || !sizes.pr) {
    return {
      summary: { name, ok: [], changed: [], missing: !sizes.main ? 'main' : 'PR' },
      details: ['<details>', `<summary><b>${name}</b> — no ${!sizes.main ? 'main' : 'PR'} data collected</summary>`, '', '</details>', ''],
    };
  }

  const rows = presetRows(presetMap(sizes.main), presetMap(sizes.pr));
  const ok = rows.filter((r) => r.ok);
  const changed = ok.filter((r) => r.dTotal !== 0 || r.dGzip !== 0);
  const broken = rows.length - ok.length;

  const summary = { name, ok, changed, missing: null };
  let title;
  if (broken) title = `${broken} of ${rows.length} presets could not be compared`;
  else if (changed.length === 0) title = `no size changes (${rows.length} presets)`;
  else title = `${changed.length} of ${rows.length} presets changed`;

  // Summary table: one row per preset with the deltas only.
  const summaryTable = [
    '| Preset | Total | Δ Total | Δ gzip | Δ WASM | Δ JS |',
    '|--------|------:|--------:|-------:|-------:|-----:|',
  ];
  for (const r of rows) {
    if (!r.ok) {
      summaryTable.push(`| ${r.preset} | n/a | n/a | n/a | n/a | n/a |`);
      continue;
    }
    summaryTable.push(
      `| ${r.preset} | ${fmt(r.tot.pr.raw)} | ${deltaCell(r.tot.main.raw, r.tot.pr.raw)} | ${deltaCell(r.tot.main.gzip, r.tot.pr.gzip, false)} ` +
        `| ${deltaCell(r.wasm.main.raw, r.wasm.pr.raw, false)} | ${deltaCell(r.js.main.raw, r.js.pr.raw, false)} |`,
    );
  }

  // Detail table: before / after / diff rows per preset; changed values are bold.
  const jsName = sanitize(ok[0]?.p?.bundles?.[ok[0].mod]?.file ?? 'JS bundle');
  const detailTable = [
    `| Preset | | ${jsName} | gzip | thorvg.wasm | Total |`,
    '|--------|---|----------:|-----:|------------:|------:|',
  ];
  const bold = (text, on) => (on ? `**${text}**` : text);
  for (const r of rows) {
    if (!r.ok) {
      detailTable.push(`| **${r.preset}** | | n/a | n/a | n/a | n/a |`);
      continue;
    }
    const { js, wasm, tot } = r;
    detailTable.push(
      `| **${r.preset}** | before | ${fmt(js.main.raw)} | ${fmt(js.main.gzip)} | ${fmt(wasm.main.raw)} | ${fmt(tot.main.raw)} |`,
      `| | after | ${bold(fmt(js.pr.raw), js.pr.raw !== js.main.raw)} | ${bold(fmt(js.pr.gzip), js.pr.gzip !== js.main.gzip)} ` +
        `| ${bold(fmt(wasm.pr.raw), wasm.pr.raw !== wasm.main.raw)} | ${bold(fmt(tot.pr.raw), tot.pr.raw !== tot.main.raw)} |`,
      `| | diff | ${bold(deltaCell(js.main.raw, js.pr.raw), js.pr.raw !== js.main.raw)} | ${deltaCell(js.main.gzip, js.pr.gzip)} ` +
        `| ${deltaCell(wasm.main.raw, wasm.pr.raw)} | ${bold(deltaCell(tot.main.raw, tot.pr.raw), tot.pr.raw !== tot.main.raw)} |`,
    );
  }

  const open = changed.length > 0 || broken > 0 ? ' open' : '';
  const details = [
    `<details${open}>`,
    `<summary><b>${name}</b> — ${title}</summary>`,
    '',
    `Total = thorvg.wasm + ${ok[0]?.mod ?? 'esm'} bundle. ${UP} increased, ${DOWN} decreased.` +
      ` \`default\` is the root export (\`import '${name}'\`); the other rows are subpath exports (\`import '${name}/<preset>'\`).`,
    '',
    ...summaryTable,
    '',
    '<details>',
    '<summary>Before / after per preset</summary>',
    '',
    ...detailTable,
    '',
    '</details>',
    '',
    ...renderBreakdown(rows),
    '',
    '</details>',
    '',
  ];
  return { summary, details };
}

function report(dir) {
  const results = loadResults(dir);
  const lines = [REPORT_HEADER, ''];
  if (results.size === 0) {
    lines.push('No data collected.', '');
  } else {
    const packages = [...results.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, sizes]) => renderPackage(name, sizes));

    lines.push(...renderOverview(packages.map((p) => p.summary)), '');
    for (const p of packages) lines.push(...p.details);
  }
  process.stdout.write(lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// cli
// ---------------------------------------------------------------------------

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === 'measure' && args.length === 3) {
    measure(args[0], args[1], args[2]);
  } else if (cmd === 'report' && args.length === 1) {
    report(args[0]);
  } else {
    console.error('usage: bundle-size.mjs measure <package> <ref> <outDir> | report <dir>');
    process.exit(2);
  }
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
