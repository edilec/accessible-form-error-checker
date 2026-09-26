/**
 * The guards a line-indexed mutation sweep found undefended outside the reader.
 *
 * Each case below names the mutation it exists to fail on, because a test whose
 * purpose is not written down is a test the next person deletes. Every one was
 * proved non-equivalent first: a differential corpus of 5824 documents shows the
 * mutated tool emitting a different exit code or a different report, so none of
 * these is an equivalent mutant being tested for the sake of a score.
 */

import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { describeValue, num, parseInstant, sanitize } from '../src/index.mjs'
import {
  checkMutated,
  cleanExpectations,
  cleanSnapshot,
  fieldIn,
  findingsFor,
  ruleIds,
  runCli,
  runCliRaw,
  stateNamed,
} from './helpers.mjs'

test('a field in error whose aria-invalid was never recorded is a gap, not a pass', async () => {
  // src/checks.mjs `if (!record.ariaInvalidCaptured)` inside the
  // requireAriaInvalid branch, and the `aria-invalid-not-captured` push under
  // it. Deleting either turned this run from exit 2 into exit 1 and exit 0.
  // The other branch -- a field NOT in error -- was already covered; this one
  // is the branch `requireAriaInvalid` governs.
  const report = await checkMutated((snapshot) => {
    delete fieldIn(stateNamed(snapshot, '01-submitted-empty'), 'email').ariaInvalid
  })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ruleIds(report), ['aria-invalid-not-captured'])
  assert.match(findingsFor(report, 'aria-invalid-not-captured')[0].message, /declares an error for field email/u)

  const cli = await runCli(await (async () => {
    const snapshot = await cleanSnapshot()
    delete fieldIn(stateNamed(snapshot, '01-submitted-empty'), 'email').ariaInvalid
    return snapshot
  })(), await cleanExpectations())
  assert.equal(cli.code, 2)
})

test('a summary block nobody could parse is not read as a summary', async () => {
  // src/checks.mjs `if (state.summary === undefined) return`. Without it the
  // run reached `state.summary.links` on `undefined` and died with a TypeError
  // -- an execution failure in place of an honest incomplete report.
  const report = await checkMutated((snapshot) => {
    stateNamed(snapshot, '01-submitted-empty').summary = { toString: {} }
  })
  assert.equal(report.status, 'incomplete')
  assert.ok(ruleIds(report).includes('state-invalid'))
  assert.ok(!ruleIds(report).includes('summary-missing-error'), 'nothing is concluded from a block nobody parsed')
})

test('a permitted focus target that could not be identified is a gap, not a miss', async () => {
  // src/checks.mjs `if (allowed.size === 0)` and the `focus-not-captured` push
  // under it. Deleting either turned exit 2 into exit 1 and exit 0: with no
  // permitted target identifiable, an empty allowed map makes every recorded
  // focus look like a miss, which is an accusation the evidence cannot support.
  const report = await checkMutated(
    (snapshot) => { for (const state of snapshot.states) state.summary = null },
    {
      expectations: (expectations) => {
        expectations.focusAfterSubmit = ['summary']
        expectations.requireErrorSummary = false
      },
    },
  )
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ruleIds(report), ['focus-not-captured'])
  const finding = findingsFor(report, 'focus-not-captured')[0]
  assert.match(finding.message, /none of the targets these expectations permit could be identified/u)
  assert.equal(finding.evidence, 'permitted: summary')
  assert.ok(!ruleIds(report).includes('focus-not-recovered'))
})

test('the permitted ids a focus finding lists are ordered by code unit', async () => {
  // src/checks.mjs `[...allowed.keys()].sort(byCodeUnit)`, the evidence line of
  // `focus-not-recovered`. The insertion order is the order
  // `focusAfterSubmit` lists the targets in, so these two are chosen to differ:
  // `email` is inserted first and `Summary-block` sorts first.
  const report = await checkMutated(
    (snapshot) => {
      for (const state of snapshot.states) {
        if (state.summary !== null && state.summary !== undefined) state.summary.id = 'Summary-block'
      }
      snapshot.nodes.push({ id: 'Summary-block', kind: 'summary', text: 'There is a problem' })
      stateNamed(snapshot, '01-submitted-empty').focus = 'email-hint'
    },
    { expectations: (expectations) => { expectations.focusAfterSubmit = ['first-invalid-field', 'summary'] } },
  )
  const finding = findingsFor(report, 'focus-not-recovered')[0]
  assert.equal(finding.evidence, 'permitted ids: Summary-block, email')
})

