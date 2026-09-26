/**
 * Unknown is never a pass.
 *
 * Every rule in `EVIDENCE_MISSING_RULES` is driven here from a real input,
 * through the real entry point, and asserted to produce `incomplete` -- because
 * membership of that list is the only thing standing between a gap in the
 * evidence and a green run.
 *
 * For the `warning` rules the test goes further and asserts that the run
 * contains NO error-severity finding at all. That is what makes the pin bite:
 * with the rule removed from the list, severity alone would make the report
 * `pass` and the process exit 0. For the `error` rules the pin is `incomplete`
 * rather than `fail`, which is the difference between exit 2 and exit 1.
 */

import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { EVIDENCE_MISSING_RULES, RULE_SEVERITY, checkForm, severityFor, statusFor } from '../src/index.mjs'
import {
  NOW,
  checkMutated,
  cleanExpectations,
  cleanSnapshot,
  fieldIn,
  ruleIds,
  runCli,
  runCliRaw,
  stateNamed,
} from './helpers.mjs'

/** ruleId -> a mutation of the clean fixture that produces it. */
const REACHED_BY_MUTATION = {
  'aria-invalid-not-captured': (snapshot) => {
    delete fieldIn(stateNamed(snapshot, '04-both-corrected'), 'email').ariaInvalid
  },
  'async-busy-not-captured': (snapshot) => {
    delete fieldIn(stateNamed(snapshot, '02-email-checking'), 'email').ariaBusy
  },
  'async-outcome-not-captured': (snapshot) => {
    snapshot.states = snapshot.states.slice(0, 2)
  },
  'async-states-not-captured': (snapshot) => {
    const record = fieldIn(stateNamed(snapshot, '02-email-checking'), 'email')
    record.pending = false
    record.ariaBusy = null
  },
  'capture-source-unsupported': (snapshot) => {
    snapshot.capture.source = 'screenshot'
  },
  'duplicate-node-id': (snapshot) => {
    snapshot.nodes.push({ id: 'email-hint', kind: 'other', text: 'A second element with the same id' })
  },
  'field-invalid': (snapshot) => {
    snapshot.fields.push({ id: 'phone', labelling: { labelFor: null } })
  },
  'focus-not-captured': (snapshot) => {
    delete stateNamed(snapshot, '01-submitted-empty').focus
  },
  'index-incomplete': (snapshot) => {
    snapshot.capture.idIndex = 'partial'
  },
  'label-evidence-missing': (snapshot) => {
    delete snapshot.fields[0].labelling
  },
  'message-text-not-captured': (snapshot) => {
    delete snapshot.nodes.find((node) => node.id === 'email-error-required').text
  },
  'no-fields-checked': (snapshot) => {
    snapshot.fields = []
    for (const state of snapshot.states) state.fields = []
  },
  'node-invalid': (snapshot) => {
    snapshot.nodes.push({ id: 'mystery', kind: 'not-a-kind' })
  },
  'reference-unresolved': (snapshot) => {
    snapshot.capture.idIndex = 'partial'
    fieldIn(stateNamed(snapshot, '04-both-corrected'), 'email').describedby = ['ghost-node']
  },
  'snapshot-age-unknown': (snapshot) => {
    delete snapshot.capture.capturedAt
  },
  'snapshot-invalid': (snapshot) => {
    snapshot.schemaVersion = '99'
  },
  'state-field-not-recorded': (snapshot) => {
    const state = stateNamed(snapshot, '04-both-corrected')
    state.fields = state.fields.filter((record) => record.id !== 'email')
  },
  'state-invalid': (snapshot) => {
    stateNamed(snapshot, '04-both-corrected').visibleMessages = 'none'
  },
  'subtree-not-captured': (snapshot) => {
    snapshot.unreadableRegions = [{ hostId: 'address-widget', reason: 'shadow-root' }]
  },
  'summary-not-captured': (snapshot) => {
    delete stateNamed(snapshot, '02-email-checking').summary
  },
  'visible-messages-not-captured': (snapshot) => {
    delete stateNamed(snapshot, '04-both-corrected').visibleMessages
  },
}

/** ruleId -> an expectations change that produces it. */
const REACHED_BY_EXPECTATIONS = {
  'field-limit-exceeded': (expectations) => {
    expectations.limits = { maxFields: 1 }
  },
  'node-limit-exceeded': (expectations) => {
    expectations.limits = { maxNodes: 3 }
  },
  'state-limit-exceeded': (expectations) => {
    expectations.limits = { maxStates: 2 }
  },
  'snapshot-too-large': (expectations) => {
    expectations.limits = { maxSnapshotBytes: 64 }
  },
}

