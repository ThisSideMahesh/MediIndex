# MediIndex API Specification

| Method | Path | Authentication | Status |
|---|---|---|---|
| GET | `/api/health` | No | Implemented |
| POST | `/api/auth/login` | No | Implemented |
| POST | `/api/auth/logout` | Session | Implemented |
| GET | `/api/auth/me` | Session | Implemented |
| GET | `/api/dashboard` | Session | Implemented |
| GET | `/api/medicines?q=` | Session | Implemented |
| POST | `/api/medicines` | Admin | Implemented |
| PUT / DELETE | `/api/medicines/:id` | Admin | Implemented |
| GET / POST | `/api/medicines/:id/batches` | Session | Implemented |
| POST | `/api/batches/:id/adjustments` | Session | Implemented |
| GET | `/api/expiry-alerts` | Session | Implemented |
| POST | `/api/expiry-alerts/:id/acknowledge` | Session | Implemented |

`POST /api/auth/login` body: `{ "email": "admin@mediindex.local", "password": "MediIndex@2026" }`.

The response sets an HTTP-only `mediindex_session` cookie. The session expires in six hours. Medicine, batch and billing endpoints will be added only with their database implementation and tests.
