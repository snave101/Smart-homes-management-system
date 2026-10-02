import * as Contract from '../contract.js';
import * as Daraja from './daraja.js';
import { buildCallbackUrls, findCallbackUrlIssues } from './core.js';
import {
  Collections,
  Crypto,
  logger,
  ServiceError
} from '@microrealestate/common';
import { createMpesaService, MpesaError } from './service.js';
import crypto from 'crypto';
import { mongoStore } from './store.js';
import { withTenantLock } from '../tenantlock.js';

/** M-Pesa settles in Kenyan shillings only. */
const MPESA_CURRENCY = 'KES';
const ENVIRONMENTS = ['sandbox', 'production'];
const SHORTCODE_TYPES = ['paybill', 'till'];
const RESPONSE_TYPES = ['Completed', 'Cancelled'];
const STATUSES = ['received', 'matched', 'unmatched', 'ignored'];
const TOKEN_PATTERN = /^[a-f0-9]{48}$/;
const MAX_TRANSACTIONS = 500;

const service = createMpesaService({
  store: mongoStore,
  payTerm: Contract.payTerm,
  withLock: withTenantLock,
  logger
});

/** Maps the errors of the service onto the HTTP errors of the api. */
async function run(task) {
  try {
    return await task();
  } catch (error) {
    if (error instanceof MpesaError) {
      throw new ServiceError(error.message, error.statusCode);
    }
    throw error;
  }
}

function newCallbackToken() {
  // hex only: Daraja refuses URLs containing words such as "exe" or "cmd"
  return crypto.randomBytes(24).toString('hex');
}

/** Settings as returned to the landlord UI: never carries the secret. */
function toSettings(config) {
  const environment = config?.environment || 'sandbox';
  const callbackBaseUrl = config?.callbackBaseUrl || '';
  const urls =
    config?.callbackToken && callbackBaseUrl
      ? buildCallbackUrls(callbackBaseUrl, config.callbackToken)
      : null;
  return {
    configured: !!config,
    enabled: !!config?.enabled,
    environment,
    shortCode: config?.shortCode || '',
    shortCodeType: config?.shortCodeType || 'paybill',
    consumerKey: config?.consumerKey || '',
    hasConsumerSecret: !!config?.consumerSecret,
    callbackBaseUrl,
    responseType: config?.responseType || 'Completed',
    rejectUnknownAccounts: !!config?.rejectUnknownAccounts,
    registeredAt: config?.registeredAt || null,
    validationUrl: urls?.validationUrl || null,
    confirmationUrl: urls?.confirmationUrl || null,
    urlIssues: callbackBaseUrl
      ? findCallbackUrlIssues(callbackBaseUrl, environment)
      : []
  };
}

function findConfig(realmId) {
  return Collections.MpesaConfig.findOne({ realmId }).lean();
}

function oneOf(value, allowed, field) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new ServiceError(`invalid ${field}`, 422);
  }
  return value;
}

function text(value, field, maxLength) {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new ServiceError(`invalid ${field}`, 422);
  }
  return value.trim();
}

/** Credentials ready to call Daraja, or a 422 naming what is missing. */
function requireCredentials(config) {
  if (
    !config?.shortCode ||
    !config.consumerKey ||
    !config.consumerSecret ||
    !config.callbackToken
  ) {
    throw new ServiceError(
      'save the short code, consumer key and consumer secret first',
      422
    );
  }
  return {
    environment: config.environment,
    consumerKey: config.consumerKey,
    consumerSecret: Crypto.decrypt(config.consumerSecret)
  };
}

////////////////////////////////////////////////////////////////////////////////
// Exported functions
////////////////////////////////////////////////////////////////////////////////
export async function getSettings(req, res) {
  res.json(toSettings(await findConfig(req.realm._id)));
}

