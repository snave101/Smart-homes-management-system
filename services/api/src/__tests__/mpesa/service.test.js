/* eslint-env node, jest */
import * as Contract from '../../managers/contract.js';
import { createMpesaService } from '../../managers/mpesa/service.js';
import { withTenantLock } from '../../managers/tenantlock.js';

const REALM = 'realm-1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clone = (value) => structuredClone(value);

function newTenant({
  _id,
  name,
  reference,
  rent = 15000,
  frequency = 'months',
  begin = '2026-01-01T00:00:00',
  end = '2026-12-31T23:59:59'
}) {
  const beginDate = new Date(begin);
  const endDate = new Date(end);
  const properties = [
    {
      propertyId: 'p1',
      property: { name: 'Apartment' },
      rent,
      expenses: [],
      entryDate: beginDate,
      exitDate: endDate
    }
  ];
  const { rents } = Contract.create({
    begin: beginDate,
    end: endDate,
    frequency,
    properties
  });
  return {
    tenant: { _id, name, reference, beginDate, endDate, properties, rents },
    frequency
  };
}

/** In-memory stand-in for the Mongo store: every read returns a copy. */
function newStore(tenants, { delay = 0 } = {}) {
  const byId = new Map(tenants.map((entry) => [entry.tenant._id, entry]));
  const transactions = new Map();
  let sequence = 0;

  return {
    transactions,
    tenant: (id) => byId.get(id).tenant,
    rentOf: (id, term) =>
      byId.get(id).tenant.rents.find((rent) => rent.term === term),

    async listTenantCandidates() {
      return [...byId.values()].map(({ tenant }) => ({
        _id: tenant._id,
        name: tenant.name,
        reference: tenant.reference,
        active: true
      }));
    },
    async loadTenant(realmId, tenantId) {
      await sleep(delay);
      const entry = byId.get(tenantId);
      return entry ? clone(entry) : null;
    },
    async saveRents(realmId, tenantId, rents) {
      await sleep(delay);
      byId.get(tenantId).tenant.rents = clone(rents);
    },
    async findTenantHolding(realmId, transId) {
      for (const { tenant } of byId.values()) {
        const held = tenant.rents.some((rent) =>
          rent.payments.some(
            (payment) =>
              payment.type === 'mobile_money' && payment.reference === transId
          )
        );
        if (held) {
          return tenant._id;
        }
      }
      return null;
    },
    async insertTransaction(realmId, payment) {
      const existing = transactions.get(payment.transId);
      if (existing) {
        return { created: false, transaction: clone(existing) };
      }
      const transaction = {
        _id: `tx-${++sequence}`,
        realmId,
        ...payment,
        status: 'received'
      };
      transactions.set(payment.transId, transaction);
      return { created: true, transaction: clone(transaction) };
    },
    async getTransaction(realmId, transactionId) {
      const found = [...transactions.values()].find(
        ({ _id }) => _id === transactionId
      );
      return found ? clone(found) : null;
    },
    async updateTransaction(realmId, transId, patch) {
      const transaction = transactions.get(transId);
      Object.assign(transaction, patch);
      return clone(transaction);
    }
  };
}

function newService(store, withLock = withTenantLock) {
  const logs = [];
  const log = (level) => (message) => logs.push(`${level} ${message}`);
  const service = createMpesaService({
    store,
    payTerm: Contract.payTerm,
    withLock,
    logger: { info: log('info'), warn: log('warn'), error: log('error') }
  });
  return { service, logs };
}

const config = {
  realmId: REALM,
  enabled: true,
  shortCode: '600638',
  shortCodeType: 'paybill',
  rejectUnknownAccounts: false
};

function confirmation(overrides = {}) {
  return {
    TransactionType: 'Pay Bill',
    TransID: 'RKTQDM7W6S',
    TransTime: '20260305143845',
    TransAmount: '15000.00',
    BusinessShortCode: '600638',
    BillRefNumber: 'A12',
    MSISDN: '25470****149',
    FirstName: 'Wanjiku',
    ...overrides
  };
}

