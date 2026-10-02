/**
 * Serializes the read-modify-write cycles applied to a tenant document.
 *
 * Recording a payment loads the tenant, recomputes every following rent and
 * writes the rents back. Two of these running at once for the same tenant
 * (a landlord saving a payment while an M-Pesa confirmation arrives, or two
 * confirmations a few milliseconds apart) would overwrite each other and
 * silently drop a payment. The api service runs as a single process, so an
 * in-process queue per tenant is enough to rule that out.
 */
const queues = new Map();

export async function withTenantLock(tenantId, task) {
  const key = String(tenantId);
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(task);
  // the queue must keep moving whatever the outcome of a task
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  queues.set(key, tail);
  try {
    return await run;
  } finally {
    if (queues.get(key) === tail) {
      queues.delete(key);
    }
  }
}

/** Number of tenants with work in progress, exposed for tests. */
export function pendingTenantLocks() {
  return queues.size;
}
