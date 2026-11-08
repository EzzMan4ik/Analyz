// Steam Web API: поиск профиля по имени и статистика CS 2.
// Нужна переменная окружения STEAM_API_KEY (бесплатно: https://steamcommunity.com/dev/apikey)
const STEAM = 'https://api.steampowered.com';

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const key = process.env.STEAM_API_KEY;
    if (!key) return res.status(500).json({ error: 'STEAM_API_KEY не настроен в Vercel Environment Variables' });

    const { action, vanity, steamid } = req.query || {};

    try {
        // Имя из ссылки steamcommunity.com/id/<имя> → SteamID64
        if (action === 'resolve') {
            if (!vanity || !/^[A-Za-z0-9_\-]{2,32}$/.test(vanity)) {
                return res.status(400).json({ error: 'Некорректное имя профиля' });
            }
            const r = await fetch(`${STEAM}/ISteamUser/ResolveVanityURL/v1/?key=${key}&vanityurl=${encodeURIComponent(vanity)}`);
            const j = await r.json();
            if (j.response && j.response.success === 1) return res.status(200).json({ steamid: j.response.steamid });
            return res.status(404).json({ error: 'Профиль не найден' });
        }

        // Статистика CS 2 (appid 730)
        if (action === 'cs2') {
            if (!/^\d{17}$/.test(steamid || '')) return res.status(400).json({ error: 'Некорректный SteamID64' });

            const summaryP = fetch(`${STEAM}/ISteamUser/GetPlayerSummaries/v2/?key=${key}&steamids=${steamid}`)
                .then(r => r.json()).catch(() => null);
            const statsP = fetch(`${STEAM}/ISteamUserStats/GetUserStatsForGame/v2/?appid=730&key=${key}&steamid=${steamid}`)
                .then(async r => ({ status: r.status, json: r.ok ? await r.json() : null }))
                .catch(() => ({ status: 0, json: null }));
            const input = encodeURIComponent(JSON.stringify({ steamid, include_played_free_games: true, appids_filter: [730] }));
            const ownedP = fetch(`${STEAM}/IPlayerService/GetOwnedGames/v1/?key=${key}&input_json=${input}`)
                .then(r => r.json()).catch(() => null);

            const [summary, stats, owned] = await Promise.all([summaryP, statsP, ownedP]);

            const profile = summary && summary.response && summary.response.players && summary.response.players[0];
            if (!profile) return res.status(404).json({ error: 'Профиль Steam не найден' });

            let statsMap = null, statsError = null;
            if (stats.json && stats.json.playerstats && Array.isArray(stats.json.playerstats.stats)) {
                statsMap = {};
                for (const s of stats.json.playerstats.stats) statsMap[s.name] = s.value;
            } else {
                statsError = (stats.status === 403 || stats.status === 500 || profile.communityvisibilitystate !== 3) ? 'private' : 'empty';
            }

            const game = owned && owned.response && owned.response.games && owned.response.games[0];
            res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
            return res.status(200).json({
                profile: {
                    personaname: profile.personaname,
                    avatarmedium: profile.avatarmedium,
                    profileurl: profile.profileurl,
                    communityvisibilitystate: profile.communityvisibilitystate
                },
                stats: statsMap,
                statsError,
                playtime: game ? { forever: game.playtime_forever || 0, twoWeeks: game.playtime_2weeks || 0 } : {}
            });
        }

        return res.status(400).json({ error: 'Неизвестное действие' });
    } catch (e) {
        return res.status(500).json({ error: 'Ошибка сервера Steam: ' + e.message });
    }
};
