/**
 * Ordering is observable, so it is pinned BEHAVIOURALLY.
 *
 * A source scan for `.localeCompare(` is not a determinism test: substituting
 * `Intl.Collator` produces identical collation drift with different source
 * text. These inputs are chosen so that code-unit order and collation order
 * genuinely differ, pushed through the real report path, and the exact emitted
 * order is asserted. The final assertion proves the inputs discriminate: a
 * collator really does sort them differently.
 */

import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { byCodeUnit, checkForm, compareFindings } from '../src/index.mjs'
import { NOW, checkMutated, stateNamed } from './helpers.mjs'

/** No age limit and no summary requirement, so only the ordering is in play. */
const EXPECTATIONS = {
  schemaVersion: '1',
  requireErrorSummary: false,
  requireAriaInvalid: true,
  focusAfterSubmit: ['first-invalid-field'],
}

/**
 * `MAX_DUPLICATE_URLS` before `MAX_DUPLICATE_URL_ENTRIES` because `S` (0x53)
 * precedes `_` (0x5F) by code point, while collation treats the underscore as
 * ignorable punctuation and puts `E` first. `Z` before `a` for the same kind of
 * reason. `a-b` before `a_b` likewise.
 */
const IDS = ['a_b', 'a-region', 'Z-region', 'MAX_DUPLICATE_URL_ENTRIES', 'a-b', 'MAX_DUPLICATE_URLS']

const EXPECTED = [
  'MAX_DUPLICATE_URLS',
  'MAX_DUPLICATE_URL_ENTRIES',
  'Z-region',
  'a-b',
  'a-region',
  'a_b',
]

async function reportOver(ids) {
  const snapshot = {
    schemaVersion: '1',
    capture: { id: 'ordering', source: 'dom-snapshot', idIndex: 'complete' },
    fields: ids.map((id) => ({
      id,
      labelling: { labelFor: null, ariaLabelledby: null, ariaLabel: id, wrappingLabel: false },
    })),
    nodes: [],
    states: [{
      name: 'only',
      visibleMessages: [],
      summary: null,
      fields: ids.map((id) => ({
        id,
        declaredError: null,
        describedby: null,
        errormessage: null,
        ariaInvalid: 'true',
      })),
    }],
  }
  const directory = await mkdtemp(join(tmpdir(), 'afec-order-'))
  const snapshotPath = join(directory, 'snapshot.json')
  const expectationsPath = join(directory, 'expectations.json')
  await writeFile(snapshotPath, JSON.stringify(snapshot))
  await writeFile(expectationsPath, JSON.stringify(EXPECTATIONS))
  return checkForm({ snapshot: snapshotPath, expectations: expectationsPath, now: NOW })
}

test('findings are emitted in code-unit order of their pointer', async () => {
  const report = await reportOver(IDS)
  assert.equal(report.findings.length, IDS.length)
  assert.deepEqual(
    report.findings.map((finding) => finding.location.pointer),
    EXPECTED.map((id) => `/states/only/fields/${id}`),
  )
})

test('the order does not depend on the order the snapshot listed them in', async () => {
  const forward = await reportOver(IDS)
  const backward = await reportOver([...IDS].reverse())
  assert.deepEqual(
    forward.findings.map((finding) => finding.location.pointer),
    backward.findings.map((finding) => finding.location.pointer),
  )
})

test('these inputs really do discriminate: a collator orders them differently', () => {
  const collated = [...EXPECTED].sort(new Intl.Collator('en').compare)
  assert.notDeepEqual(collated, EXPECTED, 'if these agreed, the test above could not fail')
  const byLocale = [...EXPECTED].sort((a, b) => a.localeCompare(b))
  assert.notDeepEqual(byLocale, EXPECTED)
})

test('byCodeUnit is a total order over the same inputs', () => {
  assert.deepEqual([...IDS].sort(byCodeUnit), EXPECTED)
  assert.equal(byCodeUnit('a', 'a'), 0)
  assert.equal(byCodeUnit('Z', 'a'), -1)
  assert.equal(byCodeUnit('a', 'Z'), 1)
})