const MARCH = 2026030100;
const APRIL = 2026040100;
const ACK = { ResultCode: 0, ResultDesc: 'Success' };

describe('M-Pesa confirmation', () => {
  let store;
  let service;

  beforeEach(() => {
    store = newStore([
      newTenant({ _id: 't1', name: 'Wanjiku', reference: 'A12' }),
      newTenant({ _id: 't2', name: 'Otieno', reference: 'B07', rent: 20000 })
    ]);
    ({ service } = newService(store));
  });

  it('records the payment on the rent of the month it was sent', async () => {
    expect(await service.confirm(config, confirmation())).toEqual(ACK);

    const march = store.rentOf('t1', MARCH);
    expect(march.payments).toEqual([
      {
        date: '05/03/2026',
        type: 'mobile_money',
        reference: 'RKTQDM7W6S',
        amount: 15000
      }
    ]);
    expect(march.total.payment).toBe(15000);
    // nothing was recorded on the other tenant
    expect(store.rentOf('t2', MARCH).total.payment).toBe(0);

    expect(store.transactions.get('RKTQDM7W6S')).toMatchObject({
      status: 'matched',
      tenantId: 't1',
      tenantName: 'Wanjiku',
      term: MARCH,
      matchedBy: 'auto',
      amount: 15000,
      paidAt: '2026-03-05T14:38'
    });
  });

  it('carries a partial payment to the balance of the next rents', async () => {
    await service.confirm(config, confirmation({ TransAmount: '10000' }));

    const march = store.rentOf('t1', MARCH);
    const april = store.rentOf('t1', APRIL);
    // January and February are unpaid: 3 x 15000 due in March
    expect(march.total.grandTotal).toBe(45000);
    expect(march.total.payment).toBe(10000);
    expect(april.total.balance).toBe(35000);
    expect(april.total.grandTotal).toBe(50000);
  });

  it('adds up several payments made for the same rent', async () => {
    await service.confirm(config, confirmation({ TransAmount: '10000' }));
    await service.confirm(
      config,
      confirmation({
        TransID: 'RKU1AAAAA2',
        TransAmount: '5000',
        TransTime: '20260320080000'
      })
    );

    const march = store.rentOf('t1', MARCH);
    expect(march.payments.map(({ reference }) => reference)).toEqual([
      'RKTQDM7W6S',
      'RKU1AAAAA2'
    ]);
    expect(march.total.payment).toBe(15000);
  });

  it('never counts a confirmation delivered twice', async () => {
    await service.confirm(config, confirmation());
    expect(await service.confirm(config, confirmation())).toEqual(ACK);

    expect(store.rentOf('t1', MARCH).payments).toHaveLength(1);
    expect(store.rentOf('t1', MARCH).total.payment).toBe(15000);
    expect(store.transactions.size).toBe(1);
  });

  it('resumes a confirmation interrupted after it was stored', async () => {
    // the first delivery stored the transaction then the process stopped
    await store.insertTransaction(REALM, {
      transId: 'RKTQDM7W6S',
      transTime: '20260305143845',
      amount: 15000
    });

    await service.confirm(config, confirmation());

    expect(store.rentOf('t1', MARCH).total.payment).toBe(15000);
    expect(store.transactions.get('RKTQDM7W6S').status).toBe('matched');
  });

  it('adopts a receipt the landlord already typed in the form', async () => {
    // recorded by hand on the other tenant before the confirmation arrived
    const otieno = store.tenant('t2');
    Contract.payTerm(
      {
        frequency: 'months',
        begin: otieno.beginDate,
        end: otieno.endDate,
        properties: otieno.properties,
        rents: otieno.rents
      },
      String(MARCH),
      {
        payments: [
          {
            date: '05/03/2026',
            type: 'mobile_money',
            reference: 'RKTQDM7W6S',
            amount: 15000
          }
        ]
      }
    );

    await service.confirm(config, confirmation());

    expect(store.rentOf('t1', MARCH).total.payment).toBe(0);
    expect(store.rentOf('t2', MARCH).payments).toHaveLength(1);
    expect(store.transactions.get('RKTQDM7W6S')).toMatchObject({
      status: 'matched',
      tenantId: 't2',
      term: MARCH,
      matchedBy: 'manual'
    });
  });

  it('keeps unknown account numbers for the landlord to allocate', async () => {
    await service.confirm(config, confirmation({ BillRefNumber: 'Z99' }));

    expect(store.transactions.get('RKTQDM7W6S')).toMatchObject({
      status: 'unmatched',
      reason: 'unknown_account',
      tenantId: null
    });
    expect(store.rentOf('t1', MARCH).total.payment).toBe(0);
  });

  it('stores the payment but records nothing when disabled', async () => {
    await service.confirm({ ...config, enabled: false }, confirmation());

    expect(store.transactions.get('RKTQDM7W6S')).toMatchObject({
      status: 'unmatched',
      reason: 'integration_disabled'
    });
    expect(store.rentOf('t1', MARCH).total.payment).toBe(0);
  });

  it('ignores payloads that are not ours or not payments', async () => {
    expect(
      await service.confirm(
        config,
        confirmation({ BusinessShortCode: '111111' })
      )
    ).toEqual(ACK);
    expect(await service.confirm(config, { hello: 'world' })).toEqual(ACK);
    expect(await service.confirm(config, undefined)).toEqual(ACK);

    expect(store.transactions.size).toBe(0);
    expect(store.rentOf('t1', MARCH).total.payment).toBe(0);
  });

  it('puts payments made outside the lease on its first or last rent', async () => {
    await service.confirm(
      config,
      confirmation({ TransID: 'EARLY00001', TransTime: '20251220100000' })
    );
    await service.confirm(
      config,
      confirmation({ TransID: 'LATE000001', TransTime: '20270115100000' })
    );

    expect(store.transactions.get('EARLY00001').term).toBe(2026010100);
    expect(store.transactions.get('LATE000001').term).toBe(2026120100);
    expect(store.rentOf('t1', 2026010100).total.payment).toBe(15000);
    expect(store.rentOf('t1', 2026120100).total.payment).toBe(15000);
  });

  it('keeps the transaction when the rents cannot be recomputed', async () => {
    const failing = createMpesaService({
      store,
      payTerm: () => {
        throw new Error('boom');
      },
      withLock: withTenantLock,
      logger: { info() {}, warn() {}, error() {} }
    });

    expect(await failing.confirm(config, confirmation())).toEqual(ACK);
    expect(store.transactions.get('RKTQDM7W6S')).toMatchObject({
      status: 'unmatched',
      reason: 'apply_failed'
    });
  });

  it('lets Safaricom retry when the transaction cannot be stored', async () => {
    store.insertTransaction = async () => {
      throw new Error('database unreachable');
    };
    await expect(service.confirm(config, confirmation())).rejects.toThrow(
      'database unreachable'
    );
  });
});

