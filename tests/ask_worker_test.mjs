// Offline test of cloudflare/ask-worker.js with Groq replaced by canned replies. Run: node tests/ask_worker_test.mjs
import assert from 'node:assert/strict';
import worker from '../cloudflare/ask-worker.js';
const calls = [];
let mode = 'ok';
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body); calls.push({ model: body.model, json: !!body.response_format, effort: body.reasoning_effort, auth: init.headers.Authorization, sys: body.messages[0].content.slice(-20) });
  if (mode === 'retired' && body.model === 'openai/gpt-oss-120b') return new Response('{"error":"model decommissioned"}', { status: 404 });
  if (mode === 'nojson' && body.response_format) return new Response('{}', { status: 400 });
  if (mode === 'busy') return new Response('{}', { status: 429 });
  const content = mode === 'wrapped' ? 'Here: {"intent":"rank_judges","measure":"days","motion":"r56","judge":"<script>alert(1)</script>","period":"2025","extra":"x"} done'
    : JSON.stringify({ intent: 'motions', focus: 'outcome', motion: 'r12', motion_detail: '12b6', judge: 'Long', case_type: 'insurance', period: '12m', measure: null, outcome: 'bogus', text: null, case_number: null });
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
};
const env = { GROQ_API_KEY: 'test-key' };
const req = (body, origin = 'https://ggb52-wq.github.io', method = 'POST') => new Request('https://edla-ask.example.workers.dev/', { method, headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: method === 'POST' ? JSON.stringify(body) : undefined });
const results = {};
const show = async (label, r) => { const text = await r.text(); results[label] = { status: r.status, origin: r.headers.get('Access-Control-Allow-Origin'), body: text ? JSON.parse(text) : null }; console.log(label.padEnd(22), r.status, text); };
await show('ok', await worker.fetch(req({ question: 'How often does Judge Long grant 12(b)(6) motions in insurance cases?', today: '2026-11-12' }), env));
console.log('  calls', JSON.stringify(calls.splice(0)));
mode = 'wrapped'; await show('wrapped+sanitize', await worker.fetch(req({ question: 'Who is fastest on MSJs?' }), env)); calls.splice(0);
mode = 'retired'; await show('model retired', await worker.fetch(req({ question: 'x' }), env)); console.log('  calls', calls.splice(0).map((c) => c.model + (c.json ? '+json' : '')).join(', '));
mode = 'nojson'; await show('no json mode', await worker.fetch(req({ question: 'x' }), env)); console.log('  calls', calls.splice(0).map((c) => c.model + (c.json ? '+json' : '')).join(', '));
mode = 'busy'; await show('rate limited', await worker.fetch(req({ question: 'x' }), env)); console.log('  calls', calls.splice(0).length);
mode = 'ok';
await show('other origin', await worker.fetch(req({ question: 'x' }, 'https://evil.example'), env));
await show('no origin', await worker.fetch(req({ question: 'x' }, ''), env));
await show('preflight', await worker.fetch(req(null, 'https://ggb52-wq.github.io', 'OPTIONS'), env));
await show('empty question', await worker.fetch(req({ question: '  ' }), env));
await show('no key', await worker.fetch(req({ question: 'x' }), {}));

assert.equal(results.ok.status, 200); assert.equal(results.ok.body.query.judge, 'Long'); assert.equal(results.ok.body.query.outcome, null, 'a value outside the vocabulary is dropped');
assert.equal(results['wrapped+sanitize'].body.query.measure, 'days'); assert.ok(!/[<>]/.test(results['wrapped+sanitize'].body.query.judge), 'angle brackets are removed');
assert.ok(!('extra' in results['wrapped+sanitize'].body.query), 'unknown keys are dropped');
assert.equal(results['model retired'].body.model, 'llama-3.3-70b-versatile');
assert.equal(results['no json mode'].status, 200); assert.equal(results['rate limited'].status, 429);
assert.equal(results['other origin'].status, 403); assert.equal(results['other origin'].origin, null); assert.equal(results['no origin'].status, 403);
assert.equal(results.preflight.status, 204); assert.equal(results['empty question'].status, 400); assert.equal(results['no key'].status, 500);
console.log('all assertions passed');
