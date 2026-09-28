// api/cs2-match.js
export default async function handler(req, res) {
    const matchId = req.query.matchId;
    const apiKey = process.env.FACEIT_API_KEY;
    
    if (!matchId) return res.status(400).json({ error: 'matchId required' });
    if (!apiKey) return res.status(500).json({ error: 'FACEIT_API_KEY not set' });
    
    try {
        const resp = await fetch(`https://open.faceit.com/data/v4/matches/${matchId}`, {
            headers: { 'Authorization': 'Bearer ' + apiKey }
        });
        if (!resp.ok) {
            const text = await resp.text();
            return res.status(resp.status).json({ error: `FACEIT API error: ${resp.status}` });
        }
        const data = await resp.json();
        res.setHeader('Cache-Control', 's-maxage=3600');
        return res.status(200).json(data);
    } catch(e) {
        return res.status(500).json({ error: e.message });
    }
}