test('findings at the same location are ordered by rule id, by code unit', async () => {
  // `error-not-associated` and `invalid-not-exposed` both land on the same
  // pointer, so the rule-id key is what decides, and reversing it would show.
  const snapshot = {
    schemaVersion: '1',
    capture: { id: 'same-pointer', source: 'dom-snapshot', idIndex: 'complete' },
    fields: [{ id: 'email', labelling: { labelFor: null, ariaLabelledby: null, ariaLabel: 'Email', wrappingLabel: false } }],
    nodes: [{ id: 'email-error', kind: 'message', belongsTo: 'email', text: 'Enter an email address' }],
    states: [{
      name: 'only',
      visibleMessages: ['email-error'],
      summary: null,
      fields: [{
        id: 'email',
        declaredError: 'email-error',
        describedby: null,
        errormessage: null,
        ariaInvalid: null,
      }],
    }],
  }
  const directory = await mkdtemp(join(tmpdir(), 'afec-order2-'))
  const snapshotPath = join(directory, 'snapshot.json')
  const expectationsPath = join(directory, 'expectations.json')
  await writeFile(snapshotPath, JSON.stringify(snapshot))
  await writeFile(expectationsPath, JSON.stringify(EXPECTATIONS))
  const report = await checkForm({ snapshot: snapshotPath, expectations: expectationsPath, now: NOW })
  assert.deepEqual(
    report.findings.map((finding) => finding.ruleId),
    ['error-not-associated', 'invalid-not-exposed'],
  )
  assert.equal(new Set(report.findings.map((finding) => finding.location.pointer)).size, 1)
})

test('each sort key decides on its own, and none of them is decoration', async (t) => {
  // A mutation sweep found three of the four keys undefended: every finding in
  // a run comes from one file, and the message key happened to order the
  // fixtures the same way the pointer key did, so dropping either changed
  // nothing observable. The keys are asserted directly, one at a time.
  const finding = (file, pointer, ruleId, message) => ({
    ruleId,
    severity: 'error',
    message,
    location: { file, pointer },
  })

  await t.test('file decides first', () => {
    const a = finding('Zebra.json', '/z', 'z-rule', 'z')
    const b = finding('apple.json', '/a', 'a-rule', 'a')
    assert.equal(compareFindings(a, b), -1, 'Z before a by code unit, whatever the other keys say')
    assert.equal(compareFindings(b, a), 1)
    assert.deepEqual(
      [b, a].sort(compareFindings).map((entry) => entry.location.file),
      ['Zebra.json', 'apple.json'],
    )
  })

  await t.test('pointer decides when the file is the same', () => {
    const a = finding('x.json', '/a-b', 'z-rule', 'zzz')
    const b = finding('x.json', '/a_b', 'a-rule', 'aaa')
    assert.equal(compareFindings(a, b), -1, '- before _ by code unit, whatever the other keys say')
    assert.equal(compareFindings(b, a), 1)
  })

  await t.test('rule id decides when the file and pointer are the same', () => {
    const a = finding('x.json', '/same', 'MAX_DUPLICATE_URLS', 'zzz')
    const b = finding('x.json', '/same', 'MAX_DUPLICATE_URL_ENTRIES', 'aaa')
    assert.equal(compareFindings(a, b), -1, 'S before _ by code unit')
    assert.equal(compareFindings(b, a), 1)
  })

  await t.test('message decides when everything else is the same', () => {
    const a = finding('x.json', '/same', 'same-rule', 'Zebra')
    const b = finding('x.json', '/same', 'same-rule', 'apple')
    assert.equal(compareFindings(a, b), -1)
    assert.equal(compareFindings(b, a), 1)
    assert.equal(compareFindings(a, { ...a }), 0)
  })

  await t.test('a run really can emit two findings that differ only in message', async () => {
    // `stale-error-message` fires once per message left visible, all at the
    // same pointer with the same rule id, so the message key is reachable.
    const report = await checkMutated((snapshot) => {
      snapshot.nodes.push({
        id: 'email-error-format',
        kind: 'message',
        belongsTo: 'email',
        text: 'Enter a valid email address',
      })
      stateNamed(snapshot, '04-both-corrected').visibleMessages = [
        'email-error-required',
        'email-error-format',
      ]
    })
    const stale = report.findings.filter((entry) => entry.ruleId === 'stale-error-message')
    assert.equal(stale.length, 2)
    assert.equal(new Set(stale.map((entry) => entry.location.pointer)).size, 1)
    assert.deepEqual(
      stale.map((entry) => /message (\S+) written/u.exec(entry.message)[1]),
      ['email-error-format', 'email-error-required'],
    )
  })
})

test('an unreadable region must give a reason the tool knows', async () => {
  const report = await checkMutated((snapshot) => {
    snapshot.unreadableRegions = [{ hostId: 'widget', reason: 'it-was-tricky' }]
  })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.findings.map((entry) => entry.ruleId), ['snapshot-invalid'])
  assert.match(report.findings[0].message, /must give a "reason" from: shadow-root, closed-shadow-root/u)
  assert.equal(report.summary.checked, 0)
})
