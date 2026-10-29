import { describe, expect, test } from 'bun:test';
import { HealthController } from '../src/health.controller';

describe('HealthController', () => {
  test('returns a liveness response', () => {
    const controller = new HealthController();

    expect(controller.live()).toEqual({ status: 'ok' });
  });
});
