import {
  addEdit,
  freezePlan,
  getOrCreatePlan,
  getPlan,
  listCases,
  previewEdit,
  publishPlan,
  upsertCase
} from './storage.mjs';
import { loadFixtures } from './fixtures.mjs';

async function readJson(request) {
  try {
    const body = await new Promise((resolve, reject) => {
      let value = '';
      request.on('data', (chunk) => { value += chunk; });
      request.on('end', () => resolve(value));
      request.on('error', reject);
    });
    return body ? JSON.parse(body) : {};
  } catch {
    return {};
  }
}

function send(response, status, body) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

export async function seedDatabase(db) {
  for (const fixture of await loadFixtures()) upsertCase(db, fixture);
}

export async function handleApiRequest(db, request, response) {
  const url = new URL(request.url, 'http://127.0.0.1');
  const segments = url.pathname.split('/').filter(Boolean);
  if (request.method === 'GET' && segments[0] === 'api' && segments[1] === 'cases' && segments.length === 2) {
    return send(response, 200, { cases: listCases(db) });
  }

  const match = (...values) => values.every((value, index) => value === segments[index]);
  if (request.method === 'POST' && match('api', 'plans') && segments.length === 2) {
    const body = await readJson(request);
    const result = getOrCreatePlan(db, body.caseId, body.asOf ?? new Date().toISOString().slice(0, 10));
    return result.error ? send(response, result.error.status, result.error.body) : send(response, 200, result.plan);
  }
  if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'plans' && segments[3] === 'edits' && segments.length === 4) {
    const body = await readJson(request);
    const result = addEdit(db, decodeURIComponent(segments[2]), body);
    return result.error ? send(response, result.error.status, result.error.body) : send(response, 200, result);
  }
  if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'plans' && segments[3] === 'preview' && segments.length === 4) {
    const body = await readJson(request);
    const result = previewEdit(db, decodeURIComponent(segments[2]), body);
    return result.error ? send(response, result.error.status, result.error.body) : send(response, 200, result);
  }
  if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'plans' && segments[3] === 'freeze' && segments.length === 4) {
    const result = freezePlan(db, decodeURIComponent(segments[2]));
    return result.error ? send(response, result.error.status, result.error.body) : send(response, 200, result.plan);
  }
  if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'plans' && segments[3] === 'publish' && segments.length === 4) {
    const result = publishPlan(db, decodeURIComponent(segments[2]));
    return result.error ? send(response, result.error.status, result.error.body) : send(response, 200, result.plan);
  }
  if (request.method === 'GET' && match('api', 'plans')) {
    const plan = getPlan(db, decodeURIComponent(segments[2]));
    return plan ? send(response, 200, plan) : send(response, 404, { error: 'plan_not_found' });
  }
  return send(response, 404, { error: 'not_found' });
}
