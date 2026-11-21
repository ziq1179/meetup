// Error reports and anonymous usage counters for Meetup.
// Events show up in Vercel runtime logs; GET /api/telemetry returns rough
// in-process totals (each serverless instance keeps its own counters).

const counters = new Map()
const hitsByIp = new Map()

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body)
    } catch {
      return null
    }
  }
  return null
}

function cleanProps(input) {
  const props = {}
  if (!input || typeof input !== 'object') return props
  for (const [key, value] of Object.entries(input).slice(0, 10)) {
    if (['string', 'number', 'boolean'].includes(typeof value)) {
      props[key.slice(0, 40)] = typeof value === 'string' ? value.slice(0, 120) : value
    }
  }
  return props
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, POST, OPTIONS')
    return res.status(204).end()
  }

  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      events: Object.fromEntries(counters),
    })
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const body = parseBody(req)
  if (!body || typeof body.name !== 'string' || !['error', 'event'].includes(body.type)) {
    return res.status(400).json({ error: 'Invalid payload' })
  }

  // Simple per-IP rate limit so a broken client cannot flood the logs
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown'
  const now = Date.now()
  const recent = (hitsByIp.get(ip) || []).filter((time) => time > now - 60000)
  if (recent.length >= 30) return res.status(429).json({ ok: false })
  recent.push(now)
  hitsByIp.set(ip, recent)
  if (hitsByIp.size > 500) hitsByIp.clear()

  const name = body.name.slice(0, 80)
  const short = (value, max) => (typeof value === 'string' ? value.slice(0, max) : undefined)
  const entry = {
    type: body.type,
    name,
    message: short(body.message, 500),
    stack: short(body.stack, 2000),
    props: cleanProps(body.props),
    ts: typeof body.ts === 'number' ? body.ts : now,
    sessionId: short(body.sessionId, 40),
    url: short(body.url, 120),
  }

  counters.set(name, (counters.get(name) || 0) + 1)
  console[entry.type === 'error' ? 'error' : 'log']('[telemetry] ' + JSON.stringify(entry))

  return res.status(202).json({ ok: true })
}
