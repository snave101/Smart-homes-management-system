# M-Pesa payments (Safaricom Daraja C2B)

Tenants pay their rent to your **Paybill** (or Till) number from their phone.
Safaricom notifies MicroRealEstate of every payment and the payment is recorded
on the rent of the tenant, exactly as if you had typed it in the payment form.

```
tenant phone ──► M-Pesa ──► POST https://your-domain/api/v2/c2b/<token>/validation     (optional)
                        └─► POST https://your-domain/api/v2/c2b/<token>/confirmation
                                   │
                                   ├─ account number = a tenant reference ─► payment recorded on the rent
                                   └─ unknown account number ─────────────► kept "to allocate"
```

## What you need

| Requirement | Why |
| :-- | :-- |
| A Paybill or Till number | The short code tenants pay to |
| An app on the [Daraja portal](https://developer.safaricom.co.ke) with the _M-Pesa Sandbox_ / C2B product | Gives the **consumer key** and **consumer secret** |
| The application reachable on a public **https** address | Safaricom calls it for every payment. Start it with `APP_DOMAIN=rent.example.com APP_PROTOCOL=https` |
| The organization currency set to **KES** | M-Pesa amounts are Kenyan shillings; the integration refuses to start otherwise |

The address must not contain the words `mpesa`, `safaricom`, `exe`, `exec`,
`cmd`, `sql` or `query`: Safaricom refuses such URLs. The settings page warns
you when it does.

## Setting it up

1. Sign in as an administrator and open **Settings > M-Pesa**.
2. Fill in the short code, its type, the consumer key and the consumer secret.
   Keep **Sandbox** for the first tests.
3. Check the public address of the server, turn on _Record the M-Pesa payments
   on the rents_ and save.
4. Click **Register the addresses with Safaricom**. This calls the Daraja
   `registerurl` API with the two addresses shown on the page.
5. In sandbox, use **Send a test payment** with a tenant reference as account
   number. The payment shows up in the list within a few seconds and on the
   rent of the tenant.
6. When everything works, complete the Daraja "Go live" process, switch the
   environment to **Production**, enter the production key and secret, save and
   register the addresses again.

Good to know before going live:

- In production Safaricom usually accepts the registration of the addresses
  **once** per short code. To change them afterwards, ask
  `apisupport@safaricom.co.ke` to remove the existing ones.
- The **validation** request (which lets the server refuse a payment before it
  is completed) is only sent when _External Validation_ is activated on your
  short code; it is off by default and has to be requested from Safaricom.
  Without it every payment is accepted and only the confirmation is sent.
- Changing the short code, the environment or the public address requires a
  new registration; the page tells you when the registration is outdated.

## How a payment finds its tenant

The **account number** typed by the tenant is compared with the **tenant
reference** (tenant form > Billing), ignoring case, spaces and punctuation:
`a-12`, `A 12` and `A12` are the same account.

References are generated as 12 random characters. For M-Pesa give your tenants
something short they can type, for example the unit number (`A12`).

| Situation | Result |
| :-- | :-- |
| The reference matches one tenant | Recorded on the rent of the period the payment was made in, with the M-Pesa receipt as payment reference |
| The same reference is used by an ended lease and a running one | The running lease wins |
| Unknown reference, reference shared by several running leases, Till payment | Kept in the list as **To allocate**: pick the tenant and click _Record on the rent_ |
| Payment made before the lease starts / after it ended | Recorded on the first / last rent |
| The same confirmation is delivered twice | Counted once (the receipt number is unique) |
| A payment that is not a rent | _Ignore_ sets it aside |

A partial or excess payment needs nothing special: the balance of a rent is
carried over to the next ones, as for any other payment.

Payments recorded from M-Pesa are protected in the rent payment form: saving
the form does not remove them or change their amount. To move a payment to
another tenant or take it off a rent, use _Remove from the rent_ on the M-Pesa
page, then allocate it again.

With _Refuse the payments whose account number is not a tenant reference_ (and
External Validation activated by Safaricom) a tenant who mistypes the account
number is told immediately by M-Pesa and no money moves.

## Security

- Safaricom does not sign its callbacks. The two addresses contain a random
  48-character token generated for your organization: **treat them as a
  password**. Anyone who knows them could declare payments. The token is
  masked in the logs of the services.
- For defence in depth, restrict `/api/v2/c2b/*` to the Safaricom addresses at
  your firewall or reverse proxy. At the time of writing Safaricom publishes:
  `196.201.214.200`, `196.201.214.206`, `196.201.213.114`, `196.201.214.207`,
  `196.201.214.208`, `196.201.213.44`, `196.201.212.127`, `196.201.212.138`,
  `196.201.212.129`, `196.201.212.136`, `196.201.212.74`, `196.201.212.69`.
  Confirm the list with Safaricom before relying on it.
- The consumer secret is stored encrypted (`CIPHER_KEY` / `CIPHER_IV_KEY`) and
  is never sent back to the browser.
- Only administrators can read or change the configuration. Members with the
  renter role can see the payments and allocate them.

## Limits

- **Reconcile with your M-Pesa statement.** If the server is unreachable when
  Safaricom sends a confirmation and its retries are exhausted, the payment
  exists at M-Pesa but not here. Record it by hand in the payment form with the
  payment type _Mobile money (M-Pesa)_ and the receipt number as reference: if
  the confirmation arrives later it will not be counted a second time.
- This is C2B only: tenants initiate the payment from their phone. There is no
  STK push ("Lipa na M-Pesa Online") prompt and no refund (reversal) API.
- The `api` service must run as a single instance (the default): concurrent
  updates of a tenant are serialized inside the process.
- No receipt is emailed automatically; send receipts from the Rents page as
  usual.

## API

Authenticated like the rest of the landlord API (`/api/v2`, access token and
`organizationid` header):

| Method and path | Role | Purpose |
| :-- | :-- | :-- |
| `GET /mpesa/settings` | administrator | Current configuration (without the secret) |
| `PUT /mpesa/settings` | administrator | Save the configuration |
| `POST /mpesa/register` | administrator | Register the callback addresses at Safaricom |
| `POST /mpesa/simulate` | administrator | Sandbox only: `{ amount, reference }` |
| `GET /mpesa/transactions?status=&limit=` | any | Payments received and counts per status |
| `POST /mpesa/transactions/:id/allocate` | any | `{ tenantId, term? }` record (or move) on a rent |
| `POST /mpesa/transactions/:id/detach` | any | Remove from the rent |
| `POST /mpesa/transactions/:id/ignore` / `restore` | any | Set aside / bring back |

Called by Safaricom (no access token, the token of the URL is the secret):

| Method and path | Answer |
| :-- | :-- |
| `POST /c2b/:token/validation` | `{ "ResultCode": "0", "ResultDesc": "Accepted" }` or `C2B00012` (account), `C2B00013` (amount), `C2B00015` (short code), `C2B00016` (other) |
| `POST /c2b/:token/confirmation` | `{ "ResultCode": 0, "ResultDesc": "Success" }` |

To replay a confirmation by hand (use the confirmation address shown on the
settings page):

```shell
curl -X POST "https://rent.example.com/api/v2/c2b/<token>/confirmation" \
  -H 'Content-Type: application/json' \
  -d '{"TransactionType":"Pay Bill","TransID":"TEST000001","TransTime":"20260305143845","TransAmount":"15000.00","BusinessShortCode":"600638","BillRefNumber":"A12","MSISDN":"2547****149","FirstName":"Test"}'
```

## Code map

| File | Role |
| :-- | :-- |
| `services/api/src/managers/mpesa/core.js` | Pure rules: payload parsing, tenant matching, choice of the rent |
| `services/api/src/managers/mpesa/service.js` | Validation, confirmation, allocation |
| `services/api/src/managers/mpesa/store.js` | MongoDB access |
| `services/api/src/managers/mpesa/daraja.js` | Calls to the Daraja API |
| `services/api/src/managers/mpesa/index.js` | HTTP handlers and settings |
| `services/api/src/managers/tenantlock.js` | One rent update at a time per tenant |
| `services/common/src/collections/mpesa*.ts` | `MpesaConfig` and `MpesaTransaction` collections |
| `webapps/landlord/src/components/mpesa/` | Settings form and payments list |

Tests: `yarn workspace @microrealestate/api run test`.
