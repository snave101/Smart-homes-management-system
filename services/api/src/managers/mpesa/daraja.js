/**
 * Thin client for the Safaricom Daraja API (C2B part only).
 * https://developer.safaricom.co.ke/APIs/CustomerToBusinessRegisterURL
 */
import axios from 'axios';
import { ServiceError } from '@microrealestate/common';

const BASE_URLS = {
  sandbox: 'https://sandbox.safaricom.co.ke',
  production: 'https://api.safaricom.co.ke'
};

const TIMEOUT_MS = 20000;

function describe(error) {
  const data = error?.response?.data;
  return (
    data?.errorMessage ||
    data?.error_description ||
    (error?.response ? `HTTP ${error.response.status}` : null) ||
    error?.code ||
    error?.message ||
    String(error)
  );
}

/** credentials: { environment, consumerKey, consumerSecret } */
async function getAccessToken(credentials) {
  try {
    const response = await axios.get(
      `${BASE_URLS[credentials.environment]}/oauth/v1/generate`,
      {
        params: { grant_type: 'client_credentials' },
        auth: {
          username: credentials.consumerKey,
          password: credentials.consumerSecret
        },
        timeout: TIMEOUT_MS
      }
    );
    if (!response.data?.access_token) {
      throw new Error('no access token returned');
    }
    return response.data.access_token;
  } catch (error) {
    throw new ServiceError(
      `Safaricom refused the consumer key and secret (${describe(error)})`,
      502
    );
  }
}

/**
 * Posts to the v2 endpoint and falls back to v1, which is the only one some
 * older apps are provisioned for.
 */
async function postC2B(credentials, operation, body) {
  const accessToken = await getAccessToken(credentials);
  const base = BASE_URLS[credentials.environment];
  let lastError;
  for (const version of ['v2', 'v1']) {
    try {
      const response = await axios.post(
        `${base}/mpesa/c2b/${version}/${operation}`,
        body,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: TIMEOUT_MS
        }
      );
      return response.data;
    } catch (error) {
      lastError = error;
      if (error?.response?.status !== 404) {
        break;
      }
    }
  }
  throw new ServiceError(`Safaricom error: ${describe(lastError)}`, 502);
}

export async function registerUrls(
  credentials,
  { shortCode, responseType, confirmationUrl, validationUrl }
) {
  return postC2B(credentials, 'registerurl', {
    ShortCode: shortCode,
    ResponseType: responseType,
    ConfirmationURL: confirmationUrl,
    ValidationURL: validationUrl
  });
}

/** Sandbox only: asks Safaricom to send a fake payment to the callbacks. */
export async function simulatePayment(
  credentials,
  { shortCode, shortCodeType, amount, msisdn, reference }
) {
  return postC2B(credentials, 'simulate', {
    ShortCode: shortCode,
    CommandID:
      shortCodeType === 'till'
        ? 'CustomerBuyGoodsOnline'
        : 'CustomerPayBillOnline',
    Amount: amount,
    Msisdn: msisdn,
    // Daraja expects no account number for Buy Goods
    BillRefNumber: shortCodeType === 'till' ? 'null' : reference
  });
}
