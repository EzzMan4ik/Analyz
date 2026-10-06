module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY не настроен' });

    const { game, stats } = req.body || {};
    if (!game || !stats) return res.status(400).json({ error: 'Нет данных' });

    let prompt = '';

    if (game === 'dota2') {
        prompt = `Ты профессиональный тренер по Dota 2 с 10-летним опытом работы с про-командами.

Проанализируй этот матч:
- Герой: ${stats.hero}, Позиция: ${stats.position}
- K/D/A: ${stats.kills}/${stats.deaths}/${stats.assists}
- GPM: ${stats.gpm} (норма: ${stats.gpmBenchmark})
- XPM: ${stats.xpm} (норма: ${stats.xpmBenchmark})
- Ластхиты 10/20/30 мин: ${stats.lh10}/${stats.lh20}/${stats.lh30}
- Норма про: ${stats.benchLh10}/${stats.benchLh20}/${stats.benchLh30}
- Урон по героям: ${stats.heroDamage}, по башням: ${stats.towerDamage}
- APM: ${stats.apm}, Участие в убийствах: ${stats.kp}%
- Результат: ${stats.won ? 'Победа' : 'Поражение'}, Длительность: ${stats.duration}

Дай детальный анализ на русском:

**ГЛАВНАЯ ПРОБЛЕМА МАТЧА:**
[одно главное что тянуло вниз]

**РАЗБОР ПО ПОКАЗАТЕЛЯМ:**
[разбери GPM, фарм, смерти, участие]

**СРАВНЕНИЕ С ПРО-СЦЕНОЙ:**
[сравни с реальными про-игроками на этой позиции]

**ЧТО УЛУЧШИТЬ (топ-3):**
1. [проблема и решение]
2. [проблема и решение]
3. [проблема и решение]

**ПЛАН ТРЕНИРОВКИ:**
[конкретные упражнения на неделю]`;
    }

    if (game === 'cs2') {
        prompt = `Ты профессиональный тренер по CS2 с опытом в Tier-1 командах.

Проанализируй матч:
- Карта: ${stats.map}
- K/D/A: ${stats.kills}/${stats.deaths}/${stats.assists}
- KD: ${stats.kd}, ADR: ${stats.adr}, HS%: ${stats.hs}%
- Утилити дамаг: ${stats.utilDmg}, Flash ассисты: ${stats.flashAssists}
- Entry убийства: ${stats.entryKills} (WR: ${stats.entryWr}%)
- Роль: ${stats.role}
- Похожий про: ${stats.similarPro} (${stats.similarTeam}), схожесть: ${stats.matchPct}%
- Результат: ${stats.won ? 'Победа' : 'Поражение'}, Раундов: ${stats.rounds}

Дай детальный анализ на русском:

**ГЛАВНАЯ ПРОБЛЕМА МАТЧА:**
[одно главное что мешало]

**РАЗБОР СТИЛЯ ИГРЫ:**
[детально разбери стиль, сравни с про-сценой]

**ПРИЦЕЛИВАНИЕ И ПОЗИЦИОНИРОВАНИЕ:**
[анализ HS%, смертей, позиционирования]

**УТИЛИТИ И КОМАНДНАЯ ИГРА:**
[анализ гранат, флэшей]

**ЧТО УЛУЧШИТЬ (топ-3):**
1. [проблема — решение за 1 неделю]
2. [проблема — решение за 1 неделю]
3. [проблема — решение за 1 неделю]

**ПЛАН ТРЕНИРОВКИ:**
[aim_botz, dm, retake с временем и целями]`;
    }

    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.7,
                    maxOutputTokens: 1200
                }
            })
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error?.message || 'Gemini API ошибка');
        }

        const data = await response.json();
        const analysis = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Анализ недоступен';

        return res.status(200).json({ analysis });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};
