# MediIndex Project State

## Current phase
Phase 1 - Foundation and authentication.

## Verified implementation

- Local HTTP request handler and health route pass automated tests. TCP listener startup needs one manual local run because this workspace sandbox blocks opening ports.
- SQLite database is initialized in `data/mediindex.db`.
- Seeded demo users have scrypt password hashes, not plaintext passwords.
- Login, logout, session expiry (six hours), and protected dashboard endpoint work.
- Authentication automated tests pass.

## In progress

Billing and sales transactions.

## Not implemented

Billing, QR scanner, prediction, Electron packaging, cloud sync and inter-pharmacy discovery.

## Next action

Implement transactional billing with batch selection and stock deduction, then test rollback and insufficient-stock cases.
