/**
 * The sanitising boundary, and the difference between "present" and "renders as
 * something".
 *
 * Two shapes are pinned here, and both have shipped as real defects:
 *
 * 1. A tool that sanitised its `evidence` field carefully and let an
 *    IDENTIFIER carrying a newline forge whole lines in the report. Every
 *    untrusted string crosses the same boundary, so each class is driven
 *    through a node id, not only through an excerpt.
 * 2. `value.trim().length > 0` passing for a string of U+0001 or U+200E that
 *    then shows nothing at all. Whatever decides "is this usable" must be asked
 *    about the rendered form.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { describeValue, isRenderableString, renderReport, sanitize, showsSomething } from '../src/index.mjs'
import { checkMutated, fieldIn, findingsFor, ruleIds, stateNamed } from './helpers.mjs'

const CLASSES = [
  ['C0', '\u0001'],
  ['newline', '\n'],
  ['DEL', '\u007f'],
  ['C1 NEL', '\u0085'],
  ['C1 CSI', '\u009b'],
  ['line separator', '\u2028'],
  ['paragraph separator', '\u2029'],
  ['bidi LRM', '\u200e'],
  ['bidi RLO', '\u202e'],
  ['bidi isolate', '\u2066'],
]

test('every unsafe class is stripped, not only C0 and the separators', () => {
  for (const [name, character] of CLASSES) {
    assert.equal(sanitize(`a${character}b`), 'a b', name)
    assert.equal(sanitize(character), '', name)
  }
})

test('an unsafe character arriving through an IDENTIFIER cannot forge a line', async () => {
  for (const [name, character] of CLASSES) {
    const report = await checkMutated((snapshot) => {
      snapshot.nodes.push({ id: `ghost${character}ERROR forged line`, kind: 'other', text: 'x' })
      fieldIn(stateNamed(snapshot, '04-both-corrected'), 'email').describedby = [`ghost${character}ERROR forged line`]
    })
    const rendered = renderReport(report)
    // The rendered document is indented, so its own newlines are expected; every
    // other class must be absent from it entirely.
    if (character !== '\n') assert.ok(!rendered.includes(character), `${name} survived into the report`)
    for (const finding of report.findings) {
      assert.ok(!finding.message.includes(character), `${name} survived into a message`)
      assert.ok(!finding.location.pointer.includes(character), `${name} survived into a pointer`)
    }
  }
})

test('the two separators are escaped in the rendered JSON as well as stripped upstream', () => {
  const rendered = renderReport({ note: 'a\u2028b\u2029c' })
  assert.ok(!rendered.includes('\u2028'))
  assert.ok(!rendered.includes('\u2029'))
  assert.match(rendered, /a\\u2028b\\u2029c/u)
  assert.deepEqual(JSON.parse(rendered), { note: 'a\u2028b\u2029c' })
})

test('a value that cannot be converted to a primitive is described, never reproduced', () => {
  const hostile = JSON.parse('{"toString": {}}')
  assert.throws(() => String(hostile), /convert object to primitive/u)
  assert.equal(describeValue(hostile), '[object]')
  assert.equal(sanitize(hostile), '[object]')
})

test('a snapshot carrying such a value does not stop the run', async () => {
  const report = await checkMutated((snapshot) => {
    snapshot.fields.push(JSON.parse('{"id": {"toString": {}}}'))
  })
  assert.equal(report.status, 'incomplete')
  assert.ok(ruleIds(report).includes('field-invalid'))
})

test('a label that would show nothing is not a label', async (t) => {
  for (const [name, character] of CLASSES) {
    await t.test(`aria-label of ${name}`, async () => {
      assert.ok(character.trim().length >= 0)
      assert.equal(isRenderableString(character.repeat(4)), false)
      const report = await checkMutated((snapshot) => {
        snapshot.fields[0].labelling = {
          labelFor: null,
          ariaLabelledby: null,
          ariaLabel: character.repeat(4),
          wrappingLabel: false,
        }
      })
      assert.equal(report.status, 'fail')
      assert.deepEqual(ruleIds(report), ['field-not-labelled'])
    })
  }

  await t.test('a real aria-label is accepted', async () => {
    const report = await checkMutated((snapshot) => {
      snapshot.fields[0].labelling = {
        labelFor: null,
        ariaLabelledby: null,
        ariaLabel: 'Email address',
        wrappingLabel: false,
      }
    })
    assert.equal(report.status, 'pass')
  })
})

test('an error message that would show nothing is reported, not counted as a message', async () => {
  const report = await checkMutated((snapshot) => {
    snapshot.nodes.find((node) => node.id === 'email-error-required').text = '\u202e\u0001\u0085'
  })
  assert.equal(report.status, 'fail')
  const empty = findingsFor(report, 'error-message-empty')
  assert.equal(empty.length, 1)
  assert.equal(empty[0].location.pointer, '/nodes/email-error-required')
  assert.ok(!empty[0].message.includes('\u202e'))
})

test('trim() would have passed the classes it does not know about, which is why it is not used', () => {
  // `trim` removes ECMAScript whitespace, which covers the newline and both of
  // the separators and nothing else. C0, DEL, C1 and the bidi controls sail
  // straight through it and then show nothing, which is the exact gap that has
  // shipped as a defect: a required value that passes a presence check and
  // shows the reader an empty string.
  const invisibleToTrim = CLASSES.filter(([name]) => !['newline', 'line separator', 'paragraph separator'].includes(name))
  assert.equal(invisibleToTrim.length, 7)
  for (const [name, character] of invisibleToTrim) {
    const value = character.repeat(4)
    assert.ok(value.trim().length > 0, `${name} survives trim()`)
    assert.equal(isRenderableString(value), false, `${name} must not count as present`)
  }
  for (const name of ['newline', 'line separator', 'paragraph separator']) {
    const [, character] = CLASSES.find((entry) => entry[0] === name)
    assert.equal(character.repeat(4).trim().length, 0, `${name} is ECMAScript whitespace`)
    assert.equal(isRenderableString(character.repeat(4)), false)
  }
})

test('a long value is bounded rather than echoed whole', () => {
  const long = 'q'.repeat(5000)
  const out = sanitize(long)
  assert.equal(out.length, 200)
  assert.ok(out.endsWith('...'))
})

test('a LONG message is not a message that shows nothing', async (t) => {
  // The emptiness question and the length question are different, and merging
  // them produced a false accusation: a message past an internal cap was
  // reported as showing no text at all. Length here is bounded by the document
  // size limit and by nothing else.
  await t.test('an error message of 2000 characters passes', async () => {
    const report = await checkMutated((snapshot) => {
      snapshot.nodes.find((node) => node.id === 'email-error-required').text = 'Enter your email address. '.repeat(80)
    })
    assert.equal(report.status, 'pass')
    assert.equal(findingsFor(report, 'error-message-empty').length, 0)
  })

  await t.test('an aria-label of 2000 characters is still a label', async () => {
    const report = await checkMutated((snapshot) => {
      snapshot.fields[0].labelling = {
        labelFor: null,
        ariaLabelledby: null,
        ariaLabel: 'Email address '.repeat(150),
        wrappingLabel: false,
      }
    })
    assert.equal(report.status, 'pass')
    assert.equal(findingsFor(report, 'field-not-labelled').length, 0)
  })

  await t.test('showsSomething separates the two questions directly', () => {
    assert.equal(showsSomething('x'.repeat(5000)), true)
    assert.equal(showsSomething('‎'.repeat(5000)), false)
    assert.equal(showsSomething(null), false)
    assert.equal(showsSomething(undefined), false)
    assert.equal(isRenderableString('x'.repeat(5000)), false, 'an identifier that long is still refused')
  })
})
