/**
 * Vercel Serverless Function entry point
 * 
 * Routes ALL requests (/ and /api/*) through the main application handler.
 * The handler internally routes to API endpoints or serves static files from public/.
 */

const { handler } = require('../server');

module.exports = handler;
