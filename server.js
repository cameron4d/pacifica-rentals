require('dotenv').config();

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');
const https = require('https');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));

const CLIENT_ID      = process.env.TABLEAU_CLIENT_ID;
const SECRET_ID      = process.env.TABLEAU_SECRET_ID;
const SECRET_VALUE   = process.env.TABLEAU_SECRET_VALUE;
const TABLEAU_USER   = process.env.TABLEAU_USER;
const TABLEAU_SERVER = process.env.TABLEAU_SERVER;
const TABLEAU_SITE   = process.env.TABLEAU_SITE;
const TABLEAU_API    = process.env.TABLEAU_API;

// ── Watched-metric allowlist ─────────────────────────────────────────────────
// Pulse metric UUIDs the COO dashboard cares about. The frontend reads this
// via /watched-metrics to scope the brief request.
const WATCHED_METRICS = [
  '27a7b6ba-c91d-4154-93a2-e127f7508b19',
  '989699c4-4050-4f71-9b1e-1ba7873707e1',
  'e2f640ba-b8de-4abf-ac8a-3e742e7482d7',
  'e5c65fcb-222a-4cc5-b488-5fa6c02f1f0b',
  'fd8489cb-e46b-4a9e-9c58-3b173a586552',
  'e40b7b51-eb8a-4dd9-8e0e-54f7589fc04e',
  'a36a26bc-747a-411f-be88-9f6289067162',
  '4d5f31b1-3e6b-48d0-8c9b-991bdc63b5de',
  'e2e2bcb8-5c76-4252-a22d-f193f8b4e8ef',
  '3ba2da8e-9c7d-4b08-9fe0-95efd9349514',
  'ee823389-9503-4aad-9ed5-12c2cd393ce8',
  'bca29b0b-793f-4645-bb9f-8fd98b4b1952',
  '0d185291-73f7-431a-816b-e7c3f6649341',
  '07ee59a8-3783-4ecd-b589-e4abfc29289e'
];

// ── JWT builder ──────────────────────────────────────────────────────────────
function generateJWT() {
  const header = Buffer.from(JSON.stringify({
    alg: 'HS256', typ: 'JWT', kid: SECRET_ID
  })).toString('base64url');

  const payload = Buffer.from(JSON.stringify({
    iss: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 300,
    jti: uuidv4(),
    aud: 'tableau',
    sub: TABLEAU_USER,
    scp: [
      'tableau:views:embed',
      'tableau:views:embed_authoring',
      'tableau:metrics_subscriptions:read',
      'tableau:content:read',
      'tableau:insights:embed',
      'tableau:insight_metrics:read',
      'tableau:insights:read',
      'tableau:auth:signin'
    ]
  })).toString('base64url');

  const signature = crypto
    .createHmac('sha256', SECRET_VALUE)
    .update(`${header}.${payload}`)
    .digest('base64url');

  return `${header}.${payload}.${signature}`;
}

// ── Cached Tableau REST session ──────────────────────────────────────────────
let tableauSession = null;

