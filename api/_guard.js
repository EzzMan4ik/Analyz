// Общая защита serverless-функций (файлы с «_» Vercel не публикует как адреса).
//  • запросы с чужих сайтов (по заголовкам Origin / Sec-Fetch-Site) отклоняются;
//  • лимит запросов с одного IP, чтобы нельзя было выбрать квоту ключей Steam / FACEIT / STRATZ;
//  • CORS не включаем: сайт обращается к /api с того же домена, чужим сайтам доступ не нужен.
// Лимит хранится в памяти экземпляра функции — это «лучшее возможное» без внешней базы;
// для жёсткой защиты дополнительно включите Vercel Firewall → Rate Limiting.

const WINDOW_MS = 60 * 1000;
const hits = new Map();

function clientIp(req) {
    const xf = String((req.headers && req.headers['x-forwarded-for']) || '');
    return (xf.split(',')[0] || (req.socket && req.socket.remoteAddress) || 'unknown').trim();
}

function hostOf(url) {
    try { return new URL(url).host; } catch (e) { return ''; }
}

// Разрешённые «внешние» адреса сайта через переменную ALLOWED_ORIGINS (через запятую), например:
// https://mysite.ru,https://www.mysite.ru. Тот же домен, с которого открыт сайт, разрешён всегда.
function originAllowed(req) {
    const origin = req.headers && req.headers.origin;
    const site = req.headers && req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') {
        // same-site/cross-site: пропускаем только явно разрешённые источники
        const extra = String(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
        return !!origin && extra.indexOf(origin) !== -1;
    }
    if (origin) {
        const host = String(req.headers.host || '');
        if (hostOf(origin) === host) return true;
        const extra = String(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
        return extra.indexOf(origin) !== -1;
    }
    return true;    // запросы без Origin (адресная строка, curl) — их ограничивает лимит
}

/**
 * Возвращает true, если запрос можно выполнять. Иначе сам отвечает ошибкой и возвращает false.
 * @param limit — сколько запросов в минуту разрешено с одного IP
 */
function guard(req, res, name, limit) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', res.getHeader('Cache-Control') || 'no-store');
    if (req.method === 'OPTIONS') { res.status(204).end(); return false; }
    if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return false; }
    if (!originAllowed(req)) { res.status(403).json({ error: 'Запрос с чужого сайта отклонён' }); return false; }

    const now = Date.now(), key = name + '|' + clientIp(req);
    let e = hits.get(key);
    if (!e || now - e.t > WINDOW_MS) e = { t: now, n: 0 };
    e.n++; hits.set(key, e);
    if (hits.size > 5000) { for (const [k, v] of hits) if (now - v.t > WINDOW_MS) hits.delete(k); }
    if (e.n > limit) {
        res.setHeader('Retry-After', String(Math.ceil((WINDOW_MS - (now - e.t)) / 1000)));
        res.status(429).json({ error: 'Слишком много запросов. Подождите минуту.' });
        return false;
    }
    return true;
}

module.exports = { guard };
