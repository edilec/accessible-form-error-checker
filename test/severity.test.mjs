/**
 * Severity decides the exit code, so it is pinned by the exit code.
 *
 * A hand-written expected-severity map in a test is a third declaration that
 * agrees with the other two, and a coordinated edit of all three passes. Here
 * every defect rule is driven from a real snapshot through the real CLI, and
 * the assertion is the process exit status: 1 for a form that broke an
 * expectation, 2 for evidence that was not obtained. An exit code cannot be
 * edited into agreement.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { EVIDENCE_MISSING_RULES, RULE_IDS, RULE_SEVERITY, SEVERITIES, severityFor } from '../src/index.mjs'
import { checkMutated, cleanExpectations, cleanSnapshot, fieldIn, ruleIds, runCli, stateNamed } from './helpers.mjs'

/** Every rule that is a defect in the form rather than a gap in the evidence. */
const DEFECTS = {
  'async-pending-not-exposed': (snapshot) => {
    fieldIn(stateNamed(snapshot, '02-email-checking'), 'email').ariaBusy = null
  },
  'error-association-wrong': (snapshot) => {
    const record = fieldIn(stateNamed(snapshot, '01-submitted-empty'), 'email')
    record.declaredError = 'postcode-error-required'
    record.describedby = ['postcode-error-required']
  },
  'error-message-empty': (snapshot) => {
    snapshot.nodes.find((node) => node.id === 'email-error-required').text = '‮'
  },
  'error-message-not-visible': (snapshot) => {
    stateNamed(snapshot, '03-email-taken').visibleMessages = ['postcode-error-required']
  },
  'error-not-associated': (snapshot) => {
    fieldIn(stateNamed(snapshot, '01-submitted-empty'), 'email').describedby = ['email-hint']
  },
  'field-not-labelled': (snapshot) => {
    snapshot.fields[0].labelling = { labelFor: null, ariaLabelledby: null, ariaLabel: null, wrappingLabel: false }
  },
  'focus-not-recovered': (snapshot) => {
    stateNamed(snapshot, '01-submitted-empty').focus = 'email-hint'
  },
  'invalid-not-exposed': (snapshot) => {
    fieldIn(stateNamed(snapshot, '01-submitted-empty'), 'email').ariaInvalid = 'false'
  },
  'reference-broken': (snapshot) => {
    fieldIn(stateNamed(snapshot, '04-both-corrected'), 'email').describedby = ['ghost-node']
  },
  'stale-error-message': (snapshot) => {
    stateNamed(snapshot, '04-both-corrected').visibleMessages = ['email-error-required']
  },
  'stale-error-state': (snapshot) => {
    fieldIn(stateNamed(snapshot, '04-both-corrected'), 'email').ariaInvalid = 'true'
  },
  'stale-summary-link': (snapshot) => {
    stateNamed(snapshot, '04-both-corrected').summary = { id: 'error-summary', links: [{ target: 'email' }] }
  },
  'summary-absent': (snapshot) => {
    stateNamed(snapshot, '02-email-checking').summary = null
  },
  'summary-link-not-a-field': (snapshot) => {
    stateNamed(snapshot, '01-submitted-empty').summary = {
      id: 'error-summary',
      links: [{ target: 'email' }, { target: 'postcode' }, { target: 'email-hint' }],
    }
  },
  'summary-missing-error': (snapshot) => {
    stateNamed(snapshot, '01-submitted-empty').summary = {
      id: 'error-summary',
      links: [{ target: 'postcode' }],
    }
  },
}

test('every defect rule fails the run and exits 1', async (t) => {
  for (const [ruleId, mutate] of Object.entries(DEFECTS)) {
    await t.test(ruleId, async () => {
      const report = await checkMutated(mutate)
      assert.ok(ruleIds(report).includes(ruleId), `expected ${ruleId}, got ${ruleIds(report).join(', ')}`)
      assert.equal(report.status, 'fail')
      assert.equal(severityFor(ruleId), 'error')

      const snapshot = await cleanSnapshot()
      mutate(snapshot)
      const result = await runCli(snapshot, await cleanExpectations())
      assert.equal(result.code, 1, 'a defect in the form is exit 1, not exit 0 and not exit 2')
      assert.equal(JSON.parse(result.stdout).status, 'fail')
    })
  }
})

test('the defect table and the evidence-missing list together cover the whole catalog', () => {
  const covered = [...Object.keys(DEFECTS), ...EVIDENCE_MISSING_RULES].sort()
  assert.deepEqual(covered, [...RULE_IDS].sort())
  for (const ruleId of Object.keys(DEFECTS)) {
    assert.ok(!EVIDENCE_MISSING_RULES.includes(ruleId), `${ruleId} cannot be both`)
  }
})

test('an unknown rule id throws rather than defaulting to something harmless', () => {
  assert.throws(() => severityFor('no-such-rule'), /Unknown ruleId/u)
  assert.throws(() => severityFor(undefined), /Unknown ruleId/u)
})

test('every severity in the table is one of the three the contract allows', () => {
  for (const ruleId of RULE_IDS) {
    assert.ok(SEVERITIES.includes(RULE_SEVERITY[ruleId]), ruleId)
  }
  assert.equal(RULE_IDS.length, Object.keys(RULE_SEVERITY).length)
})

test('a clean run exits 0 and a run that obtained no evidence exits 2', async () => {
  const clean = await runCli(await cleanSnapshot(), await cleanExpectations())
  assert.equal(clean.code, 0)
  assert.equal(JSON.parse(clean.stdout).status, 'pass')

  const snapshot = await cleanSnapshot()
  snapshot.capture.idIndex = 'partial'
  const gap = await runCli(snapshot, await cleanExpectations())
  assert.equal(gap.code, 2)
  assert.equal(JSON.parse(gap.stdout).status, 'incomplete')
})
