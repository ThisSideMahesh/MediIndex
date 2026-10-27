/**
 * css-variables.test.js
 *
 * Regression test for the batch-relocation CSS variable bug (commit 2f24299).
 *
 * Root cause: public/styles.css used five custom properties in the batch-
 * relocation section (--border, --panel-bg, --primary, --primary-light,
 * --text-muted) that were never defined in :root. In CSS, an unresolved
 * var() resolves to 'unset', making borders transparent and backgrounds
 * invisible. The rack headings appeared as plain black text; the shelf
 * buttons were unstyled.
 *
 * This test reads the live stylesheet, extracts the set of variables declared
 * in :root, extracts the set of variables referenced inside the batch-
 * relocation section, and asserts every reference has a matching declaration.
 *
 * IMPORTANT: The test uses two separate passes:
 *   - Declaration pass:  only lines inside the `:root { }` block are scanned.
 *     A variable name appearing elsewhere in the file (e.g. as a reference
 *     "var(--line)") does NOT count as declared.
 *   - Reference pass:    only the batch-relocation section is scanned.
 *     A variable that happens to appear earlier in the file as a hardcoded
 *     colour-value reference is irrelevant.
 *
 * This structure ensures the test cannot pass merely because replacement
 * names appear somewhere in the stylesheet — declarations must be explicit
 * :root assignments.
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('fs');
const path     = require('path');

const STYLES_PATH = path.join(__dirname, '..', 'public', 'styles.css');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract the text content of the :root { ... } block.
 * Walks matching braces from the first ':root {' occurrence.
 * Returns only what is INSIDE the braces — not the selector line itself.
 */
function extractRootBlock(css) {
  const marker = ':root {';
  const start  = css.indexOf(marker);
  assert.notEqual(start, -1, 'styles.css must contain a :root { block');

  let depth = 0, i = start, bodyStart = -1, bodyEnd = -1;
  while (i < css.length) {
    if (css[i] === '{') { if (depth === 0) bodyStart = i + 1; depth++; }
    else if (css[i] === '}') { depth--; if (depth === 0) { bodyEnd = i; break; } }
    i++;
  }
  assert.notEqual(bodyEnd, -1, 'Could not find closing brace of :root block');
  return css.slice(bodyStart, bodyEnd);
}

/**
 * Extract all custom property DECLARATIONS from a CSS text block.
 * Matches lines of the form:  --property-name: value;
 * Returns a Set of '--property-name' strings.
 */
function extractDeclarations(cssBlock) {
  const declared = new Set();
  // Match '--name:' at the start of a declaration (allowing leading whitespace)
  for (const match of cssBlock.matchAll(/^\s*(--[a-z][a-z0-9-]*):/gm)) {
    declared.add(match[1]);
  }
  return declared;
}

/**
 * Extract all custom property REFERENCES used within a named section.
 * The section is identified by its opening comment string; it extends to
 * the end of the file (or the next section comment).
 * Matches: var(--property-name)
 * Returns a Set of '--property-name' strings.
 */
