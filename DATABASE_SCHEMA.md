# MediIndex Database Schema

Current database: SQLite at `data/mediindex.db`.

| Table | Purpose |
|---|---|
| pharmacies | Local pharmacy tenancy boundary |
| users | Admin/staff accounts; password hash and role |
| medicines | Medicine master records and minimum stock |
| medicine_batches | Batch-level stock, prices, dates and shelf location |
| sales | Invoice header |
| sale_items | Invoice lines linked to a specific batch |
| expiry_alerts | Persisted generated alert records |

Key constraints: unique user email, role check, non-negative inventory quantity/prices, positive sale quantity, unique medicine/batch pair, and foreign keys enabled.

**Status:** Schema created and initialized. CRUD APIs beyond authentication are not yet implemented.
