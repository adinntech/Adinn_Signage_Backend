# Signage Backend – Project Rules

Full global rules: `D:\Projects\Signage\.claude\skills\adinn-signage-crm\SKILL.md` (skill `adinn-signage-crm`). Read it before building or changing any API, model or workflow. This file summarizes the backend-relevant parts.

Stack: Node.js, Express 5, TypeScript, Mongoose, MongoDB Atlas. One REST API (`/api/v1`) shared by web and mobile; this backend owns all business rules.

## Workflow
- Existing project: inspect the code first, reuse working code, avoid unnecessary refactoring.
- Build only the requested screen/stage. Do not start the next module; wait for user approval.
- Search existing middleware, validators, models, services and utilities before creating new ones.

## Architecture
- `src/modules/<name>/` with Controller -> Service -> Repository/Model. Controllers handle HTTP only; services hold business logic and workflow decisions; models handle persistence.
- Shared code lives in `src/common/` (responses, errors, middleware, validators, pagination, permissions, utils, types).
- Permissions/roles are defined in `src/modules/roles/roles.ts`; reuse the single auth middleware.

## Responses and errors
- Use the shared helpers (`successResponse`, `createdResponse`, `paginatedResponse`, `errorResponse`); never hand-build response JSON in controllers.
- Success: `{ success, message, data, meta }`. Error: `{ success: false, message, error: { code, details } }`. Keep backward compatibility with existing contracts.
- Throw `ApplicationError` subclasses (Validation, NotFound, Unauthorized, Forbidden, Conflict) and let the global error middleware and async handler deal with them. No try/catch boilerplate unless needed.
- Never expose stack traces (production), connection strings, tokens, passwords or credentials. Log internal errors with a request ID.

## Validation
- One schema per request/entity (e.g. `createProjectSchema`), reused across layers. Backend validation is authoritative.

## Business logic (implement once, unit-test)
Square feet and unit conversion, cost per shop, vendor cost comparison, trip expense and shared trip cost allocation, vendor payable, advance deduction, approval routing, project status transitions, board approval decisions, document versioning, report generation. Rates come from configurable policy/rate-card data, never constants.

## Database
- Reuse existing models. Keep createdAt, updatedAt, createdBy, updatedBy, status, version, projectId.
- Index Project Code, Client ID, Site ID, Vendor ID, assignment, user, status, date and search fields.
- No binaries in MongoDB (object storage + metadata). Avoid unbounded arrays (e.g. hundreds of shops). Use transactions for related critical writes.
- Records link by ID: Client -> Enquiry -> Quotation -> Project -> Site -> Board Option -> Recce -> Approval -> Payment -> Handover.

## Shared modules
- One communication/email module (compose, templates, attachments, drafts, send, delivery status, threads, audit) for all departments.
- One file service (upload, preview, download, versioning, category, permissions, audit); raw and annotated photos stored separately.
- Automations via services/events/jobs, idempotent: no duplicate emails, POs or payments.

## Security and env
- No hardcoded secrets. Config in `.env` (never committed); keep `.env.example` current with names only.
- Validate required env vars at startup with typed config and clear errors.
- If committed credentials are found, report them and recommend rotation; never copy them elsewhere.

## Performance
Indexed queries, pagination and filtering, background PPT/PDF jobs, file streaming, rate limiting on sensitive endpoints.

## Testing (Vitest)
Unit tests (business calculations), API integration tests, validation tests, RBAC tests, error-response tests. A feature is not done if Save/Submit/Upload/Approve/Export is decorative.

## Completion report
Completed screens/APIs, reused components, new shared components, modified files, API routes, database changes, env variable names only, tests and results, manual verification steps, known issues, next recommended stage. No secrets. Then wait for approval.

## When to load the full skill
Before building or changing any screen, API, model, workflow or shared component, invoke the `adinn-signage-crm` skill first (Skill tool) and follow it. Skip it for trivial questions, small fixes and non-code chat.
