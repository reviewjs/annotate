// Minimal receiver for Annotate's optional data-post-url / postUrl setting.
// Run: ALLOWED_ORIGIN=http://localhost:4200 node examples/feedback-server.cjs
// Set FEEDBACK_DIR to choose where JSON files are written; default is ./feedback.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_BODY_BYTES = 1024 * 1024;

function createFeedbackServer({ directory = path.resolve('feedback'), allowedOrigin = '' } = {}) {
  return http.createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (allowedOrigin && origin && origin !== allowedOrigin) {
      request.resume();
      response.writeHead(403).end('Origin not allowed');
      return;
    }
    if (allowedOrigin && origin === allowedOrigin) {
      response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (request.url !== '/feedback') {
      request.resume();
      response.writeHead(404).end('Not found');
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
      return;
    }
    if (request.method !== 'POST') {
      request.resume();
      response.writeHead(405, { Allow: 'POST, OPTIONS' }).end('Method not allowed');
      return;
    }
    if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers['content-type'] || '')) {
      request.resume();
      response.writeHead(415).end('Expected application/json');
      return;
    }

    let bytes = 0;
    const chunks = [];
    try {
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          response.writeHead(413).end('Feedback is too large');
          return;
        }
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!payload || payload.kind !== 'annotate-export' ||
          typeof payload.page !== 'string' || !Array.isArray(payload.comments)) {
        response.writeHead(400).end('Invalid Annotate export');
        return;
      }
      await fs.mkdir(directory, { recursive: true });
      const id = randomUUID();
      await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify(payload, null, 2), { flag: 'wx' });
      response.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ id }));
    } catch (error) {
      if (error instanceof SyntaxError) {
        response.writeHead(400).end('Invalid JSON');
      } else {
        console.error('Could not save feedback:', error);
        if (!response.headersSent) response.writeHead(500).end('Could not save feedback');
      }
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8787);
  const server = createFeedbackServer({
    directory: path.resolve(process.env.FEEDBACK_DIR || 'feedback'),
    allowedOrigin: process.env.ALLOWED_ORIGIN || '',
  });
  const host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`Feedback receiver: http://${host}:${port}/feedback`));
}

module.exports = { createFeedbackServer };
