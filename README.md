# Viora API

## Configuration

Copy `.env.example` to `.env` and configure `MONGODB_URI`,
`ADMIN_USERNAME`, `ADMIN_PASSWORD`, and a randomly generated `SESSION_SECRET`
of at least 32 characters. Rotating the session secret invalidates all active
sessions. In production, set `FRONTEND_URL` to one or more comma-separated
HTTPS origins used by the dashboard.

The API uses an HttpOnly signed session cookie. The dashboard sends it using
credentialed requests; business API routes reject requests without a valid
session. Do not put backend credentials or the session secret in frontend
environment variables.

## Order number migration

Stop order creation (preferably stop the backend briefly) before assigning
numbers to legacy orders:

```sh
npm run backfill:orders
npm run verify:orders
```

The migration assigns numbers in creation order to orders that do not already
have one. Existing numbers are never changed. If the database has partially
numbered orders, missing orders receive numbers after the highest existing
number so no stable identifier is rewritten. New orders continue from the
persistent counter; deleting an order does not reuse its number.

The server also initializes/advances the counter before accepting requests.

## Campaign profitability

Products own their campaign references (`store|accountId|campaign`); this is
the single persisted side of the many-to-many relationship. Campaign detail
and product profitability resolve those references against Windsor advertising
rows. Campaign spend remains unchanged; product allocation is analytical,
split equally in cents among linked products. Product revenue and sold-unit
cost use the order-item snapshots, while delivery cost follows the existing
order allocation rule.

## Checks

```sh
npm test
npm run typecheck
```
