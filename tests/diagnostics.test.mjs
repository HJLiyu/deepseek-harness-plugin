import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INTEGRATION_ERROR,
  INTEGRATION_REASON_CODES,
  attachDiagnostics,
  describeIntegrationFailure,
  integrationFailure,
  integrationHuman,
  isKnownIntegrationReason,
} from '../src/integration-diagnostics.mjs';

const DETAIL_CODES = INTEGRATION_REASON_CODES.filter(code => code !== 'unknown');

test('every integration reason refuses, carries a human explanation and safe actions only', () => {
  for (const code of DETAIL_CODES) {
    const error = integrationFailure(code, {
      file: 'web/group.html',
      before: 'a'.repeat(64),
      current: 'b'.repeat(64),
      wanted: 'c'.repeat(64),
      expiresAt: 1760000000000,
      now: 1760001000000,
      requestId: 'req-1',
      revision: 3,
      member: 'codex',
    });

    // Refusal is preserved: it is a thrown Error, never a continue signal.
    assert.equal(error instanceof Error, true, code);
    assert.equal(error.code, INTEGRATION_ERROR);
    assert.equal(error.reason, code);
    assert.equal(error.message, integrationHuman(code).detail, code);

    const human = error.details.human;
    assert.equal(typeof human.detail, 'string');
    assert.ok(human.detail.length > 8, code);
    assert.equal(typeof human.next, 'string');
    assert.ok(human.next.length > 8, code);
    assert.equal(typeof human.owner, 'string');
    assert.equal(typeof human.needsUser, 'boolean');
    assert.ok([undefined, 'diagnose'].includes(human.action), `${code} must not invent privileged actions`);

    // Technical detail is preserved for the collapsed area.
    const technical = error.details.technical;
    assert.equal(technical.file, 'web/group.html');
    assert.equal(technical.before.length, 64);
    assert.equal(technical.requestId, 'req-1');
    assert.equal(technical.revision, 3);
    // Serialising the persisted diagnostics must never fail (no cycles).
    assert.equal(JSON.parse(JSON.stringify(error.details)).reason, code);
  }
});

test('main conflict wording reports a version mismatch without asserting who changed it', () => {
  const human = integrationHuman('main_conflict');
  assert.match(human.detail, /不一致/);
  assert.doesNotMatch(human.detail, /被改动过|上次整合产物/);
  assert.match(human.next, /差异/);
});

test('unknown failures stay unknown instead of being guessed into a reason', () => {
  const raw = new Error('Main project integration conflict: something unexpected');
  const described = describeIntegrationFailure(raw);
  assert.equal(described.code, INTEGRATION_ERROR);
  assert.equal(described.reason, 'unknown');
  assert.match(described.human.detail, /无法确认/);
  assert.match(described.technical.raw, /something unexpected/);

  const invalidCode = integrationFailure('made-up-reason', { file: 'x' });
  assert.equal(invalidCode.reason, 'unknown');
  assert.equal(invalidCode.message, integrationHuman('unknown').detail);
});

test('describeIntegrationFailure exposes message/details for block() and stays JSON-safe', () => {
  const original = integrationFailure('consent_expired', { expiresAt: 1, now: 2 });
  const described = describeIntegrationFailure(original);
  assert.equal(described.reason, 'consent_expired');
  assert.equal(described.message, described.human.detail);
  assert.equal(described.details.reason, 'consent_expired');
  assert.equal(described.details.human.detail, described.human.detail);
  assert.deepEqual(JSON.parse(JSON.stringify(described)).details.technical, { expiresAt: 1, now: 2 });

  const unknown = describeIntegrationFailure(new Error('boom'));
  assert.equal(unknown.message, unknown.human.detail);
  assert.equal(unknown.details.reason, 'unknown');
  assert.equal(unknown.details.technical.raw, 'boom');
});

test('technical strings are bounded so an error cannot leak a whole file or stack', () => {
  const huge = 'x'.repeat(5000);
  const error = integrationFailure('main_conflict', { file: huge, nested: { note: huge }, list: new Array(50).fill(huge) });
  assert.ok(error.details.technical.file.length <= 301);
  assert.ok(error.details.technical.nested.note.length <= 301);
  assert.ok(error.details.technical.list.length <= 8);
  assert.ok(error.details.technical.list.every(item => item.length <= 301));
});

test('a null or missing error never looks like a successful integration', () => {
  for (const value of [null, undefined]) {
    const described = describeIntegrationFailure(value);
    assert.equal(described.reason, 'unknown');
    assert.equal(described.human.needsUser, true);
    assert.equal(typeof described.message, 'string');
    assert.ok(!Object.hasOwn(described, 'allow'));
    assert.ok(!Object.hasOwn(described, 'continue'));
  }
});

test('attachDiagnostics is the single place that keeps or clears stale diagnostics', () => {
  const request = { id: 'r1', status: 'blocked' };
  const described = describeIntegrationFailure(integrationFailure('consent_expired', { expiresAt: 1 }));
  attachDiagnostics(request, described);
  assert.equal(request.errorDetails.reason, 'consent_expired');

  // Every path that clears the error must clear diagnostics through the same helper.
  attachDiagnostics(request);
  assert.equal(Object.hasOwn(request, 'errorDetails'), false);

  attachDiagnostics(request, undefined);
  assert.equal(Object.hasOwn(request, 'errorDetails'), false);

  // No-op on a missing target instead of throwing.
  assert.equal(attachDiagnostics(null, described), null);
});

test('reason code helper only accepts the documented set', () => {
  assert.equal(isKnownIntegrationReason('consent_expired'), true);
  assert.equal(isKnownIntegrationReason('main_conflict'), true);
  assert.equal(isKnownIntegrationReason('unknown'), false);
  assert.equal(isKnownIntegrationReason('made-up-reason'), false);
  assert.equal(INTEGRATION_REASON_CODES.includes('path_unsafe'), true);
  assert.equal(INTEGRATION_REASON_CODES.includes('checkpoint_missing_or_stale'), true);
});
