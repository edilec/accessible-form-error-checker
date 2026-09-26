/**
 * Every guard in the snapshot reader, one case each.
 *
 * A line-indexed mutation sweep over `src/` and `bin/` -- every `if` condition
 * replaced with `false`, every severity flipped, every evidence-missing entry
 * deleted, every ordering call site given a collator -- found the whole of
 * `readField`, `readNode`, `readStateField`, `readSummary` and `readSnapshot`
 * undefended: thirty-eight guards could be deleted with the suite still green,
 * and a differential corpus proved every one of them changes what the tool
 * emits. None of them was an equivalent mutant.
 *
 * Each guard answers with its own `reason`, and the reason is what the report
 * prints as the gap, so the reason is what is asserted. Neutering a guard makes
 * the reader either accept the record or refuse it for a different reason, and
 * either one fails the case below.
 *
 * The table is followed by the same documents driven through the real CLI, so
 * that a reader refusal is also observed as exit 2 with an `incomplete` report
 * rather than only as a return value.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  readField,
  readNode,
  readSnapshot,
  readStateField,
  readSummary,
} from '../src/index.mjs'
import { cleanExpectations, cleanSnapshot, ruleIds, runCli, stateNamed } from './helpers.mjs'

const UNRENDERABLE = '\u0001\u200e'

function labelling(overrides = {}) {
  return { labelFor: null, ariaLabelledby: null, ariaLabel: null, wrappingLabel: false, ...overrides }
}

function stateField(overrides = {}) {
  return { id: 'email', declaredError: null, describedby: null, errormessage: null, ...overrides }
}

/** [reader, what it is given, the reason it must give back]. */
const REFUSALS = [
  // readField
  [readField, 7, 'the field record is not a JSON object'],
  [readField, null, 'the field record is not a JSON object'],
  [readField, [], 'the field record is not a JSON object'],
  [readField, { id: 1 }, 'the field has no usable "id"'],
  [readField, { id: UNRENDERABLE }, 'the field has no usable "id"'],
  [readField, { id: 'a', labelling: 7 }, '"labelling" is not a JSON object'],
  [readField, { id: 'a', labelling: { ariaLabelledby: null, ariaLabel: null, wrappingLabel: false } },
    '"labelling" must record "labelFor"; use null when the attribute was absent'],
  [readField, { id: 'a', labelling: labelling({ ariaLabelledby: 'x' }) },
    '"labelling.ariaLabelledby" must be null or an array of ids'],
  [readField, { id: 'a', labelling: labelling({ ariaLabelledby: [1] }) },
    '"labelling.ariaLabelledby" must be null or an array of ids'],
  [readField, { id: 'a', labelling: labelling({ ariaLabelledby: Array.from({ length: 33 }, (_, i) => `n${i}`) }) },
    '"labelling.ariaLabelledby" must be null or an array of ids'],
  [readField, { id: 'a', labelling: labelling({ labelFor: 1 }) }, '"labelling.labelFor" must be null or an id'],
  [readField, { id: 'a', labelling: labelling({ ariaLabel: 7 }) }, '"labelling.ariaLabel" must be null or a string'],
  [readField, { id: 'a', labelling: labelling({ wrappingLabel: 'yes' }) },
    '"labelling.wrappingLabel" must be true or false'],
  [readField, { id: 'a', asyncValidated: 'yes' }, '"asyncValidated" must be true or false'],

  // readNode
  [readNode, 7, 'the node record is not a JSON object'],
  [readNode, { id: 1, kind: 'label' }, 'the node has no usable "id"'],
  [readNode, { id: 'a', kind: 'heading' }, '"kind" must be one of: label, message, summary, other'],
  [readNode, { id: 'a', kind: 'label', text: 7 }, '"text" must be null or a string'],
  [readNode, { id: 'a', kind: 'message' },
    'a "message" node must record "belongsTo": the id of the field it is about'],

  // readStateField
  [readStateField, 7, 'the state field record is not a JSON object'],
  [readStateField, { id: 1 }, 'the state field record has no usable "id"'],
  [readStateField, { id: 'a' },
    '"declaredError" is required; use null when the state declares no error for the field'],
  [readStateField, stateField({ declaredError: 1 }), '"declaredError" must be null or the id of a message node'],
  [readStateField, { id: 'a', declaredError: null },
    '"describedby" is required; use null when the attribute was absent'],
  [readStateField, stateField({ describedby: 'x' }), '"describedby" must be null or an array of ids'],
  [readStateField, stateField({ describedby: [1] }), '"describedby" must be null or an array of ids'],
  [readStateField, { id: 'a', declaredError: null, describedby: null },
    '"errormessage" is required; use null when the attribute was absent'],
  [readStateField, stateField({ errormessage: 1 }), '"errormessage" must be null or an id'],
  [readStateField, stateField({ pending: 'yes' }), '"pending" must be true or false'],
  [readStateField, stateField({ ariaInvalid: 7 }), '"ariaInvalid" must be null or a string'],
  [readStateField, stateField({ ariaBusy: 7 }), '"ariaBusy" must be null or a string'],

  // readSummary
  [readSummary, 7, 'the summary is not a JSON object'],
  [readSummary, { id: 1, links: [] }, 'the summary has no usable "id"'],
  [readSummary, { id: 'a', links: 'x' }, 'the summary must record a "links" array of at most 500 entries'],
  [readSummary, { id: 'a', links: Array.from({ length: 501 }, () => ({ target: 'x' })) },
    'the summary must record a "links" array of at most 500 entries'],
  [readSummary, { id: 'a', links: [7] }, 'a summary link is not a JSON object'],
  [readSummary, { id: 'a', links: [{ target: 1 }] }, 'a summary link has no usable "target"'],
]

