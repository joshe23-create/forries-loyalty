# Forries Rewards: digital stamp-card loyalty app

Customers join by scanning a QR poster and get a loyalty card on their phone. There's no app store: it's a web app they can add to their home screen. Staff scan the card to add stamps, and a full card gives the customer a reward.

It runs entirely on **Firebase**:
- **Hosting:** serves the customer app (`/`) and the staff app (`/staff`).
- **Cloud Functions:** run the API, the daily birthday job and the campaign sender, in the Johannesburg region (`africa-south1`).
- **Firestore:** stores all the data.

**For customers (`/`)**
- Join in under a minute: first name, surname, mobile/WhatsApp number and email are required; birthday is optional. Separate opt-ins for email and WhatsApp marketing (POPIA), plus an 18+ and terms confirmation that's recorded with the terms version.
- A **live card QR** that changes every 30 seconds. It's generated on the phone, so it works offline. Staff scans check it with the server, so a screenshot of someone else's card stops working within about 2 minutes.
- A stamp card for each programme, and a celebration screen when they earn a reward.
- **Push notifications** (optional, per phone): "+1 stamp", "You earned a reward", birthday treats, and specials if they opt in. On iPhone, push works once the app is added to the Home Screen (iOS 16.4+).
- **Apple Wallet and Google Wallet cards** (once set up, see below).
- Rewards wallet with expiry dates, a "What's on" feed of specials and events, and their activity history.
- Passwordless sign-in on a new phone, using a 6-digit code sent by email (or WhatsApp).
- Profile, marketing preferences, and "delete my account and data".

**For staff (`/staff`)**
- Scan with the phone or tablet camera, or type the card code, phone number or email.
- Stamp any card (1 to 10 at a time) and redeem rewards. Mistakes can be undone within 15 minutes.
- Every action is logged with the staff member's name.
- **Bill verification:** staff must enter the till slip number to stamp. Each bill can be used for one member, once per card.
- **One stamp per card per visit:** after a stamp, that card is locked for a set time (default 3 hours). Staff can add 1 stamp per scan, and there's a daily limit per card. Managers can override all of these.
- Staff can't stamp their own card.

**For managers (also `/staff`)**
- **Dashboard:** members, new and active members, stamps, rewards redeemed and unclaimed rewards, a daily chart, top regulars, and CSV export.
- **Stamp cards:** create and edit them, set how long rewards stay valid, and switch cards on or off.
- **What's on:** post specials and events with start and end dates.
- **Messages:** send email campaigns, free **push notifications**, or WhatsApp campaigns using approved templates, to opted-in members only. You can target everyone, recent visitors, lapsed regulars or this month's birthdays.
- **Birthday reward:** issued automatically for the member's whole birthday month.
- **Team:** staff and manager accounts, plus a printable A4 sign-up poster with a QR code.
- **Integrity:**
  - **Weekly spot checks:** 5 random bills to look up on the till, marked ✓ or ✗.
  - **Staff scorecards:** stamps, new regulars, checks passed or failed, undos, after-hours stamps.
  - **Warning signs:** after-hours stamps, high undo rates, stamps concentrated on a few members, failed checks.
  - **Bills export:** CSV of every stamped bill.
- **Staff bonus:** a staff member is marked bonus-eligible each month when they meet your spot-check and new-regular targets with no failed checks. A "new regular" is a customer they gave a first stamp to who came back on another day.
- **Stamp rules:** set the bill requirement, visit hours, limits, trading hours and bonus targets in Team & settings.
- **Reward rules:** one reward per visit, and **no-reward days** (e.g. big rugby days) that you set in Team & settings. Members see them in the app; stamps still count; rewards expiring on those days stay valid until the next day.
- **Terms & Privacy:** `/terms` (Terms & Conditions + POPIA Privacy Notice). Till-slip records are deleted after 12 months by the daily job.

## One-time Firebase setup (in the console)

Project: **forries-2815d**

1. **Upgrade to the Blaze plan** (⚙ → Usage and billing). Cloud Functions requires it. A pub-sized programme stays well inside the free monthly allowance, so expect R0 or close to it. Set a **budget alert** (for example R100) so you're never surprised.
2. **Create the Firestore database:** Build → Firestore Database → Create database.
   - Location: **africa-south1 (Johannesburg)**. This can't be changed later, and it keeps member data in South Africa.
   - Start in **production mode**. The app's security rules block all direct access anyway; everything goes through the API.

## Deploy (from your computer)

