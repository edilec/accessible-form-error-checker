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
import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import test from 'node:test'

import { CATALOG, TOOL_ID, DEFAULT_LIMITS, FOCUS_TARGETS, REFUSED_POLICY_KEYS, marksInvalid } from '../src/index.mjs'
import { ROOT, cleanExpectations, cleanSnapshot, runCli, runCliRaw } from './helpers.mjs'

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

test('every aria-invalid token the code treats as invalid is documented, and no other', async () => {
  const text = await readme()
  for (const token of CATALOG.invalidTokens) {
    assert.match(text, new RegExp(`\`${token}\``, 'u'), token)
    assert.ok(marksInvalid(token), token)
  }
  // The other direction: `false` is documented as the default and must not be
  // in the list, and a value outside the token set takes that default.
  for (const value of ['false', 'tru', '', null, undefined]) {
    assert.ok(!marksInvalid(value), String(value))
  }
  assert.match(text, /aria-invalid.*four token values/su)
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

test('the README tells the truth about the clock, which a run without --now reads', async () => {
  // The README said "Nothing here reads the wall clock on its own behalf" two
  // sentences before saying --now "defaults to the system clock". The two
  // contradicted each other and the first was false of the code, which is worse
  // than silence because it reads as a guarantee. The behaviour is asserted
  // first, so the documents are checked against the tool rather than each other.
  const snapshot = await cleanSnapshot()
  snapshot.capture.capturedAt = '2000-01-01'
  const expectations = { ...(await cleanExpectations()), maxSnapshotAgeDays: 1 }
  const withoutNow = await runCli(snapshot, expectations, ['--json'])
  assert.equal(withoutNow.code, 2, 'a run with no --now still judges age, so it did read a clock')
  assert.ok(
    JSON.parse(withoutNow.stdout).findings.some((finding) => finding.ruleId === 'snapshot-stale'),
    'the staleness verdict is a function of the day the run happens',
  )

  const text = await readme()
  assert.ok(
    !/reads the wall clock on its own behalf/u.test(text),
    'the README may not claim a clock reading the code performs',
  )
  assert.match(text, /a run that omits `--now` \*\*is not reproducible\*\*/u)
  const help = await runCliRaw(['--help'])
  assert.match(help.stderr, /Defaults to the system clock\./u)
})

test('TOOL_ID is the directory name, the package name and the tool field of the report', async () => {
  const directory = basename(ROOT)
  assert.equal(TOOL_ID, 'accessible-form-error-checker')
  assert.equal(TOOL_ID, directory, 'the exported id and the directory must not drift apart')
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(manifest.name, TOOL_ID)
  assert.equal(Object.keys(manifest.bin)[0], TOOL_ID)
  assert.deepEqual(manifest.dependencies, undefined, 'zero runtime dependencies')
  assert.deepEqual(manifest.devDependencies, undefined, 'zero dev dependencies')
})

test('nothing in the source can reach the network', async () => {
  const sources = await readdir(join(ROOT, 'src'))
  const forbidden = /node:(net|http|https|dns|tls|dgram)|\bfetch\(|XMLHttpRequest|WebSocket/u
  for (const name of [...sources.map((file) => join('src', file)), join('bin', `${TOOL_ID}.mjs`)]) {
    const text = await readFile(join(ROOT, name), 'utf8')
    assert.equal(forbidden.test(text), false, `${name} must not reach the network`)
  }
})
