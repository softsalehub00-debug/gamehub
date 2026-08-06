// server.js — GameHub auth backend
//
// Implements exactly the two endpoints the GameHub frontend calls:
//   POST /api/auth/signup   { name, email, password } -> { token, user }
//   POST /api/auth/login    { email, password }        -> { token, user }
// On failure, responds with { error: "message" } and a 4xx status,
// which is exactly what the frontend's ghAuthRequest() expects.

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const Razorpay = require("razorpay");

const db = require("./db");

const app = express();

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!JWT_SECRET) {
  console.error(
    "Missing JWT_SECRET. Set it in your .env file before starting the server."
  );
  process.exit(1);
}

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET; // optional but recommended

let razorpay = null;
if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
} else {
  console.warn(
    "RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set — payment routes will return 500 until you add them to .env"
  );
}

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf; // needed to verify Razorpay webhook signatures
    },
  })
);

// CORS: only allow the site(s) that should be able to call this API.
// In development, ALLOWED_ORIGINS is usually empty, so we allow any origin.
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true); // curl/server-to-server
      if (ALLOWED_ORIGINS.length === 0) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
  })
);

// Basic rate limiting for auth endpoints to slow down brute force / spam signups.
const attempts = new Map(); // ip -> { count, resetAt }
function rateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 20;
  const record = attempts.get(ip);
  if (!record || now > record.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + windowMs });
    return next();
  }
  record.count += 1;
  if (record.count > maxRequests) {
    return res.status(429).json({ error: "Too many requests. Try again shortly." });
  }
  next();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function toPublicUser(row) {
  return { id: row.id, name: row.name, email: row.email };
}

function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: "7d" });
}

app.post("/api/auth/signup", rateLimit, async (req, res) => {
  try {
    const { name, email, password } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "Please fill in all fields" });
    }
    if (!email || !EMAIL_RE.test(String(email).trim())) {
      return res.status(400).json({ error: "Enter a valid email address" });
    }
    if (
      !password ||
      password.length < 8 ||
      !/[A-Za-z]/.test(password) ||
      !/[0-9]/.test(password)
    ) {
      return res
        .status(400)
        .json({ error: "Password must be 8+ characters with a letter and a number" });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const existing = db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(cleanEmail);
    if (existing) {
      return res.status(409).json({ error: "An account with that email already exists" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const id = crypto.randomUUID();

    db.prepare(
      "INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)"
    ).run(id, String(name).trim(), cleanEmail, passwordHash);

    const user = { id, name: String(name).trim(), email: cleanEmail };
    return res.status(201).json({ token: signToken(id), user });
  } catch (err) {
    console.error("signup error:", err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

app.post("/api/auth/login", rateLimit, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Please enter your email and password" });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const row = db.prepare("SELECT * FROM users WHERE email = ?").get(cleanEmail);
    if (!row) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    return res.json({ token: signToken(row.id), user: toPublicUser(row) });
  } catch (err) {
    console.error("login error:", err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// Optional: verify a token and return the current user. Handy for "stay logged in".
app.get("/api/auth/me", (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(payload.sub);
    if (!row) return res.status(401).json({ error: "Invalid token" });
    return res.json({ user: toPublicUser(row) });
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
});

// --- Payments (Razorpay) -----------------------------------------------

// 1. Frontend calls this first, with the cart total in rupees.
// Never trust an amount sent from the browser for anything you can compute
// yourself server-side — here we just accept it since GameHub's prices are
// fixed/public, but if you have per-item logic, recompute the total here
// from a trusted source (your product catalog) instead of req.body.amount.
app.post("/api/payments/create-order", rateLimit, async (req, res) => {
  if (!razorpay) {
    return res.status(500).json({ error: "Payments are not configured yet" });
  }
  try {
    const amountRupees = Number(req.body && req.body.amount);
    if (!amountRupees || amountRupees <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const amountPaise = Math.round(amountRupees * 100);
    const receipt = "gh_" + crypto.randomUUID().slice(0, 24);

    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt,
    });

    db.prepare(
      "INSERT INTO orders (id, razorpay_order_id, amount_paise, currency, status) VALUES (?, ?, ?, ?, 'created')"
    ).run(crypto.randomUUID(), order.id, amountPaise, "INR");

    // keyId is safe to expose to the browser — it's the public key.
    return res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error("create-order error:", err);
    return res.status(500).json({ error: "Could not start payment. Please try again." });
  }
});

// 2. After Razorpay's checkout popup succeeds, the frontend sends back the
// three fields it received so we can verify the payment is genuine before
// unlocking anything (this is the step that actually matters for security —
// never trust a bare "payment succeeded" message from the browser alone).
app.post("/api/payments/verify", rateLimit, (req, res) => {
  if (!RAZORPAY_KEY_SECRET) {
    return res.status(500).json({ error: "Payments are not configured yet" });
  }
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing payment details" });
    }

    const expected = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");

    if (expected !== razorpay_signature) {
      return res.status(400).json({ error: "Payment verification failed" });
    }

    db.prepare(
      "UPDATE orders SET status = 'paid', razorpay_payment_id = ?, updated_at = datetime('now') WHERE razorpay_order_id = ?"
    ).run(razorpay_payment_id, razorpay_order_id);

    // TODO: this is where you'd grant access / mark the user's purchase as
    // complete in your own data model.
    return res.json({ ok: true });
  } catch (err) {
    console.error("verify error:", err);
    return res.status(500).json({ error: "Could not verify payment" });
  }
});

// 3. Optional but recommended: Razorpay also calls this URL directly from
// their servers, independent of the browser, so a payment still gets
// recorded even if the customer closes the tab right after paying. Set this
// URL in your Razorpay dashboard under Settings -> Webhooks once you're
// live, using the same secret you put in RAZORPAY_WEBHOOK_SECRET.
app.post("/api/payments/webhook", (req, res) => {
  if (!RAZORPAY_WEBHOOK_SECRET) {
    return res.status(500).send("Webhook secret not configured");
  }
  try {
    const signature = req.headers["x-razorpay-signature"];
    const expected = crypto
      .createHmac("sha256", RAZORPAY_WEBHOOK_SECRET)
      .update(req.rawBody)
      .digest("hex");

    if (signature !== expected) {
      return res.status(400).send("Invalid signature");
    }

    const event = req.body;
    if (event.event === "payment.captured") {
      const orderId = event.payload.payment.entity.order_id;
      const paymentId = event.payload.payment.entity.id;
      db.prepare(
        "UPDATE orders SET status = 'paid', razorpay_payment_id = ?, updated_at = datetime('now') WHERE razorpay_order_id = ?"
      ).run(paymentId, orderId);
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("webhook error:", err);
    return res.status(500).send("Webhook error");
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`GameHub backend listening on port ${PORT}`);
});
