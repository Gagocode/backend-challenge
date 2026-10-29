import { describe, expect, test } from 'bun:test';
import { ReadinessController } from '../src/readiness.controller';

describe('ReadinessController', () => {
  test('reports PostgreSQL as available when the probe succeeds', async () => {
    const controller = new ReadinessController({
      query: async () => [],
    } as never);

    await expect(controller.ready()).resolves.toEqual({
      status: 'ok',
      dependencies: { postgres: 'up' },
    });
  });

  test('returns service unavailable when the probe fails', async () => {
    const controller = new ReadinessController({
      query: async () => {
        throw new Error('database unavailable');
      },
    } as never);

    await expect(controller.ready()).rejects.toMatchObject({
      status: 503,
      response: {
        status: 'not_ready',
        dependencies: { postgres: 'down' },
      },
    });
  });
});
