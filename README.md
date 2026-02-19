# Adversus Interview Assignment

Minimal full-stack notes application implementing per-resource edit locking with TTL-based expiration and atomic acquisition.

## Tech Stack

- Backend: .NET 8 Minimal API
- Database: MySQL (durable persistence)
- Frontend: React + TypeScript + Tailwind
- Containerization: Docker Compose

## Key Features

- Per-note locking (one editor at a time)
- Lock expiration (TTL-based)
- Atomic lock acquisition using database transactions
- Update enforcement (cannot modify without valid lock)
- Durable lock state across backend restarts

---

Further setup instructions will be added as implementation progresses.
