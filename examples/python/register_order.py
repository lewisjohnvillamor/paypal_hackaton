"""Send a captured PayPal order to Refund Relay and get the buyer's claim link.

    REFUND_RELAY_URL=http://localhost:8888 REFUND_RELAY_KEY=rr_sk_test_... \
    python examples/python/register_order.py 5O190127TN364715T

Call it from your own server right after your PayPal capture succeeds. Needs `requests`.
"""
import os
import sys

import requests

RELAY = os.environ.get("REFUND_RELAY_URL", "http://localhost:8888").rstrip("/")


def register_order(paypal_order_id, items):
    res = requests.post(
        f"{RELAY}/v1/orders",
        headers={"Authorization": f"Bearer {os.environ['REFUND_RELAY_KEY']}"},
        json={"paypal_order_id": paypal_order_id, "items": items},
        timeout=30,
    )
    if not res.ok:
        raise RuntimeError(res.json().get("message", res.text))
    return res.json()


if __name__ == "__main__":
    order = register_order(sys.argv[1], [{
        "sku": "MUG-01",
        "title": "Stoneware mug",
        "quantity": 2,
        "unit_price": "18.50",            # USD, as a string; must add up to the PayPal capture
        "category": "ceramic-mug",        # ceramic-mug, glass-vase, cotton-tee or headphones
        "image_url": "https://cdn.yourstore.com/mug.jpg",
    }])
    print(order["claim_url"])             # show it with relay.js, or email it to the buyer
