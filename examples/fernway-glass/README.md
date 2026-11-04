# Fernway Glass: a second store on Refund Relay

A small glass shop, not Juniper Market, built only from the four setup steps on the Refund Relay
dashboard (`/dashboard`). It has its own PayPal button, its own checkout with shipping and tax, and
its own merchant account on Refund Relay.

| Dashboard step | Where it is here |
| --- | --- |
| 1. Connect your PayPal account | The PayPal app in `FERNWAY_PAYPAL_CLIENT_ID` / `_SECRET`, pasted on the dashboard |
| 2. Create a secret key | `REFUND_RELAY_KEY` |
| 3. Send each paid order | `registerWithRefundRelay()` in `server.js`, called right after the capture |
| 4. Show buyers the button | The `relay.js` tag on `/orders/:id`, the confirmation page |

## Run it

```sh
REFUND_RELAY_URL=https://refund-relay.onrender.com REFUND_RELAY_KEY=rr_sk_test_... \
FERNWAY_PAYPAL_CLIENT_ID=... FERNWAY_PAYPAL_CLIENT_SECRET=... node examples/fernway-glass/server.js
# open http://localhost:8898
```

The whole run, from dashboard sign-up to a PayPal refund, is scripted:

```sh
node --env-file=.env scripts/e2e-fernway.js     # APP_BASE_URL defaults to the live site
```

## Live run, 2026-11-04, against https://refund-relay.onrender.com

Real PayPal sandbox, real photo check. Screenshots in `screenshots/`.

1. Signed up as Fernway Glass, connected the PayPal app (PayPal accepted it), created a key.
2. Bought 2 vases with the PayPal button: $76.00 items + $6.50 shipping + $6.08 tax = $88.58.
   `POST /v1/orders` verified it against PayPal and returned the claim link.
3. The confirmation page showed the Report a problem button. The claim page opened branded
   Fernway Glass, with the order total and both vases.
4. The buyer reported 1 cracked vase with a photo. The photo check found a crack (90%) and the
   same kind of product. The policy drafted $38.00 and left it to the shop because the same demo
   photo had been used on another request.
5. Fernway approved in its own console. PayPal refund `2E206081XK564404U`, $38.00, COMPLETED
   (confirmed with PayPal's refunds API). $50.58 stays refundable. The dashboard shows 4 of 4 done.

## Things to know

- Don't give any element `id="paypal"`. The browser makes it a `window.paypal` global, and the
  PayPal JS SDK then fails with `Cannot read properties of undefined (reading 'startsWith')`.
- Only one PayPal sandbox app exists in this project, so this run connected the same app the demo
  store uses. Each Refund Relay store can connect a PayPal app only once, so on the live site that
  app now belongs to Fernway Glass. Testing with a fully separate PayPal account needs a second
  sandbox business account and app from developer.paypal.com.