export async function updateSettings(req, res) {
  const realm = req.realm;
  const body = req.body || {};
  const previous = await findConfig(realm._id);

  const next = {
    enabled: body.enabled === undefined ? !!previous?.enabled : !!body.enabled,
    environment:
      body.environment === undefined
        ? previous?.environment || 'sandbox'
        : oneOf(body.environment, ENVIRONMENTS, 'environment'),
    shortCode:
      body.shortCode === undefined
        ? previous?.shortCode || ''
        : text(body.shortCode, 'short code', 12),
    shortCodeType:
      body.shortCodeType === undefined
        ? previous?.shortCodeType || 'paybill'
        : oneOf(body.shortCodeType, SHORTCODE_TYPES, 'short code type'),
    consumerKey:
      body.consumerKey === undefined
        ? previous?.consumerKey || ''
        : text(body.consumerKey, 'consumer key', 256),
    callbackBaseUrl:
      body.callbackBaseUrl === undefined
        ? previous?.callbackBaseUrl || ''
        : text(body.callbackBaseUrl, 'public URL', 512).replace(/\/+$/, ''),
    responseType:
      body.responseType === undefined
        ? previous?.responseType || 'Completed'
        : oneOf(body.responseType, RESPONSE_TYPES, 'response type'),
    rejectUnknownAccounts:
      body.rejectUnknownAccounts === undefined
        ? !!previous?.rejectUnknownAccounts
        : !!body.rejectUnknownAccounts
  };

  if (next.shortCode && !/^\d{3,12}$/.test(next.shortCode)) {
    throw new ServiceError('the short code must be 3 to 12 digits', 422);
  }

  let consumerSecret = previous?.consumerSecret || '';
  if (body.consumerSecret !== undefined && body.consumerSecret !== '') {
    consumerSecret = Crypto.encrypt(
      text(body.consumerSecret, 'consumer secret', 256)
    );
  }

  if (
    next.callbackBaseUrl &&
    findCallbackUrlIssues(next.callbackBaseUrl, next.environment).includes(
      'not_a_url'
    )
  ) {
    throw new ServiceError('the public URL is not a valid URL', 422);
  }

  if (next.enabled) {
    if (realm.currency !== MPESA_CURRENCY) {
      throw new ServiceError(
        `M-Pesa payments are in ${MPESA_CURRENCY} but the organization currency is ${realm.currency}`,
        422
      );
    }
    if (
      !next.shortCode ||
      !next.consumerKey ||
      !consumerSecret ||
      !next.callbackBaseUrl
    ) {
      throw new ServiceError(
        'short code, consumer key, consumer secret and public URL are required',
        422
      );
    }
  }

  // whatever was registered at Safaricom no longer matches these settings
  const registrationOutdated =
    !!previous &&
    (previous.environment !== next.environment ||
      previous.shortCode !== next.shortCode ||
      previous.callbackBaseUrl !== next.callbackBaseUrl ||
      previous.responseType !== next.responseType);

  const saved = await Collections.MpesaConfig.findOneAndUpdate(
    { realmId: realm._id },
    {
      $set: {
        ...next,
        consumerSecret,
        ...(registrationOutdated ? { registeredAt: null } : {})
      },
      // realmId comes from the filter; the token never changes afterwards
      $setOnInsert: { callbackToken: newCallbackToken() }
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  res.json(toSettings(saved));
}

/** Tells Safaricom where to send the validation and confirmation requests. */
export async function registerUrls(req, res) {
  const realm = req.realm;
  const config = await findConfig(realm._id);
  const credentials = requireCredentials(config);

  if (!config.callbackBaseUrl) {
    throw new ServiceError('set the public URL of this server first', 422);
  }
  const urlIssues = findCallbackUrlIssues(
    config.callbackBaseUrl,
    config.environment
  );
  if (urlIssues.length) {
    throw new ServiceError(
      `Safaricom will not accept this public URL (${urlIssues.join(', ')})`,
      422
    );
  }

  const urls = buildCallbackUrls(config.callbackBaseUrl, config.callbackToken);
  await Daraja.registerUrls(credentials, {
    shortCode: config.shortCode,
    responseType: config.responseType,
    confirmationUrl: urls.confirmationUrl,
    validationUrl: urls.validationUrl
  });
  logger.info(`M-Pesa callback URLs registered for ${config.shortCode}`);

  const saved = await Collections.MpesaConfig.findOneAndUpdate(
    { realmId: realm._id },
    { $set: { registeredAt: new Date() } },
    { new: true }
  ).lean();
  res.json(toSettings(saved));
}

/** Sandbox only: triggers a fake payment to check the whole chain. */
export async function simulate(req, res) {
  const config = await findConfig(req.realm._id);
  const credentials = requireCredentials(config);
  if (config.environment !== 'sandbox') {
    throw new ServiceError('payments can only be simulated in sandbox', 422);
  }
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount < 1 || amount > 250000) {
    throw new ServiceError('invalid amount', 422);
  }
  const msisdn = text(req.body?.msisdn || '254708374149', 'phone number', 15);
  if (!/^254\d{9}$/.test(msisdn)) {
    throw new ServiceError('the phone number must look like 2547XXXXXXXX', 422);
  }

  await Daraja.simulatePayment(credentials, {
    shortCode: config.shortCode,
    shortCodeType: config.shortCodeType,
    amount: Math.round(amount),
    msisdn,
    reference: text(req.body?.reference || '', 'account number', 64)
  });
  res.json({ status: 'ok' });
}

function toTransactionData(transaction) {
  // eslint-disable-next-line no-unused-vars
  const { realmId, __v, ...data } = transaction;
  return { ...data, _id: String(transaction._id) };
}

export async function transactions(req, res) {
  const realmId = req.realm._id;
  const filter = { realmId };
  if (req.query.status !== undefined) {
    filter.status = oneOf(req.query.status, STATUSES, 'status');
  }
  const limit = Math.min(
    Math.max(Number(req.query.limit) || 100, 1),
    MAX_TRANSACTIONS
  );

  const [rows, grouped] = await Promise.all([
    Collections.MpesaTransaction.find(filter)
      .sort({ paidAt: -1, _id: -1 })
      .limit(limit)
      .lean(),
    Collections.MpesaTransaction.aggregate([
      { $match: { realmId } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ])
  ]);

  const counts = { received: 0, matched: 0, unmatched: 0, ignored: 0 };
  grouped.forEach(({ _id, count }) => {
    if (_id in counts) {
      counts[_id] = count;
    }
  });

  res.json({ transactions: rows.map(toTransactionData), counts });
}

export async function allocate(req, res) {
  const { tenantId, term } = req.body || {};
  if (typeof tenantId !== 'string' || !tenantId) {
    throw new ServiceError('missing tenant', 422);
  }
  const transaction = await run(() =>
    service.allocate(
      req.realm._id,
      req.params.id,
      tenantId,
      term === undefined || term === null || term === ''
        ? undefined
        : Number(term)
    )
  );
  res.json(toTransactionData(transaction));
}

export async function detach(req, res) {
  res.json(
    toTransactionData(
      await run(() => service.detach(req.realm._id, req.params.id))
    )
  );
}

export async function ignore(req, res) {
  res.json(
    toTransactionData(
      await run(() => service.setIgnored(req.realm._id, req.params.id, true))
    )
  );
}

export async function restore(req, res) {
  res.json(
    toTransactionData(
      await run(() => service.setIgnored(req.realm._id, req.params.id, false))
    )
  );
}

/**
 * The M-Pesa transactions recorded on a rent. The rent payment form uses it
 * to keep these payments whatever the form submits.
 */
export async function lockedPaymentsOf(realmId, tenantId, term) {
  return await Collections.MpesaTransaction.find(
    { realmId, tenantId: String(tenantId), term, status: 'matched' },
    { transId: 1, transTime: 1, amount: 1 }
  ).lean();
}

////////////////////////////////////////////////////////////////////////////////
// Callbacks called by Safaricom. They are not authenticated by an access
// token: the secret is the token embedded in the URL.
////////////////////////////////////////////////////////////////////////////////
async function findConfigByToken(token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    return null;
  }
  return await Collections.MpesaConfig.findOne({ callbackToken: token }).lean();
}

export async function validationCallback(req, res) {
  const config = await findConfigByToken(req.params.token);
  if (!config) {
    return res.sendStatus(404);
  }
  res.json(await service.validate(config, req.body));
}

export async function confirmationCallback(req, res) {
  const config = await findConfigByToken(req.params.token);
  if (!config) {
    return res.sendStatus(404);
  }
  res.json(await service.confirm(config, req.body));
}
