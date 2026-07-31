# Apple Baby Album — AGENTS.md

## Scope

This repository contains the application code for the team project.

Primary work areas:

- `frontend/`: Next.js application
- `backend/`: NestJS API
- `.agents/skills/`: installed skills; do not modify unless explicitly requested

Work only in `frontend/` and `backend/` unless the user explicitly requests a root-level configuration change.

## Product context

The MVP is a private family baby-photo album.

Core flows:

- sign up and sign in
- access only the authenticated user's family album
- view an August calendar
- open a date and view its photos
- upload photos to a date
- allow at most 10 photos per date
- show one valid representative thumbnail per date
- render thumbnails first and lazy-load gallery images

The supplied prototype defines the rough interaction model, not a pixel-perfect final design.


## Technology baseline

Use the repository's existing configuration when present. For uninitialized areas, use:

- TypeScript with strict type checking
- package manager: `pnpm`
- frontend: Next.js App Router and Tailwind CSS
- backend: NestJS REST API
- API validation: DTOs and global `ValidationPipe`
- API documentation: Swagger/OpenAPI
- database: PostgreSQL with Prisma
- object storage: S3-compatible Ceph RGW through AWS SDK for JavaScript v3
- image processing: Sharp

Prefer framework and platform capabilities before adding libraries.

Do not introduce GraphQL, MongoDB, microservices, Redis, BullMQ, Kafka, AI services, or a separate worker process unless the user explicitly requests them or the current implementation cannot satisfy a confirmed requirement without them.

## Architecture rules

Use this responsibility flow:

```text
browser -> Next.js -> NestJS -> PostgreSQL / Ceph RGW
```

- NestJS is the authoritative business API.
- Do not duplicate business endpoints in Next.js route handlers without an explicit BFF or proxy requirement.
- The frontend must never connect directly to PostgreSQL.
- The frontend must never receive RGW credentials.
- PostgreSQL stores account, family, album, photo metadata, hashes, object keys, and processing state.
- PostgreSQL must not store image binaries or permanent public object URLs.
- Ceph RGW stores original and derived image objects in private storage.
- The backend must verify authorization before returning an object URL or streaming an object.
- Never authorize using only a client-provided `userId`, `familyId`, role, owner ID, or object key.
- Read endpoints, ports, credentials, bucket names, and other environment-specific values from configuration.
- Do not hard-code secrets or environment-specific addresses.

Core invariants:

- unauthenticated users cannot access albums or images
- users cannot access another family's data
- a date cannot contain more than 10 photos
- a representative thumbnail must belong to that date and reference a valid photo
- a photo must not become `READY` until required metadata and derivatives are valid
- repeated requests must not create inconsistent duplicates
- database and object-storage partial failures must be visible and recoverable

Keep roles and permissions minimal until a confirmed requirement needs additional complexity.

## Development rules

- Inspect relevant code, tests, package manifests, and existing conventions before editing.
- Make the smallest coherent change that fully satisfies the request.
- Reuse suitable existing components, modules, DTOs, schemas, and utilities.
- Do not perform unrelated refactoring, renaming, formatting, cleanup, or dependency upgrades.
- Do not create abstractions for hypothetical future requirements.
- Preserve existing public behavior unless the user explicitly requests a breaking change.
- Keep NestJS controllers thin and place business rules in focused services or pure functions.
- Keep RGW/S3 access behind a storage service instead of spreading provider-specific calls across controllers.
- Ask a question only when ambiguity materially changes the API contract, database schema, authorization model, destructive behavior, or major user flow.
- Follow existing conventions for small and reversible decisions.

## Safety rules

These rules are strict:

- Work only inside this repository.
- Do not inspect parent directories, unrelated repositories, the user home directory, or machine-level configuration.
- Do not read, print, copy, modify, or summarize `.env*`, credentials, tokens, private keys, kubeconfig, cloud configuration, database dumps, or secret values.
- Use `.env.example` and placeholders when configuration shape is needed.
- Do not add, remove, or upgrade dependencies unless required by the requested work; explain the reason first.
- Schema or migration changes must be directly required by the task.
- Never run database resets, destructive migrations, or destructive seed operations without explicit approval.
- Do not execute destructive filesystem, Git, Docker, database, or operating-system commands without explicit approval.
- Do not commit, push, change remotes, force-push, or rewrite Git history unless explicitly requested.
- Do not execute downloaded scripts or pipe network content into a shell.
- Do not transmit repository contents, logs, or data to external services.
- Never weaken authentication, authorization, validation, or tests to make a task pass.
- Never report a command, test, build, or runtime flow as successful unless it actually completed successfully.

Non-destructive local inspection, linting, type checking, targeted tests, and builds are allowed.

## Skill routing

Use the minimum relevant skill set. Skills never override the safety rules.

### `frontend-design`

Use when creating or substantially redesigning:

- a page
- a layout
- a component system
- visual hierarchy
- a user flow

Do not use for copy changes, isolated CSS fixes, or small edits with an already-defined design.

### `web-design-guidelines`

Use after implementation when reviewing:

- accessibility
- responsive behavior
- form usability
- keyboard interaction
- visual hierarchy
- general web UX consistency

Do not use it as a reason to redesign unrelated UI.

### `vercel-react-best-practices`

Use when the task materially involves:

- App Router boundaries
- server and client components
- rendering behavior
- data fetching or caching
- hydration
- bundle size
- unnecessary rerenders

Do not use for trivial JSX, copy, or styling changes.

### `tdd`

Use before implementation when logic involves:

- authentication or authorization
- family data isolation
- the 10-photo limit
- upload validation
- photo processing states
- duplicate handling
- transactions
- idempotency
- partial failure recovery
- other high-regression business rules

Do not force TDD for styling, copy, simple wiring, configuration, or trivial CRUD scaffolding.

### `agent-browser`

Use when actual browser execution is necessary to verify:

- navigation
- authentication
- upload behavior
- forms
- responsive behavior
- frontend/backend integration

Do not use when static inspection or targeted tests are sufficient.

### `grill-with-docs`

Use when the implementation must be reconciled with supplied project documents, role definitions, architecture notes, or acceptance criteria.

### `grill-me`

Use only when a high-impact unresolved decision cannot be answered from the existing code or documents.

### `improve-codebase-architecture`

Do not use automatically.

Use only when the user explicitly requests architecture work or when a demonstrated structural defect directly blocks the requested task.

## Verification

Use the narrowest sufficient verification:

1. inspect the final diff
2. run affected lint and type checks
3. run targeted unit tests
4. run API integration tests when an API, database, or storage boundary changed
5. run browser verification only when browser behavior matters
6. run the affected application build when practical

Prioritize tests for:

- authentication
- cross-family access denial
- the 10-photo limit
- representative-thumbnail validity
- upload validation
- processing-state consistency
- repeated requests
- database/object-storage partial failures

After completing work, report:

- behavior changed
- files changed
- commands and checks actually run
- verified results
- required approvals or follow-up actions
- material assumptions or remaining risks
