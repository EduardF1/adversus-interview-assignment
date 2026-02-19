# Adversus Interview Assignment

Minimal full-stack notes application implementing per-resource edit
locking with TTL-based expiration and atomic acquisition.

------------------------------------------------------------------------

## Tech Stack

### Backend

-   Node.js
-   Fastify (HTTP framework)
-   TypeScript
-   MySQL (mysql2 driver)

### Frontend

-   React
-   TypeScript
-   TailwindCSS

### Infrastructure

-   Docker Compose (planned)
-   MySQL container (planned)

------------------------------------------------------------------------

## Core Goal

Implement a per-note edit locking system that ensures:

-   Only one user can edit a note at a time
-   Locks expire automatically (TTL-based)
-   Lock acquisition is atomic
-   Updates require a valid lock
-   Lock state survives backend restarts (DB-backed)

------------------------------------------------------------------------

## Locking Strategy (Planned)

-   Locks stored in MySQL
-   Each lock contains:
    -   note_id
    -   locked_by
    -   expires_at
-   Atomic acquisition via transaction:
    -   Acquire if no lock exists
    -   OR existing lock is expired
-   TTL enforced via timestamp comparison

------------------------------------------------------------------------

## Project Structure

adversus-interview-assignment/ ├── backend/ │ ├── src/ │ ├──
package.json │ └── tsconfig.json ├── frontend/ ├── database/ │ └── init/

------------------------------------------------------------------------

## Current Status

-   Backend bootstrapped (Fastify + TypeScript)
-   Health endpoint implemented
-   MySQL integration next
-   Locking implementation next

------------------------------------------------------------------------

Further setup instructions will be added as implementation progresses.
