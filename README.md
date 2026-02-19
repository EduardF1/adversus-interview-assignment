# Adversus Interview Assignment — Notes app with per-note edit locking

Minimal full-stack Notes application implementing **per-resource edit locking** with **TTL-based expiration** and **atomic lock acquisition**.

This assignment focuses on correctness under contention: **only one session can edit a note at a time**, edits without a valid lock must never succeed, and lock state must survive backend restarts (**durable persistence**).

---

## What’s inside

- **Backend API**: Node.js + TypeScript + Fastify + MySQL (Docker Compose)
- **Frontend client**: React + TypeScript + Vite (minimal UI)
- **Integration tests** (backend): deterministic, DB-backed
- **Smoke tests** (backend): HTTP-level contract verification
- **End-to-end tests** (frontend): Playwright across two browser contexts
- **Unified pipeline**: `npm run test:full` from `backend/`

---

## Core behavior (locking rules)

Per note (`/notes/:id`), there is at most one active lock at a time:

- Locks are **owned by a session id** (`x-session-id` header)
- Locks have an **expiration time** (TTL)
- Expired locks behave as if they do not exist
- Lock acquisition is **atomic** (no double-lock under race conditions)
- Updating a note requires holding a valid lock

### Session identity

There is **no authentication**. Each browser session generates a `sessionId` (stored in `localStorage`) and sends it on requests:

- Header: `x-session-id: <uuid>`

This identity determines lock ownership and renewal.

---

## API (REST)

### `GET /notes`

Returns notes including computed lock state.

### `POST /notes/:id/lock` — acquire or renew

- Unlocked or expired → **200 OK**
- Locked by same caller → **200 OK**
- Locked by another caller → **423 Locked**

### `DELETE /notes/:id/lock` — release

- Caller owns lock → **204 No Content**
- Different owner → **403 Forbidden**
- No lock → **204 No Content**

### `PUT /notes/:id` — update note

- Requires valid lock
- Missing/expired/foreign lock → **423 Locked**
- Missing note → **404 Not Found**

---

## Reviewer Quick Start (Step-by-step)

### Prerequisites

- Docker Desktop running
- Node.js 18+ installed
- `docker compose` available in PATH
- PowerShell (Windows) or bash/zsh (macOS/Linux)

---

### 1) Start MySQL

```bash
docker compose up -d mysql
```

---

### 2) Start backend

**PowerShell (Windows):**
```powershell
cd backend
npm install
npm run dev
```

**bash/zsh (macOS/Linux):**
```bash
cd backend
npm install
npm run dev
```

Health check:

```bash
curl http://localhost:8080/health
```

---

### 3) Start frontend

```bash
cd frontend
npm install
npm run dev
```

Open: http://localhost:5173

---

### 4) Manual locking repro

1. Open app in normal window (Session A)
2. Open app in incognito (Session B)
3. Session A clicks **Edit**
4. Session B cannot edit (423 / disabled button)
5. Save/Cancel in Session A or wait for TTL
6. Session B can now edit

---

## E2E Mode (Reset Endpoint Enabled)

The backend exposes:

`POST /__test__/reset`

Only when `E2E=1`.

### Start backend in E2E mode

**PowerShell:**
```powershell
$env:E2E="1"
cd backend
npm run dev
```

**bash/zsh:**
```bash
cd backend
E2E=1 npm run dev
```

### Run Playwright

```bash
cd frontend
npm run test:e2e
```

---

## Full CI-style pipeline

From `backend/`:

```bash
npm run test:full
```

---

## Database seeding

Pre-seeded via:

`database/init/001.init.sql`

To fully reset:

```bash
docker compose down -v
docker compose up -d mysql
```

---

## Diagrams

Located in:

- `docs/diagrams/system-components.puml`
- `docs/diagrams/use-cases.puml`

---

## Repo hygiene

Remove IntelliJ `.idea/`:

```bash
git rm -r --cached .idea
echo ".idea/" >> .gitignore
git add .gitignore
git commit -m "chore: remove .idea from repo"
```

---

## Ownership

AI tools were used during development, but architecture, locking semantics, and testing strategy are fully understood and owned.