async function getTableauSession() {
  const now = Date.now();
  if (tableauSession && tableauSession.expiresAt > now + 60_000) return tableauSession;

  const jwt = generateJWT();
  console.log(`\n─── Tableau signin (site="${TABLEAU_SITE}") ───`);

  const res = await fetch(`${TABLEAU_SERVER}/api/${TABLEAU_API}/auth/signin`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ credentials: { jwt, site: { contentUrl: TABLEAU_SITE } } })
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Signin HTTP ${res.status}: ${text}`);

  const data   = JSON.parse(text);
  const token  = data.credentials?.token;
  const siteId = data.credentials?.site?.id;

  if (!token) throw new Error(`No token in signin response: ${text}`);
  console.log(`✔ Session acquired siteId=${siteId}`);

  tableauSession = { token, siteId, expiresAt: now + 3.5 * 60 * 60 * 1000 };
  return tableauSession;
}

// ── VizQL Data Service helpers (direct Tableau REST) ─────────────────────────
async function vizqlReadMetadata(datasourceLuid) {
  const session = await getTableauSession();
  const url     = `${TABLEAU_SERVER}/api/v1/vizql-data-service/read-metadata`;
  const r = await fetch(url, {
    method:  'POST',
    headers: {
      'X-Tableau-Auth': session.token,
      'Content-Type':  'application/json',
      Accept:          'application/json'
    },
    body: JSON.stringify({ datasource: { datasourceLuid } })
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`vizql read-metadata HTTP ${r.status}: ${text.substring(0, 300)}`);
  return JSON.parse(text);
}

async function vizqlQueryDatasource(datasourceLuid, query) {
  const session = await getTableauSession();
  const url     = `${TABLEAU_SERVER}/api/v1/vizql-data-service/query-datasource`;
  const r = await fetch(url, {
    method:  'POST',
    headers: {
      'X-Tableau-Auth': session.token,
      'Content-Type':  'application/json',
      Accept:          'application/json'
    },
    body: JSON.stringify({ datasource: { datasourceLuid }, query })
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`vizql query-datasource HTTP ${r.status}: ${text.substring(0, 300)}`);
  const parsed = JSON.parse(text);
  return parsed.data ?? parsed.rows ?? parsed.results ?? [];
}

// ── Pulse insight bundle (direct Tableau REST) ───────────────────────────────
async function pulseInsightBundle(bundleRequest, bundleType = 'detail') {
  const session = await getTableauSession();
  const url     = `${TABLEAU_SERVER}/api/-/pulse/insights/${bundleType}`;
  const r = await fetch(url, {
    method:  'POST',
    headers: {
      'X-Tableau-Auth': session.token,
      'Content-Type':  'application/json',
      Accept:          'application/json'
    },
    body: JSON.stringify(bundleRequest)
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`pulse insights/${bundleType} HTTP ${r.status}: ${text.substring(0, 300)}`);
  return JSON.parse(text);
}

// ── Fetch Pulse metrics via direct Tableau REST ──────────────────────────────
async function getPulseMetricsDirect(session) {
  const headers = {
    'X-Tableau-Auth': session.token,
    'Content-Type':  'application/json',
    Accept:          'application/json'
  };

  const probes = [
    {
      method: 'POST',
      url:    `${TABLEAU_SERVER}/api/-/pulse/metrics`,
      body:   JSON.stringify({ page: { page_size: 50 } })
    },
    {
      method: 'POST',
      url:    `${TABLEAU_SERVER}/api/-/pulse/metrics`,
      body:   JSON.stringify({})
    },
    {
      method: 'POST',
      url:    `${TABLEAU_SERVER}/api/-/pulse/metrics:search`,
      body:   JSON.stringify({ page: { page_size: 50 } })
    },
    {
      method: 'GET',
      url:    `${TABLEAU_SERVER}/api/-/pulse/subscriptions`,
      body:   null
    },
    {
      method: 'GET',
      url:    `${TABLEAU_SERVER}/api/-/pulse/subscriptions?page_size=50`,
      body:   null
    }
  ];

  for (const probe of probes) {
    console.log(`\n── Direct probe: ${probe.method} ${probe.url}`);
    try {
      const opts = { method: probe.method, headers };
      if (probe.body) opts.body = probe.body;

      const r    = await fetch(probe.url, opts);
      const body = await r.text();
      console.log(`HTTP ${r.status} — ${body.length} chars — snippet: ${body.substring(0, 200)}`);

      if (r.ok) {
        console.log('✔ Direct API succeeded');
        return { source: probe.url, data: body };
      }

      if (r.status === 403 && probe.url.includes('subscriptions')) {
        console.log('403 on subscriptions — user likely has no Pulse subscriptions set up');
      }
    } catch (e) {
      console.error(`Fetch error: ${e.message}`);
    }
  }

  return null;
}

// ── Strip markdown code fences ────────────────────────────────────────────────
function stripCodeFences(text) {
  if (!text) return text;
  text = text.replace(/^```(?:html|xml)?\s*\n?/i, '');
  text = text.replace(/\n?```\s*$/,               '');
  text = text.replace(/```(?:html|xml)?/gi, '');
  text = text.replace(/```/g, '');
  return text.trim();
}

// ── Convert any surviving markdown fragments to HTML ──────────────────────────
function markdownToHtml(text) {
  if (!text) return '';
  if (/<(p|h[1-6]|ul|ol|div|strong|em)\b/i.test(text)) return text;
  return text
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g,     '<strong>$1</strong>')
    .replace(/__(.+?)__/g,          '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,         '<em>$1</em>')
    .replace(/`([^`]+)`/g,         '<code>$1</code>')
    .replace(/^### (.+)$/gm,       '<h3>$1</h3>')
    .replace(/^## (.+)$/gm,        '<h2>$1</h2>')
    .replace(/^# (.+)$/gm,         '<h2>$1</h2>')
    .replace(/^[-*+] (.+)$/gm,     '<li>$1</li>')
    .replace(/(<li>[\s\S]+?<\/li>)/g, '<ul>$1</ul>')
    .replace(/\n{2,}/g,            '</p><p>')
    .replace(/^(?!<)/gm,           '<p>')
    .replace(/(?<!>)$/gm,          '</p>')
    .replace(/<p><\/p>/g,          '')
    .replace(/<p>(<h[23]>)/g,      '$1')
    .replace(/(<\/h[23]>)<\/p>/g,  '$1');
}

// ── /watched-metrics ──────────────────────────────────────────────────────────
app.get('/watched-metrics', (req, res) => res.json({ metricIds: WATCHED_METRICS }));

// ── /config — expose non-secret env vars to the client ───────────────────────
app.get('/config', (req, res) => res.json({
  tableauServer:    TABLEAU_SERVER,
  tableauSite:      TABLEAU_SITE,
  safetyMetricId:   SAFETY_METRIC_ID
}));

// ── /token ────────────────────────────────────────────────────────────────────
app.get('/token', (req, res) => res.json({ token: generateJWT() }));

// ── /session-token ────────────────────────────────────────────────────────────
app.get('/session-token', async (req, res) => {
  try {
    const session = await getTableauSession();
    res.json({
      token:  session.token,
      siteId: session.siteId,
      server: TABLEAU_SERVER,
      site:   TABLEAU_SITE
    });
  } catch (err) {
    console.error('session-token error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── /tableau-proxy ────────────────────────────────────────────────────────────
app.all('/tableau-proxy/*path', async (req, res) => {
  let targetURL = '(not yet constructed)';

  try {
    const session = await getTableauSession();

    let capture = req.params.path;
    if (Array.isArray(capture)) capture = capture.join('/');
    const tableauPath = capture
      ? `/${capture}`
      : req.path.replace(/^\/tableau-proxy/, '');

    const query   = Object.keys(req.query).length
      ? '?' + new URLSearchParams(req.query).toString()
      : '';
    targetURL = `${TABLEAU_SERVER}${tableauPath}${query}`;

    console.log(`\n── Proxy: ${req.method} ${targetURL}`);

    const opts = {
      method:  req.method,
      headers: {
        'X-Tableau-Auth': session.token,
        'Content-Type':  'application/json',
        Accept:          'application/json'
      }
    };

    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
      opts.body = JSON.stringify(req.body);
    }

    const upstream = await fetch(targetURL, opts);
    const body     = await upstream.text();

    console.log(`Proxy response: HTTP ${upstream.status} — ${body.length} chars`);

    if (upstream.status === 401) tableauSession = null;

    res
      .status(upstream.status)
      .type(upstream.headers.get('content-type') || 'application/json')
      .send(body);

  } catch (err) {
    const cause = err.cause;
    console.error(`\n✘ Proxy error`);
    console.error(`  targetURL : ${targetURL}`);
    console.error(`  message   : ${err.message}`);
    console.error(`  cause     : ${cause?.code ?? cause?.message ?? String(cause ?? '—')}`);

    res.status(502).json({
      error:     err.message,
      cause:     cause?.code ?? cause?.message ?? String(cause ?? 'unknown'),
      targetURL,
      hint:      'Check server.js terminal — targetURL and cause are logged above.'
    });
  }
});

// ── /debug-safety-fields ──────────────────────────────────────────────────────
app.get('/debug-safety-fields', async (req, res) => {
  try {
    const meta = await vizqlReadMetadata(SAFETY_DATASOURCE_LUID);
    res.json(meta);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /debug-auth ───────────────────────────────────────────────────────────────
app.get('/debug-auth', async (req, res) => {
  const out = {};

  try {
    const r        = await fetch(`${TABLEAU_SERVER}/api/${TABLEAU_API}/serverinfo`,
      { headers: { Accept: 'application/json' } });
    out.serverInfo = { status: r.status, body: JSON.parse(await r.text()) };
  } catch (e) {
    out.serverInfo = { error: e.message };
  }

  let session = null;
  try {
    session    = await getTableauSession();
    out.signin = { ok: true, siteId: session.siteId };
  } catch (e) {
    out.signin = { ok: false, error: e.message };
    return res.json(out);
  }

  const probes = [
    { method: 'POST', url: `${TABLEAU_SERVER}/api/-/pulse/metrics`,
      body: JSON.stringify({ page: { page_size: 10 } }) },
    { method: 'POST', url: `${TABLEAU_SERVER}/api/-/pulse/metrics`,
      body: JSON.stringify({}) },
    { method: 'POST', url: `${TABLEAU_SERVER}/api/-/pulse/metrics:search`,
      body: JSON.stringify({ page: { page_size: 10 } }) },
    { method: 'GET',  url: `${TABLEAU_SERVER}/api/-/pulse/subscriptions`, body: null },
    { method: 'GET',  url: `${TABLEAU_SERVER}/api/-/pulse/metrics?page_size=10`, body: null },
  ];

  out.pulseProbes = [];
  for (const probe of probes) {
    try {
      const opts = {
        method:  probe.method,
        headers: { 'X-Tableau-Auth': session.token, 'Content-Type': 'application/json',
                   Accept: 'application/json' }
      };
      if (probe.body) opts.body = probe.body;

      const r    = await fetch(probe.url, opts);
      const body = await r.text();
      out.pulseProbes.push({
        method:  probe.method,
        url:     probe.url,
        status:  r.status,
        snippet: body.substring(0, 500)
      });
    } catch (e) {
      out.pulseProbes.push({ method: probe.method, url: probe.url, error: e.message });
    }
  }

  res.json(out);
});

// ── /pulse-metrics ────────────────────────────────────────────────────────────
app.get('/pulse-metrics', async (req, res) => {
  let session;
  try {
    session = await getTableauSession();
  } catch (err) {
    return res.status(502).json({ error: 'Tableau signin failed', detail: err.message });
  }

  const direct = await getPulseMetricsDirect(session);
  if (direct) {
    console.log(`✔ Returning direct API data from ${direct.source}`);
    return res.type('application/json').send(direct.data);
  }

  return res.status(502).json({
    error: 'Pulse data fetch failed.',
    hint: [
      '1. Check /debug-auth — look for the first 2xx status.',
      '2. Confirm your user has metrics subscribed in Tableau Pulse.',
      '3. Confirm the Connected App has tableau:metrics_subscriptions:read scope.'
    ],
    debug: '/debug-auth'
  });
});

// ── /tableau/auth — connection check for the Pulse Bundle Tester ─────────────
app.get('/tableau/auth', async (req, res) => {
  try {
    const session = await getTableauSession();
    res.json({
      ok:           true,
      siteId:       session.siteId,
      tokenPreview: session.token.substring(0, 12) + '…'
    });
  } catch (e) {
    console.error('[Pulse Tester] Auth check failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── /tableau/pulse/insights/:bundleType — proxy for Pulse Bundle Tester ───────
const VALID_BUNDLE_TYPES = ['ban', 'springboard', 'basic', 'exploration', 'breakdown', 'detail', 'brief'];

app.post('/tableau/pulse/insights/:bundleType', async (req, res) => {
  const { bundleType } = req.params;

  if (!VALID_BUNDLE_TYPES.includes(bundleType)) {
    return res.status(400).json({ error: `Invalid bundle type: "${bundleType}"` });
  }

  try {
    const session    = await getTableauSession();
    const tableauUrl = `${TABLEAU_SERVER}/api/-/pulse/insights/${bundleType}`;
    console.log(`[Pulse Tester] ${bundleType} → ${tableauUrl}`);

    const r = await fetch(tableauUrl, {
      method:  'POST',
      headers: {
        'Content-Type':   'application/json',
        Accept:           'application/json',
        'X-Tableau-Auth': session.token
      },
      body: JSON.stringify(req.body)
    });

    const data = await r.json();

    // If Tableau rejects the token, clear the cache so next call re-authenticates
    if (r.status === 401) tableauSession = null;

    res.status(r.status).json(data);
  } catch (e) {
    console.error(`[Pulse Tester] Proxy error (${bundleType}):`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Pulse Brief (server-side) — mirrors pulse-brief-utils.js ─────────────────
const SAFETY_METRIC_ID = process.env.SAFETY_METRIC_ID;

async function callPulseBriefDirect(session, metricIds, content) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Tableau-Auth': session.token
  };

  const metricsRes = await fetch(`${TABLEAU_SERVER}/api/-/pulse/metrics:batchGet`, {
    method: 'POST', headers,
    body: JSON.stringify({ metric_ids: metricIds })
  });
  if (!metricsRes.ok) throw new Error(`metrics:batchGet HTTP ${metricsRes.status}`);
  const metrics = (await metricsRes.json()).metrics || [];
  if (!metrics.length) throw new Error('No metrics returned from batchGet');

  const defIds = [...new Set(metrics.map(m => m.definition_id).filter(Boolean))];
  const defsRes = await fetch(`${TABLEAU_SERVER}/api/-/pulse/definitions:batchGet`, {
    method: 'POST', headers,
    body: JSON.stringify({ definition_ids: defIds })
  });
  if (!defsRes.ok) throw new Error(`definitions:batchGet HTTP ${defsRes.status}`);
  const definitions = (await defsRes.json()).definitions || [];

  const defMap = {};
  definitions.forEach(d => { defMap[d.metadata.id] = d; });

  const contexts = metrics.map(m => {
    const def = defMap[m.definition_id];
    if (!def) return null;
    const spec = JSON.parse(JSON.stringify(m.specification));
    if (spec.comparison && Array.isArray(spec.comparison.comparison_period_override)
        && spec.comparison.comparison_period_override.length === 0) {
      delete spec.comparison.comparison_period_override;
    }
    const repOpts = JSON.parse(JSON.stringify(def.representation_options));
    delete repOpts.positive_only;
    if (repOpts.type === 'NUMBER_FORMAT_TYPE_PERCENT') {
      delete repOpts.number_units;
      delete repOpts.currency_code;
    } else if (repOpts.type === 'NUMBER_FORMAT_TYPE_NUMBER') {
      if (!repOpts.number_units) repOpts.number_units = { singular_noun: '', plural_noun: '' };
      if (repOpts.currency_code === 'CURRENCY_CODE_UNSPECIFIED') delete repOpts.currency_code;
    }
    return {
      metadata: { name: def.metadata.name, metric_id: m.id, definition_id: m.definition_id },
      metric: {
        definition: {
          datasource: def.specification.datasource,
          basic_specification: def.specification.basic_specification,
          is_running_total: def.specification.is_running_total
        },
        metric_specification: spec,
        extension_options: def.extension_options,
        representation_options: repOpts,
        insights_options: def.insights_options,
        candidates: []
      }
    };
  }).filter(Boolean);

  const payload = {
    messages: [{
      role: 'ROLE_USER',
      content,
      metric_group_context: contexts,
      metric_group_context_resolved: false,
      action_type: 'ACTION_TYPE_ANSWER'
    }],
    time_zone: 'America/New_York',
    language: 'LANGUAGE_EN_US',
    locale: 'LOCALE_EN_US'
  };

  const briefRes = await fetch(`${TABLEAU_SERVER}/api/-/pulse/insights/brief`, {
    method: 'POST', headers, body: JSON.stringify(payload)
  });
  if (!briefRes.ok) throw new Error(`insights/brief HTTP ${briefRes.status}: ${await briefRes.text()}`);
  return briefRes.json();
}

async function callPulseSpringboardFiltered(session, metricId, marketArea, allowedDimensions = null) {
  const headers = {
    'Content-Type': 'application/json',
    Accept:         'application/json',
    'X-Tableau-Auth': session.token
  };

  // Fetch metric + definition to build the full input shape
  const metricsRes = await fetch(`${TABLEAU_SERVER}/api/-/pulse/metrics:batchGet`, {
    method: 'POST', headers,
    body: JSON.stringify({ metric_ids: [metricId] })
  });
  if (!metricsRes.ok) throw new Error(`metrics:batchGet HTTP ${metricsRes.status}`);
  const metrics = (await metricsRes.json()).metrics || [];
  if (!metrics.length) throw new Error('No metric returned');
  const metric = metrics[0];

  const defsRes = await fetch(`${TABLEAU_SERVER}/api/-/pulse/definitions:batchGet`, {
    method: 'POST', headers,
    body: JSON.stringify({ definition_ids: [metric.definition_id] })
  });
  if (!defsRes.ok) throw new Error(`definitions:batchGet HTTP ${defsRes.status}`);
  const definitions = (await defsRes.json()).definitions || [];
  if (!definitions.length) throw new Error('No definition returned');
  const def = definitions[0];

  // Clone metric spec and inject the market area filter
  const spec = JSON.parse(JSON.stringify(metric.specification));
  spec.filters = spec.filters || [];
  spec.filters.push({
    field:             'market_area',
    operator:          'OPERATOR_EQUAL',
    categorical_values: [{ string_value: marketArea }]
  });
  if (spec.comparison?.comparison_period_override?.length === 0) {
    delete spec.comparison.comparison_period_override;
  }

  const extOpts = JSON.parse(JSON.stringify(def.extension_options));
  if (allowedDimensions) {
    // Use the caller-specified dimension list, but always keep market_area for the filter to work
    extOpts.allowed_dimensions = [...new Set([...allowedDimensions, 'market_area'])];
  } else if (!extOpts.allowed_dimensions.includes('market_area')) {
    extOpts.allowed_dimensions.push('market_area');
  }

  const repOpts = JSON.parse(JSON.stringify(def.representation_options));
  delete repOpts.positive_only;
  if (repOpts.type === 'NUMBER_FORMAT_TYPE_NUMBER') {
    if (!repOpts.number_units) repOpts.number_units = { singular_noun: '', plural_noun: '' };
    if (repOpts.currency_code === 'CURRENCY_CODE_UNSPECIFIED') delete repOpts.currency_code;
  }

  const payload = {
    bundle_request: {
      version: 1,
      options: {
        output_format: 'OUTPUT_FORMAT_TEXT',
        time_zone:     'America/New_York',
        language:      'LANGUAGE_EN_US',
        locale:        'LOCALE_EN_US'
      },
      input: {
        metadata: {
          name:          def.metadata.name,
          metric_id:     metric.id,
          definition_id: metric.definition_id
        },
        metric: {
          definition: {
            datasource:          def.specification.datasource,
            basic_specification: def.specification.basic_specification,
            is_running_total:    def.specification.is_running_total
          },
          metric_specification:   spec,
          extension_options:      extOpts,
          representation_options: repOpts,
          insights_options:       def.insights_options,
          candidates:             []
        }
      }
    }
  };

  const springboardRes = await fetch(`${TABLEAU_SERVER}/api/-/pulse/insights/springboard`, {
    method:  'POST',
    headers: {
      'Content-Type':   'application/vnd.tableau.pulse.insightsservice.v1.GenerateInsightBundleSpringboardRequest+json',
      Accept:           'application/json',
      'X-Tableau-Auth': session.token
    },
    body: JSON.stringify(payload)
  });
  if (!springboardRes.ok) throw new Error(`insights/springboard HTTP ${springboardRes.status}: ${await springboardRes.text()}`);
  return springboardRes.json();
}

// ── Pulse insight helpers — extract structured data without an LLM ────────────
function pickTopBreakdownDimension(briefBody, dimensionKeyword) {
  const lower = dimensionKeyword.toLowerCase();
  const insights = (briefBody.source_insights || []).filter(ins => {
    const q = (ins.question || ins.markup || '').toLowerCase();
    return q.includes(lower);
  });

  for (const ins of insights) {
    const facts = ins.facts?.target_period_value?.dimensions
              || ins.result?.facts?.target_period_value?.dimensions
              || [];
    if (Array.isArray(facts) && facts.length) {
      const top = [...facts].sort((a, b) => (b.value || 0) - (a.value || 0))[0];
      const name = top?.values?.[0]?.string_value || top?.value_name || top?.name;
      if (name) return name;
    }

    const markup = ins.markup || ins.result?.markup || '';
    const m = markup.match(new RegExp(`<strong>([^<]+)</strong>[^<]*${dimensionKeyword}`, 'i'))
          || markup.match(new RegExp(`${dimensionKeyword}[^<]*<strong>([^<]+)</strong>`, 'i'));
    if (m) return m[1].trim();
  }
  return null;
}

function joinPulseMarkup(briefBody, filterFn) {
  const insights = (briefBody.source_insights || []).filter(filterFn || (() => true));
  return insights.map(i => i.markup || i.result?.markup || '').filter(Boolean).join('\n\n');
}

// ── /safety-pulse-summary ─────────────────────────────────────────────────────
// Renders Tableau Pulse insights directly. Pulse already produces an AI-written
// narrative server-side; this route extracts the headline + top market area
// without a second LLM round-trip.
app.get('/safety-pulse-summary', async (req, res) => {
  try {
    const session = await getTableauSession();

    const briefBody = await callPulseBriefDirect(
      session,
      [SAFETY_METRIC_ID],
      'What are the key trends and changes for this safety metric? Which Market Areas are contributing the most to the incident count?'
    );

    const headlineMarkup =
        briefBody.markup
     || briefBody.brief?.summary
     || briefBody.messages?.[0]?.content
     || joinPulseMarkup(briefBody, ins => !(ins.question || '').toLowerCase().includes('market area'))
     || '';

    const marketAreaMarkup = joinPulseMarkup(briefBody, ins =>
      (ins.question || ins.markup || '').toLowerCase().includes('market area')
    );

    const topMarketArea = pickTopBreakdownDimension(briefBody, 'market area');

    const headlineHtml = markdownToHtml(headlineMarkup);
    const marketAreaHtml = topMarketArea
      ? `<p><strong>Top Market Area:</strong> ${topMarketArea}</p>`
      : `<p><strong>Top Market Area:</strong> Not available.</p>`;

    const summary = `${headlineHtml}\n${marketAreaHtml}${
      marketAreaMarkup ? `\n<details><summary>Market Area details</summary>${markdownToHtml(marketAreaMarkup)}</details>` : ''
    }`;

    // Fetch filtered Pulse insights for the top market area
    let filteredSummary = null;
    if (topMarketArea && topMarketArea !== 'unknown') {
      try {
        // First call: general springboard filtered to market area
        const springboard = await callPulseSpringboardFiltered(session, SAFETY_METRIC_ID, topMarketArea);
        const bundle      = springboard.bundle_response?.result || springboard;
        const insights    = bundle.insights || bundle.springboard_insights || [];
        const springboardText = insights
          .map(i => i.markup || i.result?.markup || i.viz?.markup || '')
          .filter(Boolean).join('\n\n') || JSON.stringify(bundle).substring(0, 1000);

        // Second call: BAN bundle — returns top insight per filterable dimension incl. ROOT_CAUSE
        let rootCauseText = '';
        try {
          const metric = (await (await fetch(`${TABLEAU_SERVER}/api/-/pulse/metrics:batchGet`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Tableau-Auth': session.token },
            body: JSON.stringify({ metric_ids: [SAFETY_METRIC_ID] })
          })).json()).metrics?.[0];

          const def = (await (await fetch(`${TABLEAU_SERVER}/api/-/pulse/definitions:batchGet`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Tableau-Auth': session.token },
            body: JSON.stringify({ definition_ids: [metric.definition_id] })
          })).json()).definitions?.[0];

          const spec = JSON.parse(JSON.stringify(metric.specification));
          spec.filters = spec.filters || [];
          spec.filters.push({ field: 'market_area', operator: 'OPERATOR_EQUAL', categorical_values: [{ string_value: topMarketArea }] });
          if (spec.comparison?.comparison_period_override?.length === 0) delete spec.comparison.comparison_period_override;

          const extOpts = JSON.parse(JSON.stringify(def.extension_options));
          // Put ROOT_CAUSE first so the detail bundle's breakdown group targets it
          const rcDim = extOpts.allowed_dimensions.find(d => d.toLowerCase().includes('root_cause') || d.toLowerCase() === 'root cause');
          if (rcDim) {
            extOpts.allowed_dimensions = [rcDim, ...extOpts.allowed_dimensions.filter(d => d !== rcDim)];
          }
          if (!extOpts.allowed_dimensions.includes('market_area')) extOpts.allowed_dimensions.push('market_area');

          const repOpts = JSON.parse(JSON.stringify(def.representation_options));
          delete repOpts.positive_only;
          if (repOpts.type === 'NUMBER_FORMAT_TYPE_NUMBER') {
            if (!repOpts.number_units) repOpts.number_units = { singular_noun: '', plural_noun: '' };
            if (!repOpts.currency_code) repOpts.currency_code = 'CURRENCY_CODE_UNSPECIFIED';
          }

          const banPayload = {
            bundle_request: {
              version: 1,
              options: { output_format: 'OUTPUT_FORMAT_TEXT', time_zone: 'America/New_York', language: 'LANGUAGE_EN_US', locale: 'LOCALE_EN_US' },
              input: {
                metadata: { name: def.metadata.name, metric_id: metric.id, definition_id: metric.definition_id },
                metric: {
                  definition: { datasource: def.specification.datasource, basic_specification: def.specification.basic_specification, is_running_total: def.specification.is_running_total },
                  metric_specification:   spec,
                  extension_options:      extOpts,
                  representation_options: repOpts,
                  insights_options:       def.insights_options,
                  candidates:             []
                }
              }
            }
          };

          const banParsed = await pulseInsightBundle(banPayload, 'detail');
          const banBundle   = banParsed.bundle_response?.result || banParsed;
          const banGroups   = banBundle.insight_groups || [];
          const sourceGroup = banGroups.find(g => g.type === 'breakdown');
          rootCauseText     = (sourceGroup?.insights || [])
            .map(i => i.result?.markup || i.markup || '').filter(Boolean).join('\n\n');
        } catch (e) {
          console.warn('BAN bundle root cause failed:', e.message);
        }

        let topRootCause = null;
        const rcMatch = rootCauseText.match(/<strong>([^<]+)<\/strong>/i)
                     || rootCauseText.match(/^([^\n,—\-:]+?)(?:\s+(?:accounts|contributes|drives|is|with|—|-))/im);
        if (rcMatch) topRootCause = rcMatch[1].trim();

        const filteredHtml = [
          markdownToHtml(springboardText),
          topRootCause
            ? `<p><strong>Top Root Cause:</strong> ${topRootCause}</p>`
            : `<p><strong>Top Root Cause:</strong> Not available.</p>`,
          rootCauseText ? `<details><summary>Root cause details</summary>${markdownToHtml(rootCauseText)}</details>` : ''
        ].filter(Boolean).join('\n');

        filteredSummary = { html: filteredHtml, topRootCause };
      } catch (e) {
        console.warn('Filtered springboard failed:', e.message);
        filteredSummary = { html: `<p><em>Could not load filtered insights: ${e.message}</em></p>`, topRootCause: null };
      }
    }

    res.json({ summary, topMarketArea, filteredSummary, raw: briefBody });
  } catch (e) {
    console.error('/safety-pulse-summary error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const SAFETY_DATASOURCE_LUID = process.env.SAFETY_DATASOURCE_LUID;

// ── /safety-incidents — VizQL Data Service ───────────────────────────────────
app.get('/safety-incidents', async (req, res) => {
  try {
    const rows = await vizqlQueryDatasource(SAFETY_DATASOURCE_LUID, {
      fields: [
        { fieldCaption: 'Incident number' },
        { fieldCaption: 'Division' },
        { fieldCaption: 'Zone' },
        { fieldCaption: 'Market Area' },
        { fieldCaption: 'Location Name' },
        { fieldCaption: 'Facility Type' },
        { fieldCaption: 'Description Of Location' },
        { fieldCaption: 'Date of incident' },
        { fieldCaption: 'Time Of Incident' },
        { fieldCaption: 'Involved Employee Id' },
        { fieldCaption: 'Involved Employee Title' },
        { fieldCaption: 'Incident Type' },
        { fieldCaption: 'Was A Motor Vehicle Involved' },
        { fieldCaption: 'Date Reported' },
        { fieldCaption: 'How Did The Injury Occur' },
        { fieldCaption: 'What Was The Injury Or Illness' },
        { fieldCaption: 'Description Of Incident' },
        { fieldCaption: 'Root Cause' },
        { fieldCaption: 'Initial Root Cause' },
        { fieldCaption: 'Why_Did_This_Occur__Why' },
        { fieldCaption: 'Why_Did_This_Occur__Why1' }
      ]
    });
    const records = Array.isArray(rows) ? rows.filter(r => r['Incident number']) : [];
    res.json(records);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Theme extraction (no-LLM substitute for narrative root-cause analysis) ───
const THEME_STOPWORDS = new Set([
  'the','and','for','with','from','that','this','was','were','have','has','had',
  'not','but','out','its','his','her','they','them','their','about','into','onto',
  'over','than','then','what','when','where','which','while','will','would','could',
  'should','been','being','also','only','very','some','more','most','other','because',
  'while','because','during','due','any','all','one','two','three','off','him','she',
  'employee','incident','customer','vehicle','car','area','location','time','day','date'
]);

function extractTokens(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !THEME_STOPWORDS.has(w));
}

function topThemes(records, fields, n = 5) {
  const freq = new Map();
  for (const r of records) {
    const text = fields.map(f => r[f] || '').join(' ');
    const seen = new Set();
    for (const tok of extractTokens(text)) {
      if (seen.has(tok)) continue;
      seen.add(tok);
      freq.set(tok, (freq.get(tok) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([term, count]) => ({ term, count }));
}

function buildRcaHtml({ heading, periodLabel, marketArea, totalIncidents, themes, topMarketAreaSummary }) {
  const themeList = themes.length
    ? `<ul>${themes.map(t => `<li><strong>${t.term}</strong> — appears in ${t.count} incident${t.count === 1 ? '' : 's'}</li>`).join('')}</ul>`
    : '<p><em>Not enough text in root-cause fields to identify themes.</em></p>';

  return [
    topMarketAreaSummary || '',
    `<h3>${heading}</h3>`,
    `<p>Analyzed <strong>${totalIncidents}</strong> incidents${marketArea ? ` in <strong>${marketArea}</strong>` : ''} for ${periodLabel}.</p>`,
    `<h3>Recurring Themes in Root-Cause Text</h3>`,
    themeList,
    `<p><em>Themes are surfaced by frequency analysis of the Initial Root Cause and Why fields. Review the underlying incidents in Tableau for full context.</em></p>`
  ].filter(Boolean).join('\n');
}

function parseCSVLine(line) {
  const result = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      result.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

// ── /safety-rca — root cause analysis for a specific market area ──────────────
app.get('/safety-rca', async (req, res) => {
  const { marketArea, rootCause } = req.query;
  if (!marketArea) return res.status(400).json({ error: 'marketArea query param required' });

  try {
    const now        = new Date();
    const quarter    = Math.ceil((now.getMonth() + 1) / 3);
    const periodLabel = `Q${quarter} ${now.getFullYear()}`;

    const rows = await vizqlQueryDatasource(SAFETY_DATASOURCE_LUID, {
      fields: [
        { fieldCaption: 'Incident number' },
        { fieldCaption: 'Initial Root Cause' },
        { fieldCaption: 'Why_Did_This_Occur__Why' },
        { fieldCaption: 'Why_Did_This_Occur__Why1' }
      ],
      filters: [
        {
          field: { fieldCaption: 'Market Area' },
          filterType: 'SET',
          values: [marketArea],
          exclude: false
        },
        ...(rootCause ? [{
          field: { fieldCaption: 'Root Cause' },
          filterType: 'SET',
          values: [rootCause],
          exclude: false
        }] : []),
        {
          field: { fieldCaption: 'New Date' },
          filterType: 'DATE',
          periodType: 'QUARTERS',
          dateRangeType: 'CURRENT'
        }
      ]
    });
    const records = Array.isArray(rows) ? rows.filter(r => r['Incident number']) : [];

    if (!records.length) {
      return res.status(404).json({ error: `No incidents found for "${marketArea}" in ${periodLabel}` });
    }

    const rcaEntries = records
      .map(r => ({
        incident: r['Incident number'],
        initial:  r['Initial Root Cause']?.trim(),
        why:      r['Why_Did_This_Occur__Why']?.trim(),
        why1:     r['Why_Did_This_Occur__Why1']?.trim()
      }))
      .filter(r => r.initial || r.why || r.why1);

    const themes = topThemes(rcaEntries, ['initial', 'why', 'why1'], 5);
    const analysis = buildRcaHtml({
      heading:        `Key Investigation Areas — ${marketArea}${rootCause ? ` / ${rootCause}` : ''}`,
      periodLabel,
      marketArea,
      totalIncidents: records.length,
      themes
    });

    res.json({
      analysis,
      marketArea,
      rootCause:       rootCause || null,
      periodLabel,
      totalIncidents:  records.length,
      recordsAnalyzed: rcaEntries.length
    });
  } catch (e) {
    console.error('/safety-rca error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── /safety-full-rca — full dataset RCA, Claude finds top market area ─────────
app.get('/safety-full-rca', async (req, res) => {
  try {
    const now         = new Date();
    const quarter     = Math.ceil((now.getMonth() + 1) / 3);
    const periodLabel = `Q${quarter} ${now.getFullYear()}`;

    const rows = await vizqlQueryDatasource(SAFETY_DATASOURCE_LUID, {
      fields: [
        { fieldCaption: 'Incident number' },
        { fieldCaption: 'Market Area' },
        { fieldCaption: 'Initial Root Cause' },
        { fieldCaption: 'Why_Did_This_Occur__Why' },
        { fieldCaption: 'Why_Did_This_Occur__Why1' }
      ],
      filters: [
        {
          field: { fieldCaption: 'New Date' },
          filterType: 'DATE',
          periodType: 'QUARTERS',
          dateRangeType: 'CURRENT'
        }
      ]
    });
    const records = Array.isArray(rows) ? rows.filter(r => r['Incident number']) : [];

    if (!records.length) {
      return res.status(404).json({ error: `No incidents found for ${periodLabel}` });
    }

    const byArea = new Map();
    for (const r of records) {
      const a = r['Market Area'] || 'Unknown';
      byArea.set(a, (byArea.get(a) || 0) + 1);
    }
    const topAreaEntry = [...byArea.entries()].sort((a, b) => b[1] - a[1])[0];
    const topMarketArea = topAreaEntry?.[0] || 'Unknown';
    const topAreaCount  = topAreaEntry?.[1] || 0;

    const topAreaRecords = records.filter(r => (r['Market Area'] || 'Unknown') === topMarketArea);
    const themes = topThemes(
      topAreaRecords.map(r => ({
        initial: r['Initial Root Cause'],
        why:     r['Why_Did_This_Occur__Why'],
        why1:    r['Why_Did_This_Occur__Why1']
      })),
      ['initial', 'why', 'why1'],
      5
    );

    const analysis = buildRcaHtml({
      heading:        'Key Investigation Areas',
      periodLabel,
      marketArea:     topMarketArea,
      totalIncidents: topAreaCount,
      themes,
      topMarketAreaSummary:
        `<h3>Highest-Incident Market Area</h3><p><strong>${topMarketArea}</strong> with <strong>${topAreaCount}</strong> incident${topAreaCount === 1 ? '' : 's'} in ${periodLabel} (out of ${records.length} total).</p>`
    });

    res.json({
      analysis,
      periodLabel,
      recordsAnalyzed: records.length,
      topMarketArea
    });
  } catch (e) {
    console.error('/safety-full-rca error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.use(express.static(path.join(__dirname)));

// Use HTTPS locally, HTTP in production (Railway provides HTTPS)
const PORT = process.env.PORT || 5500;
const useHTTPS = fs.existsSync('key.pem') && fs.existsSync('cert.pem');

if (useHTTPS) {
  const options = {
    key:  fs.readFileSync('key.pem'),
    cert: fs.readFileSync('cert.pem')
  };
  https.createServer(options, app).listen(PORT, () => {
    console.log(`Running at https://localhost:${PORT}`);
    console.log('Diagnostics:');
    console.log(`  https://localhost:${PORT}/debug-auth     ← probes POST variants`);
    console.log(`  https://localhost:${PORT}/session-token  ← REST token for browser use`);
    console.log(`  https://localhost:${PORT}/tableau-proxy/ ← CORS-safe Tableau API proxy`);
  });
} else {
  app.listen(PORT, () => {
    console.log(`Running at http://localhost:${PORT}`);
    console.log('(HTTPS certificates not found - using HTTP.)');
    console.log('Diagnostics:');
    console.log(`  http://localhost:${PORT}/debug-auth`);
    console.log(`  http://localhost:${PORT}/session-token`);
    console.log(`  http://localhost:${PORT}/tableau-proxy/`);
  });
}
