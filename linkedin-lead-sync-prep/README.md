# LinkedIn Lead Sync — isolated preparation (NOT PRODUCTION)

This directory contains a simulated-response normalizer, an optional PostgreSQL inbox adapter and an unapplied draft migration. No live API call, scheduling, webhook, campaign update or CRM integration is performed.

## Run tests
`node --test linkedin-lead-sync-prep/*.test.mjs`

## Required review gates before integration
1. Read the existing backend routes, authentication, tenant model and CRM lead schema; do not trust tenant IDs supplied by API callers.
2. Choose typed tenant IDs and add foreign keys to the actual tenant and account models. Review permissions, RLS policies and database role ownership. The draft enables RLS without policies and therefore denies access by default.
3. Define retention, privacy, deletion and consent handling for the personally identifiable fields in `payload`. Never log personal answers or OAuth tokens.
4. Verify LinkedIn Lead Sync API product approval, OAuth scopes, credential rotation, form ownership and access. Do not assume Advertising API approval enables lead form responses.
5. Map the actual versioned LinkedIn response JSON to the internal simulated fixture shape and add API-contract fixtures/tests before network calls.
6. Implement cursor/backfill, retry/backoff, 429 handling, webhook signature verification if applicable, and end-to-end idempotent CRM writes with an audit trail.
7. Test in isolated environment using fake data and least-privileged DB role before any production migration.
8. Do not automatically unpause, modify or publish LinkedIn campaigns.

Current tests are mock/unit tests only. The inbox adapter should not be attached to an HTTP route until tenancy security and database policy are validated.