function extractReferencesInSection(css, sectionMarker) {
  const start = css.indexOf(sectionMarker);
  assert.notEqual(start, -1, `Section marker not found: ${sectionMarker}`);
  const section = css.slice(start);

  const referenced = new Set();
  for (const match of section.matchAll(/var\((--[a-z][a-z0-9-]*)\)/g)) {
    referenced.add(match[1]);
  }
  return referenced;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('CSS variables: all custom properties referenced in batch-relocation section are declared in :root', () => {
  const css = fs.readFileSync(STYLES_PATH, 'utf8');

  // Step 1 — collect declarations from :root only.
  const rootBlock   = extractRootBlock(css);
  const declared    = extractDeclarations(rootBlock);

  assert.ok(declared.size > 0, ':root block must declare at least one custom property');

  // Spot-check that known variables ARE declared (guards against parser bugs).
  assert.ok(declared.has('--line'),    '--line must be declared in :root');
  assert.ok(declared.has('--surface'), '--surface must be declared in :root');
  assert.ok(declared.has('--accent'),  '--accent must be declared in :root');
  assert.ok(declared.has('--muted'),   '--muted must be declared in :root');
  assert.ok(declared.has('--accent-light'), '--accent-light must be declared in :root');

  // Step 2 — collect references from the batch-relocation section only.
  const SECTION = '/* ── Batch Relocation Dialog';
  const referenced = extractReferencesInSection(css, SECTION);

  assert.ok(referenced.size > 0,
    'Batch-relocation section must reference at least one custom property');

  // Step 3 — every reference must have a matching declaration.
  const missing = [...referenced].filter(v => !declared.has(v));

  assert.deepEqual(missing, [],
    `Batch-relocation CSS references these undefined custom properties: ${missing.join(', ')}. ` +
    'Check that new CSS uses the variables defined in :root (--line, --surface, --accent, ' +
    '--accent-light, --muted) rather than aliases from another design system.'
  );
});

test('CSS variables: :root declarations are not confused with references elsewhere in the file', () => {
  // Regression guard: this test would FAIL if extractDeclarations() naively
  // scanned the whole file for '--name:' patterns (which could match
  // property declarations inside rules, not :root assignments).
  const css = fs.readFileSync(STYLES_PATH, 'utf8');

  const rootBlock = extractRootBlock(css);
  const declared  = extractDeclarations(rootBlock);

  // The previously-broken variable names must NOT appear as declarations in :root.
  // If they were added to :root (a valid fix), this test would need updating —
  // but the preferred fix is to use the correct existing names instead.
  // This assertion documents which names were the offenders.
  const offenders = ['--border', '--panel-bg', '--primary', '--primary-light', '--text-muted'];
  const wronglyDeclared = offenders.filter(v => declared.has(v));

  assert.deepEqual(wronglyDeclared, [],
    `These variables were added to :root instead of using the existing palette names: ` +
    `${wronglyDeclared.join(', ')}. Preferred names: --line, --surface, --accent, ` +
    `--accent-light, --muted.`
  );
});

test('CSS variables: batch-relocation section exists in styles.css', () => {
  // Guard: ensures the test is scanning the right file and the section exists.
  const css = fs.readFileSync(STYLES_PATH, 'utf8');
  assert.ok(
    css.includes('/* ── Batch Relocation Dialog'),
    'Batch-relocation CSS section must exist in public/styles.css'
  );
  assert.ok(
    css.includes('.relocate-shelf-btn'),
    '.relocate-shelf-btn selector must exist in public/styles.css'
  );
});

test('CSS variables: batch-relocation section uses correct variable names after fix', () => {
  // Documents and verifies the exact substitutions made in this fix.
  const css = fs.readFileSync(STYLES_PATH, 'utf8');
  const SECTION = '/* ── Batch Relocation Dialog';
  const start   = css.indexOf(SECTION);
  const section = css.slice(start);

  // Correct names must be present.
  assert.ok(section.includes('var(--line)'),
    'Batch-relocation section must use var(--line) for borders');
  assert.ok(section.includes('var(--surface)'),
    'Batch-relocation section must use var(--surface) for panel backgrounds');
  assert.ok(section.includes('var(--accent)'),
    'Batch-relocation section must use var(--accent) for interactive colour');
  assert.ok(section.includes('var(--accent-light)'),
    'Batch-relocation section must use var(--accent-light) for hover state');
  assert.ok(section.includes('var(--muted)'),
    'Batch-relocation section must use var(--muted) for muted text');

  // Original wrong names must be absent.
  assert.equal(section.includes('var(--border)'),       false, 'var(--border) must not appear — use var(--line)');
  assert.equal(section.includes('var(--panel-bg)'),     false, 'var(--panel-bg) must not appear — use var(--surface)');
  assert.equal(section.includes('var(--primary)'),      false, 'var(--primary) must not appear — use var(--accent)');
  assert.equal(section.includes('var(--primary-light)'),false, 'var(--primary-light) must not appear — use var(--accent-light)');
  assert.equal(section.includes('var(--text-muted)'),   false, 'var(--text-muted) must not appear — use var(--muted)');
});
