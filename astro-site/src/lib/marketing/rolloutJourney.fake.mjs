/**
 * rolloutJourney.fake.mjs — 統合テスト用の**偽の世界**（Airtable / Redis / SendGrid）
 *
 * 実運用の 3 つの外部依存を、状態を持つ偽物で置き換える。
 * これで `cron-marketing-rollout` を**本物のまま**何十 tick も回し、
 * Step1 → Step24 → 完了 が人手ゼロで進むかを見られる。
 *
 * ⚠️ **判定ロジックは 1 つも真似しない。** ここが持つのは保管と反映だけ:
 *      - Airtable … 4 テーブルの行（作成 / 更新 / 名指し取得）
 *      - Redis    … GET/SET/DEL と、実際に使われている 3 種類の Lua の意味
 *      - SendGrid … 受理して数えるだけ
 *    誰に何を送るか・止めるかは**本物のコード**が決める。
 *
 * ⚠️ 実メールは 1 通も出ない（SendGrid は偽物）。
 */

const AIRTABLE = 'https://api.airtable.com/v0/';

/**
 * 行 id を決定的に振る（テストが毎回同じ結果になるように）。
 * ⚠️ **本物と同じ形**（`rec` + 英数 14 文字）にする。形が違うと本物側の検証が
 *    `campaign_delivery_id_invalid` で弾き、送信 0 になる（この偽物で実際に踏んだ）。
 */
let seq = 0;
const nextId = (tag) => `rec${tag}${String(seq += 1).padStart(14 - tag.length, '0')}`;

/**
 * Airtable の式を**実際に評価する**（テスト専用の小さな評価器）。
 *
 * 「引用符の中身と一致する行を返す」程度の雑な再現だと、
 * `FIND('customer-import:', {Source}) = 1` のような前方一致が落ちて
 * **対象 0 件**になり、テストが「動いていないのに緑」になる。
 * 実際に使われている構文だけを、意味どおりに評価する。
 */
function makeMatcher(formula) {
  const src = String(formula || '').trim();
  if (!src) return () => true;
  // {Field} → F("Field") / BLANK() → ''
  const js = src
    .replace(/\{([^}]+)\}/g, (_, name) => `F(${JSON.stringify(name)})`)
    .replace(/\bBLANK\(\)/g, "''")
    .replace(/!=/g, '!==')
    .replace(/([^=!<>])=([^=])/g, '$1===$2');
  let fn;
  try {
    // eslint-disable-next-line no-new-func -- テスト専用。式は自分たちのコードが作ったもの
    fn = new Function(
      'F', 'AND', 'OR', 'NOT', 'FIND', 'IS_AFTER', 'IS_BEFORE', 'TODAY', 'NOW',
      'DATETIME_DIFF', 'TRUE', 'FALSE', 'LOWER', 'UPPER', 'IF', 'DATETIME_FORMAT',
      `return (${js});`,
    );
  } catch {
    return () => true;   // 読めない式は絞り込まない（件数の意味は本物側が判定する）
  }
  return (fields) => {
    const F = (name) => {
      const v = (fields || {})[name];
      if (v === undefined || v === null) return '';
      return v;
    };
    const truthy = (v) => !!v && v !== '' && v !== 0;
    try {
      return !!fn(
        F,
        (...a) => a.every(truthy),
        (...a) => a.some(truthy),
        (a) => !truthy(a),
        (needle, hay) => String(hay || '').indexOf(String(needle)) + 1,
        (a, b) => Date.parse(a) > Date.parse(b),
        (a, b) => Date.parse(a) < Date.parse(b),
        () => new Date().toISOString(),
        () => new Date().toISOString(),
        (a, b) => (Date.parse(a) - Date.parse(b)) / 86400000,
        () => true,
        () => false,
        (v) => String(v || '').toLowerCase(),
        (v) => String(v || '').toUpperCase(),
        (c, a, b) => (truthy(c) ? a : b),
        (v) => String(v || ''),
      );
    } catch {
      return true;       // 評価できない条件で行を落とさない
    }
  };
}

