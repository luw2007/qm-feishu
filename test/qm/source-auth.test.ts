import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalPayload, signRequest, signedRequestHeaders } from '../../src/qm/source-auth.js';

test('source auth matches the QM v0 HMAC protocol', () => {
  const canonical = canonicalPayload('POST', '/v1/turns?async=1', '{"text":"hello"}');

  assert.equal(canonical, 'POST\n/v1/turns?async=1\n{"text":"hello"}');
  assert.equal(
    signRequest('test-secret', 1_700_000_000, canonical),
    'v0=cad7ccb0ad5d9b2569188bb43e47946282d97fd1ee7acc7fea5285d548f522d8',
  );
});

test('signed headers preserve base headers and use the supplied clock', () => {
  assert.deepEqual(
    signedRequestHeaders('test-secret', 'GET', '/v1/runs?threadRef=feishu%3Adm%3Aoc_test_1', '', {
      accept: 'application/json',
    }, 1_700_000_000),
    {
      accept: 'application/json',
      'x-timestamp': '1700000000',
      'x-signature': 'v0=816f360b87a61a0bbe8f9231414e3cb9114c7f78879c2f4d0520f89a1eb7eca2',
    },
  );
});
