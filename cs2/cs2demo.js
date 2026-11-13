/*!
 * GamerAnalyzer — разбор демо-записи CS 2 (без нейросети).
 *
 * Вход: «сырые» данные, которые отдаёт парсер демок (события, снимки игроков по тикам).
 * Выход: отчёт той же формы, что у Dota (его рисует GA.renderReport).
 *
 * Правила построены на принципах из тренерских разборов (Jerry, Rachel):
 * размен напарника, смерти в одиночку, повтор одного и того же места, гранаты «просто так»,
 * неиспользованные гранаты, открывающие дуэли, ранние смерти, закуп без отдачи.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CS2Demo = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TRADE_SEC = 5;            // окно размена, секунд
  var ISOLATED_DIST = 1100;     // дальше этого от ближайшего живого напарника = «в одиночку» (юниты карты)
  var SPOT_RADIUS = 450;        // радиус «одного и того же места»
  var NADE_ITEMS = { 'flashbang': 'flash', 'he grenade': 'he', 'smoke grenade': 'smoke', 'molotov': 'molly', 'incendiary grenade': 'molly' };
  var AWP = { awp: 1, ssg08: 1 };

  function num(v, d) { v = parseFloat(v); return isFinite(v) ? v : (d == null ? 0 : d); }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function r1(x) { return Math.round(x * 10) / 10; }
  function pct(a, b) { return b > 0 ? Math.round(a / b * 100) : 0; }
  function dist(ax, ay, bx, by) { var dx = ax - bx, dy = ay - by; return Math.sqrt(dx * dx + dy * dy); }
  function mmss(s) { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
  function plural(n, one, few, many) { var a = Math.abs(n) % 100, b = a % 10; if (a > 10 && a < 20) return many; if (b > 1 && b < 5) return few; if (b === 1) return one; return many; }
  function lower(s) { s = String(s); return s.charAt(0).toLowerCase() + s.slice(1); }
  function weaponKey(w) { return String(w || '').replace(/^weapon_/, ''); }
  function isKnife(w) { return /knife|bayonet|karambit|dagger|kukri/i.test(String(w || '')); }
  function P(id, sev, title, text, drill) { return { id: id, kind: 'problem', severity: Math.round(sev), title: title, text: text, drill: drill }; }
  function S(id, sev, title, text) { return { id: id, kind: 'strength', severity: Math.round(sev), title: title, text: text }; }
  function N(id, title, text) { return { id: id, kind: 'note', severity: 0, title: title, text: text }; }
  function roundsText(list) { return list.slice(0, 6).map(function (n) { return n; }).join(', ') + (list.length > 6 ? '…' : ''); }

  /* ------------------------------------------------------------------ */
  /* 1. Сырые данные → модель матча                                      */
  /* ------------------------------------------------------------------ */
  /**
   * raw = { header:{map_name}, tickrate?, events:[{event_name,tick,...}],
   *         snaps:[{tick,steamid,name,team_num,X,Y,is_alive,current_equip_value,balance}] }
   */
  function buildMatch(raw) {
    var tickrate = raw.tickrate || 64;
    var byName = {};
    (raw.events || []).forEach(function (e) { (byName[e.event_name] = byName[e.event_name] || []).push(e); });
    function ev(n) { return (byName[n] || []).slice().sort(function (a, b) { return a.tick - b.tick; }); }

    // --- раунды: границы по round_end с победителем ---
    var ends = ev('round_end').filter(function (e) { return e.winner === 'T' || e.winner === 'CT'; });
    var freezes = ev('round_freeze_end');
    var allDeaths = ev('player_death');
    var spans = ends.map(function (e, i) {
      return { start: i === 0 ? 0 : ends[i - 1].tick, end: e.tick, winner: e.winner, reason: e.reason };
    });
    // раунд на ножах / разминка: первый отрезок, где почти все убийства ножом
    if (spans.length) {
      var f0 = allDeaths.filter(function (d) { return d.tick > spans[0].start && d.tick <= spans[0].end; });
      var kn = f0.filter(function (d) { return isKnife(d.weapon); }).length;
      if (f0.length === 0 || kn / f0.length >= 0.6) spans.shift();
    }
    // отсекаем отрезки «разминки» без единого убийства в начале
    while (spans.length && !allDeaths.some(function (d) { return d.tick > spans[0].start && d.tick <= spans[0].end; }) && spans.length > 16) spans.shift();
    var rounds = spans.map(function (s, i) {
      var fz = freezes.filter(function (f) { return f.tick > s.start && f.tick < s.end; })[0];
      return { n: i + 1, start: s.start, end: s.end, freeze: fz ? fz.tick : s.start, winner: s.winner, reason: s.reason };
    });
    // игровое окно раунда: от конца заморозки до round_end (события «между раундами» не считаются)
    function roundAt(tick) {
      var lo = 0, hi = rounds.length - 1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1, r = rounds[mid];
        if (tick <= r.freeze) hi = mid - 1; else if (tick > r.end) lo = mid + 1; else return r;
      }
      return null;
    }
    // окно закупки: от конца прошлого раунда до конца заморозки
    function roundAtBuy(tick) {
      for (var i = 0; i < rounds.length; i++) { var r = rounds[i]; if (tick > r.start && tick <= r.freeze) return r; }
      return null;
    }

    // --- стороны игроков по раундам (снимки на конец заморозки) ---
    var snapsByTick = {};
    (raw.snaps || []).forEach(function (s) { (snapsByTick[s.tick] = snapsByTick[s.tick] || []).push(s); });
    var players = {};           // steamid -> {id,name}
    var side = {};              // round n -> steamid -> 'T'|'CT'
    var equip = {};             // round n -> steamid -> equip value
    rounds.forEach(function (r) {
      side[r.n] = {}; equip[r.n] = {};
      (snapsByTick[r.freeze] || []).forEach(function (s) {
        var id = String(s.steamid);
        players[id] = players[id] || { id: id, name: s.name };
        if (s.team_num === 2 || s.team_num === 3) side[r.n][id] = s.team_num === 2 ? 'T' : 'CT';
        equip[r.n][id] = num(s.current_equip_value, 0);
      });
    });
    // запасной вариант: стороны из убийств
    allDeaths.forEach(function (d) {
      var r = roundAt(d.tick); if (!r) return;
      if (d.attacker_steamid) { var a = String(d.attacker_steamid); players[a] = players[a] || { id: a, name: d.attacker_name }; if (!side[r.n][a] && d.attacker_team_num) side[r.n][a] = d.attacker_team_num === 2 ? 'T' : 'CT'; }
      if (d.user_steamid) { var u = String(d.user_steamid); players[u] = players[u] || { id: u, name: d.user_name }; if (!side[r.n][u] && d.user_team_num) side[r.n][u] = d.user_team_num === 2 ? 'T' : 'CT'; }
    });

    // --- убийства ---
    var kills = [];
    allDeaths.forEach(function (d) {
      var r = roundAt(d.tick); if (!r) return;
      var a = d.attacker_steamid ? String(d.attacker_steamid) : null, v = String(d.user_steamid);
      var as = a ? side[r.n][a] : null, vs = side[r.n][v];
      kills.push({
        round: r.n, tick: d.tick, t: (d.tick - r.freeze) / tickrate,
        atk: a, vic: v, assist: d.assister_steamid ? String(d.assister_steamid) : null,
        weapon: weaponKey(d.weapon), hs: !!d.headshot, thrusmoke: !!d.thrusmoke, noscope: !!d.noscope, blind: !!d.attackerblind,
        atkSide: as, vicSide: vs, enemy: !!(a && as && vs && as !== vs), world: !a,
        vx: d.user_X, vy: d.user_Y, ax: d.attacker_X, ay: d.attacker_Y
      });
    });
    var killsByRound = {};
    kills.forEach(function (k) { (killsByRound[k.round] = killsByRound[k.round] || []).push(k); });
    Object.keys(killsByRound).forEach(function (n) { killsByRound[n].sort(function (a, b) { return a.tick - b.tick; }); });

    // средний процент разменов по матчу — база для сравнения игрока
    var enemyDeaths = 0, tradedAll = 0;
    rounds.forEach(function (r) {
      var ks = killsByRound[r.n] || [];
      ks.forEach(function (k) {
        if (!k.enemy) return;
        enemyDeaths++;
        if (ks.some(function (p) { return p.enemy && p.atk && p.vic === k.atk && p.atkSide === k.vicSide && p.tick > k.tick && p.tick - k.tick <= TRADE_SEC * tickrate; })) tradedAll++;
      });
    });

    return {
      tradeRate: enemyDeaths ? tradedAll / enemyDeaths : 0.2,
      map: (raw.header && raw.header.map_name) || '', tickrate: tickrate, rounds: rounds, roundAt: roundAt, roundAtBuy: roundAtBuy,
      players: players, side: side, equip: equip, kills: kills, killsByRound: killsByRound,
      hurts: ev('player_hurt'), blinds: ev('player_blind'), purchases: ev('item_purchase'),
      flashes: ev('flashbang_detonate'), hes: ev('hegrenade_detonate'), smokes: ev('smokegrenade_detonate'), fires: ev('inferno_startburn'),
      plants: ev('bomb_planted'), defuses: ev('bomb_defused'), snapsByTick: snapsByTick
    };
  }

  /** Список игроков для выбора: ник, K/D/A, сторона по ходу матча. */
  function listPlayers(M) {
    var rows = Object.keys(M.players).map(function (id) {
      var k = 0, d = 0, a = 0;
      M.kills.forEach(function (x) { if (x.atk === id && x.enemy) k++; if (x.vic === id) d++; if (x.assist === id) a++; });
      // команда: сторона в первом раунде -> «команда А» (T в 1-м раунде) / «команда Б»
      var s1 = M.side[1] && M.side[1][id];
      return { id: id, name: M.players[id].name || id, k: k, d: d, a: a, team: s1 === 'T' ? 'A' : (s1 === 'CT' ? 'B' : '?') };
    });
    rows.sort(function (x, y) { return x.team < y.team ? -1 : x.team > y.team ? 1 : y.k - x.k; });
    return rows;
  }

  /** Счёт матча с точки зрения игрока. */
  function playerResult(M, id) {
    var won = 0, lost = 0;
    M.rounds.forEach(function (r) { var s = M.side[r.n][id]; if (!s) return; if (r.winner === s) won++; else lost++; });
    return { won: won, lost: lost, win: won > lost, draw: won === lost };
  }

  /* ------------------------------------------------------------------ */
  /* 2. Статистика игрока                                                */
  /* ------------------------------------------------------------------ */
  function playerStats(M, id) {
    var tr = M.tickrate, tw = TRADE_SEC * tr;
    var st = {
      id: id, name: (M.players[id] || {}).name || id, rounds: 0, kills: 0, deaths: 0, assists: 0, hs: 0, awpKills: 0,
      dmg: 0, kast: 0, openWin: 0, openLoss: 0, tradedDeaths: 0, untradedDeaths: 0, tradeKills: 0,
      isolated: [], earlyDeaths: [], killers: {}, deathPos: [], clutch: { att: 0, won: 0, best: 0 }, multi: { k3: 0, k4: 0, k5: 0 },
      flashes: 0, flashEff: 0, flashEnemyBlinds: 0, teamFlashes: [], heDmg: 0, mollyDmg: 0, utilDmg: 0, nades: { flash: 0, he: 0, smoke: 0, molly: 0 },
      unusedDeaths: [], overbuy: [], pistolDeaths: 0, firstDeaths: 0, equipFull: 0, equipEco: 0, rWon: 0, rLost: 0,
      moments: [], plants: 0, defuses: 0, perRound: {}
    };

    // --- по раундам ---
    M.rounds.forEach(function (r) {
      var my = M.side[r.n][id]; if (!my) return;
      st.rounds++;
      if (r.winner === my) st.rWon++; else st.rLost++;
      var ks = M.killsByRound[r.n] || [];
      var pr = { kills: 0, dmg: 0, died: false, deathT: null, assisted: false, traded: false, survived: true };
      st.perRound[r.n] = pr;

      // кто жив: все, у кого известна сторона
      var alive = {};
      Object.keys(M.side[r.n]).forEach(function (pid) { alive[pid] = M.side[r.n][pid]; });
      var firstKill = null;
      ks.forEach(function (k) { if (!firstKill && k.enemy) firstKill = k; });

      ks.forEach(function (k, idx) {
        if (k.vic in alive) delete alive[k.vic];
        if (k.atk === id && k.enemy) {
          pr.kills++; st.kills++;
          if (k.hs) st.hs++;
          if (AWP[k.weapon]) st.awpKills++;
          // размен: убитый только что убил кого-то из моей команды в пределах окна
          var traded = ks.some(function (p) { return p.enemy && p.atk === k.vic && p.vicSide === my && p.tick < k.tick && k.tick - p.tick <= tw; });
          if (traded) st.tradeKills++;
        }
        if (k.assist === id) { st.assists++; pr.assisted = true; }
        if (k.vic === id) {
          st.deaths++; pr.died = true; pr.survived = false; pr.deathT = k.t;
          if (k.atk && k.enemy) st.killers[k.atk] = (st.killers[k.atk] || 0) + 1;
          if (firstKill && firstKill === k) { st.openLoss++; }
          // размен моей смерти
          var tradedBy = ks.filter(function (p) { return p.enemy && p.atk && p.vic === k.atk && p.atkSide === my && p.tick > k.tick && p.tick - k.tick <= tw; })[0];
          if (k.enemy) { if (tradedBy) { st.tradedDeaths++; pr.traded = true; } else st.untradedDeaths++; }
          k._traded = !!tradedBy;
          // первые смерти команды в раунде
          var teamDeathsBefore = ks.filter(function (p) { return p.vicSide === my && p.tick < k.tick; }).length;
          if (teamDeathsBefore === 0) st.firstDeaths++;
          if (k.t < 25) st.earlyDeaths.push({ round: r.n, t: k.t, tick: k.tick });
          if (r.n === 1 || r.n === 13) st.pistolDeaths++;
          st.deathPos.push({ round: r.n, x: k.vx, y: k.vy, side: my, t: k.t, atk: k.atk, tick: k.tick, traded: !!tradedBy, enemy: k.enemy });
        }
        if (firstKill && firstKill === k && k.atk === id) st.openWin++;
      });

      // многоубийства
      if (pr.kills >= 5) st.multi.k5++; else if (pr.kills === 4) st.multi.k4++; else if (pr.kills === 3) st.multi.k3++;

      // KAST
      var kastOk = pr.kills > 0 || pr.assisted || pr.survived || pr.traded;
      if (kastOk) st.kast++;

      // клатч
      var aliveSim = {}; Object.keys(M.side[r.n]).forEach(function (pid) { aliveSim[pid] = M.side[r.n][pid]; });
      var clutchStarted = false, enemiesAtStart = 0;
      ks.forEach(function (k) {
        if (k.vic in aliveSim) delete aliveSim[k.vic];
        if (clutchStarted || !(id in aliveSim)) return;
        var mates = 0, foes = 0;
        Object.keys(aliveSim).forEach(function (pid) { if (aliveSim[pid] === my) mates++; else foes++; });
        if (mates === 1 && foes >= 1) { clutchStarted = true; enemiesAtStart = foes; }
      });
      if (clutchStarted) {
        st.clutch.att++;
        if (r.winner === my && pr.survived) { st.clutch.won++; st.clutch.best = Math.max(st.clutch.best, enemiesAtStart); st.moments.push({ round: r.n, tone: 'good', imp: 30 + enemiesAtStart * 8, text: 'Клатч 1 против ' + enemiesAtStart + ' — раунд выигран.' }); }
      }
    });

    // --- урон (ADR) ---
    var dmgKey = {};
    M.hurts.forEach(function (h) {
      if (String(h.attacker_steamid) !== id) return;
      var r = M.roundAt(h.tick); if (!r) return;
      var my = M.side[r.n][id], vs = M.side[r.n][String(h.user_steamid)];
      if (!my || !vs || my === vs) return;
      var key = r.n + ':' + h.user_steamid;
      var add = num(h.dmg_health, 0), cur = dmgKey[key] || 0;
      add = Math.max(0, Math.min(add, 100 - cur)); dmgKey[key] = cur + add;
      if (st.perRound[r.n]) st.perRound[r.n].dmg += add;
      st.dmg += add;
      var w = weaponKey(h.weapon);
      if (w === 'hegrenade') { st.heDmg += add; st.utilDmg += add; }
      else if (w === 'inferno' || w === 'molotov' || w === 'incgrenade') { st.mollyDmg += add; st.utilDmg += add; }
    });

    // --- гранаты: броски ---
    function mine(e) { return String(e.user_steamid) === id; }
    var thrownByRound = {};
    function addThrow(list, kind) { list.forEach(function (e) { if (!mine(e)) return; var r = M.roundAt(e.tick); if (!r) return; st.nades[kind]++; var o = thrownByRound[r.n] = thrownByRound[r.n] || { flash: 0, he: 0, smoke: 0, molly: 0 }; o[kind]++; }); }
    addThrow(M.flashes, 'flash'); addThrow(M.hes, 'he'); addThrow(M.smokes, 'smoke'); addThrow(M.fires, 'molly');

    // флешки: сколько соперников ослеплено ≥1 с, командные ослепления
    var flashTicks = M.flashes.filter(mine).map(function (e) { return e.tick; });
    st.flashes = flashTicks.length;
    var effTicks = {};
    M.blinds.forEach(function (b) {
      if (String(b.attacker_steamid) !== id) return;
      var r = M.roundAt(b.tick); if (!r) return;
      var my = M.side[r.n][id], vs = M.side[r.n][String(b.user_steamid)];
      if (!my || !vs) return;
      var dur = num(b.blind_duration, 0);
      if (String(b.user_steamid) === id) return;
      if (vs !== my) { if (dur >= 1.0) { effTicks[b.tick] = true; st.flashEnemyBlinds++; } }
      else if (dur >= 1.5) st.teamFlashes.push({ round: r.n, dur: dur, tick: b.tick });
    });
    st.flashEff = Object.keys(effTicks).length;

    // --- гранаты: купленные, но не брошенные, при смерти ---
    var bought = {};
    M.purchases.forEach(function (p) {
      if (String(p.steamid) !== id) return;
      var kind = NADE_ITEMS[String(p.item_name || '').toLowerCase()]; if (!kind) return;
      var r = M.roundAtBuy(p.tick); if (!r) return;
      var o = bought[r.n] = bought[r.n] || { flash: 0, he: 0, smoke: 0, molly: 0 };
      if (!p.was_sold) o[kind]++;
    });
    M.rounds.forEach(function (r) {
      var pr = st.perRound[r.n]; if (!pr || !pr.died) return;
      var b = bought[r.n]; if (!b) return;
      var t = thrownByRound[r.n] || { flash: 0, he: 0, smoke: 0, molly: 0 };
      var left = 0, names = [];
      ['flash', 'he', 'smoke', 'molly'].forEach(function (k) { var l = b[k] - t[k]; if (l > 0) { left += l; names.push({ flash: 'флешка', he: 'HE', smoke: 'дым', molly: 'молотов' }[k]); } });
      if (left > 0 && pr.deathT > 8) st.unusedDeaths.push({ round: r.n, left: left, names: names, t: pr.deathT });
    });

    // --- экономика ---
    M.rounds.forEach(function (r) {
      var my = M.side[r.n][id]; if (!my) return;
      var eq = M.equip[r.n][id]; if (eq == null) return;
      if (eq >= 3500) st.equipFull++; else if (eq < 1500) st.equipEco++;
      var pr = st.perRound[r.n];
      if (eq >= 3800 && pr && pr.died && pr.kills === 0 && !pr.assisted && pr.dmg < 40 && r.n !== 1 && r.n !== 13) st.overbuy.push({ round: r.n, eq: eq });
    });

    // бомба
    M.plants.forEach(function (p) { if (mine(p)) st.plants++; });
    M.defuses.forEach(function (p) { if (mine(p)) st.defuses++; });

    // ближайший живой напарник в момент смерти (по снимкам тика смерти)
    st.deathPos.forEach(function (dp) {
      var snaps = M.snapsByTick[dp.tick]; if (!snaps) return;
      var best = null;
      snaps.forEach(function (s) {
        var pid = String(s.steamid); if (pid === id || !s.is_alive) return;
        var sd = s.team_num === 2 ? 'T' : (s.team_num === 3 ? 'CT' : null);
        if (sd !== dp.side) return;
        var d = dist(dp.x, dp.y, s.X, s.Y);
        if (best == null || d < best) best = d;
      });
      dp.mateDist = best;
      if (dp.enemy && !dp.traded && best != null && best > ISOLATED_DIST) st.isolated.push({ round: dp.round, t: dp.t, dist: Math.round(best) });
    });
    return st;
  }

  /* ------------------------------------------------------------------ */
  /* 3. Правила → отчёт                                                  */
  /* ------------------------------------------------------------------ */
  function clusters(points) {
    // жадная кластеризация точек смерти по стороне и радиусу
    var cl = [];
    points.forEach(function (p) {
      if (p.x == null || p.y == null) return;
      var c = cl.filter(function (c) { return c.side === p.side && dist(c.x, c.y, p.x, p.y) <= SPOT_RADIUS; })[0];
      if (c) { c.items.push(p); c.x = (c.x * (c.items.length - 1) + p.x) / c.items.length; c.y = (c.y * (c.items.length - 1) + p.y) / c.items.length; }
      else cl.push({ x: p.x, y: p.y, side: p.side, items: [p] });
    });
    return cl.sort(function (a, b) { return b.items.length - a.items.length; });
  }

  function analyze(M, id, nameOf) {
    var st = playerStats(M, id);
    var res = playerResult(M, id);
    var items = [];
    var R = st.rounds, D = st.deaths, K = st.kills;
    nameOf = nameOf || function (pid) { return (M.players[pid] || {}).name || 'соперник'; };
    if (R < 8) {
      return finish([N('few', 'Мало данных', 'В этой записи слишком мало раундов для надёжного разбора.')], { title: 'Разбор тренера · CS2' });
    }
    var adr = st.dmg / R, kast = pct(st.kast, R), kd = D > 0 ? K / D : K;
    var hsPct = K > 0 ? pct(st.hs, K) : 0, isAwp = K > 0 && st.awpKills / K >= 0.3;
    var openAtt = st.openWin + st.openLoss, openPct = pct(st.openWin, openAtt);
    var enemyDeaths = st.tradedDeaths + st.untradedDeaths;
    var untradedPct = pct(st.untradedDeaths, enemyDeaths);

    /* --- повторный убийца --- */
    var killerIds = Object.keys(st.killers).filter(function (kid) { var n = st.killers[kid]; return n >= 3 && n / Math.max(1, D) >= 0.25; })
      .sort(function (a, b) { return st.killers[b] - st.killers[a]; });
    if (killerIds.length) {
      var kid0 = killerIds[0], n0 = st.killers[kid0];
      var rs0k = st.deathPos.filter(function (d) { return d.atk === kid0; }).map(function (d) { return d.round; });
      var extra = killerIds.length > 1 ? ' Ещё ' + nameOf(killerIds[1]) + ' убил вас ' + st.killers[killerIds[1]] + ' ' + plural(st.killers[killerIds[1]], 'раз', 'раза', 'раз') + '.' : '';
      items.push(P('repeat_killer', 42 + n0 * 6, 'Один и тот же соперник убивает вас снова и снова',
        nameOf(kid0) + ' убил вас ' + n0 + ' ' + plural(n0, 'раз', 'раза', 'раз') + ' из ' + D + ' (раунды ' + roundsText(rs0k) + '). Вы каждый раз попадаете в одну и ту же ситуацию против него.' + extra,
        'Против ' + nameOf(kid0) + ' меняйте тайминг и позицию: не выходите на него первым, просите флешку или разведите его гранатой и играйте второй волной вместе с напарником.'));
    }

    /* --- смерти в одиночку без размена --- */
    if (st.isolated.length >= 3 && st.isolated.length / Math.max(1, D) >= 0.3) {
      var il = st.isolated.map(function (x) { return x.round; });
      items.push(P('isolated', 46 + st.isolated.length * 3, 'Смерти в одиночку',
        st.isolated.length + ' из ' + D + ' ' + plural(D, 'смерти', 'смертей', 'смертей') + ' — вдали от команды и без размена (раунды ' + roundsText(il) + '). Напарник физически не мог вас разменять.',
        'Держитесь на расстоянии размена: до ближайшего напарника не дальше пары секунд бега. Перед выходом скажите, куда идёте, и дайте напарнику выйти следом. Если остались одни — отходите на угол и ждите, а не лезьте в дуэль.'));
    } else if (enemyDeaths >= 10 && untradedPct >= 90 && untradedPct - Math.round((1 - M.tradeRate) * 100) >= 8) {
      items.push(P('untraded', 40 + (untradedPct - 85) * 1.2, 'Вас редко разменивают',
        untradedPct + '% ваших смертей остались без размена (в среднем по матчу — ' + Math.round((1 - M.tradeRate) * 100) + '%): команда не успевала отомстить за вас.',
        'Играйте парой: выходите в дуэль на один тайминг с напарником, а не по одному. Перед пиком проверьте, кто сможет вас разменять.'));
    }

    /* --- одно и то же место смерти --- */
    var cl = clusters(st.deathPos.filter(function (d) { return d.enemy; }));
    if (cl.length && cl[0].items.length >= 3) {
      var c0 = cl[0], rs0 = c0.items.map(function (d) { return d.round; });
      items.push(P('spot', 38 + c0.items.length * 5, 'Смерти в одной и той же точке',
        c0.items.length + ' ' + plural(c0.items.length, 'раз', 'раза', 'раз') + ' вы погибли в одном и том же месте карты за ' + (c0.side === 'T' ? 'атаку' : 'защиту') + ' (раунды ' + roundsText(rs0) + '). Соперники знают эту позицию.',
        'Меняйте позицию и тайминг: после смерти в точке не возвращайтесь туда тем же способом. Выманите гранаты первым броском и займите угол второй волной, либо смените позицию на ту, где вас труднее убить.'));
    }

    /* --- ранние смерти --- */
    if (st.earlyDeaths.length >= 4 && st.earlyDeaths.length / Math.max(1, D) >= 0.25) {
      var el = st.earlyDeaths.map(function (x) { return x.round; });
      items.push(P('early', 40 + st.earlyDeaths.length * 3, 'Ранние смерти',
        st.earlyDeaths.length + ' ' + plural(st.earlyDeaths.length, 'раз', 'раза', 'раз') + ' вы погибли в первые 25 секунд раунда (раунды ' + roundsText(el) + ') — до того, как команда получила информацию.',
        'В первые секунды собирайте информацию, а не дуэли: слушайте, подсвечивайте угол гранатой, выходите только с поддержкой. Умерли за ничто — потеряли и фраг, и темп команды.'));
    }

    /* --- открывающие дуэли --- */
    if (openAtt >= 5 && openPct <= 35) {
      items.push(P('opening', 38 + (45 - openPct), 'Проигранные открывающие дуэли',
        'Первые дуэли раунда: выиграно ' + st.openWin + ' из ' + openAtt + ' (' + openPct + '%). Проиграв первую дуэль, вы оставляете команду в меньшинстве.',
        'Не берите первую дуэль без причины: идите на неё только с флешкой или когда напарник готов разменять. Иначе играйте вторым и ловите соперника на размене.'));
    } else if (openAtt >= 5 && openPct >= 60) {
      items.push(S('opening', 40 + (openPct - 55) * 0.5, 'Выигрыш открывающих дуэлей', 'Первые дуэли раунда: выиграно ' + st.openWin + ' из ' + openAtt + ' (' + openPct + '%) — вы задаёте темп команде.'));
    }

    /* --- гранаты: флешки --- */
    if (st.flashes >= 6) {
      var effPct = pct(st.flashEff, st.flashes);
      if (effPct <= 35) {
        items.push(P('flash_eff', 36 + (45 - effPct) * 0.5, 'Флешки пропадают зря',
          'Только ' + st.flashEff + ' из ' + st.flashes + ' ваших флешек (' + effPct + '%) ослепили соперника хотя бы на секунду.',
          'Бросайте флешку под выход напарника и по известному углу, а не «просто так». Не кидайте её, если никто не выйдет следом: в паре они работают вдвое эффективнее.'));
      } else if (effPct >= 60) {
        items.push(S('flash_eff', 34, 'Полезные флешки', st.flashEff + ' из ' + st.flashes + ' ваших флешек (' + effPct + '%) ослепили соперника — вы хорошо помогаете выходам.'));
      }
    }
    if (st.teamFlashes.length >= 3) {
      items.push(P('team_flash', 34 + st.teamFlashes.length * 3, 'Вы слепите своих',
        st.teamFlashes.length + ' ' + plural(st.teamFlashes.length, 'раз', 'раза', 'раз') + ' ваши флешки надолго ослепляли напарников (раунды ' + roundsText(st.teamFlashes.map(function (x) { return x.round; })) + ').',
        'Перед броском скажите «флешка» и бросайте так, чтобы она взрывалась перед соперником, а не на линии напарника. Тренировка: пустая карта, 10 бросков в один угол за разные позиции.'));
    }

    /* --- гранаты: неиспользованные при смерти --- */
    if (st.unusedDeaths.length >= 3) {
      items.push(P('unused', 36 + st.unusedDeaths.length * 3, 'Умираете с гранатами в инвентаре',
        'В ' + st.unusedDeaths.length + ' ' + plural(st.unusedDeaths.length, 'раунде', 'раундах', 'раундах') + ' вы погибли, не использовав купленные гранаты (раунды ' + roundsText(st.unusedDeaths.map(function (x) { return x.round; })) + '). Это потраченные впустую деньги.',
        'Тратьте гранаты до первого контакта или при отходе: бросок флешки или дыма вместе с напарником почти всегда полезнее, чем гибель с гранатой в руке.'));
    }
    var utilPerRound = st.utilDmg / R;
    if (R >= 14 && utilPerRound >= 9) items.push(S('util_dmg', 32, 'Урон гранатами', 'HE и молотовы наносят ' + r1(utilPerRound) + ' урона за раунд — вы приносите пользу гранатами.'));

    /* --- закуп без отдачи --- */
    if (st.overbuy.length >= 3) {
      items.push(P('overbuy', 34 + st.overbuy.length * 3, 'Дорогие раунды без отдачи',
        'В ' + st.overbuy.length + ' ' + plural(st.overbuy.length, 'раунде', 'раундах', 'раундах') + ' вы закупились полностью, но погибли без убийств и почти без урона (раунды ' + roundsText(st.overbuy.map(function (x) { return x.round; })) + ').',
        'Дорогой закуп обязывает: в такие раунды играйте с командой и берите дуэли только при поддержке. Иначе вы теряете и деньги, и преимущество в следующем раунде.'));
    }

    /* --- общая статистика --- */
    if (adr < 60) items.push(P('adr', 38 + (65 - adr) * 1.2, 'Низкий урон за раунд', 'Средний урон ' + Math.round(adr) + ' за раунд — ниже нормы.',
      'Наносите урон даже при отходе и разменах: ADR помогает команде добивать. 15 минут DM с винтовкой перед играми.'));
    else if (adr >= 80) items.push(S('adr', 40 + (adr - 80), 'Высокий урон', 'Средний урон ' + Math.round(adr) + ' за раунд.'));
    if (kast < 62) items.push(P('kast', 36 + (68 - kast), 'Низкая вовлечённость в раунды', 'Только в ' + kast + '% раундов вы убивали, помогали, выживали или были разменяны.',
      'Меньше «пустых» раундов: если не успеваете убить, помогите флешкой или уйдите живым и сыграйте на размене.'));
    else if (kast >= 76) items.push(S('kast', 38, 'Вы почти всегда полезны', 'Вы участвовали (убийство, помощь, выживание или размен) в ' + kast + '% раундов.'));
    if (!isAwp && K >= 8) {
      if (hsPct < 33) items.push(P('hs', 33 + (38 - hsPct), 'Низкий процент хедшотов', 'Хедшоты — ' + hsPct + '% убийств. Прицел держится ниже головы.',
        'Каждый день 10 минут aim_botz (только голова) и 10 минут DM с винтовкой. Следите за высотой прицела при передвижении.'));
      else if (hsPct >= 55) items.push(S('hs', 36, 'Точный прицел', 'Хедшоты — ' + hsPct + '% убийств.'));
    } else if (isAwp) {
      items.push(N('awp', 'Вы играли с AWP', 'Снайперские убийства — ' + pct(st.awpKills, K) + '% ваших фрагов, поэтому процент хедшотов не оценивался.'));
    }
    var tradePct = pct(st.tradeKills, K);
    if (K >= 8 && tradePct >= 30) items.push(S('trade_kills', 36, 'Вы мстите за напарников', st.tradeKills + ' из ' + K + ' ваших убийств — размены за напарников. Это признак хорошей игры в паре.'));
    if (st.clutch.won >= 2) items.push(S('clutch', 34 + st.clutch.won * 2, 'Клатчи', 'Выиграно ' + st.clutch.won + ' из ' + st.clutch.att + ' клатчей (лучший — 1 против ' + st.clutch.best + ').'));
    if (st.multi.k3 + st.multi.k4 + st.multi.k5 >= 2) items.push(S('multi', 32, 'Мультикиллы', 'Раундов с тремя и более убийствами: ' + (st.multi.k3 + st.multi.k4 + st.multi.k5) + '.'));

    /* --- оценка --- */
    var perf = 0.45 * clamp((adr - 45) / 50, 0, 1) + 0.25 * clamp((kast - 45) / 40, 0, 1) + 0.30 * clamp((kd - 0.5) / 1.3, 0, 1);
    var pen = 0; items.forEach(function (i) { if (i.kind === 'problem') pen += Math.max(0, i.severity - 35) * 0.4; });
    var score = Math.max(12, Math.round(clamp(perf, 0, 1) * 100 - Math.min(22, pen)));
    var hasMajor = items.some(function (i) { return i.kind === 'problem' && i.severity >= 40; });
    if (!res.win && !res.draw && score >= 68 && !hasMajor) items.push(N('context_loss', 'Поражение при сильных показателях', 'Ваши цифры выше нормы, но матч проигран. Ищите причины в командных решениях и закупах.'));
    else if (res.win && score < 40) items.push(N('context_win', 'Победа при слабых показателях', 'Матч выигран, но ваш личный вклад ниже нормы — команда вас вытащила.'));

    var r = finish(items, {
      title: 'Разбор тренера · CS2' + (M.map ? ' · ' + M.map : ''),
      score: score,
      foot: 'Разбор построен по записи матча: размены, позиции, гранаты и закупы. Раунд на ножах и разминка не учитываются. Гранаты и закупы оценены по событиям покупок и бросков, поэтому приблизительно.'
    });
    r.verdict = verdict(r, st, res, M, adr, kast);
    r.facts = facts(st, adr, kast, kd, hsPct, isAwp, openAtt, openPct, untradedPct, R, Math.round((1 - M.tradeRate) * 100));
    r.timeline = timeline(st, M, items, nameOf);
    r.summary = r.verdict;
    r.stats = { rounds: R, kills: K, deaths: D, assists: st.assists, adr: Math.round(adr), kast: kast, hs: hsPct, won: res.won, lost: res.lost, name: st.name };
    return r;
  }

  function finish(items, opts) {
    var problems = items.filter(function (i) { return i.kind === 'problem'; }).sort(function (a, b) { return b.severity - a.severity; });
    var strengths = items.filter(function (i) { return i.kind === 'strength'; }).sort(function (a, b) { return b.severity - a.severity; });
    var notes = items.filter(function (i) { return i.kind === 'note'; });
    var plan = [];
    problems.slice(0, 3).forEach(function (p) { if (p.drill && plan.indexOf(p.drill) === -1) plan.push(p.drill); });
    return {
      all: items, title: opts.title || 'Разбор тренера', score: opts.score == null ? null : { value: opts.score, label: scoreLabel(opts.score) },
      summary: '', main: problems[0] || null, problems: problems.slice(0, 5), strengths: strengths.slice(0, 4), notes: notes.slice(0, 4), plan: plan, foot: opts.foot || ''
    };
  }
  function scoreLabel(s) { return s < 35 ? 'Слабый матч' : s < 50 ? 'Ниже среднего' : s < 65 ? 'Средний матч' : s < 80 ? 'Хороший матч' : 'Отличный матч'; }

  function verdict(r, st, res, M, adr, kast) {
    var head = (res.draw ? 'Ничья' : res.win ? 'Победа' : 'Поражение') + (M.map ? ' на ' + M.map : '') + ' ' + res.won + ':' + res.lost + ': ' + st.kills + '/' + st.deaths + '/' + st.assists + ', ADR ' + Math.round(adr) + ', KAST ' + kast + '%.';
    var parts = [head];
    if (r.strengths[0]) parts.push('Лучшее в вашей игре — ' + lower(r.strengths[0].title) + '.');
    var pr = r.problems.slice(0, 2);
    if (pr.length === 2) parts.push('Главные точки роста: «' + pr[0].title + '» и «' + pr[1].title + '» — с них стоит начать работу.');
    else if (pr.length === 1) parts.push('Главная точка роста: «' + pr[0].title + '».');
    else parts.push('Серьёзных проблем не найдено.');
    return parts.join(' ');
  }

  function facts(st, adr, kast, kd, hsPct, isAwp, openAtt, openPct, untradedPct, R, baseUntraded) {
    var f = [];
    f.push({ label: 'Урон за раунд (ADR)', value: String(Math.round(adr)), sub: adr >= 80 ? 'Высокий' : adr < 60 ? 'Низкий' : 'Нормально', tone: adr >= 80 ? 'good' : adr < 60 ? 'bad' : '' });
    f.push({ label: 'KAST', value: kast + '%', sub: kast >= 76 ? 'Высокий' : kast < 62 ? 'Низкий' : 'Нормально', tone: kast >= 76 ? 'good' : kast < 62 ? 'bad' : '' });
    f.push({ label: 'K/D', value: r1(kd).toFixed(1), sub: st.kills + ' / ' + st.deaths, tone: kd >= 1.2 ? 'good' : kd < 0.8 ? 'bad' : '' });
    if (openAtt >= 3) f.push({ label: 'Открывающие дуэли', value: st.openWin + ' из ' + openAtt, sub: openPct + '%', tone: openPct >= 60 ? 'good' : openPct <= 35 ? 'bad' : '' });
    var ed = st.tradedDeaths + st.untradedDeaths;
    if (ed >= 5) f.push({ label: 'Смерти без размена', value: untradedPct + '%', sub: st.untradedDeaths + ' из ' + ed + ' · в среднем ' + baseUntraded + '%', tone: untradedPct <= baseUntraded - 12 ? 'good' : untradedPct >= baseUntraded + 8 && untradedPct >= 90 ? 'bad' : '' });
    if (st.flashes >= 6) f.push({ label: 'Полезные флешки', value: pct(st.flashEff, st.flashes) + '%', sub: st.flashEff + ' из ' + st.flashes, tone: pct(st.flashEff, st.flashes) >= 60 ? 'good' : pct(st.flashEff, st.flashes) <= 35 ? 'bad' : '' });
    f.push({ label: 'Урон гранатами', value: r1(st.utilDmg / R).toFixed(1), sub: 'за раунд' });
    if (!isAwp) f.push({ label: 'Хедшоты', value: hsPct + '%', sub: st.hs + ' из ' + st.kills, tone: hsPct >= 55 ? 'good' : hsPct < 33 ? 'bad' : '' });
    if (st.clutch.att) f.push({ label: 'Клатчи', value: st.clutch.won + ' из ' + st.clutch.att, sub: st.clutch.won ? 'лучший 1v' + st.clutch.best : '', tone: st.clutch.won ? 'good' : '' });
    return f;
  }

  function timeline(st, M, items, nameOf) {
    var ev = [];
    st.moments.forEach(function (m) { ev.push({ round: m.round, imp: m.imp, tone: m.tone, text: m.text, t: 0 }); });
    var repeatId = null, repeatN = 0;
    Object.keys(st.killers).forEach(function (k) { if (st.killers[k] >= 3 && st.killers[k] > repeatN) { repeatN = st.killers[k]; repeatId = k; } });
    st.deathPos.forEach(function (d) {
      var line = 'Смерть' + (d.atk ? ' от ' + nameOf(d.atk) : '') + ', ' + mmss(d.t) + ' от начала раунда';
      var imp = 10, tone = 'bad';
      if (d.atk && d.atk === repeatId) { imp = 35; line += ' — снова он.'; }
      else if (d.enemy && !d.traded && d.mateDist != null && d.mateDist > ISOLATED_DIST) { imp = 32; line += ' — в одиночку, напарники далеко (≈' + Math.round(d.mateDist) + ' юн.), размена нет.'; }
      else if (d.t < 25 && d.enemy) { imp = 26; line += ' — слишком рано, до информации.'; }
      else { line += d.traded ? ' (размен есть).' : '.'; imp = d.traded ? 5 : 12; if (d.traded) tone = ''; }
      ev.push({ round: d.round, imp: imp, tone: tone, text: line, t: d.t });
    });
    st.unusedDeaths.forEach(function (u) { ev.push({ round: u.round, imp: 28, tone: 'bad', text: 'Погибли, не использовав гранаты (' + u.names.join(', ') + ').', t: u.t }); });
    st.overbuy.forEach(function (o) { ev.push({ round: o.round, imp: 24, tone: 'bad', text: 'Полный закуп (' + o.eq + '$), но ни убийств, ни урона — раунд потерян зря.', t: 0 }); });
    Object.keys(st.perRound).forEach(function (n) { var pr = st.perRound[n]; if (pr.kills >= 3) ev.push({ round: +n, imp: 22 + pr.kills * 4, tone: 'good', text: pr.kills + ' убийства за раунд.', t: 0 }); });
    ev.sort(function (a, b) { return b.imp - a.imp; });
    var top = ev.slice(0, 10).sort(function (a, b) { return a.round - b.round || a.t - b.t; });
    return top.map(function (e) { return { t: e.t, label: 'Раунд ' + e.round, tone: e.tone, text: e.text }; });
  }

  return { buildMatch: buildMatch, listPlayers: listPlayers, analyze: analyze, playerStats: playerStats, playerResult: playerResult };
});
