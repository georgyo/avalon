/** Completeness sweep, shard 1 of 2 (see sweepkit.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLambdaShard } from './sweepkit.ts';

test('completeness sweep, shard 1/2: every distinct label list Λ', () => {
  assert.equal(runLambdaShard(1, 2), 58);
});
