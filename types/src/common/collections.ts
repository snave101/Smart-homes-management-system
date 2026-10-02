import { LeaseTimeRange, Locale, PaymentMethod, UserRole } from './index.js';

export type MongooseDocument<T> = {
  __v: number;
  save: () => Promise<T>;
  toObject: () => T;
} & T;

/* eslint-disable @typescript-eslint/no-namespace */
export namespace CollectionTypes {
  export type PartAddress = {
    street1: string;
    street2?: string;
    zipCode: string;
    city: string;
    state?: string;
    country: string;
  };

  export type Account = {
    _id: string;
    firstname: string;
    lastname: string;
    email: string;
    password: string;
    createdDate?: Date;
  };

  export type Realm = {
    _id: string;
    name: string;
    members: {
      name: string;
      email: string;
      role: UserRole;
      registered: boolean;
    }[];
    applications: {
      name: string;
      role: UserRole;
      clientId: string;
      clientSecret: string;
      createdDate: Date;
      expiryDate: Date;
    }[];
    addresses: CollectionTypes.PartAddress[];
    bankInfo: {
      name: string;
      iban: string;
    };
    contacts: {
      name: string;
      email: string;
      phone1: string;
      phone2: string;
    }[];
    isCompany: boolean;
    companyInfo: {
      name: string;
      legalStructure: string;
      legalRepresentative: string;
      capital: number;
      ein: string;
      dos: string;
      vatnumber: string;
    };
    thirdParties: {
      gmail: {
        selected: boolean;
        email: string;
        appPassword: string;
        fromEmail: string;
        replyToEmail: string;
      };
      mailgun: {
        selected: boolean;
        apiKey: string;
        domain: string;
        fromEmail: string;
        replyToEmail: string;
      };
      b2: {
        keyId: string;
        applicationKey: string;
        endpoint: string;
        bucket: string;
      };
    };
    locale: Locale;
    currency: string;
  };

  export type Document = {
    _id: string;
    realmId: string;
    tenantId: string;
    leaseId: string;
    templateId: string;
    type: 'text' | 'file';
    name: string;
    description: string;
    mimeType?: string;
    expiryDate?: Date;
    contents?: Record<string, never>;
    html?: string;
    url?: string;
    versionId?: string;
    createdDate: Date;
    updatedDate: Date;
  };

  export type Email = {
    _id: string;
    templateName: string;
    recordId: string;
    params: Record<string, never>;
    sentTo: string;
    sentDate: Date;
    status: string;
    emailId: string;
  };

  export type Lease = {
    _id: string;
    realmId: string;
    name: string;
    description: string;
    numberOfTerms: number;
    timeRange: LeaseTimeRange;
    active: boolean;
    stepperMode: boolean;
  };

  export type Property = {
    _id: string;
    realmId: string;
    type: string;
    name: string;
    description: string;
    surface: number;
    phone: string;
    digicode: string;
    address: CollectionTypes.PartAddress;
    price: number;

    // TODO to remove, replaced by address
    building: string;
    level: string;
    location: string;
  };

  export type Template = {
    _id: string;
    realmId: string;
    name: string;
    type: string;
    description: string;
    hasExpiryDate: boolean;
    contents: Record<string, never>;
    html: string;
    linkedResourceIds: string[];
    required: boolean;
    requiredOnceContractTerminated: boolean;
  };

  export type PartRent = {
    term: number;
    total: {
      preTaxAmount: number;
      charges: number;
      vat: number;
      discount: number;
      debts: number;
      balance: number;
      grandTotal: number;
      payment: number;
    };
    preTaxAmounts:
      | {
          amount: number;
          description: string;
        }[]
      | [];
    charges:
      | {
          amount: number;
          description: string;
        }[]
      | [];
    debts:
      | {
          amount: number;
          description: string;
        }[]
      | [];
    discounts:
      | {
          origin: 'contract' | 'settlement';
          amount: number;
          description: string;
        }[]
      | [];
    vats:
      | {
          origin: 'contract' | 'settlement';
          amount: number;
          description: string;
          rate: number;
        }[]
      | [];
    payments:
      | {
          date: string;
          type: PaymentMethod;
          reference: string;
          amount: number;
        }[]
      | [];
    description: string;
  };

  export type Tenant = {
    _id: string;
    realmId: string | Realm;
    name: string;
    isCompany: boolean;
    company: string;
    manager: string;
    legalForm: string;
    siret: string;
    rcs: string;
    capital: number;
    street1: string;
    street2: string;
    zipCode: string;
    city: string;
    country: string;
    contacts: {
      contact: string;
      phone: string;
      email: string;
    }[];
    reference: string;
    contract: string;
    leaseId: string | Lease;
    beginDate: Date;
    endDate: Date;
    terminationDate: Date;
    properties:
      | {
          propertyId: string;
          property: CollectionTypes.Property;
          rent: number;
          expenses: [
            { title: string; amount: number; beginDate: Date; endDate: Date }
          ];
          entryDate: Date;
          exitDate: Date;
        }[]
      | [];
    rents: PartRent[] | [];
    isVat: boolean;
    vatRatio: number;
    discount: number;
    guaranty: number;
    guarantyPayback: number;

    stepperMode: boolean;
  };

  // M-Pesa (Safaricom Daraja) Customer-to-Business integration.
  // The configuration and the transactions live in their own collections:
  // the consumer secret and the callback token must never travel with the
  // organization payload.
  export type MpesaConfig = {
    _id: string;
    realmId: string;
    enabled: boolean;
    environment: 'sandbox' | 'production';
    shortCode: string;
    shortCodeType: 'paybill' | 'till';
    consumerKey: string;
    // encrypted at rest
    consumerSecret: string;
    // random secret embedded in the callback URLs
    callbackToken: string;
    // public origin Safaricom calls back, e.g. https://rent.example.com
    callbackBaseUrl: string;
    // what M-Pesa does when the validation URL cannot be reached
    responseType: 'Completed' | 'Cancelled';
    // reject at validation time the payments with an unknown account number
    rejectUnknownAccounts: boolean;
    registeredAt?: Date | null;
  };

  export type MpesaTransactionStatus =
    | 'received' // stored, not processed yet (transient)
    | 'matched' // recorded as a payment on a tenant rent
    | 'unmatched' // money received but no tenant could be determined
    | 'ignored'; // set aside by the landlord (not a rent payment)

  export type MpesaUnmatchedReason =
    | 'unknown_account'
    | 'ambiguous_account'
    | 'no_rent'
    | 'integration_disabled'
    | 'apply_failed'
    | 'detached';

  export type MpesaTransaction = {
    _id: string;
    realmId: string;
    // M-Pesa receipt number, unique per transaction
    transId: string;
    transactionType?: string;
    // raw Daraja timestamp YYYYMMDDHHmmss (East Africa Time)
    transTime: string;
    // same instant as a sortable string YYYY-MM-DDTHH:mm
    paidAt: string;
    amount: number;
    shortCode: string;
    // account number typed by the payer (empty for Buy Goods tills)
    billRefNumber: string;
    invoiceNumber?: string;
    // masked or hashed by Safaricom
    msisdn?: string;
    payerName?: string;
    status: MpesaTransactionStatus;
    reason?: MpesaUnmatchedReason | null;
    tenantId?: string | null;
    tenantName?: string | null;
    term?: number | null;
    matchedBy?: 'auto' | 'manual' | null;
  };
}
