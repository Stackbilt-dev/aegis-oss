# Cross-Repo Learnings

Insights imported from the Memory Worker registry. These originated in other repos and were pulled here because they apply to aegis-oss.

---

### Route-shadowing in Hono catch-all handlers
- **Type**: gotcha
- **Origin**: demo-app@route-shadowing
- **Applicable to**: [aegis-oss, demo-app, bizops]
- **Confidence**: 0.8
- **Impact**: confirmed
- **Keywords**: hono, routing, catch-all, shadowing, middleware, worker, cloudflare

In Hono-based Cloudflare Workers, a catch-all route (`/*` or `/:path{.*}`) registered before more specific routes will shadow them silently — the specific route never fires, no error is thrown. This is especially treacherous when routes are registered across multiple files and the import order determines registration order. Always register specific routes before catch-alls, or use Hono's route grouping to isolate catch-all behavior to a specific path prefix.
