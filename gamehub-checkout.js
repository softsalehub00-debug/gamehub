/**
 * gamehub-checkout.js
 *
 * Drop this in a <script> tag in gamehub.html, AFTER the existing
 * <script type="module"> block and after the small script that defines
 * window.GH_API_BASE / window.ghAuthRequest. It adds real Razorpay payments
 * on top of your existing backend's /api/payments/* routes.
 *
 * Usage from your own code / a custom button:
 *   window.startGameHubCheckout(99, { name: "Jane", email: "jane@x.com" });
 *
 * It also tries to auto-wire itself to the existing "CHECKOUT • ₹..."
 * button in the cart drawer, since that button currently just shows a demo
 * alert(). See the "AUTO-WIRE" section at the bottom — read the comment
 * there before relying on it, because the page's checkout button lives
 * inside a compiled/minified React bundle, so this uses a best-effort click
 * interceptor rather than editing that code directly.
 */

(function () {
  var RAZORPAY_SCRIPT_URL = "https://checkout.razorpay.com/v1/checkout.js";
  var scriptLoadPromise = null;

  function loadRazorpayScript() {
    if (scriptLoadPromise) return scriptLoadPromise;
    scriptLoadPromise = new Promise(function (resolve, reject) {
      if (window.Razorpay) return resolve();
      var s = document.createElement("script");
      s.src = RAZORPAY_SCRIPT_URL;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("Could not load Razorpay checkout script")); };
      document.head.appendChild(s);
    });
    return scriptLoadPromise;
  }

  /**
   * Kicks off a real payment for the given amount (in rupees).
   * customer is optional: { name, email, contact }
   * Returns a promise that resolves on successful, verified payment and
   * rejects (or the user just closes the modal) otherwise.
   */
  window.startGameHubCheckout = function (amountRupees, customer) {
    customer = customer || {};
    return loadRazorpayScript()
      .then(function () {
        return window.ghAuthRequest("/payments/create-order", {
          method: "POST",
          body: { amount: amountRupees },
        });
      })
      .then(function (order) {
        return new Promise(function (resolve, reject) {
          var options = {
            key: order.keyId,
            amount: order.amount,
            currency: order.currency,
            name: "GameHub",
            description: "GameHub purchase",
            order_id: order.orderId,
            prefill: {
              name: customer.name || "",
              email: customer.email || "",
              contact: customer.contact || "",
            },
            theme: { color: "#5ad1e6" },
            handler: function (response) {
              // response has razorpay_payment_id, razorpay_order_id, razorpay_signature
              window
                .ghAuthRequest("/payments/verify", {
                  method: "POST",
                  body: response,
                })
                .then(function (result) {
                  resolve(result);
                })
                .catch(reject);
            },
            modal: {
              ondismiss: function () {
                reject(new Error("Payment cancelled"));
              },
            },
          };

          var rzp = new window.Razorpay(options);
          rzp.on("payment.failed", function (resp) {
            reject(new Error((resp && resp.error && resp.error.description) || "Payment failed"));
          });
          rzp.open();
        });
      });
  };

  // --- AUTO-WIRE (best effort) -------------------------------------------
  // The existing checkout button's onClick currently does:
  //   alert("Checkout demo • ₹" + total)
  // That handler lives inside the minified React bundle, so it can't be
  // edited from a separate script — instead, this listens for the click in
  // the CAPTURE phase (before React sees it), stops it from reaching
  // React's handler, reads the ₹ amount straight off the button's own text,
  // and opens real Razorpay checkout instead.
  //
  // This is a reasonable stopgap, but it's matching on button text rather
  // than a stable id/class, so if you ever regenerate or restyle that
  // button, re-check this still matches. For anything beyond a quick launch,
  // it's more robust to wire startGameHubCheckout() directly into the
  // button's onClick in your original (uncompiled) component source.
  document.addEventListener(
    "click",
    function (e) {
      var el = e.target && e.target.closest && e.target.closest("button");
      if (!el) return;
      var text = (el.textContent || "").trim();
      var match = text.match(/CHECKOUT\s*•\s*₹\s*([\d,.]+)/i);
      if (!match) return;

      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();

      var amount = parseFloat(match[1].replace(/,/g, ""));
      if (!amount || amount <= 0) return;

      var user = null;
      try {
        var stored = window.__ghLoggedInUser;
        user = stored || null;
      } catch (err) {}

      window
        .startGameHubCheckout(amount, user ? { name: user.name, email: user.email } : {})
        .then(function () {
          alert("Payment successful! Thanks for your purchase.");
          // TODO: clear the cart / unlock content here, matching however
          // your app currently represents "purchased" state.
        })
        .catch(function (err) {
          if (err && err.message !== "Payment cancelled") {
            alert(err.message || "Payment could not be completed.");
          }
        });
    },
    true // capture phase — runs before React's own click handler
  );
})();
