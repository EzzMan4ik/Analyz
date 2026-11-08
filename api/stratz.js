Claude



















Stratz · JS
// Прокси к STRATZ GraphQL API. Токен хранится только на сервере:
// Vercel → Settings → Environment Variables → STRATZ_TOKEN
// Запрос зафиксирован в коде (клиент передаёт только ID матча), поэтому
// чужие не смогут использовать ваш токен для произвольных запросов.
const q = (withPos) => `
query GaMatch($id: Long!) {
  match(id: $id) {
    id
    players {
      steamAccountId
      heroId
      isRadiant
      ${withPos ? 'position' : ''}
      role
      lane
      imp
      award
    }
  }
}`;
const QUERY_FULL = q(true), QUERY_SAFE = q(false);
 
// Позиция из роли и линии — на случай, если поля position нет в схеме
function posFromRoleLane(role, lane) {
    const r = String(role || '').toUpperCase(), l = String(lane || '').toUpperCase();
    if (r.indexOf('HARD') !== -1) return 5;
    if (r.indexOf('SUPPORT') !== -1) return 4;
    if (r.indexOf('CORE') !== -1) {
        if (l.indexOf('SAFE') !== -1) return 1;
        if (l.indexOf('MID') !== -1) return 2;
        if (l.indexOf('OFF') !== -1) return 3;
    }
    return null;
}
 
function posNum(v) {
    // STRATZ: POSITION_1 … POSITION_5 (иногда приходит просто число)
    if (typeof v === 'number' && v >= 1 && v <= 5) return v;
    const m = /(\d)/.exec(String(v || ''));
    const n = m ? parseInt(m[1], 10) : 0;
    return n >= 1 && n <= 5 ? n : null;
}
 
const URL_ = 'https://api.stratz.com/graphql';
const H_API = (t) => ({ 'Authorization': `Bearer ${t}`, 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'STRATZ_API' });
const H_BROWSER = (t) => ({ ...H_API(t), 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Origin': 'https://stratz.com', 'Referer': 'https://stratz.com/' });
 
// Один запрос с таймаутом. 403 от Cloudflare → одна повторная попытка с «браузерными» заголовками.
async function gql(token, query, variables) {
    let last = null;
    for (const mk of [H_API, H_BROWSER]) {
        const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 7000);
        try {
            const r = await fetch(URL_, { method: 'POST', signal: ctrl.signal, headers: mk(token), body: JSON.stringify({ query, variables }) });
            let body = null; try { body = await r.json(); } catch (e) { /* не JSON */ }
            last = { status: r.status, ok: r.ok, body };
            if (r.status !== 403) return last;
        } finally { clearTimeout(timer); }
    }
    return last;
}
 
module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
 
    const TOKEN = process.env.STRATZ_TOKEN;
    if (!TOKEN) return res.status(500).json({ error: 'STRATZ_TOKEN не настроен в Vercel Environment Variables (после добавления нужен Redeploy)' });
 
    // Диагностика: откройте в браузере  https://ВАШ-САЙТ/api/stratz?check=1
    if (req.query && req.query.check) {
        try {
            const r = await gql(TOKEN, '{ __typename }', {});
            const e = r.body && r.body.errors && r.body.errors[0] && r.body.errors[0].message;
            return res.status(200).json({ tokenSet: true, stratzHttp: r.status, ok: r.ok && !e, error: e || (r.ok ? null : 'HTTP ' + r.status) });
        } catch (err) { return res.status(200).json({ tokenSet: true, ok: false, error: err.name === 'AbortError' ? 'таймаут' : err.message }); }
    }
 
    const matchId = String((req.query && req.query.matchId) || '').trim();
    if (!/^\d{6,12}$/.test(matchId)) return res.status(400).json({ error: 'Недопустимый matchId' });
 
    try {
        let r = await gql(TOKEN, QUERY_FULL, { id: Number(matchId) });
        const msg = (r.body && r.body.errors && r.body.errors[0] && String(r.body.errors[0].message)) || '';
        if (msg && /position|Cannot query field/i.test(msg)) r = await gql(TOKEN, QUERY_SAFE, { id: Number(matchId) });   // поля position нет — берём роль+линию
 
        if (!r.body) return res.status(r.status === 429 ? 429 : 502).json({ error: 'STRATZ вернул HTTP ' + r.status + (r.status === 403 ? ' (доступ запрещён: проверьте токен)' : '') });
        if (r.status === 401) return res.status(502).json({ error: 'STRATZ: токен не принят (HTTP 401)' });
        if (r.body.errors && r.body.errors.length) {
            console.error('STRATZ errors:', JSON.stringify(r.body.errors).slice(0, 500));
            return res.status(502).json({ error: 'STRATZ GraphQL: ' + String(r.body.errors[0].message || 'ошибка').slice(0, 200) });
        }
        if (!r.ok) return res.status(r.status === 429 ? 429 : 502).json({ error: 'STRATZ вернул HTTP ' + r.status });
        const m = r.body.data && r.body.data.match;
        if (!m || !Array.isArray(m.players)) return res.status(404).json({ error: 'Матч не найден в STRATZ (возможно, ещё не обработан)' });
 
        const players = m.players.map(p => ({
            steamAccountId: p.steamAccountId != null ? Number(p.steamAccountId) : null,
            heroId: p.heroId != null ? Number(p.heroId) : null,
            pos: posNum(p.position) || posFromRoleLane(p.role, p.lane),
            role: p.role || null,
            lane: p.lane || null,
            imp: typeof p.imp === 'number' ? p.imp : null,
            award: p.award || null
        }));
        res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
        return res.status(200).json({ matchId: m.id, players });
    } catch (err) {
        return res.status(504).json({ error: err.name === 'AbortError' ? 'STRATZ не ответил за 7 секунд' : err.message });
    }
};
 
Ответ Claude завершен
