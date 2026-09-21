/**
 * Vercel Serverless Function entry point
 *
 * Routes ALL requests (/ and /api/*) through the main application handler.
 * The handler internally routes to API endpoints or serves static files from public/.
 *
 * The handler is wrapped so that an unhandled rejection returns a proper JSON
 * error response. Previously the bare handler was exported: any rejection became
 * a Vercel FUNCTION_INVOCATION_FAILED page whose body is plain text starting with
 * "A server error has occurred" — which is not JSON, and surfaced in the browser
 * as a misleading parse error instead of an actionable message.
 *
 * This mirrors the .catch() wrapper already used by the local http.createServer()
 * path in core.js, so both runtimes fail the same way.
 */
const { handler } = require('../core');

module.exports = async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Internal server error.' }));
    } else {
      try { res.end(); } catch {}
    }
  }
};