describe('M-Pesa confirmations arriving at the same time', () => {
  const twoPayments = (service) =>
    Promise.all([
      service.confirm(config, confirmation({ TransAmount: '7000' })),
      service.confirm(
        config,
        confirmation({ TransID: 'RKU1AAAAA2', TransAmount: '8000' })
      )
    ]);

  it('records both payments', async () => {
    const store = newStore(
      [newTenant({ _id: 't1', name: 'Wanjiku', reference: 'A12' })],
      { delay: 5 }
    );
    await twoPayments(newService(store).service);

    expect(store.rentOf('t1', MARCH).payments).toHaveLength(2);
    expect(store.rentOf('t1', MARCH).total.payment).toBe(15000);
  });

  it('would lose one without the tenant lock', async () => {
    // guards the test above: it must be able to detect the lost update
    const store = newStore(
      [newTenant({ _id: 't1', name: 'Wanjiku', reference: 'A12' })],
      { delay: 5 }
    );
    const noLock = (tenantId, task) => task();
    await twoPayments(newService(store, noLock).service);

    expect(store.rentOf('t1', MARCH).payments).toHaveLength(1);
  });

  it('counts once a confirmation delivered twice at the same time', async () => {
    const store = newStore(
      [newTenant({ _id: 't1', name: 'Wanjiku', reference: 'A12' })],
      { delay: 5 }
    );
    const { service } = newService(store);
    await Promise.all([
      service.confirm(config, confirmation()),
      service.confirm(config, confirmation())
    ]);

    expect(store.rentOf('t1', MARCH).payments).toHaveLength(1);
    expect(store.rentOf('t1', MARCH).total.payment).toBe(15000);
  });
});

