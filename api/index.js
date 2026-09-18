/**
 * Minimal Vercel Serverless Function entry point (Phase 5A Foundation)
 * 
 * Note: This entry point provides the HTTP handler adapter for Vercel Serverless deployment.
 * Full serverless production readiness is under active development in Phase 5.
 */

const { handler } = require('../server');

module.exports = async (req, res) => {
  return handler(req, res);
};
