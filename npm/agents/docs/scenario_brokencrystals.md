Goal: exercise authenticated shopping, profile, API documentation, GraphQL, file/document, and exposed configuration surfaces while PTK scan is running.

Sequence:
1. Authentication: open `/userlogin` and login using credentials supplied by environment variables.
2. Marketplace route: open the marketplace (`/marketplace`) and browse product listings.
3. Product search: search for a normal product term, then visit product search API surfaces such as `/api/products/search?name=opal`.
4. Account route: open the authenticated profile page (`/userprofile`) and confirm account-specific content is reachable.
5. Chat route: open the authenticated chat surface (`/chat`) and observe its API traffic without submitting sensitive values.
6. API documentation: open Swagger/OpenAPI documentation (`/swagger`, `/swagger-json`) and collect same-origin API routes.
7. GraphQL documentation: open GraphiQL and GraphQL surfaces (`/graphiql`, `/graphql`) and record discovered operations.
8. Configuration surfaces: visit configuration and secret-disclosure surfaces (`/api/config`, `/api/secrets`) and record PTK findings/export validity.
9. Common file surfaces: visit same-origin common files such as `/.htaccess`, `/nginx.conf`, `/.git/config`, and vendor/static directories when they are in scope.
10. File and metadata surfaces: visit bounded same-origin file, metadata, and cloud metadata routes from route hints; do not leave the target origin.
11. User and partner API surfaces: visit authenticated user-object, user-search, partner-search, and partner-query endpoints from route hints.
12. Broad coverage: continue deterministic crawling to find menu-only routes, hidden same-origin routes, API endpoints, forms, GraphQL calls, redirects, and terminal documents.

Constraints:
- Stay on the target origin.
- Use `--username-env` and `--password-env` or benchmark-specific `*-username-env` and `*-password-env` flags for credentials.
- Do not write raw secrets, credential values, cookies, tokens, request bodies, or raw document content to artifacts.
- Do not execute logout, delete, checkout, transfer, payment, purchase, or destructive account mutation actions during surface exploration.
- Do not rely on an agent to compensate for deterministic crawler failures.