test('the reasons an index-incomplete finding lists are ordered by code unit', async () => {
  // src/checks.mjs `[...new Set(reasons)].sort(byCodeUnit).join('; ')`. The
  // insertion order is subtree-then-declaration and the code-unit order is the
  // reverse, so these two reasons together are what makes the sort observable.
  const report = await checkMutated((snapshot) => {
    snapshot.capture.idIndex = 'partial'
    snapshot.unreadableRegions = [{ hostId: 'card-widget', reason: 'shadow-root' }]
  })
  const finding = findingsFor(report, 'index-incomplete')[0]
  assert.equal(
    finding.evidence,
    'the snapshot declares "idIndex": "partial"; the subtree under card-widget was not captured',
  )
})

test('a focus value that is not an id is reported, and nothing is concluded from it', async () => {
  // src/checks.mjs the `typeof state.focus !== 'string'` guard and the
  // `state-invalid` push under it. Deleting the guard let a number be compared
  // against the permitted ids and reported as focus on the wrong place; deleting
  // the push dropped the gap silently.
  const report = await checkMutated((snapshot) => {
    stateNamed(snapshot, '01-submitted-empty').focus = { toString: {} }
  })
  assert.equal(report.status, 'incomplete')
  assert.ok(ruleIds(report).includes('state-invalid'))
  assert.ok(ruleIds(report).includes('focus-not-captured'), 'the focus key is treated as never recorded')
  assert.ok(!ruleIds(report).includes('focus-not-recovered'))
})

test('a field recorded three times in one state stays ambiguous after the second', async () => {
  // src/checks.mjs `if (state.ambiguous.has(read.record.id)) continue`. Without
  // it the third record was accepted into `state.records` after the duplicate
  // had deleted the first two, so the state was checked against a record the
  // run had just said was ambiguous.
  const report = await checkMutated((snapshot) => {
    const state = stateNamed(snapshot, '01-submitted-empty')
    const record = fieldIn(state, 'email')
    state.fields.push({ ...record }, { ...record, ariaInvalid: null })
  })
  assert.equal(report.status, 'incomplete')
  assert.equal(findingsFor(report, 'duplicate-node-id').length, 1, 'said once, not once per extra record')
  assert.ok(ruleIds(report).includes('state-field-not-recorded'), 'the field is treated as not recorded at all')
  assert.ok(!ruleIds(report).includes('invalid-not-exposed'), 'nothing is checked against an ambiguous record')
})

test('an input path that is not a regular file is unreadable, not opened anyway', async () => {
  // src/index.mjs `if (!info.isFile())`. Without it a directory reached
  // `readFile`, which failed with a different code, so the report named the
  // wrong reason for the same refusal.
  const directory = await mkdtemp(join(tmpdir(), 'afec-dir-'))
  const expectations = join(directory, 'expectations.json')
  await writeFile(expectations, JSON.stringify(await cleanExpectations()))
  const result = await runCliRaw(['--snapshot', directory, '--expectations', expectations, '--now', '2026-09-18', '--json'])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ruleIds(report), ['snapshot-unreadable'])
  assert.match(report.findings[0].message, /not a regular file/u)
})

test('parseInstant asks about a string, before it asks about a date', async (t) => {
  // src/policy.mjs `if (!isRenderableString(value, 40))`. `RegExp.exec` coerces
  // its argument, so without this guard a value that cannot be converted to a
  // primitive at all -- which is what `{"capturedAt": {"toString": {}}}` parses
  // into -- threw out of the check instead of being reported as an age nobody
  // could establish. The crash is before the sanitiser, not after it.
  await t.test('a value that will not convert to a primitive', () => {
    assert.deepEqual(parseInstant({ toString: {} }), { ok: false, ms: null })
  })

  await t.test('and the run says the age was not established rather than failing', async () => {
    const report = await checkMutated((snapshot) => { snapshot.capture.capturedAt = { toString: {} } })
    assert.equal(report.status, 'incomplete')
    assert.ok(ruleIds(report).includes('snapshot-age-unknown'))
  })

  await t.test('an array whose text looks like a date is not a date', () => {
    // `String(['2026-09-18'])` is '2026-09-18', so coercion would accept it.
    assert.deepEqual(parseInstant(['2026-09-18']), { ok: false, ms: null })
  })
})

