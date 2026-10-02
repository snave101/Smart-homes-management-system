import * as Contract from './contract.js';
import * as FD from './frontdata.js';
import {
  Collections,
  logger,
  Service,
  ServiceError
} from '@microrealestate/common';
import axios from 'axios';
import { lockedPaymentsOf } from './mpesa/index.js';
import { mergeLockedPayments } from './mpesa/core.js';
import moment from 'moment';
import { resolveTenantFrequency } from './tenantfrequency.js';
import { withTenantLock } from './tenantlock.js';

async function _findOccupants(realm, tenantId, startTerm, endTerm) {
  const filter = {
    $query: {
      $and: [{ realmId: realm._id }]
    }
  };
  if (tenantId) {
    filter['$query']['$and'].push({ _id: tenantId });
  }
  if (startTerm && endTerm) {
    filter['$query']['$and'].push({ 'rents.term': { $gte: startTerm } });
    filter['$query']['$and'].push({ 'rents.term': { $lte: endTerm } });
  } else if (startTerm) {
    filter['$query']['$and'].push({ 'rents.term': startTerm });
  }

  const dbTenants = await Collections.Tenant.find(filter.$query)
    .sort({
      name: 1
    })
    .lean();

  return dbTenants.map((tenant) => {
    tenant._id = String(tenant._id);
    if (startTerm && endTerm) {
      tenant.rents = tenant.rents.filter(
        (rent) => rent.term >= startTerm && rent.term <= endTerm
      );
    } else if (startTerm) {
      tenant.rents = tenant.rents.filter((rent) => rent.term === startTerm);
    }
    return tenant;
  });
}

async function _getEmailStatus(
  authorizationHeader,
  locale,
  realm,
  startTerm,
  endTerm
) {
  const { DEMO_MODE, EMAILER_URL } =
    Service.getInstance().envConfig.getValues();
  try {
    let emailEndPoint = `${EMAILER_URL}/status/${startTerm}`;
    if (endTerm) {
      emailEndPoint = `${EMAILER_URL}/status/${startTerm}/${endTerm}`;
    }
    const response = await axios.get(emailEndPoint, {
      headers: {
        authorization: authorizationHeader,
        organizationid: String(realm._id),
        'Accept-Language': locale
      }
    });
    logger.debug(response.data);
    return response.data.reduce((acc, status) => {
      const data = {
        sentTo: status.sentTo,
        sentDate: status.sentDate
      };
      if (!acc[status.recordId]) {
        acc[status.recordId] = { [status.templateName]: [] };
      }
      let documents = acc[status.recordId][status.templateName];
      if (!documents) {
        documents = [];
        acc[status.recordId][status.templateName] = documents;
      }
      documents.push(data);
      return acc;
    }, {});
  } catch (error) {
    logger.error(error);
    if (DEMO_MODE) {
      logger.info('email status fallback workflow activated in demo mode');
      return {};
    } else {
      throw error.data;
    }
  }
}

async function _getRentsDataByTerm(
  authorizationHeader,
  locale,
  realm,
  currentDate,
  frequency
) {
  const startTerm = Number(currentDate.startOf(frequency).format('YYYYMMDDHH'));
  const endTerm = Number(currentDate.endOf(frequency).format('YYYYMMDDHH'));

  const [dbOccupants, emailStatus = {}] = await Promise.all([
    _findOccupants(realm, null, startTerm, endTerm),
    _getEmailStatus(
      authorizationHeader,
      locale,
      realm,
      startTerm,
      endTerm
    ).catch(logger.error)
  ]);

  // compute rents
  const rents = dbOccupants.reduce((acc, occupant) => {
    acc.push(
      ...occupant.rents
        .filter((rent) => rent.term >= startTerm && rent.term <= endTerm)
        .map((rent) =>
          FD.toRentData(rent, occupant, emailStatus?.[occupant._id])
        )
    );
    return acc;
  }, []);

  // compute rents overview
  const overview = {
    countAll: 0,
    countPaid: 0,
    countPartiallyPaid: 0,
    countNotPaid: 0,
    totalToPay: 0,
    totalPaid: 0,
    totalNotPaid: 0
  };
  rents.reduce((acc, rent) => {
    if (rent.totalAmount <= 0 || rent.newBalance >= 0) {
      acc.countPaid++;
    } else if (rent.payment > 0) {
      acc.countPartiallyPaid++;
    } else {
      acc.countNotPaid++;
    }
    acc.countAll++;
    acc.totalToPay += rent.totalToPay;
    acc.totalPaid += rent.payment;
    acc.totalNotPaid -= rent.newBalance < 0 ? rent.newBalance : 0;
    return acc;
  }, overview);

  return { overview, rents };
}

////////////////////////////////////////////////////////////////////////////////
// Exported functions
////////////////////////////////////////////////////////////////////////////////
export async function update(req, res) {
  const realm = req.realm;
  const authorizationHeader = req.headers.authorization;
  const locale = req.headers['accept-language'];
  const paymentData = req.body;
  const term = `${paymentData.year}${paymentData.month}0100`;

  res.json(
    await _updateByTerm(authorizationHeader, locale, realm, term, paymentData)
  );
}

export async function updateByTerm(req, res) {
  const realm = req.realm;
  const term = req.params.term;
  const authorizationHeader = req.headers.authorization;
  const locale = req.headers['accept-language'];
  const paymentData = req.body;

  res.json(
    await _updateByTerm(authorizationHeader, locale, realm, term, paymentData)
  );
}

function _amountOf(value, field) {
  if (value === undefined || value === null || value === '') {
    return 0;
  }
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new ServiceError(`invalid ${field}`, 422);
  }
  return amount;
}

