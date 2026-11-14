/*!
 * GamerAnalyzer — движок разбора матчей (без нейросети).
 *
 * Идея: алгоритм считает ФАКТЫ (процентили, отклонения от личной нормы,
 * частоту смертей, видение, entry-дуэли и т.д.), проверяет набор правил,
 * ранжирует найденные проблемы по важности и выдаёт конкретные упражнения.
 *
 * Каждое правило необязательно: если нужных данных нет (матч не распарсен,
 * FACEIT не вернул поле), правило просто пропускается — движок не падает.
 *
 * Работает и в браузере (window.GA), и в Node (require) — для тестов.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GA = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Утилиты                                                             */
  /* ------------------------------------------------------------------ */
  function isNum(v) { return v !== undefined && v !== null && v !== '' && isFinite(parseFloat(v)); }
  function num(v, d) { return isNum(v) ? parseFloat(v) : (d === undefined ? 0 : d); }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function round(x, n) { var m = Math.pow(10, n || 0); return Math.round(x * m) / m; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // нормальная функция распределения (Abramowitz–Stegun)
  function normCdf(z) {
    var t = 1 / (1 + 0.2316419 * Math.abs(z));
    var d = 0.3989423 * Math.exp(-z * z / 2);
    var p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }
  function pctDiff(value, base) { return base ? Math.round((value - base) / base * 100) : 0; }
  function lowerFirst(s) { s = String(s); return /^[A-ZА-ЯЁ]{2,}/.test(s) || /^[A-Z]\//.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1); }
  function plural(n, one, few, many) {
    var a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }

  /* ------------------------------------------------------------------ */
  /* Общая часть: правила → отчёт                                        */
  /* ------------------------------------------------------------------ */
  function finish(items, opts) {
    var problems = items.filter(function (i) { return i.kind === 'problem'; })
      .sort(function (a, b) { return b.severity - a.severity; });
    var strengths = items.filter(function (i) { return i.kind === 'strength'; })
      .sort(function (a, b) { return b.severity - a.severity; });
    var notes = items.filter(function (i) { return i.kind === 'note'; });

    var plan = [];
    problems.slice(0, 3).forEach(function (p) {
      if (p.drill && plan.indexOf(p.drill) === -1) plan.push(p.drill);
    });

    return {
      all: items,
      title: opts.title || 'Разбор тренера',
      score: opts.score == null ? null : { value: opts.score, label: scoreLabel(opts.score) },
      summary: opts.summary || '',
      main: problems[0] || null,
      problems: problems.slice(0, 5),
      strengths: strengths.slice(0, 4),
      notes: notes.slice(0, 4),
      plan: plan,
      foot: opts.foot || ''
    };
  }
  function scoreLabel(s) {
    if (s < 35) return 'Слабый матч';
    if (s < 50) return 'Ниже среднего';
    if (s < 65) return 'Средний матч';
    if (s < 80) return 'Хороший матч';
    return 'Отличный матч';
  }
  function P(id, severity, title, text, drill) { return { id: id, kind: 'problem', severity: Math.round(severity), title: title, text: text, drill: drill }; }
  function S(id, severity, title, text) { return { id: id, kind: 'strength', severity: Math.round(severity), title: title, text: text }; }
  function N(id, title, text) { return { id: id, kind: 'note', severity: 0, title: title, text: text }; }

  /* ------------------------------------------------------------------ */
  /* DOTA 2                                                              */
  /* ------------------------------------------------------------------ */

  // Ориентиры про-уровня (на случай, если OpenDota не отдал benchmarks)
  var DOTA_PRO = {
    1: { lh10: 50, lh20: 150, lh30: 250, gpm: 700, xpm: 680, blink: 18 },
    2: { lh10: 45, lh20: 130, lh30: 200, gpm: 650, xpm: 720, blink: 12 },
    3: { lh10: 30, lh20: 80, lh30: 150, gpm: 500, xpm: 480, blink: 13 },
    4: { lh10: 15, lh20: 40, lh30: 80, gpm: 400, xpm: 380, blink: 20 },
    5: { lh10: 10, lh20: 25, lh30: 50, gpm: 350, xpm: 320, blink: 25 }
  };
  var DOTA_POS_NAMES = { 1: 'Керри', 2: 'Мид', 3: 'Оффлейнер', 4: 'Саппорт', 5: 'Хард-саппорт' };

  function isRadiantSlot(p) { return num(p && p.player_slot, 0) < 128; }

  /** Был ли матч распарсен OpenDota (есть поминутные данные). */
  function isDotaParsed(match) {
    if (!match) return false;
    if (match.version != null) return true;
    if (match.od_data && match.od_data.has_parsed) return true;
    return (match.players || []).some(function (p) { return Array.isArray(p.lh_t) && p.lh_t.length > 0; });
  }

  /**
   * Позиции 1–5 для всех 10 игроков матча. Каждой команде достаётся ровно по одной
   * позиции каждого номера. heroInfo(id) → { roles: [...] } (из heroStats), может отсутствовать.
   * Возвращает массив { pos, approx } в порядке match.players.
   */
  function assignDotaPositions(players, heroInfo) {
    players = Array.isArray(players) ? players : [];
    heroInfo = heroInfo || function () { return null; };
    var out = players.map(function () { return { pos: null, approx: true }; });
    [true, false].forEach(function (rad) {
      var team = [];
      players.forEach(function (p, i) { if (isRadiantSlot(p) === rad) team.push(i); });
      if (!team.length) return;
      function farm(i) { var p = players[i]; return num(p.net_worth) > 0 ? num(p.net_worth) : num(p.gold_per_min) * 40 + num(p.last_hits); }
      function roles(i) { var h = heroInfo(players[i].hero_id); return (h && h.roles) || []; }
      function supportish(i) { var r = roles(i); return r.some(function (x) { return x.indexOf('Support') !== -1; }) && r.indexOf('Carry') === -1; }
      var free = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 }, left = team.slice();
      function take(i, pos, exact) { out[i] = { pos: pos, approx: !exact }; delete free[pos]; left.splice(left.indexOf(i), 1); }
      var hasLanes = team.every(function (i) { return isNum(players[i].lane_role) && num(players[i].lane_role) > 0; });
      if (hasLanes) {
        // линия известна (распарсенный матч): внутри линии самый «фармящий» — кор, второй — саппорт
        var byLane = { 1: [], 2: [], 3: [], 4: [] };
        team.forEach(function (i) { var lr = num(players[i].lane_role); (byLane[lr] || byLane[4]).push(i); });
        Object.keys(byLane).forEach(function (k) { byLane[k].sort(function (x, y) { return farm(y) - farm(x); }); });
        var coreOf = { 1: 1, 2: 2, 3: 3 }, supOf = { 1: 5, 2: 4, 3: 4 };
        [2, 1, 3].forEach(function (lr) {
          var l = byLane[lr];
          if (l.length && free[coreOf[lr]] && !(l.length > 1 && supportish(l[0]) && !supportish(l[1]))) take(l[0], coreOf[lr], true);
          else if (l.length > 1 && free[coreOf[lr]] && supportish(l[0])) take(l[1], coreOf[lr], true);
        });
        [1, 3, 2, 4].forEach(function (lr) {
          byLane[lr].forEach(function (i) {
            if (left.indexOf(i) === -1) return;
            var want = lr === 1 ? 5 : 4;
            if (free[want]) take(i, want, true);
          });
        });
      }
      // всё, что осталось, — по фарму: самый богатый получает свободную позицию с меньшим номером
      var order = left.slice().sort(function (x, y) { return farm(y) - farm(x); });
      var slots = Object.keys(free).map(Number).sort(function (x, y) { return x - y; });
      // керри — тот из двух самых богатых, у кого есть роль Carry (второй — скорее мид)
      if (slots[0] === 1 && slots[1] === 2 && order.length > 1 &&
          roles(order[0]).indexOf('Carry') === -1 && roles(order[1]).indexOf('Carry') !== -1) {
        var t = order[0]; order[0] = order[1]; order[1] = t;
      }
      order.forEach(function (i, n) { take(i, slots[n] || 5, false); });
    });
    return out;
  }

  /** Индекс оппонента по линии: 1↔3, 2↔2, 3↔1, 4↔5, 5↔4. */
  var LANE_COUNTERPART = { 1: 3, 2: 2, 3: 1, 4: 5, 5: 4 };
  function findLaneOpponent(players, positions, idx) {
    var me = players[idx], myPos = positions[idx] && positions[idx].pos;
    if (!me || !myPos) return -1;
    var want = LANE_COUNTERPART[myPos], rad = isRadiantSlot(me);
    for (var i = 0; i < players.length; i++) {
      if (isRadiantSlot(players[i]) !== rad && positions[i] && positions[i].pos === want) return i;
    }
    return -1;
  }

  function at(arr, minute) { return Array.isArray(arr) && arr.length > minute && isNum(arr[minute]) ? num(arr[minute]) : null; }

  function pickBench(p, key) {
    var b = p && p.benchmarks && p.benchmarks[key];
    if (b && isNum(b.pct)) return clamp(parseFloat(b.pct), 0, 1);
    return null;
  }

  /** Приводит игрока из ответа OpenDota (/matches/{id}) к плоскому виду. */
  function normalizeDotaPlayer(p, match, pos, heroName, extra) {
    p = p || {}; match = match || {}; extra = extra || {};
    var dur = num(match.duration, 0), durMin = Math.max(1, dur / 60);
    var isRad = num(p.player_slot, 0) < 128;
    var won = isRad ? !!match.radiant_win : !match.radiant_win;
    var teamKills = isRad ? num(match.radiant_score, 0) : num(match.dire_score, 0);
    var k = num(p.kills), d = num(p.deaths), a = num(p.assists);
    var lhT = Array.isArray(p.lh_t) ? p.lh_t : [];
    var lane = null;
    if (isNum(p.lane_efficiency_pct)) lane = num(p.lane_efficiency_pct);
    else if (isNum(p.lane_efficiency)) lane = num(p.lane_efficiency) * 100;
    var items = [];
    (Array.isArray(p.purchase_log) ? p.purchase_log : []).forEach(function (x) {
      if (x && x.key) items.push({ key: x.key, time: num(x.time) });
    });
    return {
      hero: heroName || ('Hero #' + p.hero_id),
      pos: pos || 1,
      won: won,
      durMin: durMin,
      k: k, d: d, a: a,
      gpm: num(p.gold_per_min), xpm: num(p.xp_per_min),
      lh: num(p.last_hits), denies: num(p.denies),
      hd: num(p.hero_damage), td: num(p.tower_damage), heal: num(p.hero_healing),
      kp: teamKills > 0 ? clamp((k + a) / teamKills * 100, 0, 100) : null,
      teamKills: teamKills,
      lh10: lhT.length > 10 ? num(lhT[10]) : null,
      lh20: lhT.length > 20 ? num(lhT[20]) : null,
      lh30: lhT.length > 30 ? num(lhT[30]) : null,
      pct: {
        gpm: pickBench(p, 'gold_per_min'),
        xpm: pickBench(p, 'xp_per_min'),
        hd: pickBench(p, 'hero_damage_per_min'),
        kills: pickBench(p, 'kills_per_min'),
        lh: pickBench(p, 'last_hits_per_min'),
        heal: pickBench(p, 'hero_healing_per_min'),
        td: pickBench(p, 'tower_damage')
      },
      lane: lane,
      obs: isNum(p.obs_placed) ? num(p.obs_placed) : null,
      sen: isNum(p.sen_placed) ? num(p.sen_placed) : null,
      stacked: isNum(p.camps_stacked) ? num(p.camps_stacked) : null,
      buybacks: num(p.buyback_count, 0),
      items: items,
      parsed: lhT.length > 0 || Array.isArray(p.gold_t) || isNum(p.actions_per_min),
      approxPos: !!extra.approxPos,
      // --- данные распарсенного матча ---
      g10: at(p.gold_t, 10), x10: at(p.xp_t, 10),
      g20: at(p.gold_t, 20), g30: at(p.gold_t, 30),
      tfp: isNum(p.teamfight_participation) ? clamp(num(p.teamfight_participation), 0, 1) : null,
      deadPct: isNum(p.life_state_dead) && dur > 0 ? clamp(num(p.life_state_dead) / dur, 0, 1) : null,
      deadSec: isNum(p.life_state_dead) ? num(p.life_state_dead) : null,
      // если у матча есть блок покупок, отсутствие ключа = 0 покупок (раньше это считалось «нет данных»)
      tp: p.purchase && typeof p.purchase === 'object' ? num(p.purchase.tpscroll, 0) : null,
      raw: p, match: match, nameByKey: typeof extra.nameByKey === 'function' ? extra.nameByKey : null,
      obsKills: isNum(p.observer_kills) ? num(p.observer_kills) : null,
      runes: isNum(p.rune_pickups) ? num(p.rune_pickups) : null,
      smokes: p.purchase && typeof p.purchase === 'object' ? num(p.purchase.smoke_of_deceit, 0) : null,
      deathTimes: deathTimesOf(p, match, extra.heroKey),
      opp: extra.opp ? {
        hero: extra.oppName || ('Hero #' + extra.opp.hero_id),
        lh10: at(extra.opp.lh_t, 10), g10: at(extra.opp.gold_t, 10), x10: at(extra.opp.xp_t, 10),
        gpm: num(extra.opp.gold_per_min), d: num(extra.opp.deaths), k: num(extra.opp.kills)
      } : null,
      teamAdv: teamAdvOf(match, isRad)
    };
  }

  // Время смертей игрока: из kills_log врагов (ключ — внутреннее имя героя, npc_dota_hero_*)
  function deathTimesOf(p, match, heroKey) {
    if (!heroKey || !match || !Array.isArray(match.players)) return null;
    var rad = isRadiantSlot(p), t = [], any = false;
    match.players.forEach(function (e) {
      if (isRadiantSlot(e) === rad || !Array.isArray(e.kills_log)) return;
      any = true;
      e.kills_log.forEach(function (k) { if (k && k.key === heroKey && isNum(k.time)) t.push(num(k.time)); });
    });
    return any ? t.sort(function (x, y) { return x - y; }) : null;
  }

  // Преимущество команды игрока по золоту (знак «+» — ваша команда впереди)
  function teamAdvOf(match, isRad) {
    var adv = match && match.radiant_gold_adv;
    if (!Array.isArray(adv) || adv.length < 12) return null;
    var s = isRad ? 1 : -1, out = [];
    for (var i = 0; i < adv.length; i++) out.push(isNum(adv[i]) ? num(adv[i]) * s : 0);
    return out;
  }

  // «оценка 0..1» метрики: процентиль OpenDota, а если его нет — отношение к про-ориентиру
  function metricScore(pctVal, ratio) {
    if (pctVal != null) return pctVal;
    if (ratio != null) return clamp((ratio - 0.4) / 0.8, 0, 1);
    return null;
  }
  function pctText(p) { return Math.round(p * 100); }
  function mmss(sec) { sec = Math.max(0, Math.round(sec)); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); }
  function kfmt(v) { var s = Math.abs(v) >= 1000 ? (Math.round(Math.abs(v) / 100) / 10) + 'K' : String(Math.round(Math.abs(v))); return (v < 0 ? '−' : '+') + s; }

  /* ------------------------------------------------------------------ */
  /* DOTA 2: глубокий разбор (нужен распарсенный матч OpenDota)          */
  /* смерти, видение, предметы, драки, ключевые моменты, показатели роли */
  /* ------------------------------------------------------------------ */
  var KEY_ITEM_NAMES = {
    black_king_bar: 'BKB', blink: 'Blink Dagger', aeon_disk: 'Aeon Disk', refresher: 'Refresher Orb',
    sheepstick: 'Scythe of Vyse', satanic: 'Satanic', butterfly: 'Butterfly', travel_boots: 'Boots of Travel',
    force_staff: 'Force Staff', glimmer_cape: 'Glimmer Cape', ghost: 'Ghost Scepter', lotus_orb: 'Lotus Orb',
    aghanims_shard: "Aghanim's Shard", ultimate_scepter: "Aghanim's Scepter", assault: 'Assault Cuirass',
    heart: 'Heart of Tarrasque', shivas_guard: "Shiva's Guard", radiance: 'Radiance', manta: 'Manta Style',
    greater_crit: 'Daedalus', monkey_king_bar: 'Monkey King Bar', skadi: 'Eye of Skadi', mekansm: 'Mekansm',
    guardian_greaves: 'Guardian Greaves', pipe: 'Pipe of Insight', crimson_guard: 'Crimson Guard'
  };

  function heroLabel(key, nameByKey) {
    if (!key) return 'враг';
    if (nameByKey) { var n = null; try { n = nameByKey(key); } catch (e) { n = null; } if (n) return n; }
    return String(key).replace(/^npc_dota_hero_/, '').split('_').map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
  }
  function timesText(arr, max) {
    max = max || 6;
    return arr.slice(0, max).map(mmss).join(', ') + (arr.length > max ? '…' : '');
  }
  function goldK(v) { return v >= 1000 ? (Math.round(v / 100) / 10) + 'K' : String(Math.round(v)); }

  function deepDota(m, items) {
    var out = { timeline: [], facts: [], penalty: 0 };
    var startLen = items.length;
    var p = m.raw, match = m.match || {};
    if (!p || !m.parsed) return out;
    var core = m.pos <= 3, sup = m.pos >= 4, durSec = m.durMin * 60;
    var pro = DOTA_PRO[m.pos] || DOTA_PRO[1];
    var posName = DOTA_POS_NAMES[m.pos] || 'Игрок';

    var deaths = Array.isArray(p.deaths_log) ? p.deaths_log.filter(function (d) { return d && isNum(d.time); }).map(function (d) {
      return { time: num(d.time), key: d.key, fed: num(d.gold_fed, 0), lost: num(d.gold_lost, 0), dead: num(d.time_dead, 0) };
    }) : (m.deathTimes || []).map(function (t) { return { time: t, key: null, fed: 0, lost: 0, dead: 0 }; });
    deaths.sort(function (a, b) { return a.time - b.time; });
    var tfs = Array.isArray(match.teamfights) ? match.teamfights : [];
    var idx = -1;
    (match.players || []).forEach(function (q, i) { if (q && q.player_slot === p.player_slot) idx = i; });
    var buys = Array.isArray(p.purchase_log) ? p.purchase_log : [];
    function firstBuy(key) { var t = null; buys.forEach(function (b) { if (b && b.key === key && isNum(b.time) && (t == null || b.time < t)) t = num(b.time); }); return t; }
    function uses(key) { return p.item_uses && isNum(p.item_uses[key]) ? num(p.item_uses[key]) : 0; }
    var buybackTimes = (Array.isArray(p.buyback_log) ? p.buyback_log : []).filter(function (b) { return b && isNum(b.time); }).map(function (b) { return num(b.time); });
    var cash = num(p.gold, 0);

    /* 1. Один и тот же герой убивает снова и снова */
    var byKiller = {}, topKey = null;
    deaths.forEach(function (d) { if (d.key) { (byKiller[d.key] = byKiller[d.key] || []).push(d.time); } });
    Object.keys(byKiller).forEach(function (k) { if (!topKey || byKiller[k].length > byKiller[topKey].length) topKey = k; });
    if (topKey && byKiller[topKey].length >= 3 && byKiller[topKey].length >= deaths.length * 0.5 && !(byKiller[topKey].length < 4 && deaths.length >= 6)) {
      var kn = heroLabel(topKey, m.nameByKey), kt = byKiller[topKey];
      items.push(P('repeat_killer', 42 + kt.length * 6, 'Один и тот же герой убивает вас снова и снова',
        kn + ' убил вас ' + kt.length + ' ' + plural(kt.length, 'раз', 'раза', 'раз') + ' из ' + deaths.length + ' (' + timesText(kt) + '). Это не случайность: вы каждый раз попадаете в одну и ту же ситуацию.',
        sup
          ? 'Против ' + kn + ': держитесь на шаг позади кора, не заходите в туман войны первым, а перед выходом проверяйте, где он на миникарте. Ставьте вард на его маршрут.'
          : 'Против ' + kn + ': как только он пропал с миникарты — отходите ближе к союзникам/башне и не фармите в одиночку на чужой половине. Закладывайте в сборку вещь против него (BKB, Linken, Ghost Scepter, Glimmer — по ситуации).'));
    }

    /* 2. Смерти в одиночку, вне командных драк */
    if (tfs.length >= 3 && deaths.length >= 3) {
      var picks = deaths.filter(function (d) {
        return !tfs.some(function (tf) { return d.time >= num(tf.start) - 8 && d.time <= num(tf.end) + 8; });
      });
      if (picks.length >= 3 && picks.length >= deaths.length * 0.5) {
        items.push(P('pickoffs', 30 + picks.length * 5, 'Смерти в одиночку, вне драк',
          picks.length + ' из ' + deaths.length + ' смертей — вас ловили без командной драки (' + timesText(picks.map(function (d) { return d.time; })) + '). Каждая такая смерть — бесплатное золото врагу, а ваша команда остаётся в меньшинстве.',
          'Правило: если рядом нет союзника и нет вашего варда на подходе — не идите в лес врага и за реку. Перед каждым выходом смотрите миникарту: пропавшие вражеские герои = осторожность.'));
      }
    }

    /* 3. Дорогие смерти */
    var fed = deaths.reduce(function (s, d) { return s + d.fed; }, 0);
    var worst = deaths.reduce(function (b, d) { return !b || d.fed > b.fed ? d : b; }, null);
    if (deaths.length >= 3 && (fed >= 3500 || (worst && worst.fed >= 1300))) {
      items.push(P('costly_deaths', 24 + Math.min(26, fed / 250), 'Дорогие смерти',
        'Ваши смерти принесли врагам ' + goldK(fed) + ' золота' + (worst && worst.fed >= 600 ? '; самая дорогая — на ' + mmss(worst.time) + ' (' + goldK(worst.fed) + ')' : '') + '. Чем больше у вас золота в вещах, тем дороже каждая ошибка.',
        'После 25-й минуты вы — главная цель: перед дракой убедитесь, что есть TP/BKB, а в одиночку не показывайтесь на карте без видения.'));
    }

    /* 4. Смерти в решающем отрезке игры */
    if (m.durMin >= 25) {
      var lateD = deaths.filter(function (d) { return d.time >= durSec * 0.85; });
      if (!m.won && lateD.length >= 2) {
        items.push(P('late_deaths', 40 + lateD.length * 6, 'Смерти в конце игры',
          'В решающем отрезке (' + timesText(lateD.map(function (d) { return d.time; })) + ') вы погибли ' + lateD.length + ' ' + plural(lateD.length, 'раз', 'раза', 'раз') + ' — игра закончилась вскоре после этого.',
          'В поздней игре смерть — это не пауза, а шанс врагу сломать строения. Держите деньги на выкуп и выходите на драку только рядом с союзниками, а не раньше их.'));
      }
    }

    /* 5. Золото, которое не превратилось в предметы */
    if (m.durMin >= 15 && cash >= (core ? 2500 : 1500) && (!m.won || cash >= 4000)) {
      items.push(P('unspent_gold', 22 + Math.min(24, cash / 400) - (m.won ? 14 : 0), 'Золото в кармане',
        'К концу матча у вас осталось ' + cash + ' золота — это почти целый предмет, который не работал в драках' + (m.buybacks > 0 ? '. Часть могла быть отложена на выкуп, но остаток всё равно лежал без дела.' : '.'),
        'Покупайте предметы сразу при возвращении на базу или через курьера; копите только на конкретную вещь и не дольше пары минут.'));
    }

    /* 6. Выкупы */
    if (buybackTimes.length >= 2 && !m.won) {
      items.push(N('buybacks', 'Выкупы',
        'Вы выкупались ' + buybackTimes.length + ' ' + plural(buybackTimes.length, 'раз', 'раза', 'раз') + ' (' + timesText(buybackTimes) + '), но матч проигран. Выкуп стоит дорого: используйте его, когда смерть сразу отдаёт барак/Рошана, а не просто чтобы вернуться в бой.'));
    }

    /* 7. Пропущенные драки (кор-герои) */
    if (core && tfs.length >= 8 && idx >= 0) {
      var miss = [];
      tfs.forEach(function (tf) {
        var e = tf.players && tf.players[idx];
        if (e && num(e.damage, 0) < 150 && num(e.deaths, 0) === 0) miss.push(num(tf.start));
      });
      if (miss.length >= Math.max(3, tfs.length * 0.25)) {
        items.push(P('missed_fights', 22 + miss.length * 3, 'Пропущенные драки',
          'В ' + miss.length + ' из ' + tfs.length + ' командных драк вы почти не нанесли урона (' + timesText(miss) + ') — вас не было там, где решалась игра.',
          'Когда команда собирается на объект или идёт драка, телепортируйтесь или идите к ней раньше, чем закончите фарм: золото вы доберёте после выигранной драки.'));
      }
    }

    /* 8. Видение и вспомогательные дела (саппорты) */
    var obsT = (Array.isArray(p.obs_log) ? p.obs_log : []).filter(function (w) { return w && isNum(w.time); }).map(function (w) { return num(w.time); }).sort(function (a, b) { return a - b; });
    var senT = (Array.isArray(p.sen_log) ? p.sen_log : []).filter(function (w) { return w && isNum(w.time); }).map(function (w) { return num(w.time); }).sort(function (a, b) { return a - b; });
    if (sup && m.durMin >= 20) {
      if (obsT.length && obsT[0] > 480) {
        items.push(P('first_ward', 34 + Math.min(20, (obsT[0] - 480) / 60 * 2), 'Поздний первый обсервер',
          'Первый обсервер вы поставили на ' + mmss(obsT[0]) + '. До этого команда не видела ни рун, ни лес, ни подходы врагов — это ранние смерти и упущенные ганки.',
          'Закупайте 2 обсервера в первую же закупку и ставьте их до 4-й минуты на руны и в лес врага; потом обновляйте раз в 6–7 минут.'));
      } else if (!obsT.length && m.obs === 0) {
        items.push(P('no_obs', 38, 'Ни одного обсервера',
          'За ' + Math.round(m.durMin) + ' мин вы не поставили ни одного обсервера — враг двигался по карте свободно.',
          'Каждую закупку берите 1–2 обсервера: вард, поставленный заранее, окупается первой же спасённой жизнью.'));
      }
      if (m.stacked != null && m.stacked <= 1 && m.durMin >= 20) {
        items.push(P('no_stacks', 20, 'Почти нет стаков',
          'Всего ' + m.stacked + ' ' + plural(m.stacked, 'стак', 'стака', 'стаков') + ' за ' + Math.round(m.durMin) + ' мин. Стак в окне «нечего делать на карте» — бесплатное золото для кора и опыт для вас.',
          'Стакайте лагерь на 53–57 секунде каждой минуты, когда ничего не происходит: у «треугольника» это самое выгодное место.'));
      }
      if (m.pos === 4 && m.runes != null && m.runes === 0 && m.durMin >= 20) {
        items.push(P('sup_runes', 18, 'Руны не подбираются',
          'За матч не подобрано ни одной руны. Саппорт у реки к руне помогает мидеру и даёт вам бесплатные ресурсы.',
          'К каждой чётной минуте проверяйте, не нужно ли вам забрать руну мощи/воды у реки, пока кор фармит.'));
      }
      var earlyD = deaths.filter(function (d) { return d.time < 720; });
      if (earlyD.length >= 2) {
        items.push(P('early_sup_deaths', 36 + earlyD.length * 4, 'Ранние смерти саппорта',
          'До 12-й минуты вы погибли ' + earlyD.length + ' ' + plural(earlyD.length, 'раз', 'раза', 'раз') + ' (' + timesText(earlyD.map(function (d) { return d.time; })) + '). Саппорт, который умирает на линии, отдаёт кору опыт и золото и сам остаётся без предметов.',
          'Ранняя игра: покупайте ресурсы на линию (ветки, мангo, клярити), не стойте AFK, а при потере здоровья отходите за союзного крипа и берите курьера с предметами.'));
      }
    }

    /* 9. Предметы: BKB и Blink */
    var bkbT = firstBuy('black_king_bar');
    if (core && m.durMin >= 28) {
      if (bkbT != null && bkbT > 1440 && m.durMin >= 35) {
        var before = deaths.filter(function (d) { return d.time < bkbT; }).length;
        items.push(P('late_bkb', 28 + Math.min(18, (bkbT - 1440) / 120), 'Поздний BKB',
          'BKB куплен на ' + mmss(bkbT) + (before > 0 ? ' — из ' + deaths.length + ' смертей ' + before + ' ' + plural(before, 'пришлась', 'пришлись', 'пришлись') + ' на время до него' : '') + '. Без BKB вас выключают одним станом, и вы теряете драку, не успев ничего сделать.',
          'К 20–25 минуте у кора должен быть BKB (или Ghost/Linken по ситуации). Не покупайте дорогую слабую вещь, пока нет защиты от контроля.'));
      } else if (bkbT == null && m.durMin >= 32 && m.d >= 6) {
        items.push(P('no_bkb', 30, 'Нет BKB',
          'За ' + Math.round(m.durMin) + ' мин BKB так и не куплен, при этом ' + m.d + ' смертей. Против контроля это самая важная вещь кора.',
          'Если у врага станы и контроль — BKB берётся раньше всего остального дорогого.'));
      }
      if (bkbT != null && tfs.length >= 6) {
        var after = tfs.filter(function (tf) { return num(tf.start) > bkbT; }).length;
        if (after >= 4 && uses('black_king_bar') < Math.max(2, after * 0.35)) {
          items.push(P('bkb_unused', 24, 'BKB почти не используется',
            'BKB куплен на ' + mmss(bkbT) + ', но за ' + after + ' драк после этого нажат ' + uses('black_king_bar') + ' ' + plural(uses('black_king_bar'), 'раз', 'раза', 'раз') + '. Вещь за 4 000 золота стоит без дела.',
            'Нажимайте BKB в начале драки, а не после первого стана — тогда он и работает как защита.'));
        }
      }
    }
    var blinkT = firstBuy('blink');
    if (blinkT != null && uses('blink') === 0 && m.durMin >= 20) {
      items.push(P('blink_unused', 20, 'Blink куплен, но не используется', 'Blink Dagger куплен на ' + mmss(blinkT) + ', но за матч не использован ни разу.',
        'Blink — это инициация и побег: назначьте себе кнопку и используйте в каждой драке.'));
    }

    /* 10. Сводка по золоту: вы тащили, а команда проиграла */
    if (match.players && idx >= 0 && !m.won) {
      var rad = isRadiantSlot(p);
      var mates = match.players.filter(function (q) { return isRadiantSlot(q) === rad; });
      var foes = match.players.filter(function (q) { return isRadiantSlot(q) !== rad; });
      var myNw = num(p.net_worth, 0);
      var top = mates.every(function (q) { return num(q.net_worth, 0) <= myNw; });
      var foeNw = foes.map(function (q) { return num(q.net_worth, 0); }).sort(function (a, b) { return b - a; });
      if (top && foeNw[0] >= myNw * 0.95 && foeNw[1] >= myNw * 0.7) {
        items.push(N('carry_alone', 'Вы тащили почти в одиночку',
          'Ваш нетворс ' + goldK(myNw) + ' — первый в команде, но у соперников двое с ' + goldK(foeNw[0]) + ' и ' + goldK(foeNw[1]) + '. Одного сильного кора мало: исход решает баланс золота у всей пятёрки и то, кто умирает в ключевых драках.'));
      }
    }

    /* Сильные стороны саппорта/оффлейнера: контроль и девард */
    if (!core || sup) {
      var stunSec = num(p.stuns, 0);
      if (stunSec >= (sup ? 45 : 35)) {
        items.push(S('control', 32 + Math.min(14, (stunSec - 45) / 5), 'Много контроля',
          'Ваши станы и ограничения держали врагов около ' + Math.round(stunSec) + ' секунд — именно это даёт команде возможность выигрывать драки.'));
      }
      var wardKills = num(p.observer_kills, 0) + num(p.sentry_kills, 0);
      if (sup && wardKills >= 5) {
        items.push(S('deward_total', 34, 'Вы чистите карту от вардов', 'Снято вражеских вардов: ' + wardKills + ' — враги играли с меньшим видением.'));
      }
    }

    /* Штраф к оценке за найденные глубокие ошибки */
    out.penalty = Math.min(25, items.slice(startLen).reduce(function (s, i) {
      return s + (i.kind === 'problem' ? Math.max(0, i.severity - 35) * 0.35 : 0);
    }, 0));

    /* Ключевые моменты (таймлайн) */
    var tl = out.timeline;
    deaths.forEach(function (d) {
      tl.push({ t: d.time, tone: 'bad', text: 'Смерть' + (d.key ? ' от ' + heroLabel(d.key, m.nameByKey) : '') + (d.fed >= 400 ? ' (враги получили ' + goldK(d.fed) + ' золота)' : '') });
    });
    buybackTimes.forEach(function (t) { tl.push({ t: t, tone: 'neutral', text: 'Выкуп' }); });
    Object.keys(KEY_ITEM_NAMES).forEach(function (k) {
      var t = firstBuy(k);
      if (t != null && t > 0 && ['black_king_bar', 'blink', 'aeon_disk', 'refresher', 'sheepstick', 'satanic', 'butterfly', 'travel_boots', 'aghanims_shard', 'ultimate_scepter', 'ghost', 'glimmer_cape', 'force_staff'].indexOf(k) !== -1) {
        tl.push({ t: t, tone: 'good', text: 'Куплено: ' + KEY_ITEM_NAMES[k] });
      }
    });
    (Array.isArray(match.objectives) ? match.objectives : []).forEach(function (o) {
      if (!o) return;
      if (o.type === 'CHAT_MESSAGE_FIRSTBLOOD' && (o.player_slot === p.player_slot || o.victim_player_slot === p.player_slot)) {
        tl.push({ t: num(o.time), tone: o.player_slot === p.player_slot ? 'good' : 'bad', text: o.player_slot === p.player_slot ? 'Первая кровь на вашем счету' : 'Первая кровь — вы стали жертвой' });
      }
      if (o.type === 'CHAT_MESSAGE_ROSHAN_KILL') {
        var ours = (o.team === 2) === isRadiantSlot(p);
        tl.push({ t: num(o.time), tone: ours ? 'good' : 'bad', text: ours ? 'Ваша команда убила Рошана' : 'Рошан убит врагами' });
      }
    });
    if (tfs.length && idx >= 0) {
      var bestTf = null;
      tfs.forEach(function (tf) { var e = tf.players && tf.players[idx]; if (e && (!bestTf || num(e.damage, 0) > bestTf.dmg)) bestTf = { t: num(tf.start), dmg: num(e.damage, 0) }; });
      if (bestTf && bestTf.dmg >= 2500) tl.push({ t: bestTf.t, tone: 'good', text: 'Ваша лучшая драка: ' + goldK(bestTf.dmg) + ' урона' });
    }
    tl.sort(function (a, b) { return a.t - b.t; });
    if (tl.length > 16) {
      // оставляем смерти и самые важные события, чтобы блок оставался читаемым
      tl = tl.filter(function (e, i) { return e.tone === 'bad' || e.tone === 'neutral' || i % 2 === 0; }).slice(0, 16);
    }
    out.timeline = tl;

    /* Показатели роли */
    var f = out.facts;
    var deadPctTxt = m.deadPct != null ? Math.round(m.deadPct * 100) + '%' : null;
    if (core) {
      if (m.lh10 != null) f.push({ label: 'Ластхиты к 10:00', value: String(m.lh10), sub: 'Про: ' + pro.lh10, tone: m.lh10 >= pro.lh10 * 0.9 ? 'good' : (m.lh10 < pro.lh10 * 0.6 ? 'bad' : '') });
      f.push({ label: 'Золото в запасе', value: String(cash), sub: cash >= 2500 ? 'Лежит без дела' : 'Нормально', tone: cash >= 2500 ? 'bad' : 'good' });
      f.push({ label: 'Смертей', value: String(m.d), sub: fed > 0 ? 'Отдали ' + goldK(fed) + ' золота' : '', tone: m.d / m.durMin * 10 >= 3.5 ? 'bad' : (m.d / m.durMin * 10 <= 1.4 ? 'good' : '') });
      if (bkbT != null) f.push({ label: 'BKB куплен', value: mmss(bkbT), sub: bkbT <= 1440 ? 'Вовремя' : 'Поздновато', tone: bkbT <= 1440 ? 'good' : 'bad' });
    } else {
      f.push({ label: 'Варды', value: (m.obs != null && m.sen != null) ? (m.obs + '+' + m.sen) : '—', sub: obsT.length ? 'Первый обсервер: ' + mmss(obsT[0]) : 'Обсерверы + сентри', tone: obsT.length && obsT[0] <= 480 ? 'good' : (obsT.length ? 'bad' : '') });
      f.push({ label: 'TP-свитки', value: m.tp != null ? String(m.tp) : '—', sub: m.tp != null && m.tp <= 2 && m.durMin >= 20 ? 'Слишком мало' : 'В норме', tone: m.tp != null && m.tp <= 2 && m.durMin >= 20 ? 'bad' : 'good' });
      f.push({ label: 'Стаки', value: m.stacked != null ? String(m.stacked) : '—', sub: m.stacked != null && m.stacked <= 1 && m.durMin >= 20 ? 'Почти нет' : '', tone: m.stacked != null && m.stacked <= 1 && m.durMin >= 20 ? 'bad' : (m.stacked >= 3 ? 'good' : '') });
      f.push({ label: 'Смертей', value: String(m.d), sub: deaths.length ? 'Первая на ' + mmss(deaths[0].time) : '', tone: m.d / m.durMin * 10 >= 4.5 ? 'bad' : '' });
    }
    if (deadPctTxt) f.push({ label: 'Время мёртвым', value: deadPctTxt, sub: mmss(m.deadSec || 0), tone: m.deadPct >= 0.15 ? 'bad' : (m.deadPct <= 0.07 ? 'good' : '') });
    if (m.tfp != null) f.push({ label: 'Участие в драках', value: Math.round(m.tfp * 100) + '%', sub: '', tone: m.tfp >= 0.7 ? 'good' : (m.tfp < (sup ? 0.45 : 0.35) ? 'bad' : '') });
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* DOTA 2: тренерский слой (v2)                                        */
  /* Источники логики: разборы Samorodok, No[o]ne, Komanss, Heydem,      */
  /* NVGATO, lwodas, kwinoriti, 9NeGaTV, Puppey/Dukalis.                 */
  /*  • контрольные точки роли по нетворсу и ластхитам (10/20/30 мин);   */
  /*  • цена смертей: золото врагу + потерянный фарм за время мёртвым;   */
  /*  • смерти на линии без расходников, драки с фарм-предметом,         */
  /*    кормление главного кора соперника, гибель в начале драк;         */
  /*  • реализация выигранных драк (башни/Рошан) и слив преимущества;    */
  /*  • саппорт: уровень; мид: руны силы.                                */
  /* ------------------------------------------------------------------ */
  // ориентиры «хорошего паблика» (не про-сцены): нетворс и ластхиты к 10/20/30 минуте
  var DOTA_BENCH = {
    1: { nw: [4500, 11000, 20000], lh: [55, 150, 250] },
    2: { nw: [4200, 10000, 17000], lh: [50, 130, 210] },
    3: { nw: [3300, 8000, 13500], lh: [30, 85, 150] },
    4: { nw: [1900, 4800, 8000], lh: [10, 30, 55] },
    5: { nw: [1600, 4000, 6800], lh: [6, 20, 40] }
  };
  var DOTA_XP_LEVEL = [0, 240, 640, 1160, 1760, 2440, 3200, 4000, 4900, 5900, 7000, 8200, 9500, 10900, 12400, 14000, 15700, 17500, 19400, 21400, 23600, 26000, 28600, 31400, 34400, 38400, 43400, 49400, 56400, 64400];
  function levelAt(xp) { var l = 1; for (var i = 1; i < DOTA_XP_LEVEL.length; i++) if (xp >= DOTA_XP_LEVEL[i]) l = i + 1; return l; }
  var REGEN_ITEMS = { tango: 1, flask: 1, clarity: 1, enchanted_mango: 1, faerie_fire: 1, bottle: 1, tango_single: 1, blood_grenade: 1 };
  var FARM_ITEMS = { bfury: 'Battle Fury', radiance: 'Radiance', maelstrom: 'Maelstrom', hand_of_midas: 'Hand of Midas' };
  var FIGHT_ITEMS = { black_king_bar: 1, manta: 1, sange_and_yasha: 1, satanic: 1, butterfly: 1, abyssal_blade: 1, skadi: 1, aeon_disk: 1, sphere: 1, blink: 1, harpoon: 1, disperser: 1, heart: 1, assault: 1 };
  var POWER_RUNES = { '0': 1, '1': 1, '2': 1, '3': 1, '4': 1, '6': 1, '9': 1 };
  function kGold(v) { return (Math.round(Math.abs(v) / 100) / 10).toString().replace('.', ',') + 'K'; }
  function sumBy(a, f) { var s = 0; a.forEach(function (x) { s += f(x); }); return s; }

  function coachDota(m, items) {
    var out = { penalty: 0, impact: null, phases: null, goals: [], timeline: [] };
    var p = m.raw, match = m.match || {};
    if (!p || !m.parsed) return out;
    var pos = m.pos, core = pos <= 3, sup = pos >= 4, durSec = m.durMin * 60, durMin = m.durMin;
    var bench = DOTA_BENCH[pos] || DOTA_BENCH[1];
    var rad = isRadiantSlot(p);
    var players = Array.isArray(match.players) ? match.players : [];
    var idx = -1; players.forEach(function (q, i) { if (q && q.player_slot === p.player_slot) idx = i; });
    var foes = players.filter(function (q) { return isRadiantSlot(q) !== rad; });
    var nwT = Array.isArray(p.networth_t) && p.networth_t.length ? p.networth_t : (Array.isArray(p.gold_t) ? p.gold_t : []);
    var lhT = Array.isArray(p.lh_t) ? p.lh_t : [];
    var xpT = Array.isArray(p.xp_t) ? p.xp_t : [];
    var buys = (Array.isArray(p.purchase_log) ? p.purchase_log : []).filter(function (b) { return b && b.key && isNum(b.time); });
    var tfs = Array.isArray(match.teamfights) ? match.teamfights : [];
    var nameOf = function (k) { return heroLabel(k, m.nameByKey); };
    var deaths = (Array.isArray(p.deaths_log) ? p.deaths_log : []).filter(function (d) { return d && isNum(d.time); }).map(function (d) {
      return { time: num(d.time), key: d.key || null, fed: num(d.gold_fed, 0), dead: num(d.time_dead, 0) };
    }).sort(function (a, b) { return a.time - b.time; });
    if (!deaths.length && m.deathTimes) deaths = m.deathTimes.map(function (t) { return { time: t, key: null, fed: 0, dead: 0 }; });
    // кто убил: соперник, у которого в kills_log есть убийство в этот момент
    deaths.forEach(function (d) {
      foes.forEach(function (e) {
        if (d.killer) return;
        (Array.isArray(e.kills_log) ? e.kills_log : []).forEach(function (k) { if (!d.killer && k && Math.abs(num(k.time) - d.time) <= 1) d.killer = e; });
      });
    });
    function tfOf(t) { for (var i = 0; i < tfs.length; i++) { var tf = tfs[i]; if (t >= num(tf.start) - 6 && t <= num(tf.end) + 6) return tf; } return null; }
    function tfResult(tf) {
      var ours = 0, theirs = 0;
      (tf.players || []).forEach(function (e, i) { var q = players[i]; if (!q) return; if (isRadiantSlot(q) === rad) ours += num(e.deaths, 0); else theirs += num(e.deaths, 0); });
      return { ours: ours, theirs: theirs };
    }
    var foeCore = foes.slice().sort(function (a, b) { return num(b.net_worth) - num(a.net_worth); })[0] || null;
    var gpmRate = Math.max(150, num(p.gold_per_min, 300));

    /* 1. Цена смертей */
    var fedTotal = 0, farmLost = 0, deadTotal = 0;
    deaths.forEach(function (d) {
      var mi = Math.min(nwT.length - 1, Math.floor(d.time / 60));
      var localGpm = mi >= 2 && nwT[mi] != null && nwT[mi - 2] != null ? Math.max(100, (nwT[mi] - nwT[mi - 2]) / 2) : gpmRate;
      d.farmLost = (d.dead || 0) / 60 * localGpm;
      fedTotal += d.fed; farmLost += d.farmLost; deadTotal += d.dead;
      var tf = tfOf(d.time); d.tf = tf;
      if (tf && idx >= 0 && tf.players && tf.players[idx]) { d.tfDmg = num(tf.players[idx].damage, 0); d.tfRes = tfResult(tf); }
    });
    function evDeath(d, extra) { return mmss(d.time) + ' — смерть' + (d.key ? ' от ' + nameOf(d.key) : '') + (extra ? ', ' + extra : '') + (d.fed ? ' (врагу ' + goldK(d.fed) + ' золота' + (d.dead ? ', ' + Math.round(d.dead) + ' с мёртвым' : '') + ')' : ''); }

    /* 2. Контрольные точки роли */
    var cps = [10, 20, 30].filter(function (mn) { return durMin >= mn + 1 && nwT[mn] != null; });
    var behind = [];
    cps.forEach(function (mn) {
      var i = mn / 10 - 1, nw = nwT[mn], r = nw / bench.nw[i];
      if (r < 0.75) behind.push({ mn: mn, nw: nw, need: bench.nw[i], lh: lhT[mn], needLh: bench.lh[i], r: r });
    });
    if (core && behind.length >= 2 && !(m.pct && m.pct.gpm != null && m.pct.gpm >= 0.6)) {
      var worst = behind.reduce(function (a, b) { return a.r < b.r ? a : b; });
      items.push(P('role_bench', 34 + (1 - worst.r) * 60, 'Отстаёте от таймингов роли',
        'Нетворс ' + behind.map(function (b) { return 'к ' + b.mn + ':00 — ' + goldK(b.nw) + ' (ориентир ' + goldK(b.need) + ')'; }).join('; ') + '. ' +
        (pos === 1 ? 'Самородок: «если вы проиграли на керри и сильно отстаёте от этих таймингов — дело не в команде».' : 'Без своевременных предметов герой не реализуется в драках.'),
        (pos === 1 ? 'Фарм-паттерн (Heydem): планируйте, где будете через 30–40 секунд, двигайтесь только через крипов (линия → лагерь → лагерь → линия), не ходите на драки без предметов и ульты.' : 'Между драками всегда добирайте ближайшую волну или лагерь — не стойте без дела на карте.') + ' Цель: ' + goldK(bench.nw[0]) + ' к 10:00 и ' + goldK(bench.nw[1]) + ' к 20:00.',
        { why: 'Дота — игра ресурсов (lwodas): у кого больше золота в предметах, тот сильнее в драке. Отставание по таймингам означает, что ключевые предметы приходят, когда игра уже решается без вас.',
          evidence: behind.map(function (b) { return b.mn + ':00 — нетворс ' + goldK(b.nw) + ' из ' + goldK(b.need) + (b.lh != null ? ', ластхиты ' + b.lh + ' из ' + b.needLh : ''); }) }));
      out.penalty += 6;
    } else if (core && cps.length >= 2 && cps.every(function (mn) { return nwT[mn] >= bench.nw[mn / 10 - 1] * 1.05; })) {
      items.push(S('role_bench', 46, 'Опережаете тайминги роли', 'Нетворс ' + cps.map(function (mn) { return goldK(nwT[mn]) + ' к ' + mn + ':00'; }).join(', ') + ' — выше ориентиров тренеров для вашей позиции.'));
    }

    /* 3. Смерти на линии без расходников */
    var laneDeaths = deaths.filter(function (d) { return d.time < 600; });
    var noRegen = laneDeaths.filter(function (d) { return buys.filter(function (b) { return REGEN_ITEMS[b.key] && b.time <= d.time; }).length <= 2; });
    if (noRegen.length >= 2) {
      items.push(P('lane_regen', 38 + noRegen.length * 6, 'Смерти на линии без расходников',
        'До 10-й минуты вы погибли ' + laneDeaths.length + ' ' + plural(laneDeaths.length, 'раз', 'раза', 'раз') + ', и к моменту ' + noRegen.length + ' из этих смертей было куплено не больше двух расходников (танго, фласка, клярити, манго).',
        'Покупайте реген на линию без жадности: лишняя фласка за 100 золота никогда не ошибка (Самородок). Курьер с расходниками — сразу, как просело здоровье, а не после смерти.',
        { why: 'На линии опыт важнее золота, а смерть забирает и то и другое. Яторо «не стесняется привозить себе ресурсы» — поэтому и выигрывает тяжёлые линии.', evidence: noRegen.map(function (d) { return evDeath(d); }) }));
    }
    if (pos === 2 && m.opp) {
      var midLane = laneDeaths.filter(function (d) { return d.key && heroLabel(d.key, m.nameByKey) === m.opp.hero; });
      if (midLane.length >= 2) items.push(P('mid_solo_death', 46 + midLane.length * 5, 'Проигрываете дуэль на миду',
        'Мидер соперника (' + m.opp.hero + ') убил вас ' + midLane.length + ' ' + plural(midLane.length, 'раз', 'раза', 'раз') + ' до 10-й минуты.',
        'Komanss: «умереть один на один на миду не должно случаться вообще». Знайте пики силы соперника (3–4 уровень, ульта) и его откаты: в его пик силы не стойте на возвышенности у его крипов, отводите волну к своей башне.',
        { evidence: midLane.map(function (d) { return evDeath(d); }) }));
    }

    /* 4. Драки с фарм-предметом */
    if (core) {
      Object.keys(FARM_ITEMS).forEach(function (key) {
        var bt = null; buys.forEach(function (b) { if (b.key === key && (bt == null || b.time < bt)) bt = num(b.time); });
        if (bt == null) return;
        var nextFight = null; buys.forEach(function (b) { if (FIGHT_ITEMS[b.key] && b.time > bt && (nextFight == null || b.time < nextFight)) nextFight = num(b.time); });
        var until = Math.min(bt + 420, nextFight != null ? nextFight : Infinity);
        var fd = deaths.filter(function (d) { return d.time > bt && d.time <= until && d.tf; });
        if (fd.length >= 2) items.push(P('farm_item_fight', 36 + fd.length * 6, 'Лезете в драки с фарм-предметом',
          'После покупки ' + FARM_ITEMS[key] + ' (' + mmss(bt) + ') вы погибли в драках ' + fd.length + ' ' + plural(fd.length, 'раз', 'раза', 'раз') + ', ещё не имея боевого предмета.',
          'Фарм-предмет ≠ предмет для драки (Самородок): после него задача — быстро нафармить следующий слот (BKB/Manta/Blink), а не искать драки. Присоединяйтесь только к дракам рядом с вашей зоной фарма.',
          { evidence: fd.map(function (d) { return evDeath(d, 'в драке'); }) }));
      });
    }

    /* 5. Кормите главного кора соперника */
    if (foeCore && deaths.length >= 4) {
      var byCore = deaths.filter(function (d) { return d.killer === foeCore; });
      if (byCore.length >= 3 && byCore.length >= deaths.length * 0.35) {
        var ck = null; byCore.forEach(function (d) { if (!ck && d.key) ck = d.key; });
        items.push(P('feed_core', 36 + byCore.length * 5, 'Кормите главного героя соперника',
          (ck ? nameOf(ck) : 'Соперник') + ' — самый богатый герой соперника — убил вас ' + byCore.length + ' ' + plural(byCore.length, 'раз', 'раза', 'раз') + ' и получил с этого ' + goldK(sumBy(byCore, function (d) { return d.fed; })) + ' золота.',
          'Самородок: «лучше уйти в лес, чем кормить героя, который закончит игру». Пока у вас нет предмета против него — не показывайтесь у него на пути и купите защиту (BKB, Ghost, Force, Eul).',
          { why: 'Каждая смерть от главного кора ускоряет его ключевые предметы — и от него отстаёт вся ваша команда, а не только вы.', evidence: byCore.map(function (d) { return evDeath(d); }) }));
      }
    }

    /* 6. Гибель в начале драк */
    var dmgCut = core ? 600 : 250;
    var tfDeaths = deaths.filter(function (d) { return d.tf && d.time > 600; });
    var earlyTf = tfDeaths.filter(function (d) { return d.tfDmg != null && d.tfDmg < dmgCut; });
    if (earlyTf.length >= 3 && earlyTf.length >= tfDeaths.length * 0.5) {
      items.push(P('tf_first_death', 34 + earlyTf.length * 4, 'Погибаете в драке раньше, чем успеваете что-то сделать',
        'В ' + earlyTf.length + ' ' + plural(earlyTf.length, 'драке', 'драках', 'драках') + ' вы погибли, нанеся меньше ' + dmgCut + ' урона — вас ловили на входе или до начала драки.',
        sup ? 'Саппорт стоит за линией своих коров и тратит контроль до того, как его поймают; держите сейв-предмет (Force/Glimmer) для союзника и себя.'
            : 'Входите в драку вторым, после инициации союзника, и с BKB/защитным предметом наготове. Перед дракой проверьте, где герои соперника с контролем.',
        { evidence: earlyTf.map(function (d) { return evDeath(d, 'урон в драке ' + Math.round(d.tfDmg)); }) }));
    }

    /* 7. Реализация выигранных драк */
    var objs = Array.isArray(match.objectives) ? match.objectives : [];
    var enemyTag = rad ? 'badguys' : 'goodguys';
    var wonFights = 0, converted = 0, wonList = [];
    tfs.forEach(function (tf) {
      var rr = tfResult(tf);
      if (rr.theirs - rr.ours >= 2 && rr.theirs >= 3) {
        wonFights++;
        var end = num(tf.end);
        var conv = objs.some(function (o) {
          if (!o || !isNum(o.time) || o.time < end - 5 || o.time > end + 150) return false;
          if (o.type === 'building_kill' && String(o.key || '').indexOf(enemyTag) !== -1) return true;
          return o.type === 'CHAT_MESSAGE_ROSHAN_KILL' && ((o.team === 2) === rad);
        });
        if (conv) converted++; else wonList.push(tf);
      }
    });
    var lowConv = wonFights >= 3 && converted / wonFights < 0.45;
    if (lowConv) {
      var txtWon = 'Ваша команда выиграла ' + wonFights + ' ' + plural(wonFights, 'драку', 'драки', 'драк') + ', но только ' + converted + ' ' + plural(converted, 'превратилась', 'превратились', 'превратились') + ' в башню или Рошана в течение 2,5 минут.';
      if (core && num(p.tower_damage) < durMin * 60) {
        items.push(P('no_conversion', 34 + (wonFights - converted) * 4, 'Выигранные драки не превращаются в башни',
          txtWon + ' Ваш урон по строениям — ' + Math.round(num(p.tower_damage)) + '.',
          'После выигранной драки — сразу на ближайшую башню или Рошана, а не обратно на фарм (9NeGaTV: «игры на низком рейтинге тянутся, потому что никто не зовёт команду пушить»). Станьте тем, кто ставит пинг на башню.',
          { why: 'Башни — это территория: они открывают вражеский лес и лишают соперника телепорта (lwodas). Убийства без объектов дают сопернику время откупиться.',
            evidence: wonList.slice(0, 5).map(function (tf) { var r2 = tfResult(tf); return mmss(num(tf.start)) + ' — драка выиграна ' + r2.theirs + ':' + r2.ours + ', объект не взят'; }) }));
      } else items.push(N('no_conversion', 'Драки не превращаются в объекты', txtWon + ' Выигранная драка без башни или Рошана даёт сопернику время откупиться.'));
    }

    /* 8. Слив преимущества */
    var adv = m.teamAdv;
    if (adv && adv.length >= 15 && !m.won) {
      var peak = 0, peakAt = 0;
      adv.forEach(function (v, i) { if (v > peak) { peak = v; peakAt = i; } });
      if (peak >= 8000) {
        var collapse = deaths.filter(function (d) { return d.time >= peakAt * 60; });
        items.push(N('throw', 'Слили преимущество',
          'На ' + peakAt + '-й минуте ваша команда вела на ' + kGold(peak) + ' золота, но проиграла. ' + (collapse.length ? 'После пика вы погибли ' + collapse.length + ' ' + plural(collapse.length, 'раз', 'раза', 'раз') + ' (первая — на ' + mmss(collapse[0].time) + '). ' : '') +
          'lwodas: с преимуществом не рискуйте драками без гарантии — давите башни с Аегисом и пик-оффами; игра станет длиннее, но камбэка не будет.'));
      }
    }

    /* 9. Саппорт: уровень */
    if (sup && xpT.length > 21) {
      var l10 = levelAt(num(xpT[10])), l20 = levelAt(num(xpT[20]));
      var need10 = pos === 4 ? 6 : 5, need20 = pos === 4 ? 11 : 10;
      if (l10 < need10 - 1 || l20 < need20 - 1) items.push(P('sup_level', 30 + Math.max(need10 - l10, need20 - l20) * 5, 'Саппорт без уровня',
        'Уровень к 10:00 — ' + l10 + ' (ориентир ' + need10 + '), к 20:00 — ' + l20 + ' (ориентир ' + need20 + '). Без уровня у саппорта нет контроля и ульты в драках.',
        'Puppey: пятёрка — это не только жертвовать собой ради кора, «играйте и для себя». Забирайте руны мудрости (7:00, 14:00…), участвуйте в убийствах, не стойте на линии, где опыт делится на троих.'));
    }

    /* 10. Мид: руны силы */
    var powerR = (Array.isArray(p.runes_log) ? p.runes_log : []).filter(function (r) { return r && POWER_RUNES[String(r.key)] && num(r.time) > 0 && num(r.time) < Math.min(durSec, 1500); });
    if (pos === 2 && durMin >= 20) {
      var possible = Math.floor((Math.min(durSec, 1500) - 360) / 120) + 1;
      if (possible >= 5 && powerR.length < possible * 0.3) items.push(P('mid_runes2', 24 + (possible * 0.3 - powerR.length) * 4, 'Мало рун силы',
        'До 25-й минуты вы взяли ' + powerR.length + ' ' + plural(powerR.length, 'руну силы', 'руны силы', 'рун силы') + ' из ~' + possible + ' возможных (по одной каждые 2 минуты с 6:00).',
        'No[o]ne: после 6:00 цикл мида — руна → ганг или пуш → следующая руна. За 10–15 секунд до появления отведите волну и идите к реке.'));
    }

    /* Вклад: экономика смертей */
    out.impact = {
      headline: deaths.length ? 'Смерти обошлись в ≈' + goldK(fedTotal + farmLost) + ' золота' : 'Ни одной смерти — ни золота врагу, ни потерянного фарма',
      parts: [
        { label: 'Отдано врагу', value: goldK(fedTotal), tone: fedTotal >= 3000 ? 'bad' : '' },
        { label: 'Упущенный фарм', value: goldK(farmLost), tone: farmLost >= 3000 ? 'bad' : '' },
        { label: 'Мёртвым', value: mmss(deadTotal) + (durSec ? ' (' + Math.round(deadTotal / durSec * 100) + '%)' : ''), tone: deadTotal / Math.max(1, durSec) >= 0.12 ? 'bad' : '' },
        { label: 'Смертей', value: String(m.d), tone: '' }
      ],
      note: 'Каждая смерть — это золото, отданное врагу, плюс фарм, который вы не добыли, пока ждали возрождения (по вашему темпу золота в ту минуту).'
    };

    /* Таблица по фазам */
    var rows = [];
    [[0, 10, 'Линия (0–10)'], [10, 20, 'Середина (10–20)'], [20, 30, 'Поздняя (20–30)'], [30, 999, 'Концовка (30+)']].forEach(function (ph) {
      var a = ph[0], b = Math.min(ph[1], nwT.length - 1, Math.floor(durMin));
      if (b - a < 3 || nwT[b] == null || nwT[a] == null) return;
      var cs = lhT[b] != null && lhT[a] != null ? (lhT[b] - lhT[a]) / (b - a) : null;
      var dd = deaths.filter(function (d) { return d.time >= a * 60 && d.time < b * 60; }).length;
      var bi = a / 10, full = b === ph[1] && bi <= 2;
      rows.push([ph[2], cs != null ? cs.toFixed(1).replace('.', ',') : '—', String(Math.round((nwT[b] - nwT[a]) / (b - a))),
        { v: goldK(nwT[b]), tone: full ? (nwT[b] >= bench.nw[bi] ? 'good' : nwT[b] < bench.nw[bi] * 0.75 ? 'bad' : '') : '' },
        { v: String(dd), tone: dd >= 3 ? 'bad' : dd === 0 ? 'good' : '' }]);
    });
    if (rows.length) out.phases = { title: 'Игра по фазам', cols: ['Фаза', 'Ластхиты/мин', 'Золото/мин', 'Нетворс в конце', 'Смертей'], rows: rows,
      note: 'Ориентиры нетворса для вашей позиции: ' + goldK(bench.nw[0]) + ' к 10:00, ' + goldK(bench.nw[1]) + ' к 20:00, ' + goldK(bench.nw[2]) + ' к 30:00 (уровень хорошего паблика).' };

    /* Цели */
    var g = [];
    if (core && nwT[10] != null) g.push('Нетворс к 10:00 — не меньше ' + goldK(bench.nw[0]) + ', к 20:00 — ' + goldK(bench.nw[1]) + ' (сейчас ' + goldK(nwT[10]) + ' / ' + (nwT[20] != null ? goldK(nwT[20]) : '—') + ').');
    if (laneDeaths.length >= 2) g.push('На линии — не больше 1 смерти до 10:00 (сейчас ' + laneDeaths.length + '): реген с собой, отступать, когда пропал саппорт соперника.');
    var maxD = Math.max(4, Math.round(durMin / 10 * (sup ? 2.5 : 1.8)));
    if (deaths.length > maxD) g.push('Смертей за игру — не больше ' + maxD + ' (сейчас ' + deaths.length + ').');
    if (lowConv) g.push('После каждой выигранной драки — пинг на башню или Рошана в течение 30 секунд.');
    if (sup && isNum(p.camps_stacked) && num(p.camps_stacked) < 3 && durMin >= 20) g.push('Минимум 3 стака за игру для своего кора (сейчас ' + num(p.camps_stacked) + ').');
    out.goals = g.slice(0, 3);
    return out;
  }

  function analyzeDota(m) {
    var pos = m.pos, core = pos <= 3, sup = pos >= 4;
    var pro = DOTA_PRO[pos] || DOTA_PRO[1];
    var items = [];
    var sc = {
      gpm: metricScore(m.pct.gpm, m.gpm ? m.gpm / pro.gpm : null),
      xpm: metricScore(m.pct.xpm, m.xpm ? m.xpm / pro.xpm : null),
      hd: metricScore(m.pct.hd, null),
      lh: metricScore(m.pct.lh, null),
      kills: metricScore(m.pct.kills, null),
      td: metricScore(m.pct.td, null)
    };
    var dp10 = m.d / m.durMin * 10;
    var survScore = clamp(1 - (dp10 - 1) / 4, 0, 1);
    var posName = DOTA_POS_NAMES[pos] || 'Игрок';

    /* --- ФАРМ (только кор-позиции) --- */
    if (core && sc.gpm != null) {
      var srcLow = m.pct.gpm != null
        ? ' — ниже, чем у ' + (100 - pctText(m.pct.gpm)) + '% игроков на этом герое'
        : ' при про-ориентире для роли около ' + pro.gpm;
      var srcHigh = m.pct.gpm != null
        ? ' — выше, чем у ' + pctText(m.pct.gpm) + '% игроков на этом герое'
        : ' при про-ориентире для роли около ' + pro.gpm;
      if (sc.gpm < 0.4) {
        items.push(P('farm_gpm', (0.5 - sc.gpm) * 100 + 25,
          'Слабая экономика',
          'GPM ' + m.gpm + srcLow + '. Для ' + posName.toLowerCase() + ' этого мало: предметы выходят поздно, и команде не хватает вашей силы в драках.',
          'Фарм: в демо-режиме 10 минут на героя без соперника, цель — 60+ добитых крипов (керри) или 50+ (мид). Затем в игре между волнами забирайте ближайший лес и стакайте лагерь на :53.'));
      } else if (sc.gpm >= 0.75) {
        items.push(S('farm_gpm', sc.gpm * 100 - 40,
          'Сильная экономика', 'GPM ' + m.gpm + srcHigh + '.'));
      }
    }
    /* --- ЛИНИЯ ПРОТИВ ПРЯМОГО ОППОНЕНТА (распарсенный матч) --- */
    var laneVsLost = false, laneGd = null;
    if (core && m.opp && m.g10 != null && m.opp.g10 != null && m.durMin >= 12) {
      laneGd = m.g10 - m.opp.g10;
      var lhd = (m.lh10 != null && m.opp.lh10 != null) ? m.lh10 - m.opp.lh10 : null;
      var xd = (m.x10 != null && m.opp.x10 != null) ? m.x10 - m.opp.x10 : null;
      var oppRole = (DOTA_POS_NAMES[LANE_COUNTERPART[pos]] || 'соперник').toLowerCase();
      var det = [];
      if (lhd != null && lhd !== 0) det.push(Math.abs(lhd) + ' ' + plural(Math.abs(lhd), 'ластхит', 'ластхита', 'ластхитов'));
      if (xd != null && Math.abs(xd) >= 300) det.push(Math.abs(Math.round(xd)) + ' опыта');
      if (laneGd <= -1200 || (laneGd <= -700 && lhd != null && lhd <= -12)) {
        laneVsLost = true;
        items.push(P('lane_vs', 38 + Math.min(30, -laneGd / 100), 'Проигранная линия против ' + m.opp.hero,
          'К 10-й минуте у вас на ' + Math.abs(Math.round(laneGd)) + ' золота' + (det.length ? ' и ' + det.join(', ') : '') + ' меньше, чем у ' + m.opp.hero + ' (' + oppRole + ' соперников). Отставание на линии тянется за вами всю игру.',
          pos === 2 ? 'Мид: следите за руной каждые 2 минуты, не размениваетесь здоровьем без выгоды; если проигрываете дуэль — просите ротацию саппорта к 4–6-й минуте.'
            : pos === 1 ? 'Керри: держитесь за линией своих крипов, добивайте и отходите. Если линия проиграна к 5-й минуте — не стойте под давлением, уходите на ближний лес и возвращайтесь на волну.'
            : 'Оффлейн: ваша задача — не дать керри фармить, а не выиграть по золоту. Атакуйте его, когда он добивает крипа, и держите лагерь врага под стаком/блоком.'));
      } else if (laneGd >= 1200) {
        items.push(S('lane_vs', 48 + Math.min(20, laneGd / 200), 'Выигранная линия против ' + m.opp.hero,
          'К 10-й минуте вы на ' + Math.round(laneGd) + ' золота впереди ' + m.opp.hero + (det.length && lhd > 0 ? ' (+' + det.join(', +') + ')' : '') + '.'));
      }
    }
    /* --- ЛАЙНИНГ (ластхиты на 10-й минуте) --- */
    if (core && m.lh10 != null && m.durMin >= 12) {
      var r10 = m.lh10 / pro.lh10;
      if (r10 < 0.6 && !laneVsLost) {
        items.push(P('lane_lh10', (0.8 - r10) * 100 + 20,
          'Проигранная лайн-стадия',
          'К 10-й минуте всего ' + m.lh10 + ' ластхитов при ориентире ' + pro.lh10 + ' — вы отстаёте примерно на ' + (pro.lh10 - m.lh10) + '. Именно здесь теряется основная масса золота и опыта.',
          'Лайнинг: тренируйте добивание в демо-режиме — цель 80% добитых крипов на 5-й минуте. В игре не размениваетесь автоатаками, пока крип не в добивном диапазоне.'));
      } else if (r10 >= 1.0) {
        items.push(S('lane_lh10', 55, 'Отличный старт', m.lh10 + ' ластхитов к 10-й минуте — на уровне про-ориентира (' + pro.lh10 + ').'));
      }
    }
    if (core && m.lane != null) {
      if (m.lane < 55) {
        items.push(P('lane_eff', (60 - m.lane) + 20, 'Низкая эффективность линии',
          'Эффективность линии ' + Math.round(m.lane) + '% — вы добираете меньше, чем могли бы на этой лайн-стадии.',
          'Перед игрой: 5 минут в демо-режиме на отработку добивания своих/чужих крипов (денаи). Следите за позицией: не стойте под вышкой без причины.'));
      } else if (m.lane >= 75) {
        items.push(S('lane_eff', 45, 'Уверенный лайнинг', 'Эффективность линии ' + Math.round(m.lane) + '%.'));
      }
    }
    /* --- ОПЫТ --- */
    if ((pos === 1 || pos === 2) && sc.xpm != null && sc.xpm < 0.3 && m.durMin >= 15) {
      items.push(P('xp_low', (0.45 - sc.xpm) * 100 + 15, 'Отстаёте по уровню',
        'XPM ' + m.xpm + (m.pct.xpm != null ? ' (ниже, чем у ' + (100 - pctText(m.pct.xpm)) + '% игроков)' : '') + ' — ключевая способность приходит позже, чем должна.',
        'Не пропускайте драки в зоне доступа: опыт даётся за убийства и присутствие рядом с героями. Проверьте, нет ли долгих пауз на фарме, когда команда дерётся.'));
    }
    /* --- РАННИЕ СМЕРТИ (распарсенный матч) --- */
    if (m.deathTimes) {
      var early = m.deathTimes.filter(function (t) { return t < 600; });
      if (early.length >= (sup ? 4 : 3)) {
        items.push(P('early_deaths', 40 + early.length * 5, 'Ранние смерти на линии',
          'До 10-й минуты вы погибли ' + early.length + ' ' + plural(early.length, 'раз', 'раза', 'раз') + ' (' + early.map(mmss).join(', ') + '). Каждая ранняя смерть — это потерянные волны, опыт и золото для соперника.',
          'Первые 10 минут: держите в голове, где вражеский саппорт. Пропал с линии — отходите за своих крипов. Не стойте у вражеской стороны реки без варда.'));
      }
    }
    var deadNote = (m.deadPct != null && m.deadPct >= 0.1) ? ' Всего вы провели мёртвым ' + mmss(m.deadSec) + ' — ' + Math.round(m.deadPct * 100) + '% матча.' : '';
    /* --- СМЕРТИ --- */
    var dLimit = sup ? 4.5 : 3.5;
    if (dp10 >= dLimit && m.d >= 5) {
      var dp = Math.round(dp10 * 10) / 10;
      items.push(P('deaths', 30 + (dp10 - dLimit) * 18 + (m.won ? 0 : 10),
        'Слишком много смертей',
        m.d + ' ' + plural(m.d, 'смерть', 'смерти', 'смертей') + ' за ' + Math.round(m.durMin) + ' мин (' + dp + ' на 10 минут). Каждая смерть на кор-позиции — это пауза в фарме и потеря темпа.' + deadNote,
        'Перед каждой вылазкой задавайте себе вопрос: «Где вражеские герои на миникарте?» Если не видите 2+ героев — не заходите за реку и не идите в лес в одиночку. После первого же смертельного пика меняйте поведение.'));
    } else if (m.deadPct != null && m.deadPct >= 0.15 && m.durMin >= 20) {
      items.push(P('dead_time', 30 + (m.deadPct - 0.15) * 200, 'Много времени мёртвым',
        'Вы провели мёртвым ' + mmss(m.deadSec) + ' — ' + Math.round(m.deadPct * 100) + '% матча. Смертей немного, но они дорогие: в поздней игре каждая стоит минуту без героя.',
        'Во второй половине игры умирать нельзя первым: держитесь за инициатором, носите TP и выкуп (buyback) — копите на него после 30-й минуты.'));
    } else if (dp10 <= 1.4 && m.durMin >= 15) {
      items.push(S('deaths', 40, 'Хорошая выживаемость', m.d + ' ' + plural(m.d, 'смерть', 'смерти', 'смертей') + ' за ' + Math.round(m.durMin) + ' мин — вы редко отдаёте врагу золото.'));
    }
    /* --- УЧАСТИЕ В ДРАКАХ --- */
    var part = m.tfp != null ? m.tfp * 100 : m.kp;
    var partWhat = m.tfp != null ? 'Участие в командных драках' : 'Участие в убийствах команды';
    if (part != null && m.teamKills >= 15) {
      var kpLow = sup ? 45 : 35;
      if (part < kpLow) {
        items.push(P('kp', (kpLow - part) * 1.4 + 25, 'Мало участия в драках',
          partWhat + ' — ' + Math.round(part) + '%. Вас не хватает в моменты, когда команда дерётся.',
          sup ? 'Саппорт: держите ротацию к тиммейтам после установки варда; ждите кор-героя у линии боя.'
              : 'Следите за миникартой каждые 5 секунд; когда команда собирается на объект, телепортируйтесь/идите к ней раньше фарма.'));
      } else if (part >= 70) {
        items.push(S('kp', 38, 'Присутствие в драках', partWhat + ' — ' + Math.round(part) + '%: вы там, где решается игра.'));
      }
    }
    /* --- КОНВЕРСИЯ: фарм есть, урона нет --- */
    if (core && sc.gpm != null && sc.hd != null && sc.gpm >= 0.55 && sc.hd < 0.3) {
      items.push(P('conversion', (0.5 - sc.hd) * 100 + 25, 'Золото не превращается в урон',
        'Экономика хорошая, но урон по героям ниже, чем у ' + (100 - pctText(sc.hd)) + '% игроков. Предметы есть — вклада в драках нет.',
        'Разберите повтор: сколько драк вы пропустили или вступили слишком поздно? Цель — входить во 2–3 секунду драки и сфокусироваться на ближайшей цели.'));
    } else if (core && sc.hd != null && sc.hd >= 0.8) {
      items.push(S('hd', 42, 'Высокий урон', 'Урон по героям лучше, чем у ' + pctText(sc.hd) + '% игроков на этом герое.'));
    }
    /* --- ТЕМП ФАРМА ПОСЛЕ 20-Й МИНУТЫ (распарсенный матч) --- */
    if (core && m.g10 != null && m.g20 != null && m.g30 != null && m.durMin >= 32) {
      var r1 = (m.g20 - m.g10) / 10, r2 = (m.g30 - m.g20) / 10;
      if (r1 > 0 && r2 < r1 * 0.85) {
        items.push(P('farm_drop', 28 + Math.min(25, (1 - r2 / r1) * 80), 'Темп фарма упал после 20-й минуты',
          'С 10-й по 20-ю минуту вы получали ~' + Math.round(r1) + ' золота в минуту, а с 20-й по 30-ю — ~' + Math.round(r2) + '. У кора доход должен расти, а не падать.',
          'После 20-й минуты фармите там, где есть видение: подтолкнули линию → ближний лес → обратно к волне. Не ходите в лес врага без 2–3 тиммейтов рядом.'));
      }
    }
    /* --- TELEPORT --- */
    var hasBoT = m.items.some(function (x) { return x.key === 'travel_boots' || x.key === 'travel_boots_2'; });
    if (m.tp != null && m.durMin >= 28 && m.tp <= 2 && !hasBoT) {
      items.push(P('tp', m.tp === 0 ? 36 : 22, (m.tp === 0 ? 'Ни одного телепорта' : 'Редко покупаете телепорт'),
        'За ' + Math.round(m.durMin) + ' мин куплено всего ' + m.tp + ' ' + plural(m.tp, 'свиток', 'свитка', 'свитков') + ' телепорта. Без TP вы не успеваете на драки и защиту башен.',
        'TP всегда в слоте: использовали — сразу докупайте с курьером. Это дешевле любой проигранной драки.'));
    }
    /* --- ДЕВАРД (саппорты) --- */
    if (sup && m.obsKills != null && m.durMin >= 25) {
      if (m.obsKills === 0 && (m.sen == null || m.sen <= 2)) {
        items.push(P('deward', 26, 'Нет девардинга',
          'За игру вы не сняли ни одного вражеского обсервера' + (m.sen != null ? ' и поставили ' + m.sen + ' ' + plural(m.sen, 'сентри', 'сентри', 'сентри') : '') + '. Соперник видит каждое ваше движение.',
          'Носите 1–2 сентри и проверяйте типичные места вардов у своих башен и лагерей. Снятый вард = 100+ золота и опыт команде.'));
      } else if (m.obsKills >= 4) {
        items.push(S('deward', 30, 'Активный девард', 'Вы сняли ' + m.obsKills + ' ' + plural(m.obsKills, 'вражеский вард', 'вражеских варда', 'вражеских вардов') + ' — соперник играл вслепую.'));
      }
    }
    /* --- РУНЫ (мид) --- */
    if (pos === 2 && m.runes != null && m.durMin >= 20 && m.runes < m.durMin / 5) {
      items.push(P('runes', 18, 'Мало рун',
        'Подобрано ' + m.runes + ' ' + plural(m.runes, 'руна', 'руны', 'рун') + ' за ' + Math.round(m.durMin) + ' мин. Для мида руны — главный источник ротаций и выигранных дуэлей.',
        'Ставьте себе пометку на каждую чётную минуту: за 10–15 секунд до появления руны отводите волну и идите к реке.'));
    }
    /* --- ВЫШКИ --- */
    if (core && sc.td != null && m.durMin >= 25 && sc.td < 0.25) {
      items.push(P('towers', (0.4 - sc.td) * 100 + 10, 'Нет давления на строения',
        'Урон по строениям меньше, чем у ' + (100 - pctText(sc.td)) + '% игроков. В затянувшейся игре без снесённых башен победа не приходит.',
        'После выигранной драки — сразу на ближайшую башню или барак, не возвращайтесь на фарм. Договоритесь с командой о «пуше после каждой драки».'));
    }
    /* --- ВИДЕНИЕ (саппорты) --- */
    if (sup && m.obs != null && m.sen != null && m.durMin >= 15) {
      var wardsPerMin = (m.obs + m.sen) / m.durMin;
      if (wardsPerMin < 0.3) {
        items.push(P('vision', 40 + (0.3 - wardsPerMin) * 80, 'Мало вардов',
          'Установлено ' + (m.obs + m.sen) + ' вардов за ' + Math.round(m.durMin) + ' мин (' + round(wardsPerMin, 2) + ' в минуту). Команда играет вслепую, а вас проще поймать.',
          'Закупайте 2 обсервера и 1 сентри на каждый выход с базы. Ставьте варды на тайминги рун (каждые 2 минуты) и перед Рошаном.'));
      } else if (wardsPerMin >= 0.55) {
        items.push(S('vision', 40, 'Хорошее видение', 'Установлено ' + (m.obs + m.sen) + ' вардов — карта под контролем.'));
      }
    }
    if (sup && m.stacked != null && m.stacked >= 3) {
      items.push(S('stacks', 25, 'Стаки лагерей', 'Вы сделали ' + m.stacked + ' ' + plural(m.stacked, 'стак', 'стака', 'стаков') + ' — это помогает коре фармить быстрее.'));
    }
    /* --- ПРЕДМЕТЫ: Blink --- */
    var blink = m.items.filter(function (x) { return x.key === 'blink'; })[0];
    if (core && blink) {
      var bm = blink.time / 60;
      if (bm > pro.blink + 4) {
        items.push(P('blink_late', Math.min(55, 20 + (bm - pro.blink - 4) * 4), 'Поздний Blink Dagger',
          'Blink куплен на ' + Math.floor(bm) + '-й минуте, про-ориентир — около ' + pro.blink + '-й.',
          'Планируйте покупку: после ботинок и основной вещи сразу собирайте 2250 золота на Blink и откладывайте дорогую слабую вещь.'));
      }
    }
    var deep = deepDota(m, items);
    var coach = coachDota(m, items);
    if (items.some(function (i) { return i.id === 'feed_core'; })) items = items.filter(function (i) { return i.id !== 'repeat_killer'; });
    if (items.some(function (i) { return i.id === 'mid_runes2'; })) items = items.filter(function (i) { return i.id !== 'runes'; });
    if (items.some(function (i) { return i.id === 'lane_regen'; })) items = items.filter(function (i) { return i.id !== 'early_deaths'; });
    deep.penalty = Math.min(30, deep.penalty + coach.penalty);
    /* --- КОНТЕКСТ РЕЗУЛЬТАТА --- */
    var parts = [];
    ['gpm', 'xpm', 'hd', 'kills'].forEach(function (k) { if (sc[k] != null) parts.push(sc[k]); });
    parts.push(survScore);
    if (part != null) parts.push(clamp(part / 70, 0, 1));
    if (laneGd != null) parts.push(clamp(0.5 + laneGd / 4000, 0, 1));
    if (sup && m.obs != null && m.sen != null) parts.push(clamp(((m.obs + m.sen) / m.durMin) / 0.55, 0, 1));
    if (core) { /* у кор-героев фарм важнее — учитываем GPM дважды */ if (sc.gpm != null) parts.push(sc.gpm); }
    var perf = parts.reduce(function (a, b) { return a + b; }, 0) / parts.length;
    var score = Math.max(5, Math.round(clamp(perf, 0, 1) * 100 - deep.penalty));

    /* --- ОБЩИЙ ВКЛАД В МАТЧ (собственный индекс на данных OpenDota) --- */
    if (parts.length >= 3) {
      if (score <= 22) items.push(P('impact', 55 - score, 'Низкий общий вклад в матч',
        'По сумме фарма, урона, опыта и участия в боях ваш вклад в этот матч ниже среднего (' + score + ' из 100).',
        'Посмотрите повтор целиком: на какой минуте вы перестали успевать за игрой — фарм, драки или карта?'));
      else if (score >= 82) items.push(S('impact', score - 40, 'Высокий общий вклад в матч',
        'По сумме фарма, урона, опыта и участия в боях вы были одним из сильнейших игроков матча (' + score + ' из 100).'));
    }

    /* --- ГДЕ РЕШИЛАСЬ ИГРА (золото команды) --- */
    if (m.teamAdv && m.teamAdv.length >= 15) {
      var adv = m.teamAdv, best = null;
      for (var i = 0; i + 10 < adv.length; i++) {
        var dlt = adv[i + 10] - adv[i];
        if (m.won ? (best == null || dlt > best.d) : (best == null || dlt < best.d)) best = { i: i, d: dlt };
      }
      if (best && Math.abs(best.d) >= 5000) {
        items.push(N('swing', m.won ? 'Где выиграна игра' : 'Где проиграна игра',
          'С ' + best.i + '-й по ' + (best.i + 10) + '-ю минуту ваша команда ' + (best.d < 0 ? 'потеряла ' : 'набрала ') + Math.abs(Math.round(best.d / 100) / 10) + 'K золота преимущества (было ' + kfmt(adv[best.i]) + ', стало ' + kfmt(adv[best.i + 10]) + '). ' +
          (m.won ? 'Посмотрите, что сработало в этом отрезке, — это ваш рецепт победы.' : 'Разбор повтора начните именно с этого отрезка: какие драки и объекты были отданы.')));
      }
    }

    var hasMajor = items.some(function (i) { return i.kind === 'problem' && i.severity >= 40; });
    if (!m.won && score >= 68 && !hasMajor) {
      items.push(N('context_loss', 'Поражение при сильных показателях',
        'Ваши цифры выше среднего, но матч проигран. По статистике упрекнуть себя не в чем — ищите причины в драфте, выборе моментов для драки и решениях команды.'));
    } else if (m.won && score < 40) {
      items.push(N('context_win', 'Победа при слабых показателях',
        'Матч выигран, но ваш личный вклад ниже среднего — команда вас вытащила. На следующей игре такого везения может не быть.'));
    }

    var res = finish(items, {
      title: 'Разбор тренера · ' + m.hero + ' · ' + posName,
      score: score,
      foot: m.parsed
        ? (m.approxPos ? 'Позиция определена по фарму внутри команды и может быть неточной.' : '')
        : 'Матч ещё не распарсен OpenDota: разбор построен на итоговой статистике, а позиция определена по фарму внутри команды. Лайнинг против соперника, ранние смерти, темп фарма и ход игры появятся после парсинга.'
    });
    res.summary = dotaSummary(res, m);
    res.verdict = dotaVerdict(res, m);
    res.timeline = deep.timeline;
    res.facts = deep.facts;
    if (coach.impact) res.impact = coach.impact;
    if (coach.phases) res.phases = coach.phases;
    if (coach.goals && coach.goals.length) res.goals = coach.goals;
    return res;
  }

  // Вердикт: 2–3 предложения о том, что решило матч для этого игрока
  function dotaVerdict(r, m) {
    if (!m.parsed) return '';
    var parts = [];
    var strong = r.strengths[0], probs = r.problems;
    parts.push((m.won ? 'Победа' : 'Поражение') + ' на ' + m.hero + ': ' + m.k + '/' + m.d + '/' + m.a + ', ' + m.gpm + ' GPM.');
    if (strong) parts.push('Лучшее в вашей игре — ' + lowerFirst(strong.title) + '.');
    if (probs.length >= 2) parts.push('Главные точки роста: «' + probs[0].title + '» и «' + probs[1].title + '» — с них стоит начать работу.');
    else if (probs.length === 1) parts.push('Главная точка роста: «' + probs[0].title + '».');
    else parts.push('Крупных ошибок алгоритм не нашёл, ищите резерв в деталях ниже.');
    return parts.join(' ');
  }

  function dotaSummary(r, m) {
    var head = (m.won ? 'Победа' : 'Поражение') + ' на ' + m.hero + ' (' + (DOTA_POS_NAMES[m.pos] || 'роль не определена') + '): ' + m.k + '/' + m.d + '/' + m.a + ', ' + m.gpm + ' GPM.';
    if (r.main) return head + ' Главное, что тянуло вниз, — ' + lowerFirst(r.main.title) + '.';
    if (r.strengths.length) return head + ' Серьёзных проблем алгоритм не нашёл — ' + lowerFirst(r.strengths[0].title) + '.';
    return head + ' Серьёзных проблем алгоритм не нашёл.';
  }

  /* ------------------------------------------------------------------ */
  /* Dota 2: разбор профиля (вкладка «Моя статистика»)                   */
  /* ------------------------------------------------------------------ */
  function analyzeDotaProfile(matches, heroes, heroName) {
    matches = Array.isArray(matches) ? matches : [];
    heroes = Array.isArray(heroes) ? heroes : [];
    var items = [];
    var n = matches.length;
    if (n < 5) {
      return finish([N('few', 'Мало матчей', 'Для разбора нужно хотя бы 5 матчей за выбранный период. Выберите период больше.')],
        { title: 'Разбор профиля' });
    }
    function won(m) { return m.radiant_win === (num(m.player_slot) < 128); }
    var wins = matches.filter(won).length, wr = wins / n;

    // тренд: матчи приходят от новых к старым
    if (n >= 10) {
      var half = Math.floor(n / 2);
      var newer = matches.slice(0, half), older = matches.slice(n - half);
      var wrNew = newer.filter(won).length / newer.length, wrOld = older.filter(won).length / older.length;
      var diff = Math.round((wrNew - wrOld) * 100);
      if (diff <= -15) items.push(P('trend_down', 35 + Math.abs(diff), 'Серия неудач',
        'В последних матчах винрейт ' + Math.round(wrNew * 100) + '% против ' + Math.round(wrOld * 100) + '% раньше. Похоже на тильт или смену мета.',
        'Сделайте паузу после двух поражений подряд. Вернитесь к 2–3 самым успешным героям из списка ниже.'));
      else if (diff >= 15) items.push(S('trend_up', 40 + diff, 'Прогресс', 'Винрейт вырос с ' + Math.round(wrOld * 100) + '% до ' + Math.round(wrNew * 100) + '% — вы набираете форму.'));
    }
    // герои
    var hs = heroes.filter(function (h) { return num(h.games) > 0; }).sort(function (a, b) { return b.games - a.games; });
    var totalG = hs.reduce(function (s, h) { return s + num(h.games); }, 0);
    if (hs.length && totalG >= 10) {
      var top = hs[0];
      var share = top.games / totalG;
      if (share >= 0.45) items.push(S('onetrick', 38, 'Узкий пул героев',
        heroName(top.hero_id) + ' — ' + Math.round(share * 100) + '% ваших игр. Глубокое знание героя — реальное преимущество в рейтинге.'));
      var top3 = hs.slice(0, 3).reduce(function (s, h) { return s + num(h.games); }, 0);
      if (totalG >= 20 && top3 / totalG < 0.3) items.push(P('wide_pool', 45, 'Слишком широкий пул героев',
        'Топ-3 героя — лишь ' + Math.round(top3 / totalG * 100) + '% игр. Распыляясь, трудно довести механики до автоматизма.',
        'Выберите 3 героя (по одному на 1–2 позиции) и играйте только ими следующие 20 матчей.'));
      var withG = hs.filter(function (h) { return num(h.games) >= 5; });
      var best = withG.slice().sort(function (a, b) { return b.win / b.games - a.win / a.games; })[0];
      var worst = withG.slice().sort(function (a, b) { return a.win / a.games - b.win / b.games; })[0];
      if (best && best.win / best.games >= 0.6) items.push(S('best_hero', 35, 'Лучший герой',
        heroName(best.hero_id) + ' — ' + Math.round(best.win / best.games * 100) + '% побед за ' + best.games + ' ' + plural(best.games, 'игру', 'игры', 'игр') + '. Берите его чаще.'));
      if (worst && worst !== best && worst.win / worst.games <= 0.4) items.push(P('worst_hero', 50 + (0.4 - worst.win / worst.games) * 100, 'Проблемный герой',
        heroName(worst.hero_id) + ' — всего ' + Math.round(worst.win / worst.games * 100) + '% побед за ' + worst.games + ' ' + plural(worst.games, 'игру', 'игры', 'игр') + '.',
        'Уберите ' + heroName(worst.hero_id) + ' из пула на неделю или разберите 2–3 его матча по повторам.'));
    }
    // смерти
    var totD = 0, totDur = 0;
    matches.forEach(function (m) { totD += num(m.deaths); totDur += num(m.duration); });
    var dp10 = totDur > 0 ? totD / (totDur / 600) : 0;
    if (dp10 >= 3.5) items.push(P('deaths', 40 + (dp10 - 3.5) * 15, 'Много смертей в среднем',
      'В среднем ' + round(dp10, 1) + ' смертей на 10 минут игры. Это системная проблема, а не случайность.',
      'Правило «карта перед шагом»: перед выходом за пределы линии смотрите миникарту. Цель на неделю — меньше 3 смертей на 10 минут.'));
    else if (dp10 > 0 && dp10 <= 1.8) items.push(S('deaths', 36, 'Аккуратная игра', 'Всего ' + round(dp10, 1) + ' смертей на 10 минут — вы редко рискуете зря.'));
    // короткие / длинные игры
    var short = matches.filter(function (m) { return num(m.duration) < 1800; });
    var long = matches.filter(function (m) { return num(m.duration) >= 2400; });
    if (short.length >= 5 && long.length >= 5) {
      var wrS = short.filter(won).length / short.length, wrL = long.filter(won).length / long.length;
      if (wrS - wrL >= 0.2) items.push(P('late_game', 40, 'Слабая поздняя игра',
        'В играх до 30 минут вы выигрываете ' + Math.round(wrS * 100) + '%, а в играх от 40 минут — только ' + Math.round(wrL * 100) + '%.',
        'В затянутых играх чаще используйте Рошана и пуш после драк; следите за тем, чтобы не отдавать пустые решающие драки.'));
      else if (wrL - wrS >= 0.2) items.push(P('early_game', 40, 'Слабая ранняя игра',
        'Долгие игры вы выигрываете на ' + Math.round((wrL - wrS) * 100) + ' п.п. чаще коротких — ранние фазы проседают.',
        'Работайте над лайн-стадией: 70+ ластхитов к 10-й минуте на керри, давление на линии для оффлейна.'));
    }
    var res = finish(items, {
      title: 'Разбор профиля',
      summary: 'Проанализировано ' + n + ' ' + plural(n, 'матч', 'матча', 'матчей') + ', общий винрейт — ' + Math.round(wr * 100) + '%.'
    });
    return res;
  }

  /* ------------------------------------------------------------------ */
  /* CS 2                                                                */
  /* ------------------------------------------------------------------ */

  // Ориентировочные нормы по уровню FACEIT (используются, только если нет личной истории).
  // Это приближения, а не официальная статистика — заменяйте реальными данными вашей базы.
  function csRef(level) {
    var l = clamp(num(level, 5), 1, 10);
    return {
      adr: { m: 58 + l * 2.6, sd: 13 },
      hs: { m: 44, sd: 12 },
      kd: { m: 1.0, sd: 0.28 },
      dpr: { m: 0.68, sd: 0.1 }
    };
  }

  function keyify(k) { return String(k).toLowerCase().replace(/%/g, 'pct').replace(/[^a-z0-9]/g, ''); }
  function rawMap(raw) {
    var o = {};
    Object.keys(raw || {}).forEach(function (k) { o[keyify(k)] = raw[k]; });
    return o;
  }
  function pickRaw(map, names) {
    for (var i = 0; i < names.length; i++) {
      var v = map[keyify(names[i])];
      if (isNum(v)) return parseFloat(v);
    }
    return null;
  }

  /** Приводит player_stats из FACEIT (любой набор ключей) к плоскому виду. */
  function normalizeCsStats(raw, rounds) {
    var m = rawMap(raw);
    var kills = pickRaw(m, ['Kills']) || 0, deaths = pickRaw(m, ['Deaths']) || 0, assists = pickRaw(m, ['Assists']) || 0;
    var rds = rounds || pickRaw(m, ['Rounds']) || null;
    var damage = pickRaw(m, ['Damage']);
    var adr = pickRaw(m, ['ADR', 'Average Damage per Round']);
    if (adr == null && damage != null && rds) adr = damage / rds;
    var hsPct = pickRaw(m, ['Headshots %', 'Headshots Percentage']);
    var hsCnt = pickRaw(m, ['Headshot', 'Headshots']);
    if (hsPct == null && hsCnt != null && kills > 0) hsPct = hsCnt / kills * 100;
    var kd = pickRaw(m, ['K/D Ratio']);
    if (kd == null) kd = deaths > 0 ? kills / deaths : kills;
    var entryCnt = pickRaw(m, ['Match Entry Count', 'Entry Count']);
    var entryWin = pickRaw(m, ['Match Entry Wins', 'Entry Wins']);
    return {
      kills: kills, deaths: deaths, assists: assists, rounds: rds,
      kd: kd, adr: adr, hs: hsPct,
      kpr: pickRaw(m, ['K/R Ratio']) != null ? pickRaw(m, ['K/R Ratio']) : (rds ? kills / rds : null),
      dpr: rds ? deaths / rds : null,
      mvps: pickRaw(m, ['MVPs']) || 0,
      triple: pickRaw(m, ['Triple Kills']) || 0,
      quadro: pickRaw(m, ['Quadro Kills']) || 0,
      penta: pickRaw(m, ['Penta Kills']) || 0,
      entryCnt: entryCnt, entryWin: entryWin,
      firstKills: pickRaw(m, ['First Kills']),
      v1c: pickRaw(m, ['1v1Count']), v1w: pickRaw(m, ['1v1Wins']),
      v2c: pickRaw(m, ['1v2Count']), v2w: pickRaw(m, ['1v2Wins']),
      utilDmg: pickRaw(m, ['Utility Damage']),
      enemiesFlashed: pickRaw(m, ['Enemies Flashed']),
      flashCount: pickRaw(m, ['Flash Count']),
      flashSucc: pickRaw(m, ['Flash Successes']),
      sniperKills: pickRaw(m, ['Sniper Kills'])
    };
  }

  /**
   * Личная норма игрока из его последних матчей.
   * items — ответ /players/{id}/games/cs2/stats ({items:[{stats:{...}}]}).
   */
  function buildCsBaseline(items, excludeMatchId) {
    var list = (Array.isArray(items) ? items : []).map(function (it) { return it && it.stats ? it.stats : null; })
      .filter(function (s) {
        if (!s) return false;
        if (excludeMatchId) {
          var mm = rawMap(s);
          if (String(mm.matchid || '') === String(excludeMatchId)) return false;
        }
        return true;
      });
    var acc = { kd: [], adr: [], hs: [], dpr: [] };
    list.forEach(function (s) {
      var n = normalizeCsStats(s);
      if (isNum(n.kd)) acc.kd.push(n.kd);
      if (isNum(n.adr) && n.adr > 0) acc.adr.push(n.adr);
      if (isNum(n.hs)) acc.hs.push(n.hs);
      if (isNum(n.dpr)) acc.dpr.push(n.dpr);
    });
    function avg(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }
    var kdAvg = avg(acc.kd);
    return { n: list.length, kd: kdAvg, adr: avg(acc.adr), hs: avg(acc.hs), dpr: avg(acc.dpr) };
  }

  function zOf(value, base, sd) { return (value - base) / sd; }

  function analyzeCs2(ctx) {
    var s = ctx.stats, items = [];
    var level = ctx.level, base = ctx.baseline && ctx.baseline.n >= 5 ? ctx.baseline : null;
    var ref = csRef(level);
    var rounds = s.rounds || ctx.rounds || 24;
    var awpShare = (s.sniperKills != null && s.kills > 0) ? s.sniperKills / s.kills : 0;
    var isAwp = awpShare >= 0.3;
    var ruleLabel = base ? 'вашей нормы за ' + base.n + ' ' + plural(base.n, 'матч', 'матча', 'матчей') : 'нормы уровня ' + (level || '—');

    // «норма» и разброс: личная история приоритетнее уровня FACEIT
    var kdBase = base && base.kd != null ? base.kd : ref.kd.m;
    var adrBase = base && base.adr != null ? base.adr : ref.adr.m;
    var hsBase = base && base.hs != null ? base.hs : ref.hs.m;
    var dprBase = base && base.dpr != null ? base.dpr : ref.dpr.m;

    var zs = [];
    var zKd = zOf(s.kd, kdBase, ref.kd.sd); zs.push(zKd);
    var zAdr = null, zHs = null, zDpr = null;
    if (isNum(s.adr) && s.adr > 0) { zAdr = zOf(s.adr, adrBase, ref.adr.sd); zs.push(zAdr, zAdr); }
    if (isNum(s.dpr)) { zDpr = -zOf(s.dpr, dprBase, ref.dpr.sd); zs.push(zDpr); }

    /* --- K/D --- */
    if (zKd <= -0.8 || s.kd < 0.75) {
      items.push(P('kd', 35 + Math.abs(Math.min(zKd, 0)) * 25,
        'Низкий K/D',
        'K/D ' + round(s.kd, 2) + ' (' + s.kills + '/' + s.deaths + ') — ниже ' + ruleLabel + ' (' + round(kdBase, 2) + ').',
        'После каждого матча смотрите три свои первые смерти: были ли они в одиночных дуэлях без поддержки? Следующую неделю играйте ближе к напарнику (в пределах одного пика).'));
    } else if (zKd >= 0.9 || s.kd >= 1.35) {
      items.push(S('kd', 40 + Math.max(zKd, 0) * 10, 'Сильный K/D',
        'K/D ' + round(s.kd, 2) + ' (' + s.kills + '/' + s.deaths + ') — заметно выше ' + ruleLabel + ' (' + round(kdBase, 2) + ').'));
    }
    /* --- ADR --- */
    if (zAdr != null) {
      if (zAdr <= -0.8) {
        items.push(P('adr', 38 + Math.abs(zAdr) * 22, 'Низкий урон за раунд',
          'ADR ' + Math.round(s.adr) + ' — на ' + Math.abs(pctDiff(s.adr, adrBase)) + '% ниже ' + ruleLabel + ' (' + Math.round(adrBase) + '). Вы вносите меньше вклада, чем обычно.',
          'Перед игрой — 15 минут Deathmatch: цель не фраги, а ADR выше 75. Играйте активнее: даже без убийства урон помогает команде добить врага.'));
      } else if (zAdr >= 0.9) {
        items.push(S('adr', 40 + zAdr * 10, 'Высокий урон', 'ADR ' + Math.round(s.adr) + ' — на ' + pctDiff(s.adr, adrBase) + '% выше ' + ruleLabel + '.'));
      }
    }
    /* --- ВЫЖИВАЕМОСТЬ --- */
    if (s.dpr != null && (s.dpr >= 0.75 || (zDpr != null && zDpr <= -1.2 && s.dpr >= 0.66))) {
      items.push(P('survival', 30 + Math.max(s.dpr - 0.6, 0) * 180, 'Слишком частые смерти',
        s.deaths + ' ' + plural(s.deaths, 'смерть', 'смерти', 'смертей') + ' за ' + rounds + ' ' + plural(rounds, 'раунд', 'раунда', 'раундов') + ' — вы умираете в ' + Math.round(s.dpr * 100) + '% раундов' +
          (base && base.dpr != null ? ' (обычно — в ' + Math.round(base.dpr * 100) + '%).' : '.'),
        'Не пикайте в одиночку без флешки. После убийства меняйте позицию (в CS2 вас видят по дыму/звуку). Отработайте shoulder-peek и jiggle-peek на карте aim_botz или в Deathmatch.'));
    } else if (s.dpr != null && s.dpr <= 0.55 && rounds >= 16) {
      items.push(S('survival', 36, 'Живучесть', 'Вы умирали лишь в ' + Math.round(s.dpr * 100) + '% раундов.'));
    }
    /* --- ХЕДШОТЫ --- */
    if (s.hs != null && !isAwp) {
      if (s.hs <= hsBase - 12 && s.hs < 40) {
        items.push(P('hs', 25 + (hsBase - s.hs), 'Прицел ниже головы',
          'HS ' + Math.round(s.hs) + '% — ниже ' + ruleLabel + ' (' + Math.round(hsBase) + '%). Пули уходят в корпус, из-за чего приходится тратить больше выстрелов.',
          'Crosshair placement: на каждой карте следите, чтобы прицел был на уровне головы при движении. 10 минут в день — aim_botz (hs only), затем DM с одной винтовкой.'));
      } else if (s.hs >= Math.max(hsBase + 12, 60)) {
        items.push(S('hs', 30, 'Точный прицел', 'HS ' + Math.round(s.hs) + '% — выше ' + ruleLabel + '.'));
      }
      if (s.hs >= 60 && zAdr != null && zAdr <= -0.6) {
        items.push(P('hs_low_adr', 35, 'Много хедшотов, мало урона',
          'HS высокий (' + Math.round(s.hs) + '%), но ADR низкий (' + Math.round(s.adr) + '). Вы выигрываете дуэли, но мало их берёте.',
          'Берите больше инициативы: идите на пики раньше, а не ждите врага в углу. Играйте ближе к бомбсайту, где больше контактов.'));
      }
    }
    /* --- ENTRY --- */
    if (s.entryCnt != null && s.entryCnt >= 3) {
      var ew = s.entryWin != null ? s.entryWin / s.entryCnt : null;
      if (ew != null && ew < 0.4) {
        items.push(P('entry', 40 + (0.45 - ew) * 80, 'Проигранные первые дуэли',
          'Вы выигрываете лишь ' + Math.round(ew * 100) + '% первых дуэлей (' + s.entryWin + ' из ' + s.entryCnt + '). Каждая такая смерть отдаёт раунд в неравном составе.',
          'Заходите за флешкой напарника или за дымом. Не пикайте стоя: тренируйте swing-peek. Если вы не entry — не берите на себя эту роль.'));
      } else if (ew != null && ew >= 0.6) {
        items.push(S('entry', 38, 'Сильные первые дуэли', 'Выиграно ' + s.entryWin + ' из ' + s.entryCnt + ' первых дуэлей (' + Math.round(ew * 100) + '%).'));
      }
    }
    /* --- КЛАТЧИ --- */
    var c1c = (s.v1c || 0), c1w = (s.v1w || 0);
    if (c1c >= 2 && c1w / c1c < 0.34) {
      items.push(P('clutch', 30, 'Слабая игра 1vX',
        'Выиграно ' + c1w + ' из ' + c1c + ' клатчей 1v1.',
        'В 1v1 слушайте, не бегите: займите позицию, где враг должен пикнуть вас. Отрабатывайте 1v1 на деате с ботами.'));
    } else if (c1w >= 2 || (s.v2w || 0) >= 1) {
      items.push(S('clutch', 35, 'Клатч-способности', 'Выиграно клатчей: 1v1 — ' + c1w + (s.v2w ? ', 1v2 — ' + s.v2w : '') + '.'));
    }
    /* --- УТИЛИТИ --- */
    if (s.utilDmg != null && rounds) {
      var uPerRound = s.utilDmg / rounds;
      if (uPerRound < 2.5 && rounds >= 16) {
        items.push(P('utility', 30 + (2.5 - uPerRound) * 8, 'Мало урона гранатами',
          'Урон гранатами — ' + round(uPerRound, 1) + ' за раунд (всего ' + Math.round(s.utilDmg) + '). Гранаты чаще лежат в инвентаре, чем бросаются.',
          'Выучите по 2 раскидки (смок + молотов) на каждую карту из пула. Бросайте HE и молотов перед входом, даже если не знаете, где враги.'));
      } else if (uPerRound >= 8) {
        items.push(S('utility', 33, 'Гранаты в деле', 'Урон гранатами ' + round(uPerRound, 1) + ' за раунд — вы эффективно используете утилити.'));
      }
    }
    if (s.flashCount != null && s.flashCount >= 6 && s.enemiesFlashed != null) {
      var fr = s.enemiesFlashed / s.flashCount;
      if (fr < 0.8) {
        items.push(P('flashes', 28 + (0.8 - fr) * 30, 'Флешки не ослепляют',
          'Флешек брошено ' + Math.round(s.flashCount) + ', ослеплено врагов — ' + Math.round(s.enemiesFlashed) + ' (' + round(fr, 2) + ' на флешку).',
          'Отрабатывайте флешки «из-за угла» и «в потолок»: 3 раскидки на карту, которые ослепляют сразу при пике.'));
      }
    }
    /* --- МУЛЬТИКИЛЛЫ --- */
    if (s.quadro + s.penta >= 1) {
      items.push(S('multi', 42, 'Взрывной раунд', 'За матч получилось ' + (s.penta ? 'эйс' : 'квадро-килл') + ' — вы умеете забирать раунды в одиночку.'));
    } else if (s.triple >= 2) {
      items.push(S('multi', 30, 'Тройные убийства', 'Вы сделали ' + s.triple + ' раунда с тремя убийствами.'));
    }
    /* --- СТИЛЬ AWP --- */
    if (isAwp) {
      items.push(N('awp', 'Вы играли с AWP', 'Снайперские убийства — ' + Math.round(awpShare * 100) + '% ваших фрагов, поэтому процент хедшотов не оценивался.'));
    }
    /* --- ОЦЕНКА --- */
    var z = zs.reduce(function (a, b) { return a + b; }, 0) / zs.length;
    var score = Math.round(clamp(50 + 18 * z, 5, 98));
    if (!ctx.won && score >= 68) {
      items.push(N('context_loss', 'Поражение при сильных показателях',
        'Ваши цифры выше нормы, но матч проигран. Скорее всего, не хватило командной игры — посмотрите, сколько ваших убийств пришлось на раунды, которые команда всё равно проиграла.'));
    } else if (ctx.won && score < 40) {
      items.push(N('context_win', 'Победа при слабых показателях',
        'Матч выигран, но ваш личный вклад ниже нормы — команда вас вытащила.'));
    }
    var res = finish(items, {
      title: 'Разбор тренера · CS2' + (ctx.map ? ' · ' + ctx.map : ''),
      score: score,
      foot: base ? 'Сравнение с вашей личной нормой по ' + base.n + ' ' + plural(base.n, 'последнему матчу', 'последним матчам', 'последним матчам') + '.'
                 : 'Личная история недоступна — использованы ориентировочные нормы для уровня FACEIT ' + (level || '—') + '.'
    });
    res.summary = csSummary(res, s, ctx);
    return res;
  }

  function csSummary(r, s, ctx) {
    var head = (ctx.won ? 'Победа' : 'Поражение') + (ctx.map ? ' на ' + ctx.map : '') + ': ' + s.kills + '/' + s.deaths + '/' + s.assists +
      (isNum(s.adr) && s.adr > 0 ? ', ADR ' + Math.round(s.adr) : '') + '.';
    if (r.main) return head + ' Главная проблема — ' + lowerFirst(r.main.title) + '.';
    if (r.strengths.length) return head + ' Серьёзных проблем не найдено — ' + lowerFirst(r.strengths[0].title) + '.';
    return head + ' Серьёзных проблем не найдено.';
  }

  /* ------------------------------------------------------------------ */
  /* CS 2: разбор профиля Steam (накопительная статистика)               */
  /* ------------------------------------------------------------------ */
  var CS_AWP_KEYS = ['total_kills_awp', 'total_kills_ssg08'];
  function analyzeCs2Profile(st) {
    var items = [];
    function g(k) { return num(st && st[k], 0); }
    var kills = g('total_kills'), deaths = g('total_deaths'), hsK = g('total_kills_headshot');
    var shots = g('total_shots_fired'), hits = g('total_shots_hit');
    var mP = g('total_matches_played'), mW = g('total_matches_won');
    var rounds = g('total_rounds_played'), dmg = g('total_damage_done');
    var awp = CS_AWP_KEYS.reduce(function (s, k) { return s + g(k); }, 0);
    if (kills < 200) {
      return finish([N('few', 'Мало данных', 'В профиле слишком мало убийств для надёжного разбора.')], { title: 'Разбор профиля CS2' });
    }
    var kd = deaths > 0 ? kills / deaths : kills;
    var isAwp = awp / kills >= 0.3;
    if (kd < 0.9) items.push(P('kd', 40 + (0.9 - kd) * 100, 'K/D ниже единицы',
      'Общий K/D ' + round(kd, 2) + ' — вы чаще умираете, чем убиваете.',
      'Играйте ближе к команде и не вступайте в дуэли без поддержки. Недельный план: 15 минут DM перед играми, после — разбор своих смертей.'));
    else if (kd >= 1.2) items.push(S('kd', 40 + (kd - 1.2) * 50, 'Хороший K/D', 'Общий K/D ' + round(kd, 2) + ' — выше среднего.'));
    var hs = hsK / kills * 100;
    if (!isAwp) {
      if (hs < 35) items.push(P('hs', 35 + (40 - hs), 'Низкий процент хедшотов',
        'Хедшоты — ' + Math.round(hs) + '% убийств. Скорее всего, прицел держится ниже головы.',
        'Каждый день 10 минут aim_botz (только голова) и 10 минут deathmatch с винтовкой. Следите за высотой прицела при передвижении.'));
      else if (hs >= 55) items.push(S('hs', 38, 'Точный прицел', 'Хедшоты — ' + Math.round(hs) + '% убийств.'));
    } else {
      items.push(N('awp', 'Игра с AWP', 'Снайперские убийства — ' + Math.round(awp / kills * 100) + '% от всех: процент хедшотов не оценивался.'));
    }
    if (shots > 1000) {
      var acc = hits / shots * 100;
      if (acc < 14) items.push(P('accuracy', 30 + (16 - acc) * 4, 'Низкая точность стрельбы',
        'Точность ' + round(acc, 1) + '% — много выстрелов уходит впустую (пролётные спреи).',
        'Стреляйте очередями по 2–3 пули на средней дистанции и прицельно с первой пули на дальней. Тренировка: Recoil Master (карта в мастерской).'));
      else if (acc >= 22) items.push(S('accuracy', 33, 'Экономные выстрелы', 'Точность ' + round(acc, 1) + '% — вы редко палите вхолостую.'));
    }
    if (mP >= 30) {
      var wr = mW / mP * 100;
      if (wr < 45) items.push(P('winrate', 35 + (50 - wr), 'Винрейт ниже 50%', 'Выигрыш ' + Math.round(wr) + '% матчей (' + mW + ' из ' + mP + ').',
        'Играйте в стаке или с постоянными партнёрами: дисциплина команды сильнее личных показателей. Обсуждайте тактики до старта.'));
      else if (wr >= 55) items.push(S('winrate', 38, 'Высокий винрейт', 'Выиграно ' + Math.round(wr) + '% матчей (' + mW + ' из ' + mP + ').'));
    }
    if (rounds > 0 && dmg > 0) {
      var adr = dmg / rounds;
      if (adr < 60) items.push(P('adr', 35 + (65 - adr), 'Низкий средний урон', 'Средний урон за раунд ≈ ' + Math.round(adr) + '.',
        'Фокусируйтесь на ADR, а не на убийствах: наносите урон даже при отходе — это помогает команде добивать.'));
      else if (adr >= 80) items.push(S('adr', 38, 'Высокий урон', 'Средний урон за раунд ≈ ' + Math.round(adr) + '.'));
    }
    return finish(items, {
      title: 'Разбор профиля CS2',
      summary: 'Анализ накопительной статистики: ' + kills.toLocaleString('ru-RU') + ' убийств, K/D ' + round(kd, 2) + (mP ? ', ' + mP + ' матчей' : '') + '.',
      foot: 'Данные Steam показывают статистику за всё время игры, без фильтра по периоду.'
    });
  }

  /* ------------------------------------------------------------------ */
  /* Отрисовка отчёта                                                    */
  /* ------------------------------------------------------------------ */
  function renderEvidence(p, open) {
    var h = '';
    if (p.why) h += '<div class="coach-why">' + esc(p.why) + '</div>';
    if (p.evidence && p.evidence.length) {
      var lis = p.evidence.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('');
      h += open ? '<ul class="coach-ev">' + lis + '</ul>'
                : '<details><summary class="coach-ev-sum">Где это было (' + p.evidence.length + ')</summary><ul class="coach-ev">' + lis + '</ul></details>';
    }
    return h;
  }
  function renderTable(t) {
    if (!t || !t.rows || !t.rows.length) return '';
    var h = '<div class="analysis-section"><div class="analysis-section-title"><svg class="ico"><use href="#i-target"/></svg> ' + esc(t.title) + '</div><div class="coach-table-wrap"><table class="coach-table"><thead><tr>';
    t.cols.forEach(function (c) { h += '<th>' + esc(c) + '</th>'; });
    h += '</tr></thead><tbody>';
    t.rows.forEach(function (row) {
      h += '<tr>' + row.map(function (c) {
        var cls = typeof c === 'object' && c ? (c.tone || '') : '';
        var v = typeof c === 'object' && c ? c.v : c;
        return '<td' + (cls ? ' class="' + cls + '"' : '') + '>' + esc(v) + '</td>';
      }).join('') + '</tr>';
    });
    h += '</tbody></table></div>' + (t.note ? '<div class="coach-table-note">' + esc(t.note) + '</div>' : '') + '</div>';
    return h;
  }

  function renderReport(r) {
    if (!r) return '';
    var h = '<div class="result-block"><div class="result-block-title"><svg class="ico"><use href="#i-spark"/></svg> ' + esc(r.title) + '</div>';
    if (r.score) {
      var cls = r.score.value >= 60 ? 'good' : (r.score.value < 40 ? 'bad' : '');
      h += '<div class="metrics-grid"><div class="metric-card"><div class="metric-label">Оценка матча</div><div class="metric-value">' + r.score.value + '<span style="font-size:0.9rem;color:#888;"> / 100</span></div><div class="metric-sub ' + cls + '">' + esc(r.score.label) + '</div></div></div>';
    }
    if (r.impact) {
      h += '<div class="coach-impact"><div class="coach-impact-head">' + esc(r.impact.headline) + '</div>';
      (r.impact.parts || []).forEach(function (p) { h += '<span class="coach-chip ' + (p.tone === 'good' || p.tone === 'bad' ? p.tone : '') + '">' + esc(p.label) + ': ' + esc(p.value) + '</span>'; });
      if (r.impact.note) h += '<div class="coach-impact-note">' + esc(r.impact.note) + '</div>';
      h += '</div>';
    }
    if (r.verdict) h += '<div class="verdict-box"><div class="verdict-label"><svg class="ico"><use href="#i-bulb"/></svg> Вердикт тренера</div><div class="verdict-text">' + esc(r.verdict) + '</div></div>';
    else if (r.summary) h += '<div class="analysis-text">' + esc(r.summary) + '</div>';
    if (r.facts && r.facts.length) {
      h += '<div class="analysis-section"><div class="analysis-section-title"><svg class="ico"><use href="#i-target"/></svg> Ключевые показатели</div><div class="metrics-grid">';
      r.facts.forEach(function (f) {
        h += '<div class="metric-card"><div class="metric-label">' + esc(f.label) + '</div><div class="metric-value">' + esc(f.value) + '</div>' +
          (f.sub ? '<div class="metric-sub ' + (f.tone === 'good' || f.tone === 'bad' ? f.tone : '') + '">' + esc(f.sub) + '</div>' : '') + '</div>';
      });
      h += '</div></div>';
    }
    if (r.main) {
      h += '<div class="problem-block" style="margin-top:16px;"><div class="problem-title">Главная проблема: ' + esc(r.main.title) + '</div><div class="problem-text">' + esc(r.main.text) + '</div>' +
        renderEvidence(r.main, true) +
        (r.main.drill ? '<div class="rec-exercise" style="margin-top:12px;"><strong>Что делать:</strong> ' + esc(r.main.drill) + '</div>' : '') + '</div>';
    }
    if (r.problems.length > 1 || (r.problems.length === 1 && !r.main)) {
      h += '<div class="analysis-section"><div class="analysis-section-title"><svg class="ico"><use href="#i-warn"/></svg> Что ещё исправить</div>';
      r.problems.forEach(function (p, i) {
        if (i === 0 && r.main) return;
        h += '<div class="analysis-item negative"><strong>' + esc(p.title) + '</strong> — ' + esc(p.text) + renderEvidence(p, false) +
          (p.drill ? '<div class="rec-exercise"><strong>Что делать:</strong> ' + esc(p.drill) + '</div>' : '') + '</div>';
      });
      h += '</div>';
    }
    h += renderTable(r.phases);
    if (r.timeline && r.timeline.length) {
      h += '<div class="analysis-section"><div class="analysis-section-title"><svg class="ico"><use href="#i-clock"/></svg> Ключевые моменты матча</div><div class="tl">';
      r.timeline.forEach(function (e) {
        h += '<div class="tl-row ' + (e.tone === 'good' || e.tone === 'bad' ? e.tone : '') + '"><span class="tl-time">' + esc(e.label || mmss(e.t)) + '</span><span class="tl-text">' + esc(e.text) + '</span></div>';
      });
      h += '</div></div>';
    }
    if (r.strengths.length) {
      h += '<div class="analysis-section"><div class="analysis-section-title"><svg class="ico"><use href="#i-check"/></svg> Сильные стороны</div>';
      r.strengths.forEach(function (p) {
        h += '<div class="analysis-item positive"><strong>' + esc(p.title) + '</strong> — ' + esc(p.text) + '</div>';
      });
      h += '</div>';
    }
    if (r.notes.length) {
      h += '<div class="analysis-section"><div class="analysis-section-title"><svg class="ico"><use href="#i-chat"/></svg> Контекст</div>';
      r.notes.forEach(function (p) {
        h += '<div class="analysis-item neutral"><strong>' + esc(p.title) + '</strong> — ' + esc(p.text) + '</div>';
      });
      h += '</div>';
    }
    if (r.goals && r.goals.length) {
      h += '<div class="analysis-section"><div class="analysis-section-title"><svg class="ico"><use href="#i-calendar"/></svg> Цели на следующие 3 матча</div>';
      r.goals.forEach(function (g) { h += '<div class="coach-goal"><span class="marker">✓</span><div>' + esc(g) + '</div></div>'; });
      h += '</div>';
    } else if (r.plan.length) {
      h += '<div class="analysis-section"><div class="analysis-section-title"><svg class="ico"><use href="#i-calendar"/></svg> План на неделю</div>';
      r.plan.forEach(function (d, i) {
        h += '<div class="recommendation-item"><span class="marker">' + (i + 1) + '.</span><div>' + esc(d) + '</div></div>';
      });
      h += '</div>';
    }
    if (!r.main && !r.strengths.length && !r.notes.length) {
      h += '<div class="analysis-item neutral">Алгоритм не нашёл выраженных проблем или сильных сторон — показатели близки к норме.</div>';
    }
    if (r.foot) h += '<div class="steam-hint" style="margin-top:14px;">' + esc(r.foot) + '</div>';
    h += '</div>';
    return h;
  }

  return {
    // Dota 2
    normalizeDotaPlayer: normalizeDotaPlayer,
    analyzeDota: analyzeDota,
    isDotaParsed: isDotaParsed,
    assignDotaPositions: assignDotaPositions,
    findLaneOpponent: findLaneOpponent,
    analyzeDotaProfile: analyzeDotaProfile,
    // CS2
    normalizeCsStats: normalizeCsStats,
    buildCsBaseline: buildCsBaseline,
    analyzeCs2: analyzeCs2,
    analyzeCs2Profile: analyzeCs2Profile,
    // вывод
    renderReport: renderReport,
    _internal: { normCdf: normCdf, csRef: csRef, keyify: keyify }
  };
});
