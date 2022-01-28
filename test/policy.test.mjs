/**
 * The expectations document is the policy, so every problem with it means the
 * run never had a subject: exit 2, empty stdout, message on stderr.
 *
 * A documented key that is accepted and then ignored is one of the defect
 * classes this contract names: a one-character typo must not turn a real
 * failure into a green run.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { ConfigError, DEFAULT_LIMITS, FOCUS_TARGETS, LIMIT_NAMES, parseInstant, validatePolicy } from '../src/index.mjs'
import { NOW, checkMutated, cleanExpectations, cleanSnapshot, runCli } from './helpers.mjs'

async function refuses(mutate, pattern) {
  const expectations = await cleanExpectations()
  mutate(expectations)
  const result = await runCli(await cleanSnapshot(), expectations)
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '', 'a configuration error leaves stdout empty')
  assert.match(result.stderr, pattern)
  return result
}

test('an unknown expectation key is refused, not ignored', async () => {
  await refuses((expectations) => {
    expectations.requireErrorSummry = true
  }, /Unknown expectation key\(s\): requireErrorSummry/u)
})

test('a typo cannot turn a real failure into a green run', async () => {
  // With `requireAriaInvalid` misspelled, the real key would fall back to its
  // default and the misspelling would be silently ignored. It is refused.
  await refuses((expectations) => {
    expectations.requireAriaInvalidd = expectations.requireAriaInvalid
    delete expectations.requireAriaInvalid
  }, /Unknown expectation key/u)
})

test('every required key must actually be given', async (t) => {
  for (const key of ['requireErrorSummary', 'requireAriaInvalid']) {
    await t.test(key, async () => {
      await refuses((expectations) => {
        delete expectations[key]
      }, new RegExp(`"${key}" must be true or false`, 'u'))
    })
  }
  await t.test('focusAfterSubmit', async () => {
    await refuses((expectations) => {
      expectations.focusAfterSubmit = []
    }, /must be a non-empty array/u)
  })
})

test('focusAfterSubmit accepts only the documented targets, each once', async () => {
  await refuses((expectations) => {
    expectations.focusAfterSubmit = ['wherever']
  }, /unknown target/u)
  await refuses((expectations) => {
    expectations.focusAfterSubmit = ['summary', 'summary']
  }, /more than once/u)
  for (const target of FOCUS_TARGETS) {
    const policy = validatePolicy({
      schemaVersion: '1',
      requireErrorSummary: false,
      requireAriaInvalid: false,
      focusAfterSubmit: [target],
    })
    assert.deepEqual(policy.focusAfterSubmit, [target])
  }
})

test('every documented focus target actually changes what is accepted', async (t) => {
  // A target that is accepted and then never consulted is a documented limit
  // that is never enforced.
  await t.test('first-invalid-field alone rejects focus on the summary', async () => {
    const report = await checkMutated(null, {
      expectations: (expectations) => {
        expectations.focusAfterSubmit = ['first-invalid-field']
      },
    })
    assert.equal(report.status, 'fail')
    assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['focus-not-recovered'])
  })

  await t.test('first-error-message alone accepts focus on the message', async () => {
    const report = await checkMutated(
      (snapshot) => {
        snapshot.states[0].focus = 'email-error-required'
      },
      {
        expectations: (expectations) => {
          expectations.focusAfterSubmit = ['first-error-message']
        },
      },
    )
    assert.equal(report.status, 'pass')
  })

  await t.test('summary alone accepts focus on the summary', async () => {
    const report = await checkMutated(null, {
      expectations: (expectations) => {
        expectations.focusAfterSubmit = ['summary']
      },
    })
    assert.equal(report.status, 'pass')
  })
})

test('requireErrorSummary and requireAriaInvalid each change the verdict', async (t) => {
  await t.test('requireErrorSummary false accepts a state with no summary', async () => {
    const report = await checkMutated(
      (snapshot) => {
        snapshot.states[1].summary = null
      },
      { expectations: (expectations) => { expectations.requireErrorSummary = false } },
    )
    assert.equal(report.status, 'pass')
  })

  await t.test('requireAriaInvalid false stops a missing aria-invalid failing', async () => {
    const report = await checkMutated(
      (snapshot) => {
        snapshot.states[0].fields[0].ariaInvalid = null
      },
      { expectations: (expectations) => { expectations.requireAriaInvalid = false } },
    )
    assert.equal(report.status, 'pass')
  })

  await t.test('but it does not stop a STALE aria-invalid failing', async () => {
    // The flag governs whether a field in error must expose itself as invalid.
    // It says nothing about a field that is not in error still being marked as
    // one, and reading it as though it did would be the tool narrowing what it
    // checks.
    const report = await checkMutated(
      (snapshot) => {
        snapshot.states[3].fields[0].ariaInvalid = 'true'
      },
      { expectations: (expectations) => { expectations.requireAriaInvalid = false } },
    )
    assert.equal(report.status, 'fail')
    assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['stale-error-state'])
  })
})

test('limits are validated and every one of them is enforced', async (t) => {
  await t.test('an unknown limit is refused', async () => {
    await refuses((expectations) => {
      expectations.limits = { maxFeilds: 10 }
    }, /Unknown limit\(s\): maxFeilds/u)
  })

  await t.test('a non-integer limit is refused', async () => {
    await refuses((expectations) => {
      expectations.limits = { maxFields: 1.5 }
    }, /"limits.maxFields" must be a whole number/u)
  })

  await t.test('the documented names and defaults are what the code uses', () => {
    assert.deepEqual(LIMIT_NAMES, ['maxFields', 'maxNodes', 'maxSnapshotBytes', 'maxStates'])
    const policy = validatePolicy({
      schemaVersion: '1',
      requireErrorSummary: false,
      requireAriaInvalid: false,
      focusAfterSubmit: ['summary'],
    })
    assert.deepEqual(policy.limits, DEFAULT_LIMITS)
  })
})

test('the schema version must be declared', async () => {
  await refuses((expectations) => {
    delete expectations.schemaVersion
  }, /must declare "schemaVersion": "1"/u)
})

test('maxSnapshotAgeDays is enforced and is reproducible through --now', async (t) => {
  await t.test('inside the window passes', async () => {
    const report = await checkMutated(null, { now: NOW })
    assert.equal(report.status, 'pass')
  })

  await t.test('outside the window is incomplete', async () => {
    const report = await checkMutated(null, { now: NOW + 91 * 86400000 })
    assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['snapshot-stale'])
    assert.match(report.findings[0].message, /past the 90 day\(s\) the expectations allow/u)
  })

  await t.test('the boundary is the documented one', async () => {
    const at90 = await checkMutated(null, { now: Date.UTC(2026, 8, 10) + 90 * 86400000 })
    assert.equal(at90.status, 'pass')
    const at91 = await checkMutated(null, { now: Date.UTC(2026, 8, 10) + 91 * 86400000 })
    assert.equal(at91.status, 'incomplete')
  })

  await t.test('omitting it removes the check entirely', async () => {
    const report = await checkMutated(
      (snapshot) => { delete snapshot.capture.capturedAt },
      { expectations: (expectations) => { delete expectations.maxSnapshotAgeDays } },
    )
    assert.equal(report.status, 'pass')
  })
})

test('the instant parser refuses anything it was not taught', () => {
  assert.deepEqual(parseInstant('2026-09-18'), { ok: true, ms: Date.UTC(2026, 8, 18) })
  assert.deepEqual(parseInstant('2026-09-18T12:30:00Z'), { ok: true, ms: Date.UTC(2026, 8, 18, 12, 30, 0) })
  for (const value of ['18 September 2026', '2026-09-18T12:30:00+01:00', '2026-02-30', '2026-13-01', '', null, 20260918]) {
    assert.equal(parseInstant(value).ok, false, String(value))
  }
})

test('validatePolicy throws ConfigError, which the CLI turns into exit 2', () => {
  assert.throws(() => validatePolicy(null), ConfigError)
  assert.throws(() => validatePolicy([]), ConfigError)
  assert.throws(() => validatePolicy({ schemaVersion: '1' }), ConfigError)
})