test('every evidence-missing rule really makes the run incomplete', async (t) => {
  for (const [ruleId, mutate] of Object.entries(REACHED_BY_MUTATION)) {
    await t.test(`${ruleId} (${severityFor(ruleId)})`, async () => {
      const report = await checkMutated(mutate)
      assert.ok(ruleIds(report).includes(ruleId), `expected ${ruleId}, got ${ruleIds(report).join(', ')}`)
      assert.equal(report.status, 'incomplete')
      if (severityFor(ruleId) === 'warning') {
        assert.ok(
          report.findings.every((finding) => finding.severity !== 'error'),
          'no error severity here, so listing this rule as evidence-missing is the only thing preventing a pass',
        )
      }
    })
  }

  for (const [ruleId, mutate] of Object.entries(REACHED_BY_EXPECTATIONS)) {
    await t.test(`${ruleId} (${severityFor(ruleId)})`, async () => {
      const report = await checkMutated(null, { expectations: mutate })
      assert.ok(ruleIds(report).includes(ruleId), `expected ${ruleId}, got ${ruleIds(report).join(', ')}`)
      assert.equal(report.status, 'incomplete')
    })
  }

  await t.test('snapshot-stale', async () => {
    const report = await checkMutated(null, { now: NOW + 400 * 86400000 })
    assert.deepEqual(ruleIds(report), ['snapshot-stale'])
    assert.equal(report.status, 'incomplete')
    assert.ok(report.findings.every((finding) => finding.severity !== 'error'))
  })

  await t.test('snapshot-unparsable', async () => {
    const result = await runCli('{"schemaVersion": ', await cleanExpectations())
    assert.equal(result.code, 2)
    const report = JSON.parse(result.stdout)
    assert.deepEqual(ruleIds(report), ['snapshot-unparsable'])
    assert.equal(report.status, 'incomplete')
  })

  await t.test('snapshot-not-utf8', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'afec-bytes-'))
    const snapshotPath = join(directory, 'snapshot.json')
    const expectationsPath = join(directory, 'expectations.json')
    await writeFile(snapshotPath, Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]))
    await writeFile(expectationsPath, JSON.stringify(await cleanExpectations()))
    const report = await checkForm({ snapshot: snapshotPath, expectations: expectationsPath, now: NOW })
    assert.deepEqual(ruleIds(report), ['snapshot-not-utf8'])
    assert.equal(report.status, 'incomplete')
    assert.match(report.findings[0].message, /not valid UTF-8/u)
  })

  await t.test('snapshot-unreadable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'afec-missing-'))
    const expectationsPath = join(directory, 'expectations.json')
    await writeFile(expectationsPath, JSON.stringify(await cleanExpectations()))
    const result = await runCliRaw([
      '--snapshot', join(directory, 'nothing-here.json'),
      '--expectations', expectationsPath,
      '--now', '2026-09-18',
    ])
    assert.equal(result.code, 2)
    const report = JSON.parse(result.stdout)
    assert.deepEqual(ruleIds(report), ['snapshot-unreadable'])
    assert.equal(report.status, 'incomplete')
  })

  await t.test('the table above covers the whole list, in both directions', () => {
    const covered = new Set([
      ...Object.keys(REACHED_BY_MUTATION),
      ...Object.keys(REACHED_BY_EXPECTATIONS),
      'snapshot-stale',
      'snapshot-unparsable',
      'snapshot-not-utf8',
      'snapshot-not-utf8',
      'snapshot-unreadable',
    ])
    assert.deepEqual([...covered].sort(), [...EVIDENCE_MISSING_RULES].sort())
  })
})

test('a rule that is NOT evidence-missing fails the run instead of making it incomplete', async () => {
  const report = await checkMutated((snapshot) => {
    fieldIn(stateNamed(snapshot, '04-both-corrected'), 'email').ariaInvalid = 'true'
  })
  assert.deepEqual(ruleIds(report), ['stale-error-state'])
  assert.equal(report.status, 'fail')
  assert.ok(!EVIDENCE_MISSING_RULES.includes('stale-error-state'))
})

test('missing evidence outranks a defect: half a form checked is not a verdict on the form', async () => {
  const report = await checkMutated((snapshot) => {
    fieldIn(stateNamed(snapshot, '04-both-corrected'), 'email').ariaInvalid = 'true'
    snapshot.capture.idIndex = 'partial'
  })
  assert.ok(ruleIds(report).includes('stale-error-state'))
  assert.ok(ruleIds(report).includes('index-incomplete'))
  assert.equal(report.status, 'incomplete', 'an error present does not downgrade a gap in the evidence')
})

test('exactly fifteen evidence-missing rules are warnings, and the list is the only guard for those', () => {
  const warnings = EVIDENCE_MISSING_RULES.filter((ruleId) => RULE_SEVERITY[ruleId] === 'warning')
  assert.equal(warnings.length, 15)
  // The second clause, asserted rather than merely stated. For each of those
  // fifteen the ONLY difference between an incomplete run and a green one is
  // membership of the list: the severity is held identical on both sides, so
  // nothing else can be what decides it. Removing a rule from the list makes
  // the left-hand call return what the right-hand call returns here.
  for (const ruleId of warnings) {
    assert.equal(statusFor([{ ruleId, severity: 'warning' }]), 'incomplete', ruleId)
    assert.equal(statusFor([{ ruleId: `${ruleId}-not-in-the-list`, severity: 'warning' }]), 'pass', ruleId)
  }
})

test('a pass on no evidence at all is not reachable', async () => {
  const report = await checkMutated((snapshot) => {
    snapshot.fields = []
    snapshot.states = []
  })
  assert.equal(report.summary.checked, 0)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ruleIds(report), ['no-fields-checked'])
})
