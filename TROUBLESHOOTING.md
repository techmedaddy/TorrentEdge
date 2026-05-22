# TorrentEdge Troubleshooting & Known Bugs Log

This document serves as a persistent record of complex bugs, configuration gotchas, and system-level issues encountered during the development and deployment of TorrentEdge. 

Each entry details the symptom, root cause, and the definitive solution to prevent regressions and accelerate future debugging.

---

## 1. Google OAuth 2.0: `Error 400: redirect_uri_mismatch` in Local Production Docker

**Date Logged:** May 22, 2026
**Component:** Authentication / Docker / Nginx

### Symptom
When attempting to log in via Google OAuth while running the production container locally (`docker-compose -f docker-compose.prod.yml up`), Google rejected the authentication request with `Error 400: redirect_uri_mismatch`.

### Root Cause
There were two intersecting configuration mismatches causing Google to reject the request:
1. **Environment Variable Override:** The `docker-compose.prod.yml` file explicitly loads `.env.prod`. In `.env.prod`, the `GOOGLE_CALLBACK_URL` was set to the production placeholder `https://your-domain.com/auth/google/callback`. The Node.js backend blindly sent this placeholder to Google as the requested redirect URI, which did not match the `http://localhost:3029...` URI registered in the Google Cloud Console.
2. **Docker Port Isolation (Nginx Proxying):** In the production Docker layout, the Node.js backend (port `3029`) is completely isolated from the host. Only the Nginx reverse proxy (port `80`) is exposed. If Google were to redirect the browser back to `http://localhost:3029`, the connection would be refused.

### Solution
To successfully test the production environment locally:
1. **Update `.env.prod`:** Temporarily changed `GOOGLE_CALLBACK_URL` to point to the Nginx entry point: `http://localhost/auth/google/callback`.
2. **Update Google Cloud Console:** Added `http://localhost/auth/google/callback` to the "Authorized redirect URIs" list to exactly match the new environment variable.
3. **Nginx Routing:** Ensured `nginx/prod.conf` explicitly proxied the `/auth/` path to the backend container to ensure the callback successfully reached the Node.js API.

**Key Takeaway:** Google OAuth requires a 1:1 character-perfect match. Always ensure your `.env` target matches your Cloud Console, and ensure you account for Nginx port mapping when declaring callback URLs.