describe('M-Pesa and leases that are not monthly', () => {
  it('records the payment on the week it was sent', async () => {
    const store = newStore([
      newTenant({
        _id: 'w1',
        name: 'Weekly tenant',
        reference: 'W1',
        rent: 3000,
        frequency: 'weeks',
        begin: '2026-01-05T00:00:00',
        end: '2026-03-01T23:59:59'
      })
    ]);
    const termsBefore = store.tenant('w1').rents.map(({ term }) => term);
    const { service } = newService(store);

    await service.confirm(
      config,
      confirmation({
        BillRefNumber: 'W1',
        TransAmount: '3000',
        TransTime: '20260121090000'
      })
    );

    // Wednesday 21 January belongs to the week starting Monday 19 January
    expect(store.transactions.get('RKTQDM7W6S').term).toBe(2026011900);
    expect(store.rentOf('w1', 2026011900).total.payment).toBe(3000);
    // the schedule of the lease is untouched
    expect(store.tenant('w1').rents.map(({ term }) => term)).toEqual(
      termsBefore
    );
  });
});

describe('M-Pesa validation', () => {
  let service;

  beforeEach(() => {
    const store = newStore([
      newTenant({ _id: 't1', name: 'Wanjiku', reference: 'A12' })
    ]);
    ({ service } = newService(store));
  });

  const accepted = { ResultCode: '0', ResultDesc: 'Accepted' };
  const rejected = (code) => ({ ResultCode: code, ResultDesc: 'Rejected' });

  it('accepts a valid payment', async () => {
    expect(await service.validate(config, confirmation())).toEqual(accepted);
  });

  it('accepts unknown accounts unless told otherwise', async () => {
    const unknown = confirmation({ BillRefNumber: 'Z99' });
    expect(await service.validate(config, unknown)).toEqual(accepted);
    expect(
      await service.validate(
        { ...config, rejectUnknownAccounts: true },
        unknown
      )
    ).toEqual(rejected('C2B00012'));
    // a till has no account number: nothing to check
    expect(
      await service.validate(
        { ...config, rejectUnknownAccounts: true, shortCodeType: 'till' },
        unknown
      )
    ).toEqual(accepted);
  });

  it('rejects with the code matching the problem', async () => {
    expect(
      await service.validate(config, confirmation({ TransAmount: '0' }))
    ).toEqual(rejected('C2B00013'));
    expect(
      await service.validate(
        config,
        confirmation({ BusinessShortCode: '111111' })
      )
    ).toEqual(rejected('C2B00015'));
    expect(await service.validate(config, {})).toEqual(rejected('C2B00016'));
    expect(
      await service.validate({ ...config, enabled: false }, confirmation())
    ).toEqual(rejected('C2B00016'));
  });
});