async function _updateByTerm(
  authorizationHeader,
  locale,
  realm,
  term,
  paymentData
) {
  if (
    typeof paymentData?._id !== 'string' ||
    !Collections.ObjectId.isValid(paymentData._id)
  ) {
    throw new ServiceError('tenant not found', 404);
  }
  if (!/^\d{10}$/.test(String(term))) {
    throw new ServiceError('invalid term', 422);
  }

  // amounts are validated before anything is computed: a negative discount
  // or extra charge silently inverted the balance of the rent
  const promo = _amountOf(paymentData.promo, 'discount');
  const extracharge = _amountOf(paymentData.extracharge, 'extra charge');
  const submittedPayments = (paymentData.payments || [])
    .map((payment) => ({
      date: payment.date || '',
      amount: _amountOf(payment.amount, 'payment amount'),
      type: payment.type || '',
      reference: payment.reference || '',
      description: payment.description || ''
    }))
    .filter(({ amount }) => amount > 0);

  // one rent update at a time per tenant, otherwise two concurrent saves
  // (or a save and an incoming M-Pesa payment) overwrite each other
  const savedOccupant = await withTenantLock(paymentData._id, async () => {
    const occupant = await Collections.Tenant.findOne({
      _id: paymentData._id,
      realmId: realm._id
    }).lean();

    if (!occupant) {
      throw new ServiceError('tenant not found', 404);
    }

    const contract = {
      frequency: await resolveTenantFrequency(realm._id, occupant),
      begin: occupant.beginDate,
      end: occupant.endDate,
      discount: occupant.discount || 0,
      vatRate: occupant.vatRatio,
      properties: occupant.properties,
      rents: occupant.rents
    };

    const settlements = {
      // payments received through M-Pesa are kept whatever the form sent
      payments: mergeLockedPayments(
        submittedPayments,
        await lockedPaymentsOf(realm._id, occupant._id, Number(term))
      ),
      debts: [],
      discounts: [],
      description: paymentData.description || ''
    };

    if (promo) {
      settlements.discounts.push({
        origin: 'settlement',
        description: paymentData.notepromo || '',
        amount: promo * (contract.vatRate ? 1 / (1 + contract.vatRate) : 1)
      });
    }

    if (extracharge) {
      settlements.debts.push({
        description: paymentData.noteextracharge || '',
        amount:
          extracharge * (contract.vatRate ? 1 / (1 + contract.vatRate) : 1)
      });
    }

    let rents;
    try {
      rents = Contract.payTerm(contract, term, settlements).rents;
    } catch (error) {
      throw new ServiceError(error, 422);
    }

    // only the rents changed: do not write back the other tenant fields
    const saved = await Collections.Tenant.findOneAndUpdate(
      {
        _id: occupant._id,
        realmId: realm._id
      },
      { $set: { rents } },
      { new: true }
    ).lean();

    if (!saved) {
      throw new ServiceError('tenant not found', 404);
    }
    return saved;
  });

  const emailStatus =
    (await _getEmailStatus(
      authorizationHeader,
      locale,
      realm,
      Number(term)
    ).catch(logger.error)) || {};

  const rent = savedOccupant.rents.filter(
    (rent) => rent.term === Number(term)
  )[0];

  return FD.toRentData(
    rent,
    savedOccupant,
    emailStatus?.[String(savedOccupant._id)]
  );
}

export async function rentsOfOccupant(req, res) {
  const realm = req.realm;
  const { id } = req.params;
  const term = Number(moment().format('YYYYMMDDHH'));

  const dbOccupants = await _findOccupants(realm, id);
  if (!dbOccupants.length) {
    return res.sendStatus(404);
  }

  const dbOccupant = dbOccupants[0];
  const rentsToReturn = dbOccupant.rents.map((currentRent) => {
    const rent = FD.toRentData(currentRent);
    if (currentRent.term === term) {
      rent.active = 'active';
    }
    rent.vatRatio = dbOccupant.vatRatio;
    return rent;
  });

  res.json({
    occupant: FD.toOccupantData(dbOccupant),
    rents: rentsToReturn
  });
}

export async function rentOfOccupantByTerm(req, res) {
  const realm = req.realm;
  const { id, term } = req.params;

  res.json(
    await _rentOfOccupant(
      req.headers.authorization,
      req.headers['accept-language'],
      realm,
      id,
      term
    )
  );
}

async function _rentOfOccupant(
  authorizationHeader,
  locale,
  realm,
  tenantId,
  term
) {
  const [dbOccupants = [], emailStatus = {}] = await Promise.all([
    _findOccupants(realm, tenantId, Number(term)).catch(logger.error),
    _getEmailStatus(authorizationHeader, locale, realm, Number(term)).catch(
      logger.error
    )
  ]);

  if (!dbOccupants.length) {
    throw new ServiceError('tenant not found', 404);
  }
  const dbOccupant = dbOccupants[0];

  if (!dbOccupant.rents.length) {
    throw new ServiceError('rent not found', 404);
  }
  const rent = FD.toRentData(
    dbOccupant.rents[0],
    dbOccupant,
    emailStatus?.[dbOccupant._id]
  );
  if (rent.term === Number(moment().format('YYYYMMDDHH'))) {
    rent.active = 'active';
  }
  rent.vatRatio = dbOccupant.vatRatio;

  return rent;
}

export async function all(req, res) {
  const realm = req.realm;

  let currentDate = moment().startOf('month');
  if (req.params.year && req.params.month) {
    currentDate = moment(`${req.params.month}/${req.params.year}`, 'MM/YYYY');
  }

  res.json(
    await _getRentsDataByTerm(
      req.headers.authorization,
      req.headers['accept-language'],
      realm,
      currentDate,
      'months'
    )
  );
}
