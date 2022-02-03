/**
 * The shape guards, pinned one at a time.
 *
 * Every test in this file exists because a mutation sweep found the guard
 * undefended: the code was right and nothing held it there. Several of these
 * mutations leave the same rule id firing with a different message, which is
 * exactly the shape a rule-id-only assertion cannot see -- so the message is
 * what is asserted.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { makeFinding, msg, readField, readNode, readStateField } from '../src/index.mjs'
import { checkMutated, findingsFor, ruleIds, stateNamed } from './helpers.mjs'

test('a field recorded twice in one state is ambiguous, and neither record is used', async () => {
  const report = await checkMutated((snapshot) => {
    const state = stateNamed(snapshot, '04-both-corrected')
    state.fields.push({
      id: 'email',
      declaredError: null,
      describedby: null,
      errormessage: null,
      ariaInvalid: 'true',
    })
  })
  assert.equal(report.status, 'incomplete')
  const duplicate = findingsFor(report, 'duplicate-node-id')
  assert.equal(duplicate.length, 1)
  assert.match(duplicate[0].message, /records field email more than once/u)
  assert.equal(duplicate[0].location.pointer, '/states/04-both-corrected/fields/email')
  // Neither record decides anything: the second one would have failed the
  // stale-error check, and it must not, because which one describes the field
  // is not established.
  assert.ok(!ruleIds(report).includes('stale-error-state'))
  assert.ok(ruleIds(report).includes('state-field-not-recorded'))
})

test('a state that records a field the snapshot never declares is reported, not ignored', async () => {
  const report = await checkMutated((snapshot) => {
    stateNamed(snapshot, '04-both-corrected').fields.push({
      id: 'phone',
      declaredError: null,
      describedby: null,
      errormessage: null,
      ariaInvalid: 'true',
    })
  })
  assert.equal(report.status, 'incomplete')
  const stray = findingsFor(report, 'field-invalid')
  assert.equal(stray.length, 1)
  assert.match(stray[0].message, /records a field phone that the snapshot does not declare/u)
  assert.equal(stray[0].location.pointer, '/states/04-both-corrected/fields/phone')
})

test('every required key of a state field record is required BY NAME', async (t) => {
  for (const key of ['declaredError', 'describedby', 'errormessage']) {
    await t.test(key, async () => {
      const report = await checkMutated((snapshot) => {
        delete stateNamed(snapshot, '04-both-corrected').fields[0][key]
      })
      assert.equal(report.status, 'incomplete')
      const invalid = findingsFor(report, 'field-invalid')
      assert.equal(invalid.length, 1)
      assert.match(
        invalid[0].message,
        new RegExp(`"${key}" is required; use null when`, 'u'),
        'the message must name the key and say null is the way to record an absent attribute',
      )
    })
  }

  await t.test('the reader says the same thing directly', () => {
    const base = { id: 'email', declaredError: null, describedby: null, errormessage: null }
    assert.equal(readStateField(base).ok, true)
    for (const key of ['declaredError', 'describedby', 'errormessage']) {
      const raw = { ...base }
      delete raw[key]
      const read = readStateField(raw)
      assert.equal(read.ok, false)
      assert.match(read.reason, new RegExp(`"${key}" is required`, 'u'))
    }
  })
})

test('a message node must say which field it is written about', async () => {
  const report = await checkMutated((snapshot) => {
    delete snapshot.nodes.find((node) => node.id === 'email-error-required').belongsTo
  })
  assert.equal(report.status, 'incomplete')
  const invalid = findingsFor(report, 'node-invalid')
  assert.equal(invalid.length, 1)
  assert.match(invalid[0].message, /must record "belongsTo": the id of the field it is about/u)
  // Without belongsTo the tool must not decide the association either way.
  assert.ok(!ruleIds(report).includes('error-association-wrong'))

  assert.equal(readNode({ id: 'm', kind: 'message', text: 'x' }).ok, false)
  assert.equal(readNode({ id: 'm', kind: 'message', text: 'x', belongsTo: 'email' }).ok, true)
  assert.equal(readNode({ id: 'm', kind: 'other', text: 'x' }).ok, true, 'only a message node needs it')
})

test('an idIndex value the tool does not know is refused, not read as complete', async () => {
  // A typo here would silently turn a partial index into a complete one, which
  // is the difference between "this reference is a gap" and "this reference is
  // broken". It is refused rather than guessed.
  for (const value of ['complte', 'COMPLETE', true, null, undefined]) {
    const report = await checkMutated((snapshot) => {
      if (value === undefined) delete snapshot.capture.idIndex
      else snapshot.capture.idIndex = value
    })
    assert.equal(report.status, 'incomplete', String(value))
    assert.deepEqual(ruleIds(report), ['snapshot-invalid'])
    assert.match(report.findings[0].message, /"capture.idIndex" must be one of: complete, partial/u)
    assert.equal(report.summary.checked, 0, 'nothing is checked against an index of unknown completeness')
  }
})

test('every sub-key of labelling is required BY NAME', async (t) => {
  for (const key of ['labelFor', 'ariaLabelledby', 'ariaLabel', 'wrappingLabel']) {
    await t.test(key, async () => {
      const report = await checkMutated((snapshot) => {
        delete snapshot.fields[0].labelling[key]
      })
      assert.equal(report.status, 'incomplete')
      // The field is dropped from the index, so every state then records a
      // field the snapshot no longer declares. What is asserted here is that
      // the FIRST refusal names the missing key.
      const named = findingsFor(report, 'field-invalid').filter((finding) => (
        new RegExp(`"labelling" must record "${key}"; use null when the attribute was absent`, 'u').test(finding.message)
      ))
      assert.equal(named.length, 1)
      assert.equal(named[0].location.pointer, '/fields/0')
    })
  }

  await t.test('the reader says the same thing directly', () => {
    const labelling = { labelFor: null, ariaLabelledby: null, ariaLabel: 'Email', wrappingLabel: false }
    assert.equal(readField({ id: 'email', labelling }).ok, true)
    for (const key of Object.keys(labelling)) {
      const partial = { ...labelling }
      delete partial[key]
      const read = readField({ id: 'email', labelling: partial })
      assert.equal(read.ok, false, key)
      assert.match(read.reason, new RegExp(`must record "${key}"`, 'u'))
    }
  })
})

test('a suggestion crosses the sanitising boundary like every other output string', () => {
  // Every call site builds its suggestion from this tool's own ASCII literals
  // today, so this changes no byte of any current report -- which is exactly
  // why it was the one string that could quietly skip the boundary. The guard
  // is asserted directly rather than through a fixture that cannot reach it.
  const finding = makeFinding(
    'stale-error-state',
    msg`a message`,
    { file: 'snapshot.json' },
    { suggestion: 'Clear it\u0085ERROR forged\u2028line\u202eand reversed' },
  )
  assert.equal(finding.suggestion, 'Clear it ERROR forged line and reversed')
  for (const character of ['\u0085', '\u2028', '\u202e']) {
    assert.ok(!finding.suggestion.includes(character))
  }
})
