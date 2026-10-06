import * as Express from 'express';
import { Collections, logger, ServiceError } from '@microrealestate/common';
import {
  CollectionTypes,
  MongooseDocument,
  TenantAPI,
  UserServicePrincipal
} from '@microrealestate/types';
import moment from 'moment';

type MpesaInfo = NonNullable<TenantAPI.TenantDataType['landlord']['mpesa']>;

/**
 * Matches a contact email exactly, whatever the case. The email used to be
 * turned into a regular expression as is, so a tenant signed in with
 * "ann@example.com" also received the leases of "joann@example.com".
 */
function _emailFilter(email: string) {
  const escaped = email.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { $regex: new RegExp(`^\\s*${escaped}\\s*$`, 'i') };
}

function _realmIdOf(tenant: CollectionTypes.Tenant) {
  const realm = tenant.realmId as CollectionTypes.Realm | string;
  return String(typeof realm === 'string' ? realm : realm?._id);
}

/** What tenants need to pay by M-Pesa, by organization id. */
async function _findMpesaInfo(tenants: CollectionTypes.Tenant[]) {
  const mpesaByRealm = new Map<string, MpesaInfo>();
  const realmIds = [...new Set(tenants.map(_realmIdOf))];
  if (!realmIds.length) {
    return mpesaByRealm;
  }
  try {
    const configs = await Collections.MpesaConfig.find({
      realmId: { $in: realmIds },
      enabled: true
    }).lean();
    configs.forEach((config) => {
      if (config.shortCode) {
        mpesaByRealm.set(String(config.realmId), {
          shortCode: config.shortCode,
          shortCodeType: config.shortCodeType,
          testMode: config.environment !== 'production'
        });
      }
    });
  } catch (error) {
    // the lease must stay visible even if the payment details cannot be read
    logger.error(String(error));
  }
  return mpesaByRealm;
}

export async function getOneTenant(
  request: Express.Request,
  response: Express.Response
) {
  const req = request as TenantAPI.GetOneTenant.Request;
  const res = response as TenantAPI.GetOneTenant.Response;
  const email = (req.user as UserServicePrincipal).email;
  if (!email) {
    logger.error('missing email field');
    throw new ServiceError('unauthorized', 401);
  }
  const tenantId = req.params.tenantId;

  const dbTenant = await Collections.Tenant.findOne<
    MongooseDocument<CollectionTypes.Tenant>
  >({
    _id: tenantId,
    'contacts.email': _emailFilter(email)
  }).populate<{
    realmId: CollectionTypes.Realm;
    leaseId: CollectionTypes.Lease;
  }>(['realmId', 'leaseId']);

  if (!dbTenant) {
    throw new ServiceError('tenant not found', 404);
  }

  const now = moment();
  const lastTerm = Number(now.format('YYYYMMDDHH'));

  const mpesaByRealm = await _findMpesaInfo([dbTenant]);

  res.json({
    results: [
      _toTenantResponse(
        dbTenant,
        lastTerm,
        mpesaByRealm.get(_realmIdOf(dbTenant))
      )
    ]
  });
}

export async function getAllTenants(
  request: Express.Request,
  response: Express.Response
) {
  const req = request as TenantAPI.GetAllTenants.Request;
  const res = response as TenantAPI.GetAllTenants.Response;
  const email = (req.user as UserServicePrincipal).email;
  if (!email) {
    logger.error('missing email field');
    throw new ServiceError('unauthorized', 401);
  }

  // find tenants from mongo which has a given email contact
  const dbTenants = await Collections.Tenant.find<
    MongooseDocument<CollectionTypes.Tenant>
  >({
    'contacts.email': _emailFilter(email)
  }).populate<{
    realmId: CollectionTypes.Realm;
    leaseId: CollectionTypes.Lease;
  }>(['realmId', 'leaseId']);

  // the last term considering the current date
  const lastTerm = Number(moment().format('YYYYMMDDHH'));

  const mpesaByRealm = await _findMpesaInfo(dbTenants);

  res.json({
    results: dbTenants.map((tenant) =>
      _toTenantResponse(tenant, lastTerm, mpesaByRealm.get(_realmIdOf(tenant)))
    )
  });
}

