/* eslint-env node, jest */
import * as Contract from '../../managers/contract.js';

function newContract() {
  const begin = new Date('2026-01-01T00:00:00');
  const end = new Date('2026-12-31T23:59:59');
  return Contract.create({
    begin,
    end,
    frequency: 'months',
    properties: [
      {
        propertyId: 'p1',
        property: { name: 'Apartment' },
        rent: 15000,
        expenses: [],
        entryDate: begin,
        exitDate: end
      }
    ]
  });
}

describe('paying a term', () => {
  it('keeps what was entered on the following rents', () => {
    const contract = newContract();
    Contract.payTerm(contract, '2026040100', {
      payments: [
        { date: '03/04/2026', type: 'cash', reference: '', amount: 5000 }
      ],
      discounts: [
        { origin: 'settlement', description: 'goodwill', amount: 1000 }
      ],
      debts: [{ description: 'broken window', amount: 1200 }],
      description: 'April: promised the rest by the 10th'
    });

    // recording a payment on March recomputes April and every later rent
    Contract.payTerm(contract, '2026030100', {
      payments: [
        { date: '02/03/2026', type: 'transfer', reference: 'T1', amount: 15000 }
      ]
    });

    const april = contract.rents.find(({ term }) => term === 2026040100);
    expect(april.description).toBe('April: promised the rest by the 10th');
    expect(april.total.payment).toBe(5000);
    expect(april.total.discount).toBe(1000);
    expect(april.total.debts).toBe(1200);
    // January, February and March were due, March brought 15000
    expect(april.total.balance).toBe(30000);
  });
});
