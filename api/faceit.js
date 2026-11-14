const { guard } = require('./_guard');

module.exports = async function handler(req, res) {
    if (!guard(req, res, 'faceit', 40)) return;

    const FACEIT_KEY = process.env.FACEIT_API_KEY;

    if (!FACEIT_KEY) {
        return res.status(500).json({ 
            error: 'FACEIT_API_KEY не настроен в Vercel Environment Variables' 
        });
    }

    const { path } = req.query;
    const pathStr = Array.isArray(path) 
        ? path.join('/') 
        : (path || '');

    // Защита ключа: разрешены только нужные сайту GET-запросы к FACEIT,
    // иначе этот прокси можно использовать как открытый доступ к API по вашему ключу.
    const ALLOWED = [
        /^matches\/[A-Za-z0-9-]{1,64}(\/stats)?$/,
        /^players(\/[A-Za-z0-9-]{1,64}(\/(stats\/cs2|games\/cs2\/stats|history))?)?$/,
        /^search\/players$/
    ];
    if (req.method !== 'GET' || !ALLOWED.some(re => re.test(pathStr))) {
        return res.status(400).json({ error: 'Недопустимый путь запроса' });
    }

    // Передаём дальше только безопасные числовые параметры (сайт использует limit/offset)
    const params = {};
    for (const k of ['limit', 'offset']) {
        const v = Array.isArray(req.query[k]) ? req.query[k][0] : req.query[k];
        if (v != null && /^\d{1,3}$/.test(String(v))) params[k] = String(v);
    }
    const qs = new URLSearchParams(params).toString();

    const url = `https://open.faceit.com/data/v4/${pathStr}${qs ? '?' + qs : ''}`;

    try {
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${FACEIT_KEY}`,
                'Accept': 'application/json'
            }
        });

        const data = await response.json();
        return res.status(response.status).json(data);

    } catch (err) {
        console.error('faceit proxy error:', err && err.message);
        return res.status(502).json({ error: 'FACEIT не отвечает. Попробуйте позже.' });
    }
}
