import http from 'node:http';
import fs from 'node:fs/promises';
import { createServer as createViteServer } from 'vite';
import { handleApiRequest, seedDatabase } from './src/server/api.mjs';
import { openStorage } from './src/server/storage.mjs';

const db = openStorage();
await seedDatabase(db);

const vite = await createViteServer({
  server: {
    middlewareMode: true,
    host: '127.0.0.1',
    port: 5355,
    strictPort: true
  },
  appType: 'custom'
});

const server = http.createServer((request, response) => {
  if (request.url?.startsWith('/api/')) {
    return handleApiRequest(db, request, response).catch((error) => {
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: 'internal_error', message: error.message }));
    });
  }
  vite.middlewares(request, response, async () => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/src/') || url.pathname.includes('.')) {
      response.statusCode = 404;
      response.end('Not found');
      return;
    }
    const rawHtml = await fs.readFile(new URL('./index.html', import.meta.url), 'utf8');
    const html = await vite.transformIndexHtml(url.pathname, rawHtml);
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(html);
  });
});

server.listen(5355, '127.0.0.1', () => {
  console.log('SDC review: http://127.0.0.1:5355');
});
