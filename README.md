# GameHub backend

A small Express + SQLite API that implements exactly the two calls your
`gamehub.html` page already makes:

- `POST /api/auth/signup` — `{ name, email, password }` → `{ token, user }`
- `POST /api/auth/login` — `{ email, password }` → `{ token, user }`

Errors come back as `{ error: "message" }`, which is what the page's
`ghAuthRequest()` helper expects.

## 1. Run it locally

```bash
npm install
cp .env.example .env
# open .env and set JWT_SECRET (see the comment in the file for how to generate one)
npm start
```

The server starts on `http://localhost:4000`, matching the
`window.GH_API_BASE = "http://localhost:4000/api"` line already in your HTML
file — so locally, no changes are needed. Open the HTML file in a browser and
try signing up.

## 2. Go live

Everything's already wired for this: `frontend/index.html` is your site with
the checkout script included, and `render.yaml` describes both services so
Render can deploy them together.

### Fastest path — Render Blueprint (recommended)

1. Push this whole `gamehub-backend/` folder to a new GitHub repo (`render.yaml`
   needs to be at the repo root — it already is).
2. In the [Render Dashboard](https://dashboard.render.com): **New → Blueprint**,
   connect the repo. Render reads `render.yaml` and shows you two services:
   `gamehub-api` (the backend) and `gamehub-site` (the static frontend).
3. Click **Deploy Blueprint**. You'll be prompted for the env vars marked
   `sync: false` in `render.yaml` — for now just enter your Razorpay **test**
   keys and leave `ALLOWED_ORIGINS` blank; you'll fill in real values in step 5.
4. Once both are live, you'll have two URLs, e.g.
   `https://gamehub-api.onrender.com` and `https://gamehub-site.onrender.com`.
5. Open `frontend/index.html`, update the `GH_API_BASE` line to your API's
   URL (`https://gamehub-api.onrender.com/api`), commit and push — Render
   redeploys the site automatically. Then in the `gamehub-api` service's
   **Environment** tab on Render, set `ALLOWED_ORIGINS` to your site's URL.
6. Test the whole flow on the live site: sign up, add to cart, and pay with
   a [Razorpay test card](https://razorpay.com/docs/payments/payments/test-card-details/).

**Important — SQLite on Render's free plan:** the `users`/`orders` database
is a file on disk (`gamehub.db`). Render's **free** web services don't keep a
persistent disk, so that file resets on every redeploy or restart. That's
fine for testing the flow end-to-end, but before you rely on this for real
signups, either (a) upgrade `gamehub-api` to a paid plan and attach a Render
Disk (Dashboard → service → Disks), or (b) move to a hosted database — ask
me and I'll switch `db.js` over to Render's free Postgres instead of SQLite.

### Custom domain

Once you're happy with the `.onrender.com` URLs: in each service's Render
settings → **Custom Domains**, add your domain (e.g. `www.yourdomain.com`
for the site, `api.yourdomain.com` for the API) and add the `CNAME` record
it gives you at your registrar (Namecheap, GoDaddy, Cloudflare, etc.). Render
issues free HTTPS certificates automatically. Then repeat step 5 above with
your real domain instead of the `.onrender.com` one.

### Other ways to host it

If you'd rather not use Render, the same two pieces (API + static site) can
go anywhere:

### Option A — simplest: a platform that runs Node for you

Services like Render, Railway, or Fly.io will build and run this folder
with almost no config:

1. Push this folder to a GitHub repo.
2. Create a new "Web Service" (Render) or project (Railway/Fly) and point it
   at the repo.
3. Set the start command to `npm start` and add the environment variables
   from `.env.example` (`JWT_SECRET`, `ALLOWED_ORIGINS`) in the platform's
   dashboard — don't upload your `.env` file itself.
4. Once deployed you'll get a URL like `https://gamehub-api.onrender.com`.
5. In the platform's settings, add your **custom domain** (e.g.
   `api.yourdomain.com`) and follow their instructions to add a `CNAME`
   record at your domain registrar (Namecheap, GoDaddy, Cloudflare, etc.)
   pointing at the URL they give you. They'll issue an HTTPS certificate
   automatically.

Note: SQLite (`gamehub.db`) writes to local disk. That's fine on a
single-instance app, but most of these platforms wipe the disk on redeploy
unless you attach a persistent volume (Render and Fly both offer this) —
add one if you don't want users list to reset on every deploy. If you'd
rather not deal with that, swap `db.js` for a hosted Postgres database
(Render, Railway, and Neon all offer a free Postgres instance) — ask me and
I can rewrite `db.js`/`server.js` for Postgres.

### Option B — your own VPS (DigitalOcean, Hetzner, EC2, etc.)

1. `git clone` this project onto the server, `npm install`, create `.env`.
2. Run it with a process manager so it survives reboots/crashes:
   ```bash
   npm install -g pm2
   pm2 start server.js --name gamehub-api
   pm2 save && pm2 startup
   ```
3. Put Nginx in front of it as a reverse proxy so you can attach a domain
   and free HTTPS via Let's Encrypt (`certbot`):
   ```nginx
   server {
       server_name api.yourdomain.com;
       location / {
           proxy_pass http://localhost:4000;
           proxy_set_header Host $host;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       }
   }
   ```
   Then: `sudo certbot --nginx -d api.yourdomain.com`.
4. At your domain registrar, add an `A` record for `api.yourdomain.com`
   pointing at the server's IP address.

### Hosting the static HTML file itself

Your `gamehub.html` file is static — it doesn't need Node. Cheapest/easiest
options: Netlify, Vercel, Cloudflare Pages, or GitHub Pages. Drop the file
in (rename to `index.html`), connect your domain (e.g. `www.yourdomain.com`)
by adding the `CNAME`/`A` records they specify, and you're done.

### 3. Point the site at the live API

Already covered in step 5 of the Blueprint path above — just remember: every
time your API's URL changes (new host, new domain), update the
`GH_API_BASE` line in `frontend/index.html` and the `ALLOWED_ORIGINS` env var
on the API to match.

## 3. Accept real payments (Razorpay)

The backend now has three payment routes:

- `POST /api/payments/create-order` — `{ amount }` (rupees) → creates a
  Razorpay order, returns `{ orderId, amount, currency, keyId }`
- `POST /api/payments/verify` — the three fields Razorpay's checkout popup
  returns after a successful payment → verifies the signature and marks the
  order paid
- `POST /api/payments/webhook` — Razorpay calls this directly from their
  servers as a backup, independent of the browser

### Get your keys

1. Sign up at [razorpay.com](https://razorpay.com) (Indian business/PAN
   required to fully activate — you can start building with **Test Mode**
   before that's done).
2. Dashboard → **Settings → API Keys** → generate keys. Put the Test Mode
   ones (`rzp_test_...`) in your `.env` as `RAZORPAY_KEY_ID` /
   `RAZORPAY_KEY_SECRET` while developing.
3. Test Mode uses [test card numbers](https://razorpay.com/docs/payments/payments/test-card-details/)
   — no real money moves. Switch to the Live Mode keys only once your
   account is fully activated (KYC approved) and you're ready to charge
   real customers.
4. Optional but recommended for production: Dashboard → **Settings →
   Webhooks** → add `https://api.yourdomain.com/api/payments/webhook`,
   choose the `payment.captured` event, and put the secret it gives you in
   `RAZORPAY_WEBHOOK_SECRET`.

### Wire up the frontend

`frontend/index.html` already includes `frontend/gamehub-checkout.js` via a
`<script src="./gamehub-checkout.js"></script>` tag, right after the
`GH_API_BASE` script — nothing to add if you deploy that folder as-is.

It does two things:

1. Exposes `window.startGameHubCheckout(amountRupees, { name, email })`,
   which opens the real Razorpay payment popup and verifies payment with
   your backend when it succeeds.
2. Tries to auto-wire itself to your existing "CHECKOUT • ₹…" cart button,
   which currently just shows a demo `alert()`. It does this by intercepting
   the click before React's own handler and reading the amount straight off
   the button's text — a working stopgap, but a bit fragile since it matches
   on text rather than the button's own click handler. Since that button
   lives inside a compiled/minified bundle, the more robust fix is to call
   `startGameHubCheckout()` directly from your original (uncompiled) source
   for that button, if you have it — I'm happy to wire that up properly if
   you share it.

### Go live checklist

- [ ] Razorpay account KYC approved, switched to Live Mode keys
- [ ] `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` set to `rzp_live_...` values on your host
- [ ] `ALLOWED_ORIGINS` set to your real domain (not empty/`*`)
- [ ] Webhook URL added in the Razorpay dashboard, `RAZORPAY_WEBHOOK_SECRET` set
- [ ] Site served over HTTPS (required for Razorpay checkout)

## Files

- `server.js` — the Express app: auth routes and Razorpay payment routes
- `db.js` — SQLite table setup (`users`, `orders`)
- `render.yaml` — one-click Blueprint deploying both services on Render
- `frontend/index.html` — your site, ready to deploy, with the checkout script included
- `frontend/gamehub-checkout.js` — real Razorpay checkout wired to the backend
- `.env.example` — required environment variables (copy to `.env`)
- `.gitignore` — keeps `.env`, `node_modules`, and the database file out of git