export function createWorld({ people = [], nowRef = { ms: Date.now() } } = {}) {
  const tables = {
    Customers: people.map((p) => ({
      id: p.recordId,
      fields: {
        Email: p.email,
        プラン: p.plan || 'Free',
        Source: p.source || 'customer-import:imp-2026-08-09-001',
        ...(p.fields || {}),
      },
    })),
    ScheduledEmails: [],
    CampaignDeliveries: [],
    EmailBlacklist: [],
  };
  const redis = new Map();
  const sent = [];           // { to, subject }
  const calls = { airtable: 0, sendgrid: 0, background: 0 };
  /** 送信を「途中で止める」ための細工（分割再開の検証に使う） */
  let sendLimit = Infinity;
  let sendFailFor = () => false;

  const table = (url) => {
    const m = /\/v0\/[^/]+\/([^/?]+)/.exec(url);
    return m ? decodeURIComponent(m[1]) : null;
  };

  const ok = (body) => ({ ok: true, status: 200, json: async () => body });

  /** 式を評価して行を絞る（**本物と同じ意味**で絞れないと、テストが嘘をつく） */
  function selectRows(name, formula) {
    const rows = tables[name] || [];
    if (!formula) return rows;
    const match = makeMatcher(formula);
    return rows.filter((r) => match(r.fields || {}));
  }

  async function airtable(url, init) {
    calls.airtable += 1;
    const name = table(url);
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : {};
    const rows = tables[name] || [];

    // listRecords（長い式は POST で来る）
    if (/\/listRecords$/.test(url)) {
      const f = body.filterByFormula || '';
      return ok({ records: selectRows(name, f) });
    }
    if (method === 'GET') {
      const u = new URL(url);
      const f = u.searchParams.get('filterByFormula') || '';
      const picked = selectRows(name, f);
      return ok({ records: picked });
    }
    if (method === 'POST') {
      // upsert（DeliveryKey で突き合わせ）か、素の作成
      const mergeOn = body.performUpsert && body.performUpsert.fieldsToMergeOn;
      const created = [];
      // ⚠️ Airtable は**単票作成 `{fields}`** と**まとめ `{records:[...]}`** の両方を受ける。
      //    片方しか見ないと「作成したつもりで 1 行も増えない」状態になり、
      //    テストが「送った」と誤認する（この偽物を作ったときに実際にそうなった）。
      const incoming = Array.isArray(body.records) ? body.records
        : (body.fields ? [{ fields: body.fields }] : []);
      for (const rec of incoming) {
        if (mergeOn && mergeOn.includes('DeliveryKey')) {
          const key = rec.fields.DeliveryKey;
          const found = rows.find((r) => r.fields.DeliveryKey === key);
          if (found) { Object.assign(found.fields, rec.fields); created.push(found); continue; }
        }
        const row = { id: nextId(name === 'ScheduledEmails' ? 'JOB' : 'DEL'), fields: { ...rec.fields } };
        rows.push(row);
        created.push(row);
      }
      // 単票で来たときは単票で返す（呼び出し側は `res.id` を読む）
      if (!Array.isArray(body.records) && created.length === 1) return ok(created[0]);
      return ok({ records: created });
    }
    if (method === 'PATCH') {
      // ⚠️ Airtable の upsert は **PATCH + performUpsert**（POST ではない）。
      //    ここを取りこぼすと配信台帳が 1 行も増えず、
      //    dispatcher が「送る相手がいない」と正しく判断して止まる（＝送信 0 になる）。
      const upsertOn = body.performUpsert && body.performUpsert.fieldsToMergeOn;
      if (upsertOn) {
        const out = [];
        for (const rec of body.records || []) {
          const key = upsertOn[0];
          const found = rows.find((r) => r.fields[key] && r.fields[key] === rec.fields[key]);
          if (found) { Object.assign(found.fields, rec.fields); out.push(found); continue; }
          const row = { id: nextId('DEL'), fields: { ...rec.fields } };
          rows.push(row);
          out.push(row);
        }
        return ok({ records: out });
      }
      // 単票 PATCH（URL 末尾が recordId）と、まとめ PATCH の両方
      const single = /\/(rec[A-Za-z0-9]+)$/.exec(url);
      if (single) {
        const row = rows.find((r) => r.id === single[1]);
        if (row) Object.assign(row.fields, body.fields || {});
        return ok({ id: single[1], fields: row ? row.fields : {} });
      }
      const updated = [];
      for (const rec of body.records || []) {
        const row = rows.find((r) => r.id === rec.id);
        if (row) { Object.assign(row.fields, rec.fields); updated.push(row); }
      }
      return ok({ records: updated });
    }
    return ok({ records: [] });
  }

  /** 偽 Redis。**実際に使われている 3 種類の Lua の意味**だけを再現する */
  async function redisCmd(args) {
    const op = String(args[0]).toUpperCase();
    if (op === 'GET') return redis.has(args[1]) ? redis.get(args[1]) : null;
    if (op === 'SET') {
      // SET k v NX EX n（排他）と素の SET を区別する
      if (args.includes('NX')) {
        if (redis.has(args[1])) return null;
        redis.set(args[1], String(args[2]));
        return 'OK';
      }
      redis.set(args[1], String(args[2]));
      return 'OK';
    }
    if (op === 'DEL') { redis.delete(args[1]); return 1; }
    if (op === 'EXPIRE') return 1;
    // 排他の fencing token（**単調増加**が要件。ここを返さないと lock が取れない）
    if (op === 'INCR') {
      const n = (Number(redis.get(args[1])) || 0) + 1;
      redis.set(args[1], String(n));
      return n;
    }
    if (op === 'SADD') { return 1; }
    if (op === 'EVAL') {
      const script = String(args[1]);
      const key = args[3];
      // ① 展開状態の CAS
      if (script.includes('CONFLICT')) {
        const cur = redis.get(key);
        const expected = String(args[5] ?? '');
        if (cur) {
          const m = /"version":(\d+)/.exec(cur);
          if (!m || m[1] !== expected) return 'CONFLICT';
        } else if (expected !== '') return 'MISSING';
        redis.set(key, args[4]);
        return 'OK';
      }
      // ② 排他の確認 / 解放 / 延長（token 照合）
      if (script.includes('LOST') || script.includes('STOLEN')) {
        const cur = redis.get(key);
        if (!cur) return 'LOST';
        if (cur !== String(args[4])) return 'STOLEN';
        if (script.includes('DEL')) redis.delete(key);
        return 'OK';
      }
      // ③ 集計の加算（既存値へ足す）
      const delta = JSON.parse(args[4] || '{}');
      const cur = redis.get(key) ? JSON.parse(redis.get(key)) : { schema: Number(args[5]) };
      if (script.includes('steps')) {
        cur.steps = cur.steps || {};
        for (const [step, m] of Object.entries(delta)) {
          const prev = cur.steps[step] || { sent: 0, failed: 0, opened: 0, clicked: 0, queued: 0 };
          cur.steps[step] = {
            sent: prev.sent + (m.sent || 0), failed: prev.failed + (m.failed || 0),
            opened: prev.opened + (m.opened || 0), clicked: prev.clicked + (m.clicked || 0),
            queued: prev.queued + (m.queued || 0),
          };
        }
      } else {
        for (const [k, v] of Object.entries(delta)) {
          if (typeof v === 'number') cur[k] = (Number(cur[k]) || 0) + v;
        }
      }
      cur.schema = Number(args[5]);
      cur.updatedAtMs = Number(args[6]) || null;
      redis.set(key, JSON.stringify(cur));
      return 'OK';
    }
    return null;
  }

  /** 差し替える fetch。Airtable / SendGrid / Background を振り分ける */
  function makeFetch({ onBackground }) {
    return async (url, init = {}) => {
      const u = String(url);
      if (u.startsWith(AIRTABLE)) return airtable(u, init);
      if (u.includes('api.sendgrid.com')) {
        calls.sendgrid += 1;
        // ⚠️ **送信だけを数える。** 抑制リスト照会（GET /v3/suppression/...）を
        //    送信として数えると「送っていないのに送った」ことになる。
        if (!/\/v3\/mail\/send$/.test(u) || (init.method || 'GET').toUpperCase() !== 'POST') {
          return { ok: true, status: 200, json: async () => ({ result: [] }), text: async () => '[]' };
        }
        const payload = JSON.parse(init.body || '{}');
        const to = payload.personalizations?.[0]?.to?.[0]?.email || '';
        if (sendFailFor(to)) return { ok: false, status: 400, text: async () => 'rejected', json: async () => ({}) };
        if (sent.length >= sendLimit) {
          // 送信基盤が詰まった状況（この起動では以降送らない）
          return { ok: false, status: 429, text: async () => 'slow down', json: async () => ({}) };
        }
        sent.push({ to, subject: payload.subject });
        return { ok: true, status: 202, json: async () => ({}), text: async () => '' };
      }
      if (u.includes('marketing-campaign-dispatch-background')) {
        calls.background += 1;
        const body = JSON.parse(init.body || '{}');
        await onBackground(body);
        return { ok: true, status: 202, json: async () => ({}), text: async () => '' };
      }
      if (u.includes('upstash') || u.includes('redis') || u.includes('.invalid')) {
        return { ok: true, status: 200, json: async () => ({ result: await redisCmd(JSON.parse(init.body || '[]')) }) };
      }
      throw new Error(`予期しない外部呼び出し: ${u}`);
    };
  }

  return {
    tables, redis, sent, calls, redisCmd, makeFetch,
    /** その人の状態を変える（購入・配信停止など。**本物の判定に効かせる**） */
    setCustomer(recordId, fields) {
      const row = tables.Customers.find((r) => r.id === recordId);
      if (row) Object.assign(row.fields, fields);
    },
    addToBlacklist(email, type = 'unsubscribe') {
      tables.EmailBlacklist.push({ id: nextId('BL'), fields: { Email: email, Type: type } });
    },
    /** この起動では N 通までしか受け付けない（分割再開の検証） */
    limitSends(n) { sendLimit = n; },
    clearSendLimit() { sendLimit = Infinity; },
    failSendsFor(fn) { sendFailFor = fn; },
    jobs() { return tables.ScheduledEmails.map((r) => ({ id: r.id, ...r.fields })); },
    deliveries() { return tables.CampaignDeliveries.map((r) => ({ id: r.id, ...r.fields })); },
    nowRef,
  };
}

export default createWorld;
