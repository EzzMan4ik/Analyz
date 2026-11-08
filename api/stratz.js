// Прокси к STRATZ GraphQL API. Токен хранится только на сервере:
// Vercel → Settings → Environment Variables → STRATZ_TOKEN
// Запрос зафиксирован в коде (клиент передаёт только ID матча), поэтому
// чужие не смогут использовать ваш токен для произвольных запросов.
const MATCH_QUERY = `
query GaMatch($id: Long!) {
  match(id: $id) {
    id
    players {
      steamAccountId
      heroId
      isRadiant
      position
      role
      lane
      imp
      award
    }
  }
}`;

function posNum(v) {
    // STRATZ: POSITION_1 … POSITION_5 (иногда приходит просто число)
    if (typeof v === 'number' && v >= 1 && v <= 5) return v;
    const m = /(\d)/.exec(String(v || ''));
    const n = m ? parseInt(m[1], 10) : 0;
    return n >= 1 && n <= 5 ? n : null;
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const TOKEN = process.env.STRATZ_TOKEN;
    if (!TOKEN) return res.status(500).json({ error: 'STRATZ_TOKEN не настроен в Vercel Environment Variables' });

    const matchId = String((req.query && req.query.matchId) || '').trim();
    if (!/^\d{6,12}$/.test(matchId)) return res.status(400).json({ error: 'Недопустимый matchId' });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
        const r = await fetch('https://api.stratz.com/graphql', {
            method: 'POST',
            signal: ctrl.signal,
            headers: {
                'Authorization': `Bearer ${TOKEN}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'STRATZ_API'          // STRATZ требует непустой User-Agent
            },
            body: JSON.stringify({ query: MATCH_QUERY, variables: { id: Number(matchId) } })
        });
        let body = null;
        try { body = await r.json(); } catch (e) { /* не JSON */ }
        if (!r.ok || !body) {
            return res.status(r.status === 429 ? 429 : 502).json({ error: 'STRATZ вернул HTTP ' + r.status });
        }
        if (body.errors && body.errors.length) {
            // Чаще всего — поле схемы изменилось. Сообщение видно в логах Vercel и в ответе.
            console.error('STRATZ errors:', JSON.stringify(body.errors).slice(0, 500));
            return res.status(502).json({ error: 'STRATZ GraphQL: ' + String(body.errors[0].message || 'ошибка').slice(0, 200) });
        }
        const m = body.data && body.data.match;
        if (!m || !Array.isArray(m.players)) return res.status(404).json({ error: 'Матч не найден в STRATZ' });

        const players = m.players.map(p => ({
            steamAccountId: p.steamAccountId != null ? Number(p.steamAccountId) : null,
            heroId: p.heroId != null ? Number(p.heroId) : null,
            pos: posNum(p.position),
            role: p.role || null,
            lane: p.lane || null,
            imp: typeof p.imp === 'number' ? p.imp : null,
            award: p.award || null
        }));
        res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
        return res.status(200).json({ matchId: m.id, players });
    } catch (err) {
        return res.status(504).json({ error: err.name === 'AbortError' ? 'STRATZ не ответил за 8 секунд' : err.message });
    } finally {
        clearTimeout(timer);
    }
};
