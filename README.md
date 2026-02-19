# Adversus Interview Assignment

Minimal full-stack Notes application implementing per-resource edit
locking with TTL-based expiration and atomic lock acquisition.

The purpose of this assignment is to ensure that only one session can
edit a note at a time, even under contention, and that lock state
survives backend restarts (DB-backed persistence).

------------------------------------------------------------------------

## Tech Stack

### Backend

-   Node.js
-   Fastify
-   TypeScript
-   MySQL (mysql2 driver)

### Frontend

-   React
-   TypeScript
-   TailwindCSS

### Infrastructure

-   Docker Compose
-   MySQL container (auto-seeded at startup)

------------------------------------------------------------------------

## Core Goal

Implement a per-note edit locking system that ensures:

-   Only one user/session can edit a note at a time
-   Locks expire automatically (TTL-based)
-   Lock acquisition is atomic
-   Updates require a valid lock
-   Lock state survives backend restarts (DB-backed)

------------------------------------------------------------------------

## Data Model

### Note

-   id
-   title
-   content
-   updated_at

### Lock

-   note_id (PK)
-   locked_by (session id)
-   locked_at
-   expires_at

------------------------------------------------------------------------

## Locking Strategy (Implemented)

Locks are stored in MySQL (note_locks table).

Lock acquisition uses an atomic upsert:

-   INSERT ... ON DUPLICATE KEY UPDATE
-   If lock does not exist → create it
-   If expired → takeover
-   If same owner → renew TTL
-   If different owner and not expired → keep existing lock

TTL is enforced using UTC time comparisons:

    expires_at <= UTC_TIMESTAMP()

Expired locks behave as if they do not exist.

Additionally, GET /notes performs best-effort cleanup:

    DELETE FROM note_locks WHERE expires_at <= UTC_TIMESTAMP();

This cleanup is not required for correctness but keeps the DB tidy.

------------------------------------------------------------------------

## API

### GET /notes

Returns notes including computed lock state.

### POST /notes/:id/lock

Acquire or renew lock.

-   Unlocked or expired → 200 OK
-   Locked by same caller → 200 OK (renew)
-   Locked by another caller → 423 Locked

### DELETE /notes/:id/lock

-   Caller owns lock → 204 No Content
-   Different owner → 403 Forbidden
-   No lock → 204 No Content

### PUT /notes/:id

Requires valid lock.

-   Success → 200 OK
-   Missing/expired/foreign lock → 423 Locked
-   Missing note → 404 Not Found

------------------------------------------------------------------------

# Running the Application

## Prerequisites

-   Docker Desktop running
-   Node.js 18+ installed
-   docker compose available in PATH
-   On Windows: PowerShell available (for smoke tests)

------------------------------------------------------------------------

## Development Modes

### 1. Full Development Mode (Recommended)

From backend/:

    npm run dev:full

This script:

1.  Starts MySQL via Docker Compose
2.  Waits for MySQL container health
3.  Starts backend in watch mode (tsx watch)

Backend runs at:

    http://localhost:8080

------------------------------------------------------------------------

### 2. Backend Only (Manual Mode)

If MySQL is already running:

    npm run dev

This runs:

    tsx watch src/server.ts

------------------------------------------------------------------------

# Testing Modes

The project supports multiple levels of testing.

------------------------------------------------------------------------

## 1. Integration Tests Only

From backend/:

    npm run build
    npm test

This:

-   Compiles TypeScript
-   Runs Fastify integration tests using Node's built-in test runner
-   Uses DB-backed locking logic
-   Cleans up lock state between tests

------------------------------------------------------------------------

## 2. Smoke Test (Manual Contract Verification)

From backend/:

    npm run smoke:locks

This script:

-   Verifies backend health
-   Waits until note is unlocked
-   Executes real HTTP calls via curl
-   Validates lock ownership and update rules

Windows: Uses PowerShell. Mac/Linux: Requires pwsh if using the same
script.

------------------------------------------------------------------------

## 3. Full Test Pipeline (CI-Style)

From backend/:

    npm run test:full

This performs:

1.  Starts MySQL via Docker Compose
2.  Waits for container health
3.  Builds TypeScript
4.  Runs integration tests
5.  Starts backend (if not already running)
6.  Waits for /health
7.  Executes smoke tests
8.  Stops backend if it started it

This simulates a CI environment.

------------------------------------------------------------------------

# Database Seeding

Notes are pre-seeded via:

    database/init/001.init.sql

This runs automatically when the MySQL container is created the first
time.

To reset database completely:

    docker compose down -v
    docker compose up -d

------------------------------------------------------------------------

# Project Structure

``` text
adversus-interview-assignment/
│
├── backend/
│   ├── src/
│   │   ├── app.ts
│   │   ├── server.ts
│   │   ├── locks.ts
│   │   ├── db.ts
│   │   └── config.ts
│   │
│   ├── scripts/
│   │   ├── dev-full.mjs
│   │   ├── test-full.mjs
│   │   └── smoke-locks.ps1
│   │
│   ├── test/
│   │   └── locks.integration.test.ts
│   │
│   └── package.json
│
├── frontend/
│
├── database/
│   └── init/
│       └── 001.init.sql
│
└── docker-compose.yml
```

------------------------------------------------------------------------

# Manual Reproduction Scenario

1.  Open frontend in two different browser sessions
2.  Session A locks a note
3.  Session B attempts edit and receives 423
4.  Session A closes browser or TTL expires
5.  Session B can acquire the lock

------------------------------------------------------------------------

# Assignment Status

-   Atomic locking implemented
-   TTL-based expiration enforced
-   DB-backed persistence
-   Integration tests passing
-   Smoke tests passing
-   Full CI-style pipeline available
-   Dev bootstrap scripts implemented

The backend locking layer is production-safe within the assignment
scope.
