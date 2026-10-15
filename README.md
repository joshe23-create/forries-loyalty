# Forries Rewards: digital stamp-card loyalty app

Customers join by scanning a QR poster and get a loyalty card on their phone. There's no app store: it's a web app they can add to their home screen. Staff scan the card to add stamps, and a full card gives the customer a reward.

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
- **Stamp cards:** create and edit them (for example "9 coffees, 10th free"), set how long rewards stay valid, and switch cards on or off.
- **What's on:** post specials and events with start and end dates, plus an optional image.
- **Messages:** send email campaigns, or WhatsApp campaigns using approved templates, to opted-in members only. You can target everyone, recent visitors, lapsed regulars (60+ days) or this month's birthdays.
- **Birthday reward:** issued automatically for the member's whole birthday month, with an optional email or WhatsApp notification.
- **Team:** staff and manager accounts, plus a printable A4 sign-up poster with a QR code.

## Run it

```bash
npm install
cp .env.example .env       # for a quick try: set DEMO_MODE=true (login codes show on screen)
npm start                  # customers: http://localhost:3000   staff: http://localhost:3000/staff
```

The first visit to `/staff` creates the manager account. Two starter cards (Coffee and Pint, 9 stamps each) are set up automatically, and you can edit them.

## Going live

1. **Host it** on a small VPS (about R100/month) or any Node host. It needs HTTPS: the phone camera and "Add to Home Screen" only work over HTTPS. Caddy gives you HTTPS automatically:
   ```
   rewards.forries.co.za {
     reverse_proxy localhost:3000
   }
   ```
   You can also use Docker:
   `docker build -t forries-rewards . && docker run -d -p 3000:3000 --env-file .env -v rewards-data:/app/data forries-rewards`
2. **Set `.env`:**
   - `PUBLIC_URL`
   - `APP_SECRET` (generate it with `openssl rand -hex 32`)
   - `COOKIE_SECURE=true`
   - `DEMO_MODE=false`
   - your SMTP details
   - `PRIVACY_URL`
3. **Email.** It's required, because sign-in codes go by email. Any SMTP account works. For good deliverability, use a transactional service with a free tier, such as Brevo (300/day), and set up SPF/DKIM for your domain.
4. **Back up `data/`.** The whole database is a single SQLite file.
5. **Print the poster** from Team & settings and put it on tables and the bar.

## WhatsApp (optional)

You'll need a Meta WhatsApp Cloud API number. Set `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID`, then create these templates in WhatsApp Manager:

| Template | Category | Used for |
|---|---|---|
| `WHATSAPP_OTP_TEMPLATE` | Authentication (copy-code button) | Sign-in codes for members |
| `WHATSAPP_BIRTHDAY_TEMPLATE` | Marketing, `{{1}}` = first name | Birthday notification |
| any name you choose | Marketing | Campaigns from the Messages tab |

Meta charges per marketing or authentication message in South Africa. Check the current rates in WhatsApp Manager.

## POPIA notes

- Marketing needs an explicit opt-in for each channel, and it's never pre-ticked.
- Every campaign email has an unsubscribe link and a one-click `List-Unsubscribe` header.
- Members can change their preferences or delete their account themselves.
- Only managers can export member data.
- Add a privacy policy (`PRIVACY_URL`) that names your Information Officer.

## Fraud controls

- Only staff can add stamps.
- Each scan is capped (`MAX_STAMPS_PER_SCAN`).
- Every stamp and redemption is logged with the staff member.
- Undo is limited to 15 minutes and blocked once the reward has been used.
- A member can set their birthday only once, so they can't change it to collect extra birthday rewards.

## Layout

```
src/server.js     routes: member API (/api/m), staff API (/api/s), poster, unsubscribe
src/loyalty.js    stamping, rewards, undo, birthday job
src/auth.js       member sessions + login codes, staff accounts
src/notify.js     email (SMTP) and WhatsApp Cloud API
src/db.js         SQLite schema
public/           customer PWA (index.html, member.js, sw.js) and staff app (staff.html, staff.js)
```
