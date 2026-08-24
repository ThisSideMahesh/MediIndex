# MediIndex Architecture

## Current implementation

One local Node.js process serves the browser UI and JSON API. SQLite is the local system of record. The browser never receives password hashes. A server-side session token is held in an HTTP-only, SameSite cookie.

`Browser UI -> Node HTTP API -> SQLite`

This is deliberately a local MVP. Electron packaging, mobile QR scanning and cloud synchronization are deferred until the core local workflow has test evidence.

## Technology decision

- Node.js built-in HTTP, crypto and SQLite APIs.
- SQLite local database.
- Plain HTML/CSS/JavaScript client.

There are no third-party dependencies, which makes the first build reproducible without a package installation. Electron is compatible as a later packaging layer; it is not yet implemented.