test('every guard in the record readers refuses with its own reason', async (t) => {
  for (const [reader, raw, reason] of REFUSALS) {
    await t.test(`${reader.name}: ${reason}`, () => {
      assert.deepEqual(reader(raw), { ok: false, reason })
    })
  }
})

test('the readers accept the shapes the documented schema allows', async (t) => {
  // The guard for the guards: a reader that refused everything would pass every
  // case above while making the tool useless.
  await t.test('readField', () => {
    assert.equal(readField({ id: 'a' }).ok, true)
    assert.equal(readField({ id: 'a', labelling: labelling({ ariaLabelledby: ['x', 'y'] }) }).ok, true)
    assert.equal(readField({ id: 'a', asyncValidated: true }).ok, true)
  })
  await t.test('readNode', () => {
    for (const kind of ['label', 'summary', 'other']) assert.equal(readNode({ id: 'a', kind }).ok, true)
    assert.equal(readNode({ id: 'a', kind: 'message', belongsTo: 'f', text: null }).ok, true)
  })
  await t.test('readStateField', () => {
    assert.equal(readStateField(stateField()).ok, true)
    assert.equal(readStateField(stateField({ ariaInvalid: null, ariaBusy: null, pending: true })).ok, true)
  })
  await t.test('readSummary', () => {
    assert.equal(readSummary({ id: 'a', links: [] }).ok, true)
    assert.equal(readSummary({ id: 'a', links: [{ target: 'f' }] }).ok, true)
  })
})

function snapshotWith(mutate) {
  const document = {
    schemaVersion: '1',
    capture: { id: 'c', source: 'dom-snapshot', idIndex: 'complete' },
    fields: [],
    nodes: [],
    states: [],
  }
  mutate(document)
  return document
}

