# MediIndex Architecture & Design Decisions

| Date | Decision | Rationale | Alternatives Rejected |
|---|---|---|---|
| 2026-08-24 | Use local SQLite MVP first | Core pharmacy workflows must remain operational offline without cloud network dependencies. | Distributed cloud-only databases (unreliable internet in small medical stores). |
| 2026-08-24 | Use Node.js built-ins only (zero external npm packages) | Guarantees deterministic, reproducible compilation and execution on any faculty/evaluator machine without version conflicts or supply-chain vulnerabilities. | Express/Prisma/Webpack frameworks (packaging bloat and version mismatch risks during evaluation). |
| 2026-08-24 | Defer Electron/mobile/cloud sync | Prioritizes a rock-solid, fully-tested core inventory and POS engine before adding deployment layers. | Attempting all layers simultaneously without tested core functionality. |
| 2026-08-24 | Use server-side sessions with scrypt password hashing | Ensures complete credential security and prevents XSS token theft via `HttpOnly; SameSite=Strict` cookie controls. | Plaintext passwords or client-stored JWTs in `localStorage`. |
| 2026-08-24 | Adopt FEFO (First-Expired, First-Out) dispensing with manual batch override | Prevents medicine wastage by prioritizing earliest expiring batches while allowing explicit barcode/batch selection. | FIFO (First-In, First-Out) which ignores batch expiry dates and leads to drug expiration on shelves. |
| 2026-08-24 | Atomic multi-statement SQLite transactions for sales | Prevents inventory inconsistencies and overselling by enforcing full ACID rollback if any line item exceeds batch balance. | Non-transactional sequential updates which cause orphaned records and inventory drift. |