You need [Node.js 22](https://nodejs.org) installed.

```bash
npm install -g firebase-tools
firebase login
git clone https://github.com/joshe23-create/forries-loyalty.git
cd forries-loyalty/functions
npm install
cp .env.example .env        # then fill it in (see below)
cd ..
firebase deploy
```

The first deploy takes a few minutes, and Firebase may ask you to enable some Google Cloud APIs: say yes. If it asks about an Artifact Registry clean-up policy, accept the default.

When it's done, the app is live at **https://forries-2815d.web.app**. Open `/staff` there to create the manager account.

### What goes in `functions/.env`

| Setting | What to put |
|---|---|
| `PUBLIC_URL` | `https://forries-2815d.web.app`, or your custom domain once it's connected |
| `APP_SECRET` | A long random string (`openssl rand -hex 32`, or mash the keyboard for 40+ characters) |
| `SMTP_*`, `MAIL_FROM` | Email account details. **Required:** members sign in on new phones with emailed codes. Brevo's free plan (300 emails a day) works well. |
| `PRIVACY_URL` | Your privacy policy page |
| `WHATSAPP_*` | Optional, see below |

Keep `DEMO_MODE=false`. `functions/.env` is never committed to GitHub.

### Custom domain

Go to Hosting → **Add custom domain** → `rewards.forries.co.za`, and add the DNS records it shows at your domain provider. Then set `PUBLIC_URL` to `https://rewards.forries.co.za` and run `firebase deploy` again.

### Optional: automatic deploys from GitHub

`.github/workflows/deploy.yml` redeploys the app whenever `main` changes. It does nothing until you add two repository secrets (GitHub → Settings → Secrets and variables → Actions):

- **`FIREBASE_SERVICE_ACCOUNT`:** a JSON key for a Google Cloud service account. Create one in Google Cloud Console → IAM → Service accounts, give it these roles, then add a JSON key:
  - Firebase Admin
  - Cloud Functions Admin
  - Cloud Scheduler Admin
  - Service Account User
  - Artifact Registry Administrator
- **`FUNCTIONS_ENV`:** the full contents of your `functions/.env`.

## Trying it locally

```bash
cd functions && npm install && cd ..
printf 'DEMO_MODE=true\nCOOKIE_SECURE=false\n' > functions/.env.local   # login codes shown on screen
firebase emulators:start --only functions,firestore,hosting
```

Then open http://127.0.0.1:5000 for the customer app and http://127.0.0.1:5000/staff for staff.

## Wallet cards (optional)

Both wallet cards stay hidden in the app until their settings are added to `functions/.env` (or the `FUNCTIONS_ENV` GitHub secret).

**Google Wallet.** The card shows the same rotating QR as the app, so staff scan it as normal.

1. Create an issuer account at https://pay.google.com/business/console, under **Google Wallet API**. Note the **Issuer ID**.
2. In Google Cloud (project `forries-2815d`), enable the **Google Wallet API**. Create a service account (for example `wallet`) and download a **JSON key**.
3. In the Wallet console, go to **Users** and add the service account's email as a **Developer**.
4. Set `GOOGLE_WALLET_ISSUER_ID=…` and `GOOGLE_WALLET_SA_KEY=<the JSON key, base64-encoded>` (`base64 -w0 key.json`).
5. While Google reviews your account, only the test users you add in the console can save cards. Then request **publishing access**.

**Apple Wallet.** Apple Wallet barcodes can't change, so this card has no barcode. It shows the member's stamps and rewards, updates itself (with a lock-screen message) when they're stamped, pops up near the pub, and links to the live card for scanning.

1. Join the Apple Developer Program ($99/year).
2. Go to Certificates, Identifiers & Profiles. Under **Identifiers**, add a **Pass Type ID** such as `pass.za.co.forries.rewards`.
3. Create a **Pass Type ID certificate** for it, open it in Keychain Access and export it as a `.p12` with a password.
4. Download Apple's **WWDR G4** intermediate certificate (PEM).
5. Set these values:
   - `APPLE_PASS_TYPE_ID`
   - `APPLE_TEAM_ID`
   - `APPLE_PASS_P12=<base64 of the .p12>`
   - `APPLE_PASS_P12_PASSWORD`
   - `APPLE_WWDR_PEM=<base64 of the PEM>`
   - optional: `VENUE_LAT` and `VENUE_LNG`, so the card pops up near the pub

Note: `npm audit` reports `node-forge` (used to sign Apple passes). The advisory is about *verifying* RSA signatures, which this app never does; it only signs.

## WhatsApp (optional)

You'll need a Meta WhatsApp Cloud API number. Set `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID`, then create these templates in WhatsApp Manager:

| Template | Category | Used for |
|---|---|---|
| `WHATSAPP_OTP_TEMPLATE` | Authentication (copy-code button) | Sign-in codes for members |
| `WHATSAPP_BIRTHDAY_TEMPLATE` | Marketing, `{{1}}` = first name | Birthday notification |
| any name you choose | Marketing | Campaigns from the Messages tab |

Meta charges per marketing or authentication message.

## POPIA notes

- Marketing needs an explicit opt-in for each channel, and it's never pre-ticked.
- Every campaign email has an unsubscribe link and a one-click `List-Unsubscribe` header.
- Members can change their preferences or delete their account and data themselves.
- Data is stored in Johannesburg (`africa-south1`).
- Add a privacy policy (`PRIVACY_URL`) that names your Information Officer.

## Fraud controls

- Only staff can add stamps.
- Each scan is capped (`MAX_STAMPS_PER_SCAN`).
- Every stamp and redemption is logged with the staff member.
- Undo is limited to 15 minutes, works newest-first, and is blocked once the reward has been used.
- A member can set their birthday only once.

## Layout

```
firebase.json            hosting rewrites (/api/**, /unsubscribe, /manifest.webmanifest → web relay → api)
firestore.rules          deny all direct client access
firestore.indexes.json   composite index for member activity
functions/src/index.js   Cloud Functions: api (HTTP, africa-south1), web (relay for Hosting, europe-west1),
                         birthdays (daily 08:00 SAST, europe-west1), sendCampaign (Firestore trigger)
functions/src/app.js     the Express API
functions/src/loyalty.js stamping, rewards, undo, birthdays (Firestore transactions)
functions/src/auth.js    member sessions + login codes, staff accounts
functions/src/notify.js  email (SMTP) and WhatsApp Cloud API
functions/src/db.js      Firestore setup and collection overview
public/                  customer PWA (index.html, member.js, sw.js) and staff app (staff.html, staff.js)
```
