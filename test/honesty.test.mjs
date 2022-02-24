/**
 * The limits of the evidence, pinned as BEHAVIOUR rather than as sentences in
 * the README.
 *
 * Three clauses are defended here:
 *
 *   the report does not claim to emulate a screen reader
 *   shadow-root or browser limitations are explicit
 *   results remain DOM-based evidence
 *
 * Each is enforced by something that fails loudly, not by prose: a message that
 * would overclaim throws at construction, an expectation this evidence cannot
 * settle is refused with an empty stdout and exit 2, an unreadable subtree is
 * named in the report and makes the run incomplete, and evidence of another
 * kind is never reinterpreted as a DOM snapshot.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CATALOG,
  DISCLAIMER,
  FORBIDDEN_CLAIMS,
  NOT_ESTABLISHED,
  REFUSED_POLICY_KEYS,
  findForbiddenClaim,
  makeFinding,
  msg,
} from '../src/index.mjs'
import { checkMutated, cleanExpectations, cleanSnapshot, findingsFor, ruleIds, runCli, stateNamed, fieldIn } from './helpers.mjs'

test('the report does not claim to emulate a screen reader', async (t) => {
  await t.test('a finding message that would claim it throws at construction', () => {
    assert.throws(
      () => msg`The error was announced to the user.`,
      /may not claim this tool observed a form directly or emulated assistive technology/u,
    )
    assert.throws(() => msg`A screen reader reads the message first.`, /screen reader/u)
    assert.throws(() => msg`The spoken output was correct.`, /spoken/u)
    assert.throws(
      () => makeFinding('stale-error-state', msg`fine`, {}, { suggestion: 'Check what NVDA announces.' }),
      /may not claim/u,
    )
  })

  await t.test('a finding may not be built from a raw string at all', () => {
    // This guard is the whole of the enforcement above. FORBIDDEN_CLAIMS is
    // checked INSIDE `msg`, so a call site handing `makeFinding` a plain string
    // would bypass the check completely -- and the resulting finding carries no
    // `message` field at all, which the report contract requires. Duck-typing
    // is refused too: the check is `instanceof`, not "has a text property".
    assert.throws(
      () => makeFinding('stale-error-state', 'A screen reader announced the wrong error.', { file: 's.json' }),
      /must build its message with the msg tagged template/u,
    )
    assert.throws(
      () => makeFinding('stale-error-state', { text: 'a message-shaped object' }, { file: 's.json' }),
      /must build its message with the msg tagged template/u,
    )
    const built = makeFinding('stale-error-state', msg`A message built the one permitted way.`, { file: 's.json' })
    assert.equal(built.message, 'A message built the one permitted way.')
  })

  await t.test('a line break cannot hide a forbidden phrase from the check', () => {
    assert.throws(
      () => msg`The message was read
        aloud before the field.`,
      /read aloud/u,
    )
  })

  await t.test('the check reads the tool’s own words, not the document’s', async () => {
    // A form is allowed to name an element after the thing it is for. Scanning
    // the rendering rather than the source would let a node id flag the tool.
    const report = await checkMutated((snapshot) => {
      snapshot.nodes.push({ id: 'screen-reader-announcement', kind: 'other', text: 'Loading' })
      fieldIn(stateNamed(snapshot, '04-both-corrected'), 'email').describedby = ['screen-reader-announcement']
    })
    assert.equal(report.status, 'pass')
    // The same text WOULD be refused in one of this tool's own sentences.
    assert.equal(findForbiddenClaim('screen-reader-announcement'), 'announcement')
    assert.throws(() => msg`screen-reader-announcement`, /may not claim/u)
  })

  await t.test('no finding in a real run carries a claim this tool cannot make', async () => {
    const reports = [
      await checkMutated(null),
      await checkMutated((snapshot) => {
        snapshot.capture.idIndex = 'partial'
        stateNamed(snapshot, '01-submitted-empty').focus = 'email-hint'
        delete fieldIn(stateNamed(snapshot, '04-both-corrected'), 'email').ariaBusy
      }),
    ]
    for (const report of reports) {
      for (const finding of report.findings) {
        for (const text of [finding.message, finding.suggestion ?? '', finding.evidence ?? '']) {
          assert.equal(findForbiddenClaim(text), null, `${finding.ruleId}: ${text}`)
        }
      }
    }
  })

  await t.test('an expectation about what was spoken is refused: exit 2 with EMPTY stdout', async () => {
    for (const key of REFUSED_POLICY_KEYS) {
      const expectations = await cleanExpectations()
      expectations[key] = 'Enter your email address'
      const result = await runCli(await cleanSnapshot(), expectations)
      assert.equal(result.code, 2, key)
      assert.equal(result.stdout, '', `${key} must leave stdout empty: the run never had a subject`)
      assert.match(result.stderr, /cannot be checked from a DOM snapshot/u)
      assert.match(result.stderr, /separate manual evidence/u)
    }
  })

  await t.test('every report says, in itself, what this evidence does not settle', async () => {
    const report = await checkMutated(null)
    assert.deepEqual(report.notEstablished, [...NOT_ESTABLISHED])
    assert.match(report.notEstablished[0], /assistive technology conveys/u)
    assert.match(report.disclaimer, /does not emulate assistive technology/u)
    assert.match(DISCLAIMER, /needs separate manual evidence/u)
  })

  await t.test('the forbidden list names the assistive technologies it is about', () => {
    for (const term of ['screen reader', 'voiceover', 'nvda', 'jaws', 'announced', 'spoken']) {
      assert.ok(FORBIDDEN_CLAIMS.includes(term), term)
    }
  })
})

test('shadow-root and other capture limitations are explicit', async (t) => {
  await t.test('an unreadable subtree is named in the report, with its reason, and exits 2', async () => {
    const snapshot = await cleanSnapshot()
    snapshot.unreadableRegions = [{ hostId: 'address-widget', reason: 'closed-shadow-root' }]
    const result = await runCli(snapshot, await cleanExpectations())
    assert.equal(result.code, 2)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'incomplete')
    const subtree = report.findings.filter((finding) => finding.ruleId === 'subtree-not-captured')
    assert.equal(subtree.length, 1)
    assert.match(subtree[0].message, /address-widget/u)
    assert.equal(subtree[0].evidence, 'reason: closed-shadow-root')
    assert.equal(subtree[0].location.pointer, '/unreadableRegions/address-widget')
  })

  await t.test('a snapshot that claims a complete index while listing an unreadable subtree is still incomplete', () => {
    // The two statements contradict each other and the conservative one wins.
    // Deleting the `unreadableRegions.length === 0` term of `complete` turns
    // this run from exit 2 into exit 1.
    return checkMutated((snapshot) => {
      snapshot.capture.idIndex = 'complete'
      snapshot.unreadableRegions = [{ hostId: 'card-widget', reason: 'cross-origin-iframe' }]
      fieldIn(stateNamed(snapshot, '01-submitted-empty'), 'email').describedby = ['email-hint', 'email-error-required', 'not-captured-message']
    }).then((report) => {
      assert.equal(report.status, 'incomplete')
      assert.ok(ruleIds(report).includes('reference-unresolved'))
      assert.ok(!ruleIds(report).includes('reference-broken'))
    })
  })

  await t.test(
    'the SAME dangling reference is a defect with a complete index and a gap without one',
    async () => {
      const dangle = (snapshot) => {
        fieldIn(stateNamed(snapshot, '01-submitted-empty'), 'email').describedby = [
          'email-hint',
          'email-error-required',
          'ghost-node',
        ]
      }

      const complete = await checkMutated(dangle)
      assert.equal(complete.status, 'fail')
      assert.deepEqual(ruleIds(complete), ['reference-broken'])

      const partial = await checkMutated((snapshot) => {
        dangle(snapshot)
        snapshot.capture.idIndex = 'partial'
      })
      assert.equal(partial.status, 'incomplete')
      assert.ok(ruleIds(partial).includes('reference-unresolved'))
      assert.ok(
        !ruleIds(partial).includes('reference-broken'),
        'an id missing from an index that is known to be missing ids is not a broken reference',
      )
    },
  )

  await t.test('a partial index is reported once, saying why absence was not treated as evidence', async () => {
    const report = await checkMutated((snapshot) => {
      snapshot.capture.idIndex = 'partial'
    })
    assert.equal(report.status, 'incomplete')
    const gate = findingsFor(report, 'index-incomplete')
    assert.equal(gate.length, 1)
    assert.equal(gate[0].evidence, 'the snapshot declares "idIndex": "partial"')
    assert.match(gate[0].message, /was not treated as an id the form does not have/u)
  })

  await t.test('a dropped record makes the index incomplete, so absence stops being evidence', async () => {
    // Evidence dropped while BUILDING the index makes the comparison
    // incomplete. It does not make the comparison clean.
    const report = await checkMutated((snapshot) => {
      snapshot.nodes.push({ id: 'broken-node', kind: 'not-a-kind' })
      fieldIn(stateNamed(snapshot, '04-both-corrected'), 'email').describedby = ['ghost-node']
    })
    assert.equal(report.status, 'incomplete')
    assert.ok(ruleIds(report).includes('node-invalid'))
    assert.ok(ruleIds(report).includes('index-incomplete'))
    assert.ok(ruleIds(report).includes('reference-unresolved'))
    assert.ok(!ruleIds(report).includes('reference-broken'))
  })

  await t.test('a field whose only labelling reference cannot be resolved is not called unlabelled', async () => {
    const report = await checkMutated((snapshot) => {
      snapshot.capture.idIndex = 'partial'
      snapshot.fields[0].labelling.labelFor = 'label-in-the-shadow-root'
    })
    assert.equal(report.status, 'incomplete')
    assert.ok(ruleIds(report).includes('reference-unresolved'))
    assert.ok(
      !ruleIds(report).includes('field-not-labelled'),
      'a label that could not be looked up is not a label that is not there',
    )
  })

  await t.test('with a complete index, the same field IS called unlabelled', async () => {
    const report = await checkMutated((snapshot) => {
      snapshot.fields[0].labelling.labelFor = 'label-that-does-not-exist'
    })
    assert.equal(report.status, 'fail')
    assert.deepEqual(ruleIds(report).sort(), ['field-not-labelled', 'reference-broken'])
  })

  await t.test('every reason an exporter may give is accepted and echoed', async () => {
    for (const reason of CATALOG.unreadableReasons) {
      const report = await checkMutated((snapshot) => {
        snapshot.unreadableRegions = [{ hostId: 'widget', reason }]
      })
      assert.equal(report.status, 'incomplete')
      assert.equal(findingsFor(report, 'subtree-not-captured')[0].evidence, `reason: ${reason}`)
    }
  })
})

test('results remain DOM-based evidence', async (t) => {
  await t.test('the report names the kind of evidence it rests on', async () => {
    const report = await checkMutated(null)
    assert.equal(report.evidenceBasis, 'dom-snapshot')
    assert.equal(CATALOG.supportedSource, 'dom-snapshot')
  })

  await t.test('evidence of another kind is refused, not reinterpreted: exit 2, nothing checked', async () => {
    for (const source of ['screenshot', 'screen-reader-transcript', 'accessibility-tree-export', undefined]) {
      const snapshot = await cleanSnapshot()
      if (source === undefined) delete snapshot.capture.source
      else snapshot.capture.source = source
      const result = await runCli(snapshot, await cleanExpectations())
      assert.equal(result.code, 2, String(source))
      const report = JSON.parse(result.stdout)
      assert.equal(report.status, 'incomplete')
      assert.deepEqual(ruleIds(report), ['capture-source-unsupported'])
      assert.equal(report.summary.checked, 0, 'nothing may be checked against evidence of the wrong kind')
      assert.equal(report.summary.fields, 0)
    }
  })

  await t.test('every finding points at the snapshot document it came from', async () => {
    const report = await checkMutated((snapshot) => {
      snapshot.capture.idIndex = 'partial'
      stateNamed(snapshot, '01-submitted-empty').focus = 'email-hint'
      fieldIn(stateNamed(snapshot, '04-both-corrected'), 'email').ariaInvalid = 'true'
    })
    assert.ok(report.findings.length >= 3)
    for (const finding of report.findings) {
      assert.equal(finding.location.file, 'snapshot.json')
      assert.ok(!finding.location.file.startsWith('/'), 'never an absolute host path')
      assert.match(finding.location.pointer, /^\//u)
    }
  })
})
