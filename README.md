Replace the current coupon system with a simple Offer System similar to Zomato/Swiggy. Do not over-engineer it. Reuse as much of the existing coupon code, APIs, database structure, and UI components as possible.

## Offer Types

### 1. Free Product Offer

If cart/order value reaches a minimum amount, automatically add a free product.

Example:

* Order ₹500+ → Get 1 Coke free

Seller config:

* Minimum order amount
* Free product selection
* Free product quantity

### 2. Cart Value Discount Offer

Discount is applied when cart reaches a minimum amount.

Support:

* Flat discount percentage
* Tiered discounts

Examples:

* ₹500+ → 10% off
* ₹1000+ → 20% off

Tiered Example:

* ₹300+ → 5% off
* ₹500+ → 10% off
* ₹1000+ → 20% off

Discount should support:

* Entire cart
* Selected products only

For selected products, seller can choose one or more products from their catalog and discount will apply only to those products.

## Seller Panel

Replace "Coupons" with "Offers".

Create a clean, modern, mobile-friendly UI.

Offer creation should be simple:

Step 1:

* Select Offer Type

  * Free Product Offer
  * Cart Discount Offer

Step 2:

* Configure offer details based on selected type

Show a live preview card:

* "Spend ₹500 and get 1 Coke free"
* "Get 10% off above ₹500"
* "Get up to 20% off on selected products"

## Seller Guidance

Add a language toggle:

* हिन्दी (Default)
* English

Each field should have a short explanation/help text.

Hindi Example:
"ग्राहक ₹500 या उससे अधिक का ऑर्डर करेगा तो चुना गया मुफ्त उत्पाद अपने आप जुड़ जाएगा।"

English Example:
"When the customer places an order of ₹500 or more, the selected free product will be automatically added."

Keep explanations short and easy to understand.

## Customer Side

Offers should automatically apply when conditions are met.

Customers should clearly see:

* Offer name
* Discount amount
* Free product received
* Savings

No coupon codes required.

## Important

Keep the implementation simple and maintainable.

Avoid creating unnecessary offer types, complex rule engines, or excessive abstractions.

The system should focus only on:

1. Free Product Offers
2. Cart Value Discount Offers

while keeping the codebase clean and easy to extend later if needed.
