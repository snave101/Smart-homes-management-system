# Installing the app on a phone or a computer

The landlord and the tenant applications can be installed like an app: an icon
on the home screen, opening full screen without the browser bars. Nothing is
downloaded from an app store, the app is installed from the browser.

There are two separate apps:

| App | Address | For |
| :-- | :-- | :-- |
| Landlord (blue icon) | `https://your-domain/landlord` | Landlords and their team |
| My rent (green icon) | `https://your-domain/tenant` | Tenants |

## Requirements

The application must be served over **https** on a public address (or opened on
`http://localhost` on the computer running it). Browsers refuse to install a
site served over plain http.

## How to install

**Android (Chrome)**

1. Open the address of the app in Chrome and sign in.
2. Tap the menu (three dots), then **Install app** (or **Add to Home screen**).
3. Confirm. The icon appears on the home screen.

**iPhone and iPad (Safari)**

1. Open the address of the app in Safari.
2. Tap the Share button, then **Add to Home Screen**.

**Computer (Chrome or Edge)**

1. Open the address of the app.
2. Click the install icon at the right of the address bar.

## What tenants see

After signing in with the email address the landlord recorded for them, tenants
see their lease, their rents and, when the landlord accepts M-Pesa payments
(see [MPESA.md](./MPESA.md)), a **Pay with M-Pesa** card with:

- the Paybill (or Till) number,
- their account number, which is their tenant reference,
- the amount currently due,

each with a button to copy the value. The payment itself is made from the
M-Pesa menu of the phone; once Safaricom confirms it, it shows in the list of
rents.

While the M-Pesa settings are on **Sandbox**, the card carries a red "Test
mode: do not send real money" warning, because a sandbox short code is not
yours.

## Good to know

- The app needs an Internet connection: rents and payments are always read
  from the server, nothing is kept on the phone. Without a connection an
  "offline" page is shown.
- Updating the server updates the app, there is nothing to reinstall.
- To change the name shown under the icon or its colours, edit
  `webapps/landlord/public/manifest.webmanifest` and
  `webapps/tenant/public/manifest.webmanifest`, and replace the images in the
  `public/icons` folders (192 and 512 pixels).
- Publishing on Google Play is possible later by wrapping the same addresses in
  a "Trusted Web Activity"; nothing here has to be redone for it.
