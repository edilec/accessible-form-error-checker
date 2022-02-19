/**
 * The acceptance criteria, one test block each, asserted through the real entry
 * point and the real CLI so that the exit code is observed rather than
 * described.
 *
 *   "An error linked to the wrong field fails"
 *   "corrected input clears stale error state"
 *   "asynchronous validation is covered"
 *
 * Each block also pins the honest NEGATIVE: the same situation, with the
 * evidence missing instead of the defect present, must come back `incomplete`
 * and exit 2 -- never `pass`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { checkMutated, fieldIn, findingsFor, ruleIds, runCli, stateNamed, cleanExpectations, cleanSnapshot } from './helpers.mjs'

test('the shipped clean example passes, so the failing cases below are not passing by accident', async () => {
  const report = await checkMutated(null)
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.checked, 8)
})

test('an error linked to the wrong field fails', async (t) => {
  await t.test('a field associated with another field’s message is an error and exits 1', async () => {
    const report = await checkMutated((snapshot) => {
      const record = fieldIn(stateNamed(snapshot, '01-submitted-empty'), 'email')
      record.declaredError = 'postcode-error-required'
      record.describedby = ['email-hint', 'postcode-error-required']
    })
    assert.equal(report.status, 'fail')
    const wrong = findingsFor(report, 'error-association-wrong')
    assert.equal(wrong.length, 1)
    assert.match(wrong[0].message, /belonging to field postcode/u)
    assert.equal(wrong[0].location.pointer, '/states/01-submitted-empty/fields/email')

    const snapshot = await cleanSnapshot()
    const record = fieldIn(stateNamed(snapshot, '01-submitted-empty'), 'email')
    record.declaredError = 'postcode-error-required'
    record.describedby = ['email-hint', 'postcode-error-required']
    const cli = await runCli(snapshot, await cleanExpectations())
    assert.equal(cli.code, 1)
  })

  await t.test('describing a field with another field’s message fails even when the state declares no error', async () => {
    const report = await checkMutated((snapshot) => {
      fieldIn(stateNamed(snapshot, '04-both-corrected'), 'email').describedby = ['postcode-error-required']
    })
    assert.equal(report.status, 'fail')
    assert.equal(findingsFor(report, 'error-association-wrong').length, 1)
  })

  await t.test('a declared error that names a label rather than a message fails', async () => {
    const report = await checkMutated((snapshot) => {
      const record = fieldIn(stateNamed(snapshot, '01-submitted-empty'), 'email')
      record.declaredError = 'email-label'
      record.describedby = ['email-hint', 'email-label']
      stateNamed(snapshot, '01-submitted-empty').visibleMessages = ['email-label', 'postcode-error-required']
    })
    assert.equal(report.status, 'fail')
    const wrong = findingsFor(report, 'error-association-wrong')
    assert.equal(wrong.length, 1)
    assert.match(wrong[0].message, /records that id as a label rather than a message/u)
  })

  await t.test('a declared error the state never associates with the field fails', async () => {
    const report = await checkMutated((snapshot) => {
      fieldIn(stateNamed(snapshot, '01-submitted-empty'), 'email').describedby = ['email-hint']
    })
    assert.equal(report.status, 'fail')
    assert.equal(findingsFor(report, 'error-not-associated').length, 1)
  })

  await t.test(
    'a message the snapshot could not capture is NOT asserted to belong to the wrong field: incomplete, exit 2',
    async () => {
      // The same shape as the failing case, except that the message node lives
      // in a subtree the exporter could not traverse. The tool must not say the
      // association is wrong, and must not say it is right either.
      const snapshot = await cleanSnapshot()
      snapshot.capture.idIndex = 'partial'
      snapshot.unreadableRegions = [{ hostId: 'address-widget', reason: 'closed-shadow-root' }]
      snapshot.nodes = snapshot.nodes.filter((node) => node.id !== 'postcode-error-required')
      const record = fieldIn(stateNamed(snapshot, '01-submitted-empty'), 'email')
      record.declaredError = 'postcode-error-required'
      record.describedby = ['email-hint', 'postcode-error-required']

      // The positive control, and it is not decoration: without it the four
      // negative assertions below would all pass over a run that produced no
      // findings at all. The line this replaces called `checkMutated` with a
      // no-op and asserted the CLEAN fixture was clean, which reads as though
      // it had checked the document built above and checked nothing of the
      // kind. This control uses that same document, with the one difference
      // the test is about: the message node is present and the index complete.
      const control = await cleanSnapshot()
      const controlRecord = fieldIn(stateNamed(control, '01-submitted-empty'), 'email')
      controlRecord.declaredError = 'postcode-error-required'
      controlRecord.describedby = ['email-hint', 'postcode-error-required']
      const controlCli = await runCli(control, await cleanExpectations())
      assert.equal(controlCli.code, 1, 'control: with the node present this shape really does fail')
      assert.ok(ruleIds(JSON.parse(controlCli.stdout)).includes('error-association-wrong'))

      const cli = await runCli(snapshot, await cleanExpectations())
      assert.equal(cli.code, 2)
      const parsed = JSON.parse(cli.stdout)
      assert.equal(parsed.status, 'incomplete')
      assert.ok(ruleIds(parsed).includes('reference-unresolved'))
      assert.ok(ruleIds(parsed).includes('subtree-not-captured'))
      assert.ok(
        !ruleIds(parsed).includes('error-association-wrong'),
        'an unresolvable message must not be asserted to belong to another field',
      )
      assert.ok(
        !ruleIds(parsed).includes('reference-broken'),
        'an unresolvable message must not be asserted to be a broken reference either',
      )
    },
  )
})

test('corrected input clears stale error state', async (t) => {
  await t.test('the clean corrected state, which clears everything, is the passing case', async () => {
    const report = await checkMutated(null)
    const corrected = (await cleanSnapshot()).states.at(-1)
    assert.equal(corrected.name, '04-both-corrected')
    assert.deepEqual(corrected.visibleMessages, [])
    assert.equal(report.status, 'pass')
  })

  await t.test('aria-invalid left on a field the state declares no error for fails', async () => {
    const report = await checkMutated((snapshot) => {
      fieldIn(stateNamed(snapshot, '04-both-corrected'), 'email').ariaInvalid = 'true'
    })
    assert.equal(report.status, 'fail')
    assert.deepEqual(ruleIds(report), ['stale-error-state'])
  })

  await t.test('an error message left on screen after the field is corrected fails', async () => {
    const report = await checkMutated((snapshot) => {
      stateNamed(snapshot, '04-both-corrected').visibleMessages = ['email-error-required']
    })
    assert.equal(report.status, 'fail')
    const stale = findingsFor(report, 'stale-error-message')
    assert.equal(stale.length, 1)
    assert.match(stale[0].message, /email-error-required/u)
  })

  await t.test('a summary link left pointing at a corrected field fails', async () => {
    const report = await checkMutated((snapshot) => {
      stateNamed(snapshot, '04-both-corrected').summary = {
        id: 'error-summary',
        links: [{ target: 'email' }],
      }
    })
    assert.equal(report.status, 'fail')
    assert.deepEqual(ruleIds(report), ['stale-summary-link'])
  })

  await t.test(
    'a corrected state that does not record aria-invalid is incomplete, not clean: exit 2',
    async () => {
      const snapshot = await cleanSnapshot()
      const record = fieldIn(stateNamed(snapshot, '04-both-corrected'), 'email')
      delete record.ariaInvalid
      const cli = await runCli(snapshot, await cleanExpectations())
      assert.equal(cli.code, 2)
      const parsed = JSON.parse(cli.stdout)
      assert.equal(parsed.status, 'incomplete')
      assert.deepEqual(ruleIds(parsed), ['aria-invalid-not-captured'])
      assert.ok(!ruleIds(parsed).includes('stale-error-state'))
      assert.match(parsed.findings[0].message, /whether an earlier error state was cleared/u)
    },
  )

  await t.test(
    'a corrected state that does not record which messages were present is incomplete, not clean',
    async () => {
      const report = await checkMutated((snapshot) => {
        delete stateNamed(snapshot, '04-both-corrected').visibleMessages
      })
      assert.equal(report.status, 'incomplete')
      assert.deepEqual(ruleIds(report), ['visible-messages-not-captured'])
    },
  )

  await t.test(
    'a visibleMessages id the index cannot resolve is not dropped out of the comparison',
    async () => {
      // The defect this pins: the id was read straight out of the index and a
      // miss was skipped, so one misspelled id was `reference-broken` and exit
      // 1 in `describedby` and INVISIBLE here -- pass, exit 0, with a complete
      // index and no unreadable region. Both halves are asserted, because what
      // makes it a defect is that the two disagree.
      const snapshot = await cleanSnapshot()
      stateNamed(snapshot, '04-both-corrected').visibleMessages = ['email-error-requird']
      const cli = await runCli(snapshot, await cleanExpectations())
      assert.equal(cli.code, 1, 'a dangling id under a complete index fails the run')
      const parsed = JSON.parse(cli.stdout)
      assert.equal(parsed.status, 'fail')
      assert.deepEqual(ruleIds(parsed), ['reference-broken'])
      assert.equal(parsed.findings[0].location.pointer, '/states/04-both-corrected/visibleMessages')

      const viaDescribedby = await cleanSnapshot()
      fieldIn(stateNamed(viaDescribedby, '04-both-corrected'), 'email').describedby = ['email-error-requird']
      const other = await runCli(viaDescribedby, await cleanExpectations())
      assert.equal(other.code, cli.code, 'one dangling id means the same thing in either field')
      assert.deepEqual(ruleIds(JSON.parse(other.stdout)), ruleIds(parsed))
    },
  )

  await t.test(
    'a visibleMessages id is unresolved rather than broken when the index is partial',
    async () => {
      const snapshot = await cleanSnapshot()
      snapshot.capture.idIndex = 'partial'
      stateNamed(snapshot, '04-both-corrected').visibleMessages = ['email-error-requird']
      const cli = await runCli(snapshot, await cleanExpectations())
      assert.equal(cli.code, 2)
      const parsed = JSON.parse(cli.stdout)
      assert.equal(parsed.status, 'incomplete')
      assert.ok(ruleIds(parsed).includes('reference-unresolved'))
      assert.ok(
        !ruleIds(parsed).includes('reference-broken'),
        'an incomplete index may not call an id the form does not have',
      )
    },
  )

  await t.test('a state that says nothing at all about a declared field is incomplete', async () => {
    const report = await checkMutated((snapshot) => {
      const state = stateNamed(snapshot, '04-both-corrected')
      state.fields = state.fields.filter((record) => record.id !== 'email')
    })
    assert.equal(report.status, 'incomplete')
    assert.ok(ruleIds(report).includes('state-field-not-recorded'))
    assert.equal(report.summary.checked, 7)
  })
})

test('a declared error the index could not resolve is not asserted to be absent from the state', async (t) => {
  // `error-message-not-visible` is a positive statement: this state does not
  // record that message as present. It may only be made about an id the index
  // could look up. The two subtests are the same document either side of that
  // one line, so the gate is what the pair measures.
  await t.test('the control: a resolvable declared error missing from visibleMessages fails', async () => {
    const snapshot = await cleanSnapshot()
    const record = fieldIn(stateNamed(snapshot, '01-submitted-empty'), 'email')
    stateNamed(snapshot, '01-submitted-empty').visibleMessages = ['postcode-error-required']
    const cli = await runCli(snapshot, await cleanExpectations())
    assert.equal(cli.code, 1)
    const parsed = JSON.parse(cli.stdout)
    assert.ok(ruleIds(parsed).includes('error-message-not-visible'))
    assert.equal(record.declaredError, 'email-error-required')
  })

  await t.test('an unresolvable declared error produces no such statement', async () => {
    const snapshot = await cleanSnapshot()
    snapshot.capture.idIndex = 'partial'
    const record = fieldIn(stateNamed(snapshot, '01-submitted-empty'), 'email')
    record.declaredError = 'ghost'
    record.describedby = ['ghost']
    const cli = await runCli(snapshot, await cleanExpectations())
    assert.equal(cli.code, 2)
    const parsed = JSON.parse(cli.stdout)
    assert.equal(parsed.status, 'incomplete')
    assert.ok(ruleIds(parsed).includes('reference-unresolved'))
    assert.ok(
      !ruleIds(parsed).includes('error-message-not-visible'),
      'a node the run says it could not find may not also be reported as not shown',
    )
  })
})

test('asynchronous validation is covered', async (t) => {
  await t.test('a pending check that nothing in the markup exposes fails', async () => {
    const report = await checkMutated((snapshot) => {
      fieldIn(stateNamed(snapshot, '02-email-checking'), 'email').ariaBusy = null
    })
    assert.equal(report.status, 'fail')
    const finding = findingsFor(report, 'async-pending-not-exposed')
    assert.equal(finding.length, 1)
    assert.match(finding[0].message, /records aria-busy as absent/u)
  })

  await t.test('an aria-busy value that is not "true" fails', async () => {
    const report = await checkMutated((snapshot) => {
      fieldIn(stateNamed(snapshot, '02-email-checking'), 'email').ariaBusy = 'false'
    })
    assert.equal(report.status, 'fail')
    assert.deepEqual(ruleIds(report), ['async-pending-not-exposed'])
  })

  await t.test('a pending check whose outcome was never recorded is incomplete, exit 2', async () => {
    const snapshot = await cleanSnapshot()
    // Drop every state after the one that records the check in flight.
    snapshot.states = snapshot.states.slice(0, 2)
    const cli = await runCli(snapshot, await cleanExpectations())
    assert.equal(cli.code, 2)
    const parsed = JSON.parse(cli.stdout)
    assert.equal(parsed.status, 'incomplete')
    assert.deepEqual(ruleIds(parsed), ['async-outcome-not-captured'])
    assert.match(parsed.findings[0].message, /no later state records it settled/u)
  })

  await t.test('a field declared asynchronously validated with no pending state recorded is incomplete', async () => {
    const report = await checkMutated((snapshot) => {
      fieldIn(stateNamed(snapshot, '02-email-checking'), 'email').pending = false
      fieldIn(stateNamed(snapshot, '02-email-checking'), 'email').ariaBusy = null
    })
    assert.equal(report.status, 'incomplete')
    assert.deepEqual(ruleIds(report), ['async-states-not-captured'])
  })

  await t.test('a pending state that does not record aria-busy at all is incomplete, not passing', async () => {
    const report = await checkMutated((snapshot) => {
      delete fieldIn(stateNamed(snapshot, '02-email-checking'), 'email').ariaBusy
    })
    assert.equal(report.status, 'incomplete')
    assert.deepEqual(ruleIds(report), ['async-busy-not-captured'])
  })

  await t.test('the error an asynchronous check produces is held to the same association rules', async () => {
    // `03-email-taken` is the state after the asynchronous check settles. A
    // wrong-field association there must fail exactly as it does in the
    // synchronous state, which is what "asynchronous validation is covered"
    // has to mean if it means anything.
    const report = await checkMutated((snapshot) => {
      const record = fieldIn(stateNamed(snapshot, '03-email-taken'), 'email')
      record.declaredError = 'postcode-error-required'
      record.errormessage = 'postcode-error-required'
    })
    assert.equal(report.status, 'fail')
    const wrong = findingsFor(report, 'error-association-wrong')
    assert.equal(wrong.length, 1)
    assert.equal(wrong[0].location.pointer, '/states/03-email-taken/fields/email')
  })

  await t.test('an asynchronous error that is never shown fails', async () => {
    const report = await checkMutated((snapshot) => {
      stateNamed(snapshot, '03-email-taken').visibleMessages = ['postcode-error-required']
    })
    assert.equal(report.status, 'fail')
    assert.deepEqual(ruleIds(report), ['error-message-not-visible'])
  })
})
