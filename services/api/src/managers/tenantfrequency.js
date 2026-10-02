import { Collections } from '@microrealestate/common';

const TIME_RANGES = ['hours', 'days', 'weeks', 'months', 'years'];

function asTimeRange(value) {
  return TIME_RANGES.includes(value) ? value : undefined;
}

/**
 * The rent frequency of a tenant is the time range of its lease. Tenant
 * documents do not store it (only legacy ones carry a `frequency` field), so
 * it has to be read from the lease: assuming months would recompute the rents
 * of a weekly or yearly lease on a monthly schedule.
 */
export async function resolveTenantFrequency(realmId, tenant) {
  // legacy tenants may carry a lease id that is not an ObjectId
  if (tenant?.leaseId && Collections.ObjectId.isValid(String(tenant.leaseId))) {
    const lease = await Collections.Lease.findOne({
      _id: String(tenant.leaseId),
      realmId
    }).lean();
    const timeRange = asTimeRange(lease?.timeRange);
    if (timeRange) {
      return timeRange;
    }
  }
  return asTimeRange(tenant?.frequency) ?? 'months';
}
