module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

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

    const params = { ...req.query };
    delete params.path;
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
        return res.status(500).json({ error: err.message });
    }
}