/** [what the top-level reader is given, the reason it must give back]. */
const DOCUMENT_REFUSALS = [
  ['not an object', () => 7, 'the snapshot is not a JSON object'],
  ['null', () => null, 'the snapshot is not a JSON object'],
  ['an array', () => [], 'the snapshot is not a JSON object'],
  ['a wrong schemaVersion', () => snapshotWith((d) => { d.schemaVersion = '2' }),
    'the snapshot must declare "schemaVersion": "1"'],
  ['no capture object', () => snapshotWith((d) => { d.capture = 7 }),
    'the snapshot must record a "capture" object'],
  ['an unusable capture id', () => snapshotWith((d) => { d.capture.id = 1 }),
    '"capture.id" is missing or unusable'],
  ['an unknown idIndex', () => snapshotWith((d) => { d.capture.idIndex = 'some' }),
    '"capture.idIndex" must be one of: complete, partial'],
  ['fields that are not an array', () => snapshotWith((d) => { d.fields = {} }), '"fields" must be an array'],
  ['nodes that are not an array', () => snapshotWith((d) => { d.nodes = {} }), '"nodes" must be an array'],
  ['states that are not an array', () => snapshotWith((d) => { d.states = {} }), '"states" must be an array'],
  ['unreadableRegions that are not an array', () => snapshotWith((d) => { d.unreadableRegions = 'x' }),
    '"unreadableRegions" must be an array of at most 200 entries'],
  ['too many unreadableRegions', () => snapshotWith((d) => {
    d.unreadableRegions = Array.from({ length: 201 }, (_, i) => ({ hostId: `h${i}`, reason: 'shadow-root' }))
  }), '"unreadableRegions" must be an array of at most 200 entries'],
  ['an unreadable region that is not an object', () => snapshotWith((d) => { d.unreadableRegions = [7] }),
    'an unreadable region is not a JSON object'],
  ['an unreadable region with no host', () => snapshotWith((d) => { d.unreadableRegions = [{ hostId: 1, reason: 'shadow-root' }] }),
    'an unreadable region has no usable "hostId"'],
  ['an unreadable region with an unknown reason', () => snapshotWith((d) => { d.unreadableRegions = [{ hostId: 'h', reason: 'because' }] }),
    'an unreadable region must give a "reason" from: shadow-root, closed-shadow-root, cross-origin-iframe, '
    + 'not-serialisable, access-denied'],
  ['a state that is not an object', () => snapshotWith((d) => { d.states = [7] }), 'state 0 is not a JSON object'],
  ['a state with no usable name', () => snapshotWith((d) => { d.states = [{ name: 1, fields: [] }] }),
    'state 0 has no usable "name"'],
  ['a state whose fields are not an array', () => snapshotWith((d) => { d.states = [{ name: 'only', fields: 7 }] }),
    'state "only" must record a "fields" array'],
  ['a state whose submitted is not a boolean', () => snapshotWith((d) => {
    d.states = [{ name: 'only', fields: [], submitted: 'yes' }]
  }), 'state "only" must record "submitted" as true or false'],
]

test('every guard in readSnapshot refuses with its own reason', async (t) => {
  for (const [label, build, reason] of DOCUMENT_REFUSALS) {
    await t.test(label, () => {
      assert.deepEqual(readSnapshot(build()), { ok: false, reason })
    })
  }
})

test('a document readSnapshot refuses is exit 2 with an incomplete report, never a pass', async (t) => {
  // The reasons above are return values; this is the behaviour they produce.
  for (const [label, build, reason] of DOCUMENT_REFUSALS) {
    await t.test(label, async () => {
      const result = await runCli(build(), await cleanExpectations())
      assert.equal(result.code, 2)
      const report = JSON.parse(result.stdout)
      assert.equal(report.status, 'incomplete')
      assert.deepEqual(ruleIds(report), ['snapshot-invalid'])
      assert.ok(report.findings[0].message.includes(reason), report.findings[0].message)
      assert.equal(report.summary.checked, 0)
    })
  }
})

test('a record the readers refuse is reported as a gap, not skipped', async (t) => {
  // The per-record readers are reached through `buildIndex` and the state loop,
  // where a refusal becomes a finding rather than a dropped record -- and the
  // finding carries the reader's own reason, so a guard that stopped refusing
  // would change what the report says was wrong.
  const cases = [
    ['a field record', (snapshot) => { snapshot.fields.push({ id: 'x', asyncValidated: 'yes' }) },
      'field-invalid', '"asyncValidated" must be true or false'],
    ['a node record', (snapshot) => { snapshot.nodes.push({ id: 'x', kind: 'label', text: 7 }) },
      'node-invalid', '"text" must be null or a string'],
    ['a state field record', (snapshot) => {
      stateNamed(snapshot, '01-submitted-empty').fields.push({ id: 'email', declaredError: null, describedby: 'x', errormessage: null })
    }, 'field-invalid', '"describedby" must be null or an array of ids'],
    ['a summary block', (snapshot) => { stateNamed(snapshot, '01-submitted-empty').summary = { id: 'x', links: [7] } },
      'state-invalid', 'a summary link is not a JSON object'],
  ]
  for (const [label, mutate, ruleId, reason] of cases) {
    await t.test(label, async () => {
      const snapshot = await cleanSnapshot()
      mutate(snapshot)
      const result = await runCli(snapshot, await cleanExpectations())
      assert.equal(result.code, 2)
      const report = JSON.parse(result.stdout)
      assert.equal(report.status, 'incomplete')
      const finding = report.findings.find((entry) => entry.ruleId === ruleId)
      assert.ok(finding !== undefined, ruleIds(report).join(', '))
      assert.ok(finding.message.includes(reason), finding.message)
    })
  }
})
