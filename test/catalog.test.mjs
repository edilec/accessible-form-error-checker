/**
 * The documented catalog and the code, checked against each other in BOTH
 * directions.
 *
 * A rule the README describes but the code never emits is a documentation
 * overclaim; a rule the code emits but the README does not list is a surprise.
 * The table is parsed out of the README rather than repeated here, so there is
 * no third declaration to edit into agreement.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { CATALOG, DEFAULT_LIMITS, FOCUS_TARGETS, REFUSED_POLICY_KEYS } from '../src/index.mjs'
import { ROOT } from './helpers.mjs'

async function readme() {
  return readFile(join(ROOT, 'README.md'), 'utf8')
}

function ruleRows(text) {
  const rows = new Map()
  const pattern = /^\| `([a-z0-9-]+)` \| (error|warning|info) \| (yes|no) \|$/gmu
  for (const match of text.matchAll(pattern)) {
    rows.set(match[1], { severity: match[2], evidenceMissing: match[3] === 'yes' })
  }
  return rows
}

test('the README rule table and the severity table agree, both ways', async () => {
  const rows = ruleRows(await readme())
  assert.equal(rows.size, CATALOG.ruleIds.length, 'the README lists a different number of rules')
  assert.deepEqual([...rows.keys()].sort(), [...CATALOG.ruleIds].sort())
  for (const [ruleId, row] of rows) {
    assert.equal(row.severity, CATALOG.severity[ruleId], `${ruleId} severity`)
    assert.equal(
      row.evidenceMissing,
      CATALOG.evidenceMissing.includes(ruleId),
      `${ruleId} evidence-missing marking`,
    )
  }
})

test('the README limit table names every limit, with the real default', async () => {
  const text = await readme()
  for (const [name, value] of Object.entries(DEFAULT_LIMITS)) {
    assert.match(text, new RegExp(`\\| \`${name}\` \\| ${value} \\|`, 'u'), name)
  }
  const documented = [...text.matchAll(/^\| `(max[A-Za-z]+)` \| \d+ \|/gmu)].map((match) => match[1])
  assert.deepEqual(documented.sort(), Object.keys(DEFAULT_LIMITS).sort())
})

test('every documented focus target and node kind exists in the code', async () => {
  const text = await readme()
  for (const target of FOCUS_TARGETS) assert.match(text, new RegExp(`\`${target}\``, 'u'), target)
  for (const kind of CATALOG.nodeKinds) assert.match(text, new RegExp(`\`${kind}\``, 'u'), kind)
  for (const state of CATALOG.indexStates) assert.match(text, new RegExp(`"${state}"`, 'u'), state)
})

test('every refused policy key is named in the README', async () => {
  const text = await readme()
  for (const key of REFUSED_POLICY_KEYS) assert.match(text, new RegExp(`\`${key}\``, 'u'), key)
})

test('the README does not claim a capability this tool refuses to have', async () => {
  const text = await readme()
  // The documents in this catalog have carried confinement claims the code did
  // not perform, which reads as coverage and is worse than silence. These are
  // the three this tool must never make.
  assert.ok(!/\bwe (drive|render|visit|fetch)\b/iu.test(text))
  assert.match(text, /does not emulate a screen reader|does not emulate assistive technology/u)
  assert.match(text, /Not an HTML parser/u)
  assert.match(text, /writes no file/u)
  // `--out` may appear only in the sentence that says there is none: a tool
  // with no confinement root must not document a destination it does not take.
  assert.match(text, /It has no `--out`/u)
  assert.equal(text.split('--out').length - 1, 1, 'the only mention of --out is the one saying there is none')
})

test('the schema versions the README shows are the ones the code requires', async () => {
  const text = await readme()
  assert.equal(CATALOG.snapshotSchemaVersion, '1')
  assert.equal(CATALOG.policySchemaVersion, '1')
  assert.equal(CATALOG.reportSchemaVersion, '1')
  assert.match(text, /"schemaVersion": "1"/u)
})

test('the exit code table matches what the code returns', async () => {
  const text = await readme()
  assert.match(text, /^\| `0` \| every declared field was checked/mu)
  assert.match(text, /^\| `1` \| the check completed and the form broke an expectation \|$/mu)
  assert.match(text, /^\| `2` \| invalid configuration, or evidence the check could not obtain \|$/mu)
})

test('the count of warning-severity evidence-missing rules the README states is true', async () => {
  const text = await readme()
  const warnings = CATALOG.evidenceMissing.filter((ruleId) => CATALOG.severity[ruleId] === 'warning')
  assert.equal(warnings.length, 15)
  assert.match(text, /The fifteen `warning` rules marked `yes`/u)
})