test('parseInstant refuses a time of day the clock does not have', async (t) => {
  // src/policy.mjs `if (hour > 23 || minute > 59 || second > 59)`. The
  // round-trip check below it catches an hour, because 24:00 lands on the next
  // day -- but a minute of 60 rolls forward one hour and leaves the DATE alone,
  // so it round-tripped clean and the run silently used an instant an hour
  // later than the document said. That mutation turned exit 2 into exit 0.
  for (const value of ['2026-09-18T00:60:00Z', '2026-09-18T00:00:60Z', '2026-09-18T24:00:00Z']) {
    await t.test(value, () => {
      assert.deepEqual(parseInstant(value), { ok: false, ms: null })
    })
  }
  await t.test('the last instant of a day is still a date', () => {
    assert.equal(parseInstant('2026-09-18T23:59:59Z').ok, true)
  })
})

test('a limits value that is not an object is a configuration error', async () => {
  // src/policy.mjs `if (!isRecord(document.limits))`. Without it `[]` and `0`
  // both walked past every limit check and the run exited 0 -- a policy the
  // tool never read, reported as a policy that held.
  for (const limits of [[], 0, 'none', true]) {
    const result = await runCli(await cleanSnapshot(), { ...(await cleanExpectations()), limits })
    assert.equal(result.code, 2, JSON.stringify(limits))
    assert.equal(result.stdout, '', 'a configuration error leaves stdout empty')
    assert.match(result.stderr, /"limits" must be a JSON object\./u)
  }
})

test('the key lists a configuration error prints are ordered by code unit', async (t) => {
  // src/policy.mjs three `.sort()` call sites: the unknown top-level keys, the
  // known-key list printed beside them, and the unknown limit names. Each one
  // is a string a person reads; none of them was pinned, and the insertion
  // order differs from the code-unit order for the pairs chosen here.
  await t.test('unknown expectation keys, and the known list beside them', async () => {
    const expectations = { ...(await cleanExpectations()), zeta: 1, Alpha: 2 }
    const result = await runCli(await cleanSnapshot(), expectations)
    assert.equal(result.code, 2)
    assert.match(result.stderr, /^Unknown expectation key\(s\): Alpha, zeta\. /u)
    assert.match(
      result.stderr,
      /Known keys: focusAfterSubmit, limits, maxSnapshotAgeDays, requireAriaInvalid, requireErrorSummary, schemaVersion\./u,
    )
  })

  await t.test('unknown limit names', async () => {
    const expectations = { ...(await cleanExpectations()), limits: { zeta: 1, Alpha: 2 } }
    const result = await runCli(await cleanSnapshot(), expectations)
    assert.equal(result.code, 2)
    assert.match(result.stderr, /^Unknown limit\(s\): Alpha, zeta\. Known limits: maxFields, maxNodes, maxSnapshotBytes, maxStates\./u)
  })
})

test('describeValue names a shape it will not reproduce', async (t) => {
  // src/rules.mjs. The array branch was the one nothing defended: without it
  // `String([])` is the empty string, so an array arriving where a string was
  // expected rendered as nothing at all and the report said so about a value
  // that was plainly there.
  await t.test('an array is described, never stringified', () => {
    assert.equal(describeValue([]), '[array]')
    assert.equal(describeValue(['a', 'b']), '[array]')
    assert.equal(sanitize([]), '[array]')
  })

  await t.test('and the report says so rather than showing nothing', async () => {
    const report = await checkMutated((snapshot) => { snapshot.capture.source = [] })
    assert.deepEqual(ruleIds(report), ['capture-source-unsupported'])
    assert.match(report.findings[0].message, /declares its source as \[array\]/u)
  })

  await t.test('the other shapes it names', () => {
    assert.equal(describeValue({ toString: {} }), '[object]')
    // A function converts fine, so the `[function]` branch is only reached when
    // conversion itself fails -- which is the point of the branch.
    assert.equal(describeValue(Object.assign(() => {}, { toString: {}, valueOf: {} })), '[function]')
    assert.equal(describeValue(null), 'null')
    assert.equal(describeValue(undefined), 'undefined')
    assert.equal(describeValue('plain'), 'plain')
  })
})

test('num describes a value it cannot print as a number', () => {
  // src/rules.mjs `if (!Number.isFinite(value)) return describeValue(value)`.
  // For NaN and the infinities the arithmetic below happens to print the same
  // text, so no document in the corpus tells the two apart -- but `num` is
  // exported, and for anything that is not a number at all the guard is the
  // difference between the value and the word NaN.
  assert.equal(num(0), '0')
  assert.equal(num(-0), '0')
  assert.equal(num(1.23456), '1.2346')
  assert.equal(num(Number.NaN), 'NaN')
  assert.equal(num(Number.POSITIVE_INFINITY), 'Infinity')
  assert.equal(num('seven'), 'seven')
  assert.equal(num([]), '[array]')
  assert.equal(num(null), 'null')
})
