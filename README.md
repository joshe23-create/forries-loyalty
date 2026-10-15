# Forries Rewards: digital stamp-card loyalty app

Customers join by scanning a QR poster and get a loyalty card on their phone. There's no app store: it's a web app they can add to their home screen. Staff scan the card to add stamps, and a full card gives the customer a reward.

It runs entirely on **Firebase**:
- **Hosting:** serves the customer app (`/`) and the staff app (`/staff`).
- **Cloud Functions:** run the API, the daily birthday job and the campaign sender, in the Johannesburg region (`africa-south1`).
- **Firestore:** stores all the data.

**For customers (`/`)**
- Join in under a minute: name, email, optional mobile and birthday, and separate opt-ins for email and WhatsApp marketing (POPIA).
- A card with a QR code, a stamp card for each programme, and a celebration screen when they earn a reward.
- Rewards wallet with expiry dates, a "What's on" feed of specials and events, and their activity history.
- Passwordless sign-in on a new phone, using a 6-digit code sent by email (or WhatsApp).
- Profile, marketing preferences, and "delete my account and data".

**For staff (`/staff`)**
- Scan with the phone or tablet camera, or type the card code, phone number or email.
- Stamp any card (1 to 10 at a time) and redeem rewards. Mistakes can be undone within 15 minutes.
- Every action is logged with the staff member's name.

**For managers (also `/staff`)**
- **Dashboard:** members, new and active members, stamps, rewards redeemed and unclaimed rewards, a daily chart, top regulars, and CSV export.
- **Stamp cards:** create and edit them, set how long rewards stay valid, and switch cards on or off.
- **What's on:** post specials and events with start and end dates.
- **Messages:** send email campaigns, or WhatsApp campaigns using approved templates, to opted-in members only. You can target everyone, recent visitors, lapsed regulars or this month's birthdays.
- **Birthday reward:** issued automatically for the member's whole birthday month.
- **Team:** staff and manager accounts, plus a printable A4 sign-up poster with a QR code.

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
firebase.json            hosting rewrites (/api/**, /unsubscribe, /manifest.webmanifest → api function)
firestore.rules          deny all direct client access
firestore.indexes.json   composite index for member activity
functions/src/index.js   Cloud Functions: api (HTTP), birthdays (daily 08:00 SAST), sendCampaign (Firestore trigger)
functions/src/app.js     the Express API
functions/src/loyalty.js stamping, rewards, undo, birthdays (Firestore transactions)
functions/src/auth.js    member sessions + login codes, staff accounts
functions/src/notify.js  email (SMTP) and WhatsApp Cloud API
functions/src/db.js      Firestore setup and collection overview
public/                  customer PWA (index.html, member.js, sw.js) and staff app (staff.html, staff.js)
```
