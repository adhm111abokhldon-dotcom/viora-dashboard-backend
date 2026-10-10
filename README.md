# Viora API

## Configuration

Copy `.env.example` to `.env` and configure `MONGODB_URI` and the Windsor
connector keys. In production, set `FRONTEND_URL` to one or more
comma-separated HTTPS origins used by the dashboard. The dashboard login is a
frontend-only navigation gate and does not authenticate or authorize API
requests. Protect the API and database using deployment/network controls.
Advertising data is limited to Viora's verified Windsor account; unknown
Windsor accounts are excluded rather than assigned to Viora.

## Business-number reset migration

Stop all application writes before resetting business numbers. The migration
reassigns every order and product number deterministically, so it must be run
only when the maintenance window is active:

```sh
npm run migrate:business-numbers -- --dry-run
npm run migrate:business-numbers -- --apply --confirm-reset
npm run migrate:business-numbers -- --verify
```

Destructive apply is restricted to loopback MongoDB hosts unless the operator
explicitly adds `--allow-remote-target` after verifying and authorizing a
remote target.

The apply mode explicitly resets both sequences to `1..N` in `createdAt ASC,
_id ASC` order, then aligns the independent order and product counters. Take a
database backup before applying. Verification allows gaps left by deleted
records but rejects invalid, duplicate, or out-of-order numbers and counters
below the highest assigned number.
Run `--apply` only once for the initial reset; later runs would renumber
surviving records and violate stable business identifiers.

The server verifies migration completion before accepting requests. New
orders and products use atomic counter increments; deleting a record never
reuses its number.

## Campaign profitability

Products own their campaign references (`store|accountId|campaign`); this is
the single persisted side of the many-to-many relationship. Campaign detail
and product profitability resolve those references against Windsor advertising
rows. Campaign spend remains unchanged; product allocation is an estimate,
not product-level attribution. Each Windsor campaign-day expense stores an
exact-cent allocation snapshot with the product IDs and names that were linked
when that spend was captured. New spend follows current links; existing
snapshots remain unchanged, including when a product is renamed or deleted.
Unsnapshotted spend is captured against persisted links: additions are captured
after they are saved, while removals preserve the prior links by capturing
before the change. Campaign spend with no linked products remains unallocated.
Product revenue and sold-unit cost use the order-item snapshots, while delivery
cost follows the existing order allocation rule.

The campaign catalog is reconstructed from stored Windsor advertising expenses,
not only the latest connector response. Successful syncs update `lastSeenAt` and
provider status but do not remove historical expenses or allocation snapshots.
The catalog separates active, paused/inactive, completed, no-longer-returned,
unverified, and unclassified campaigns; account summaries and pagination cover
the complete stored catalog.

## Windsor sync-key uniqueness

Before deploying the unique Windsor external-key index to an existing
database, stop advertising sync writes and inspect/deduplicate existing
duplicate keys:

```sh
npm run migrate:windsor-keys -- --dry-run
npm run migrate:windsor-keys -- --apply --confirm-deduplicate
npm run migrate:windsor-keys -- --verify
```

Destructive apply is restricted to loopback MongoDB hosts unless the operator
explicitly adds `--allow-remote-target` after verifying and authorizing a
remote target.

Apply keeps the most recently updated Windsor row for each duplicate key,
removes only older Windsor rows with that same key, and creates the partial
unique index. Back up the database first; manual expenses are not modified.

## Checks

```sh
npm test
npm run typecheck
```
