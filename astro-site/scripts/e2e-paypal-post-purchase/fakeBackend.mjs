/**
 * 偽の外部（Airtable・PayPal Sandbox・Upstash Redis・SendGrid）。E2E 専用・ローカルの HTTP サーバー 1 つ。
 * 経路は `/<本物のホスト>/<パス>`（stub.mjs が本物の URL をここへ書き換える）。PII は合成値だけ・本物へは出ない。
 */
import { createServer } from 'node:http';

const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });

/** Airtable の filterByFormula の、この導線で使う形だけを評価する（知らない形は記録して 0 件） */
export function evalFormula(formula, f, unknown) {
  const s = String(formula || '').trim();
  if (!s) return true;
  let m = s.match(/^AND\((.*)\)$/s);
  if (m) return splitArgs(m[1]).every((a) => evalFormula(a, f, unknown));
  m = s.match(/^OR\((.*)\)$/s);
  if (m) return splitArgs(m[1]).some((a) => evalFormula(a, f, unknown));
  m = s.match(/^NOT\(\{([^}]+)\}\)$/);
  if (m) return !f[m[1]];
  m = s.match(/^LOWER\(TRIM\(\{([^}]+)\}\)\)\s*=\s*['"](.*)['"]$/s);
  if (m) return String(f[m[1]] || '').trim().toLowerCase() === m[2].replace(/\\(['"])/g, '$1');
  m = s.match(/^\{([^}]+)\}\s*=\s*['"](.*)['"]$/s);
  if (m) return String(f[m[1]] ?? '') === m[2].replace(/\\(['"])/g, '$1');
  unknown.push(s);
  return false;
}
function splitArgs(s) {
  const out = []; let depth = 0; let q = null; let cur = '';
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function createFakeBackend() {
  const st = {
    tables: { Customers: {}, AuthTokens: {} },
    subs: {},
    redis: new Map(),
    mails: [],
    unknownFormulas: [],
    seq: 0,
    log: [],
  };
  const newId = () => `rec${String(++st.seq).padStart(14, 'E')}`.slice(0, 17);

  async function airtable(req, res, path, url) {
    // /v0/{base}/{table}[/{id}|/listRecords]
    const [, , , rawTable, rest] = path.split('/');
    const table = decodeURIComponent(rawTable || '');
    const rows = st.tables[table] || (st.tables[table] = {});
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : {};
    st.log.push(`${req.method} airtable ${table}${rest ? `/${rest}` : ''}`);
    const list = (formula, max) => {
      const hits = Object.entries(rows).filter(([, f]) => evalFormula(formula, f, st.unknownFormulas));
      return hits.slice(0, Number(max) || 100).map(([id, fields]) => ({ id, createdTime: new Date().toISOString(), fields }));
    };
    if (req.method === 'GET' && !rest) return json(res, 200, { records: list(url.searchParams.get('filterByFormula'), url.searchParams.get('maxRecords')) });
    if (req.method === 'POST' && rest === 'listRecords') return json(res, 200, { records: list(body.filterByFormula, body.maxRecords) });
    if (req.method === 'GET' && rest) return rows[rest] ? json(res, 200, { id: rest, fields: rows[rest] }) : json(res, 404, { error: 'NOT_FOUND' });
    if (req.method === 'POST' && !rest) {
      const items = body.records || [{ fields: body.fields }];
      const out = items.map((r) => { const id = newId(); rows[id] = { ...r.fields }; return { id, fields: rows[id] }; });
      return json(res, 200, body.records ? { records: out } : out[0]);
    }
    if ((req.method === 'PATCH' || req.method === 'PUT') && rest) {
      if (!rows[rest]) return json(res, 404, { error: 'NOT_FOUND' });
      Object.assign(rows[rest], body.fields || {});
      return json(res, 200, { id: rest, fields: rows[rest] });
    }
    if ((req.method === 'PATCH' || req.method === 'PUT') && !rest) {
      const out = (body.records || []).map((r) => { Object.assign(rows[r.id] || (rows[r.id] = {}), r.fields || {}); return { id: r.id, fields: rows[r.id] }; });
      return json(res, 200, { records: out });
    }
    return json(res, 404, { error: 'unsupported' });
  }

  async function paypal(req, res, path) {
    const raw = await readBody(req);
    st.log.push(`${req.method} paypal ${path}`);
    if (path === '/v1/oauth2/token') return json(res, 200, { access_token: 'e2e-token', expires_in: 3600 });
    if (path === '/v1/billing/subscriptions' && req.method === 'POST') {
      const b = JSON.parse(raw);
      const sid = `I-E2E${String(Object.keys(st.subs).length + 1).padStart(10, '0')}`;
      st.subs[sid] = {
        id: sid, status: 'APPROVAL_PENDING', plan_id: b.plan_id, custom_id: b.custom_id,
        returnUrl: b.application_context?.return_url,
        links: [{ rel: 'approve', href: `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-${sid}` }],
      };
      const { returnUrl, ...pub } = st.subs[sid];
      return json(res, 201, pub);
    }
    const m = path.match(/^\/v1\/billing\/subscriptions\/(I-[A-Z0-9]+)$/);
    if (m) {
      const s = st.subs[m[1]];
      if (!s) return json(res, 404, { name: 'RESOURCE_NOT_FOUND' });
      const { returnUrl, ...pub } = s;
      return json(res, 200, pub);
    }
    return json(res, 404, { name: 'NOT_SUPPORTED' });
  }

  async function redis(req, res, path) {
    const raw = await readBody(req);
    if (path !== '/') {
      // pipeline: [[cmd...], ...]
      const cmds = raw ? JSON.parse(raw) : [];
      return json(res, 200, cmds.map((c) => ({ result: runRedis(c) })));
    }
    return json(res, 200, { result: runRedis(JSON.parse(raw)) });
  }
  function runRedis([cmd, key, ...args]) {
    const c = String(cmd).toUpperCase();
    const r = st.redis;
    switch (c) {
      case 'GET': return typeof r.get(key) === 'string' ? r.get(key) : null;
      case 'SET': {
        const nx = args.map(String).map((x) => x.toUpperCase()).includes('NX');
        if (nx && r.has(key)) return null;
        r.set(key, String(args[0])); return 'OK';
      }
      case 'GETDEL': { const v = r.get(key) ?? null; r.delete(key); return typeof v === 'string' ? v : null; }
      case 'DEL': return r.delete(key) ? 1 : 0;
      case 'EXISTS': return r.has(key) ? 1 : 0;
      case 'INCR': case 'INCRBY': { const v = Number(r.get(key) || 0) + Number(c === 'INCR' ? 1 : args[0]); r.set(key, String(v)); return v; }
      case 'EXPIRE': case 'PEXPIRE': return 1;
      case 'TTL': return -1;
      case 'HSET': case 'HSETNX': {
        const h = r.get(key) instanceof Map ? r.get(key) : new Map(); r.set(key, h);
        if (c === 'HSETNX' && h.has(args[0])) return 0;
        for (let i = 0; i < args.length; i += 2) h.set(String(args[i]), String(args[i + 1]));
        return 1;
      }
      case 'HGET': return r.get(key) instanceof Map ? r.get(key).get(String(args[0])) ?? null : null;
      case 'HINCRBY': { const h = r.get(key) instanceof Map ? r.get(key) : new Map(); r.set(key, h); const v = Number(h.get(String(args[0])) || 0) + Number(args[1]); h.set(String(args[0]), String(v)); return v; }
      case 'HGETALL': return r.get(key) instanceof Map ? [...r.get(key).entries()].flat() : [];
      case 'SADD': { const s = r.get(key) instanceof Set ? r.get(key) : new Set(); r.set(key, s); let n = 0; for (const a of args) if (!s.has(String(a))) { s.add(String(a)); n += 1; } return n; }
      case 'SISMEMBER': return r.get(key) instanceof Set && r.get(key).has(String(args[0])) ? 1 : 0;
      default: return null;
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fake');
      const [, host, ...rest] = url.pathname.split('/');
      const path = `/${rest.join('/')}`;
      if (host === 'api.airtable.com') return await airtable(req, res, path, url);
      if (host === 'api-m.sandbox.paypal.com') return await paypal(req, res, path);
      if (host === 'redis.e2e.invalid') return await redis(req, res, path);
      if (host === 'api.sendgrid.com') { const b = await readBody(req); st.mails.push(b); return json(res, 202, {}); }
      json(res, 404, { error: 'unknown_host', host });
    } catch (e) {
      json(res, 500, { error: String(e?.message || e) });
    }
  });

  /** PayPal の承認画面で「同意して購読」を押した後の状態（支払い済み）にする */
  st.pay = (sid, amountYen) => {
    const s = st.subs[sid];
    s.status = 'ACTIVE';
    s.billing_info = { last_payment: { amount: { currency_code: 'JPY', value: String(amountYen) }, time: new Date().toISOString() } };
  };
  return { st, server };
}