describe('M-Pesa manual allocation', () => {
  let store;
  let service;

  beforeEach(async () => {
    store = newStore([
      newTenant({ _id: 't1', name: 'Wanjiku', reference: 'A12' }),
      newTenant({ _id: 't2', name: 'Otieno', reference: 'B07', rent: 20000 })
    ]);
    ({ service } = newService(store));
    await service.confirm(config, confirmation({ BillRefNumber: 'Z99' }));
  });

  const txId = () => store.transactions.get('RKTQDM7W6S')._id;

  it('records an unmatched payment on the chosen tenant', async () => {
    const transaction = await service.allocate(REALM, txId(), 't2');

    expect(transaction).toMatchObject({
      status: 'matched',
      tenantId: 't2',
      tenantName: 'Otieno',
      term: MARCH,
      matchedBy: 'manual',
      reason: null
    });
    expect(store.rentOf('t2', MARCH).total.payment).toBe(15000);
  });

  it('records it on the requested rent', async () => {
    await service.allocate(REALM, txId(), 't2', APRIL);

    expect(store.rentOf('t2', MARCH).total.payment).toBe(0);
    expect(store.rentOf('t2', APRIL).total.payment).toBe(15000);
  });

  it('moves a payment without leaving a copy behind', async () => {
    await service.allocate(REALM, txId(), 't1');
    await service.allocate(REALM, txId(), 't2');

    expect(store.rentOf('t1', MARCH).payments).toEqual([]);
    expect(store.rentOf('t1', MARCH).total.payment).toBe(0);
    expect(store.rentOf('t1', APRIL).total.balance).toBe(45000);
    expect(store.rentOf('t2', MARCH).total.payment).toBe(15000);
    expect(store.transactions.get('RKTQDM7W6S').tenantId).toBe('t2');
  });

  it('is idempotent', async () => {
    await service.allocate(REALM, txId(), 't1');
    await service.allocate(REALM, txId(), 't1');

    expect(store.rentOf('t1', MARCH).payments).toHaveLength(1);
  });

  it('removes the payment from the rent when detached', async () => {
    await service.allocate(REALM, txId(), 't1');
    const transaction = await service.detach(REALM, txId());

    expect(transaction).toMatchObject({
      status: 'unmatched',
      reason: 'detached',
      tenantId: null,
      term: null
    });
    expect(store.rentOf('t1', MARCH).payments).toEqual([]);
    expect(store.rentOf('t1', MARCH).total.payment).toBe(0);
  });

  it('keeps the other payments and the notes of the rent', async () => {
    // a cash payment and a note entered by the landlord on the same rent
    const tenant = store.tenant('t1');
    Contract.payTerm(
      {
        frequency: 'months',
        begin: tenant.beginDate,
        end: tenant.endDate,
        properties: tenant.properties,
        rents: tenant.rents
      },
      String(MARCH),
      {
        payments: [
          { date: '02/03/2026', type: 'cash', reference: '', amount: 4000 }
        ],
        discounts: [
          { origin: 'settlement', description: 'goodwill', amount: 500 }
        ],
        debts: [{ description: 'broken window', amount: 1200 }],
        description: 'promised the rest by the 10th'
      }
    );

    await service.allocate(REALM, txId(), 't1');
    let march = store.rentOf('t1', MARCH);
    expect(march.total.payment).toBe(19000);
    expect(march.total.discount).toBe(500);
    expect(march.total.debts).toBe(1200);
    expect(march.description).toBe('promised the rest by the 10th');

    await service.detach(REALM, txId());
    march = store.rentOf('t1', MARCH);
    expect(march.payments).toEqual([
      { date: '02/03/2026', type: 'cash', reference: '', amount: 4000 }
    ]);
    expect(march.total.discount).toBe(500);
    expect(march.total.debts).toBe(1200);
    expect(march.description).toBe('promised the rest by the 10th');
  });

  it('refuses unknown transactions, tenants and rents', async () => {
    await expect(service.allocate(REALM, 'nope', 't1')).rejects.toMatchObject({
      statusCode: 404
    });
    await expect(service.allocate(REALM, txId(), 'nope')).rejects.toMatchObject(
      { statusCode: 404 }
    );
    await expect(
      service.allocate(REALM, txId(), 't1', 2030010100)
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      service.allocate(REALM, txId(), 't1', 1.5)
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(store.rentOf('t1', MARCH).total.payment).toBe(0);
  });

  it('sets aside and restores a transaction', async () => {
    expect((await service.setIgnored(REALM, txId(), true)).status).toBe(
      'ignored'
    );
    expect(await service.setIgnored(REALM, txId(), false)).toMatchObject({
      status: 'unmatched'
    });

    await service.allocate(REALM, txId(), 't1');
    await expect(service.setIgnored(REALM, txId(), true)).rejects.toMatchObject(
      { statusCode: 409 }
    );
  });
});