function _toTenantResponse(
  tenant: CollectionTypes.Tenant,
  lastTerm: number,
  mpesa?: MpesaInfo
): TenantAPI.TenantDataType {
  const now = moment();
  const firstRent = tenant.rents?.[0];
  const totalPreTaxAmount = firstRent?.total.preTaxAmount || 0;
  const totalChargesAmount = firstRent?.total.charges || 0;
  const totalVatAmount = firstRent?.total.vat || 0;
  const totalAmount = totalPreTaxAmount + totalChargesAmount + totalVatAmount;
  const { remainingIterations, remainingIterationsToPay } =
    _computeRemainingIterations(tenant, lastTerm, totalAmount);
  const landlord = tenant.realmId as CollectionTypes.Realm;
  const lease = tenant.leaseId as CollectionTypes.Lease;
  return {
    tenant: {
      id: tenant._id,
      name: tenant.name,
      reference: tenant.reference,
      contacts: tenant.contacts.map((contact) => ({
        name: contact.contact,
        email: contact.email,
        phone1: contact.phone
      })),
      addresses: [
        {
          street1: tenant.street1,
          street2: tenant.street2,
          zipCode: tenant.zipCode,
          city: tenant.city,
          state: '',
          country: ''
        }
      ]
    },
    landlord: {
      name: landlord.name,
      addresses: landlord.addresses,
      contacts: landlord.contacts,
      currency: landlord.currency,
      locale: landlord.locale,
      mpesa: mpesa || null
    },
    lease: {
      name: lease.name,
      beginDate: tenant.beginDate,
      endDate: tenant.endDate,
      terminationDate: tenant.terminationDate,
      timeRange: lease.timeRange,
      status: tenant.terminationDate
        ? 'terminated'
        : moment(tenant.endDate, 'YYYY-MM-DD').isBefore(now)
          ? 'ended'
          : 'active',
      rent: {
        totalPreTaxAmount,
        totalChargesAmount,
        totalVatAmount,
        totalAmount
      },
      remainingIterations,
      remainingIterationsToPay,
      properties:
        tenant.properties?.map((property) => ({
          id: property.property._id,
          name: property.property.name,
          description: property.property.description,
          type: property.property.type
        })) || [],
      documents: [],
      // tenant.leaseId.documents.map((document) => ({
      //   name: document.name,
      //   description: document.description,
      //   url: document.url,
      // })),
      invoices: tenant.rents
        ?.filter(({ term }) => term <= lastTerm)
        .sort((r1, r2) => r2.term - r1.term)
        .map((rent) => {
          return {
            id: `${tenant._id}-${rent.term}`,
            term: rent.term,
            balance: rent.total.balance,
            grandTotal: rent.total.grandTotal,
            payment: rent.total.payment || 0,
            methods: rent.payments
              .filter((payment) => !!payment)
              .map((payment) => payment.type),
            status:
              rent.total.grandTotal - (rent.total.payment || 0) <= 0
                ? 'paid'
                : rent.total.payment > 0
                  ? 'partially-paid'
                  : 'unpaid',
            payments:
              rent.payments.map((payment) => ({
                date: payment.date,
                method: payment.type,
                reference: payment.reference,
                amount: payment.amount || 0
              })) || []
          };
        }),
      balance: _computeBalance(tenant.rents, lastTerm),
      deposit: tenant.guaranty - tenant.guarantyPayback
    }
  };
}

function _computeRemainingIterations(
  tenant: CollectionTypes.Tenant,
  lastTerm: number,
  rentAmount: number
) {
  const timeRange = (tenant.leaseId as CollectionTypes.Lease).timeRange;
  const remainingIterations = Math.ceil(
    moment(tenant.terminationDate || tenant.endDate).diff(
      moment(lastTerm, 'YYYYMMDDHH').startOf(timeRange),
      timeRange,
      true
    )
  );

  let remainingIterationsToPay = remainingIterations;
  const balance = _computeBalance(tenant.rents, lastTerm);

  if (balance === 0) {
    remainingIterationsToPay -= 1;
  } else if (balance > 0) {
    const nbIterationWhereRentPaid = Math.abs(balance / rentAmount);
    remainingIterationsToPay -= Math.floor(nbIterationWhereRentPaid);
  }

  return {
    remainingIterations,
    remainingIterationsToPay
  };
}

function _computeBalance(rents: CollectionTypes.PartRent[], lastTerm: number) {
  // find the rent closest to the last term
  const rent = rents.reduce((prev, curr) => {
    if (curr.term <= lastTerm) {
      return curr;
    }

    return prev;
  });

  return -rent.total.grandTotal + rent.total.payment;
}
