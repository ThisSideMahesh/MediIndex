# Decisions

| Date | Decision | Reason |
|---|---|---|
| 2026-08-24 | Use a local SQLite MVP first | Core pharmacy workflows must work without cloud infrastructure. |
| 2026-08-24 | Use Node built-ins only for the first build | No repository existed; this gives a reproducible working baseline without unverified dependencies. |
| 2026-08-24 | Defer Electron/mobile/cloud | They are packaging/integration work and do not replace tested inventory and billing. |
| 2026-08-24 | Use server-side sessions and scrypt password hashes | Meets the authentication requirement without storing plaintext passwords or browser tokens. |
