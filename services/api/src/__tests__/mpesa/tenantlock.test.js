/* eslint-env node, jest */
import {
  pendingTenantLocks,
  withTenantLock
} from '../../managers/tenantlock.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('tenant lock', () => {
  it('runs the tasks of a tenant one after the other', async () => {
    const events = [];
    const task = (name, ms) => async () => {
      events.push(`${name} start`);
      await sleep(ms);
      events.push(`${name} end`);
      return name;
    };

    const results = await Promise.all([
      withTenantLock('t1', task('a', 20)),
      withTenantLock('t1', task('b', 1)),
      withTenantLock('t1', task('c', 5))
    ]);

    expect(results).toEqual(['a', 'b', 'c']);
    expect(events).toEqual([
      'a start',
      'a end',
      'b start',
      'b end',
      'c start',
      'c end'
    ]);
  });

  it('does not make a tenant wait for another one', async () => {
    const events = [];
    await Promise.all([
      withTenantLock('t1', async () => {
        await sleep(20);
        events.push('t1');
      }),
      withTenantLock('t2', async () => {
        events.push('t2');
      })
    ]);
    expect(events).toEqual(['t2', 't1']);
  });

  it('keeps going after a failed task and reports the failure', async () => {
    const failing = withTenantLock('t1', async () => {
      throw new Error('boom');
    });
    const following = withTenantLock('t1', async () => 'ok');

    await expect(failing).rejects.toThrow('boom');
    expect(await following).toBe('ok');
  });

  it('does not keep finished tenants in memory', async () => {
    await withTenantLock('t1', async () => undefined);
    await withTenantLock(42, async () => undefined);
    expect(pendingTenantLocks()).toBe(0);
  });
});
