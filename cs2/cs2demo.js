/*!
 * GamerAnalyzer — тренерский разбор демо-записи CS 2 (без нейросети), версия 2.
 *
 * Вход: «сырые» данные парсера демок (события + снимки игроков по тикам).
 * Выход: отчёт, который рисует GA.renderReport.
 *
 * Логика собрана из разборов тренеров и про-игроков (donk/sh1ro, chopper, Rachel, Jerry,
 * Alienn, Sashka, Kuro, panas и др.). Главные принципы:
 *  1. «Цифры врут». K/D и ADR не показывают, решили ли ваши убийства раунд. Поэтому каждое
 *     убийство и каждая смерть оцениваются через изменение шанса команды выиграть раунд
 *     (модель: численность, бомба, закуп). Добивание при 5v1 стоит почти ноль,
 *     открывающая смерть без размена — дорого.
 *  2. Ищем причину, а не симптом: каждая смерть получает контекст (одиночный выход, без размена,
 *     отдали численное преимущество, не сохранили оружие в проигранном раунде, смерть с гранатами,
 *     смерть по эко-закупу соперника, смерть после установки бомбы и т.д.).
 *  3. Проблемы ранжируются по цене — сколько раундов они стоили команде, с доказательствами
 *     (номер раунда, время, место на карте).
 *  4. Размены — основа командной игры: и «вас не разменяли», и «вы не разменяли напарника».
 *  5. Контекст раунда: пистолетка / эко / форс / полный закуп / анти-эко; синхронность закупа.
 *  6. Роль игрока (entry, AWP, поддержка, люркер) меняет нормы.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CS2Demo = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TRADE_SEC = 5;            // окно размена, секунд
  var ISOLATED_DIST = 1100;     // дальше этого от ближайшего живого напарника = «в одиночку»
  var TRADE_DIST = 700;         // ближе этого к погибшему напарнику (и вы ближайший) — вы могли его разменять
  var SPOT_RADIUS = 300;        // радиус «одного и того же места» (если нет названий мест)
  var NADE_ITEMS = { 'flashbang': 'flash', 'he grenade': 'he', 'hegrenade': 'he', 'smoke grenade': 'smoke', 'smokegrenade': 'smoke', 'molotov': 'molly', 'incendiary grenade': 'molly', 'incgrenade': 'molly' };
  var AWP = { awp: 1, ssg08: 1 };
  var NADE_RU = { flash: 'флешка', he: 'HE', smoke: 'дым', molly: 'молотов' };

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
  function P(id, sev, title, text, drill, extra) { var o = { id: id, kind: 'problem', severity: Math.round(clamp(sev, 1, 99)), title: title, text: text, drill: drill }; if (extra) for (var k in extra) o[k] = extra[k]; return o; }
  function S(id, sev, title, text) { return { id: id, kind: 'strength', severity: Math.round(sev), title: title, text: text }; }
  function N(id, title, text) { return { id: id, kind: 'note', severity: 0, title: title, text: text }; }
  function sum(a, f) { var s = 0; a.forEach(function (x) { s += f ? f(x) : x; }); return s; }
  function uniq(a) { var o = [], m = {}; a.forEach(function (x) { if (!m[x]) { m[x] = 1; o.push(x); } }); return o; }
  // P(X >= k) для биномиального распределения (n попыток, вероятность p)
  function binomTail(n, k, p) {
    var s = 0, c = 1;
    for (var i = 0; i <= n; i++) {
      if (i > 0) c = c * (n - i + 1) / i;
      if (i >= k) s += c * Math.pow(p, i) * Math.pow(1 - p, n - i);
    }
    return s;
  }
  function roundsText(list) { list = uniq(list); return list.slice(0, 7).join(', ') + (list.length > 7 ? '…' : ''); }
  function sgn(x) { return (x >= 0 ? '+' : '−') + Math.abs(Math.round(x * 100)) + '%'; }
  function roundsVal(x) { return (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(1).replace('.', ','); }
  // «BombsiteA» → «плент A», «PalaceInterior» → «Palace Interior»
  function placeName(p) {
    if (!p) return '';
    var s = String(p);
    var m = /^Bombsite([AB])$/i.exec(s); if (m) return 'плент ' + m[1].toUpperCase();
    if (/^CTSpawn$/i.test(s)) return 'респаун CT';
    if (/^TSpawn$/i.test(s)) return 'респаун T';
    return s.replace(/([a-z])of([A-Z])/g, '$1 of $2').replace(/([a-z])([A-Z0-9])/g, '$1 $2');
  }
  // «раунд/раунда/раундов» с учётом дробных значений (1,3 раунда)
  function roundsWord(x) { x = Math.abs(x); var r = Math.round(x * 10) / 10; if (r % 1 !== 0) return 'раунда'; return plural(r, 'раунд', 'раунда', 'раундов'); }

  /* ------------------------------------------------------------------ */
  /* Модель шанса выиграть раунд (для стороны T)                         */
  /* Опирается на публичную статистику исходов раундов: 5v4 ≈ 66%,      */
  /* 4v5 ≈ 30%, 3v5 ≈ 15%; установленная бомба резко помогает T;         */
  /* преимущество в закупе тоже сдвигает шансы.                          */
  /* ------------------------------------------------------------------ */
  function wpT(t, ct, planted, eqAdv) {
    if (ct <= 0) return 1;
    if (t <= 0) return planted ? 0.12 : 0;
    var z = 0.8 * (t - ct) - 0.15 + (planted ? 1.05 : 0) + 0.55 * Math.tanh((eqAdv || 0) / 2500);
    return 1 / (1 + Math.exp(-z));
  }

  /* ------------------------------------------------------------------ */
  /* 1. Сырые данные → модель матча                                      */
  /* ------------------------------------------------------------------ */
  /**
   * raw = { header:{map_name}, tickrate?, events:[{event_name,tick,...}],
   *         snaps:[{tick,steamid,name,team_num,X,Y,is_alive,current_equip_value,balance,last_place_name?}] }
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
    while (spans.length && !allDeaths.some(function (d) { return d.tick > spans[0].start && d.tick <= spans[0].end; }) && spans.length > 16) spans.shift();
    var rounds = spans.map(function (s, i) {
      var fz = freezes.filter(function (f) { return f.tick > s.start && f.tick < s.end; })[0];
      return { n: i + 1, start: s.start, end: s.end, freeze: fz ? fz.tick : s.start, winner: s.winner, reason: s.reason, plant: null, planter: null, plantSite: null, defuse: null, defuser: null };
    });
    function roundAt(tick) {
      var lo = 0, hi = rounds.length - 1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1, r = rounds[mid];
        if (tick <= r.freeze) hi = mid - 1; else if (tick > r.end) lo = mid + 1; else return r;
      }
      return null;
    }
    function roundAtBuy(tick) {
      for (var i = 0; i < rounds.length; i++) { var r = rounds[i]; if (tick > r.start && tick <= r.freeze) return r; }
      return null;
    }
    ev('bomb_planted').forEach(function (p) { var r = roundAt(p.tick); if (r && !r.plant) { r.plant = p.tick; r.planter = p.user_steamid ? String(p.user_steamid) : null; r.plantSite = p.site; } });
    ev('bomb_defused').forEach(function (p) { var r = roundAt(p.tick); if (r && !r.defuse) { r.defuse = p.tick; r.defuser = p.user_steamid ? String(p.user_steamid) : null; } });

    // --- стороны, закуп и деньги игроков по раундам (снимки на конец заморозки) ---
    var snapsByTick = {};
    (raw.snaps || []).forEach(function (s) { (snapsByTick[s.tick] = snapsByTick[s.tick] || []).push(s); });
    var players = {}, side = {}, equip = {}, balance = {};
    rounds.forEach(function (r) {
      side[r.n] = {}; equip[r.n] = {}; balance[r.n] = {};
      (snapsByTick[r.freeze] || []).forEach(function (s) {
        var id = String(s.steamid);
        players[id] = players[id] || { id: id, name: s.name };
        if (s.team_num === 2 || s.team_num === 3) side[r.n][id] = s.team_num === 2 ? 'T' : 'CT';
        equip[r.n][id] = num(s.current_equip_value, 0);
        balance[r.n][id] = num(s.balance, 0);
      });
    });
    allDeaths.forEach(function (d) {
      var r = roundAt(d.tick); if (!r) return;
      if (d.attacker_steamid) { var a = String(d.attacker_steamid); players[a] = players[a] || { id: a, name: d.attacker_name }; if (!side[r.n][a] && d.attacker_team_num) side[r.n][a] = d.attacker_team_num === 2 ? 'T' : 'CT'; }
      if (d.user_steamid) { var u = String(d.user_steamid); players[u] = players[u] || { id: u, name: d.user_name }; if (!side[r.n][u] && d.user_team_num) side[r.n][u] = d.user_team_num === 2 ? 'T' : 'CT'; }
    });

    // --- тип раунда для каждой стороны по среднему закупу ---
    rounds.forEach(function (r) {
      var acc = { T: [], CT: [] };
      Object.keys(side[r.n]).forEach(function (id) { var s = side[r.n][id]; if (equip[r.n][id] != null) acc[s].push(equip[r.n][id]); });
      function avg(a) { return a.length ? sum(a) / a.length : 0; }
      r.eq = { T: avg(acc.T), CT: avg(acc.CT) };
      r.nT = Object.keys(side[r.n]).filter(function (id) { return side[r.n][id] === 'T'; }).length;
      r.nCT = Object.keys(side[r.n]).filter(function (id) { return side[r.n][id] === 'CT'; }).length;
      var pistol = r.n === 1 || r.n === 13;
      function kind(v) { return pistol ? 'pistol' : v < 1500 ? 'eco' : v < 3400 ? 'force' : 'full'; }
      r.type = { T: kind(r.eq.T), CT: kind(r.eq.CT) };
    });

    // --- убийства + шанс раунда до/после каждого ---
    var kills = [];
    allDeaths.forEach(function (d) {
      var r = roundAt(d.tick); if (!r) return;
      var a = d.attacker_steamid ? String(d.attacker_steamid) : null, v = String(d.user_steamid);
      var as = a ? side[r.n][a] : null, vs = side[r.n][v];
      kills.push({
        round: r.n, tick: d.tick, t: (d.tick - r.freeze) / tickrate,
        atk: a, vic: v, assist: d.assister_steamid ? String(d.assister_steamid) : null, flashAssist: !!d.assistedflash,
        weapon: weaponKey(d.weapon), hs: !!d.headshot, thrusmoke: !!d.thrusmoke, noscope: !!d.noscope, blind: !!d.attackerblind,
        atkSide: as, vicSide: vs, enemy: !!(a && as && vs && as !== vs), world: !a || a === v,
        vx: d.user_X, vy: d.user_Y, ax: d.attacker_X, ay: d.attacker_Y,
        place: d.user_last_place_name || '', atkPlace: d.attacker_last_place_name || ''
      });
    });
    var killsByRound = {};
    kills.forEach(function (k) { (killsByRound[k.round] = killsByRound[k.round] || []).push(k); });
    rounds.forEach(function (r) {
      var ks = (killsByRound[r.n] = (killsByRound[r.n] || []).sort(function (a, b) { return a.tick - b.tick; }));
      var alive = {}; Object.keys(side[r.n]).forEach(function (id) { alive[id] = side[r.n][id]; });
      function cnt(s) { var c = 0; for (var id in alive) if (alive[id] === s) c++; return c; }
      var eqAdv = r.eq.T - r.eq.CT;
      r.wp0 = wpT(r.nT, r.nCT, false, eqAdv);
      var planted = false, plantDone = false;
      ks.forEach(function (k) {
        if (!plantDone && r.plant && r.plant < k.tick) {
          plantDone = true; planted = true;
          var t0 = cnt('T'), c0 = cnt('CT');
          r.plantDelta = wpT(t0, c0, true, eqAdv) - wpT(t0, c0, false, eqAdv);
          r.plantAlive = { T: t0, CT: c0 };
        }
        k.aliveBefore = { T: cnt('T'), CT: cnt('CT') };
        k.planted = planted;
        k.wpB = wpT(k.aliveBefore.T, k.aliveBefore.CT, planted, eqAdv);
        if (k.vic in alive) delete alive[k.vic];
        k.aliveAfter = { T: cnt('T'), CT: cnt('CT') };
        k.wpA = wpT(k.aliveAfter.T, k.aliveAfter.CT, planted, eqAdv);
        k.dT = k.wpA - k.wpB;                      // изменение шанса T
      });
      if (!plantDone && r.plant) { var t1 = cnt('T'), c1 = cnt('CT'); r.plantDelta = wpT(t1, c1, true, eqAdv) - wpT(t1, c1, false, eqAdv); r.plantAlive = { T: t1, CT: c1 }; }
      if (r.defuse) { var t2 = cnt('T'), c2 = cnt('CT'); r.defuseDelta = wpT(t2, c2, true, eqAdv); }
      // размены
      ks.forEach(function (k) {
        if (!k.enemy) return;
        k.tradedBy = null;
        ks.forEach(function (p) {
          if (!k.tradedBy && p.enemy && p.vic === k.atk && p.atkSide === k.vicSide && p.tick > k.tick && p.tick - k.tick <= TRADE_SEC * tickrate) k.tradedBy = p.atk;
        });
        k.isTrade = ks.some(function (p) { return p.enemy && p.atk === k.vic && p.vicSide === k.atkSide && p.tick < k.tick && k.tick - p.tick <= TRADE_SEC * tickrate; });
      });
    });

    // средние по матчу — база для сравнения игрока
    var enemyDeaths = 0, tradedAll = 0;
    kills.forEach(function (k) { if (k.enemy) { enemyDeaths++; if (k.tradedBy) tradedAll++; } });
    var earlyAll = kills.filter(function (k) { return k.enemy && k.t < 25; }).length;
    var enemyKillsAll = kills.filter(function (k) { return k.enemy; }).length;

    return {
      earlyRate: enemyKillsAll ? earlyAll / enemyKillsAll : 0.25,
      tradeRate: enemyDeaths ? tradedAll / enemyDeaths : 0.2,
      map: (raw.header && raw.header.map_name) || '', tickrate: tickrate, rounds: rounds, roundAt: roundAt, roundAtBuy: roundAtBuy,
      players: players, side: side, equip: equip, balance: balance, kills: kills, killsByRound: killsByRound,
      hurts: ev('player_hurt'), blinds: ev('player_blind'), purchases: ev('item_purchase'),
      flashes: ev('flashbang_detonate'), hes: ev('hegrenade_detonate'), smokes: ev('smokegrenade_detonate'), fires: ev('inferno_startburn'),
      plants: ev('bomb_planted'), defuses: ev('bomb_defused'), snapsByTick: snapsByTick
    };
  }

  /** Список игроков для выбора: ник, K/D/A, команда. */
  function listPlayers(M) {
    var rows = Object.keys(M.players).map(function (id) {
      var k = 0, d = 0, a = 0;
      M.kills.forEach(function (x) { if (x.atk === id && x.enemy) k++; if (x.vic === id) d++; if (x.assist === id) a++; });
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
  /* 2. Статистика игрока: каждый раунд, каждое убийство и смерть        */
  /* ------------------------------------------------------------------ */
  function teamWp(k, s) { return s === 'T' ? k.wpB : 1 - k.wpB; }   // шанс команды s перед событием

  function playerStats(M, id) {
    var tr = M.tickrate;
    var st = {
      id: id, name: (M.players[id] || {}).name || id, rounds: 0, kills: 0, deaths: 0, assists: 0, hs: 0, awpKills: 0,
      dmg: 0, kast: 0, openWin: 0, openLoss: 0, openAttT: 0, openAttCT: 0, tradedDeaths: 0, untradedDeaths: 0, tradeKills: 0,
      killers: {}, deaths_: [], kills_: [], clutch: { att: 0, won: 0, best: 0, list: [] }, multi: { k3: 0, k4: 0, k5: 0 },
      flashes: 0, flashEff: 0, flashEnemyBlinds: 0, flashAssists: 0, teamFlashes: [], heDmg: 0, mollyDmg: 0, utilDmg: 0,
      nades: { flash: 0, he: 0, smoke: 0, molly: 0 }, nadesBoughtFull: 0, fullRounds: 0,
      unusedDeaths: [], overbuy: [], rWon: 0, rLost: 0, moments: [], plants: 0, defuses: 0, perRound: {},
      side: { T: { r: 0, dmg: 0, k: 0, d: 0, wpa: 0 }, CT: { r: 0, dmg: 0, k: 0, d: 0, wpa: 0 } },
      half: [{ r: 0, dmg: 0 }, { r: 0, dmg: 0 }], passiveLost: [],
      wpa: 0, wpaKills: 0, wpaDeaths: 0, wpaObj: 0, wpaAssist: 0,
      missedTrades: [], tradeChances: 0, desync: [], pistolNoBuy: [], noSave: [], antiEcoDeaths: [], advThrows: [], postPlantDeaths: [],
      isolated: [], earlyDeaths: [], awpDeaths: [], smokeDeaths: [], blindDeaths: [], ecoHeroKills: 0, cheapKills: 0,
      byType: {}, mateDistKills: [], deathTimes: []
    };
    function typeRow(k) { return st.byType[k] = st.byType[k] || { r: 0, won: 0, dmg: 0, wpa: 0, kast: 0, deaths: 0, kills: 0 }; }

    M.rounds.forEach(function (r) {
      var my = M.side[r.n][id]; if (!my) return;
      var foe = my === 'T' ? 'CT' : 'T';
      st.rounds++;
      var won = r.winner === my;
      if (won) st.rWon++; else st.rLost++;
      var ks = M.killsByRound[r.n] || [];
      var myEq = M.equip[r.n][id] || 0;
      var tk = r.type[my], ek = r.type[foe];
      var rtype = tk === 'pistol' ? 'pistol' : tk === 'full' && (ek === 'eco' || (ek === 'force' && r.eq[foe] < 2300)) ? 'antieco' : tk;
      var pr = { kills: 0, dmg: 0, died: false, deathT: null, deathK: null, assisted: false, traded: false, survived: true, wpa: 0, type: rtype, won: won, side: my, eq: myEq };
      st.perRound[r.n] = pr;
      var firstKill = null; ks.forEach(function (k) { if (!firstKill && k.enemy) firstKill = k; });
      if (firstKill && (firstKill.atk === id || firstKill.vic === id)) { if (my === 'T') st.openAttT++; else st.openAttCT++; }

      ks.forEach(function (k) {
        var dMy = my === 'T' ? k.dT : -k.dT;           // изменение шанса моей команды
        if (k.atk === id && k.enemy) {
          pr.kills++; st.kills++;
          if (k.hs) st.hs++;
          if (AWP[k.weapon]) st.awpKills++;
          if (k.isTrade) st.tradeKills++;
          var vEq = M.equip[r.n][k.vic] || 0;
          var kill = { round: r.n, t: k.t, val: dMy, place: k.place, vic: k.vic, wpB: teamWp(k, my), vEq: vEq, myEq: myEq, open: firstKill === k, trade: k.isTrade, alive: k.aliveBefore };
          st.kills_.push(kill);
          st.wpaKills += dMy; pr.wpa += dMy;
          if (Math.abs(dMy) < 0.04) st.cheapKills++;
          if (myEq < 1600 && vEq >= 3500) st.ecoHeroKills++;
          if (firstKill === k) st.openWin++;
        }
        if (k.assist === id && k.atk !== id) {
          st.assists++; pr.assisted = true;
          if (k.enemy) { var av = Math.abs(dMy) * 0.15; st.wpaAssist += av; pr.wpa += av; if (k.flashAssist) st.flashAssists++; }
        }
        if (k.vic === id) {
          st.deaths++; pr.died = true; pr.survived = false; pr.deathT = k.t;
          var cost = dMy;                                 // отрицательное число
          if (k.enemy && k.tradedBy) cost *= 0.5;         // размен вернул часть преимущества
          st.wpaDeaths += cost; pr.wpa += cost;
          var dObj = {
            round: r.n, t: k.t, tick: k.tick, x: k.vx, y: k.vy, place: k.place, side: my, atk: k.atk, enemy: k.enemy, weapon: k.weapon,
            traded: !!k.tradedBy, open: firstKill === k, cost: cost, wpB: teamWp(k, my), alive: k.aliveBefore, planted: k.planted,
            myEq: myEq, atkEq: k.atk ? (M.equip[r.n][k.atk] || 0) : 0, won: won, type: rtype, blind: false, smoke: k.thrusmoke
          };
          pr.deathK = dObj;
          st.deaths_.push(dObj);
          st.deathTimes.push(k.t);
          if (k.enemy) { if (k.tradedBy) { st.tradedDeaths++; pr.traded = true; } else st.untradedDeaths++; }
          if (k.atk && k.enemy) st.killers[k.atk] = (st.killers[k.atk] || 0) + 1;
          if (k.enemy && k.weapon === 'awp') st.awpDeaths.push(r.n);
          if (k.enemy && k.thrusmoke) st.smokeDeaths.push(r.n);
          if (firstKill === k) st.openLoss++;
          if (k.enemy && k.t < 25) st.earlyDeaths.push({ round: r.n, t: k.t });
        }
      });

      // бомба
      if (r.planter === id && r.plantDelta) { var pv = my === 'T' ? r.plantDelta : 0; st.plants++; st.wpaObj += pv; pr.wpa += pv; }
      if (r.defuser === id && r.defuseDelta) { st.defuses++; st.wpaObj += r.defuseDelta; pr.wpa += r.defuseDelta; }

      // многоубийства
      if (pr.kills >= 5) st.multi.k5++; else if (pr.kills === 4) st.multi.k4++; else if (pr.kills === 3) st.multi.k3++;
      // KAST
      if (pr.kills > 0 || pr.assisted || pr.survived || pr.traded) st.kast++;

      // клатч: остались последним живым в команде
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
        var cw = won && pr.survived || (won && r.plant && my === 'T');
        st.clutch.list.push({ round: r.n, vs: enemiesAtStart, won: !!cw });
        if (cw) { st.clutch.won++; st.clutch.best = Math.max(st.clutch.best, enemiesAtStart); st.moments.push({ round: r.n, tone: 'good', imp: 30 + enemiesAtStart * 8, text: 'Клатч 1 против ' + enemiesAtStart + ' — раунд выигран.', t: 0 }); }
      }

      // пропущенные размены: напарник погиб рядом, вы были живы и не наказали убийцу
      var myDeathTick = pr.deathK ? pr.deathK.tick : Infinity;
      ks.forEach(function (k) {
        if (!k.enemy || k.vicSide !== my || k.vic === id || k.tick >= myDeathTick) return;
        var snaps = M.snapsByTick[k.tick]; if (!snaps) return;
        var me = snaps.filter(function (s) { return String(s.steamid) === id; })[0];
        if (!me || !me.is_alive || k.vx == null) return;
        var d = dist(me.X, me.Y, k.vx, k.vy);
        if (d > TRADE_DIST) return;
        // вы должны быть ближайшим живым напарником погибшего
        var closer = snaps.some(function (s) { var pid = String(s.steamid); if (pid === id || pid === k.vic || !s.is_alive) return false; var sd = s.team_num === 2 ? 'T' : (s.team_num === 3 ? 'CT' : null); return sd === my && dist(s.X, s.Y, k.vx, k.vy) < d; });
        if (closer) return;
        st.tradeChances++;
        if (k.tradedBy) return;                                         // разменял кто-то (возможно, вы)
        var diedTrying = pr.deathK && pr.deathK.tick - k.tick <= TRADE_SEC * tr && pr.deathK.atk === k.atk;
        if (diedTrying) return;
        st.missedTrades.push({ round: r.n, t: k.t, mate: k.vic, dist: Math.round(d), place: k.place });
      });
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
    st.flashes = M.flashes.filter(mine).length;
    var effTicks = {};
    M.blinds.forEach(function (b) {
      if (String(b.attacker_steamid) !== id) return;
      var r = M.roundAt(b.tick); if (!r) return;
      var my = M.side[r.n][id], vs = M.side[r.n][String(b.user_steamid)];
      if (!my || !vs || String(b.user_steamid) === id) return;
      var dur = num(b.blind_duration, 0);
      if (vs !== my) { if (dur >= 1.0) { effTicks[b.tick] = true; st.flashEnemyBlinds++; } }
      else if (dur >= 1.5) st.teamFlashes.push({ round: r.n, dur: dur, tick: b.tick });
    });
    st.flashEff = Object.keys(effTicks).length;

    // смерти, пока вас слепила флешка соперника
    M.blinds.forEach(function (b) {
      if (String(b.user_steamid) !== id) return;
      var dur = num(b.blind_duration, 0); if (dur < 1.2) return;
      var r = M.roundAt(b.tick); if (!r) return;
      var my = M.side[r.n][id], as = M.side[r.n][String(b.attacker_steamid)];
      if (!my || !as || my === as) return;
      var dd = st.deaths_.filter(function (d) { return d.round === r.n && d.tick >= b.tick && d.tick <= b.tick + (dur + 0.4) * tr; })[0];
      if (dd) { dd.blind = true; if (st.blindDeaths.indexOf(r.n) === -1) st.blindDeaths.push(r.n); }
    });

    // --- купленные гранаты: неиспользованные при смерти, закуп без гранат ---
    var bought = {};
    M.purchases.forEach(function (p) {
      if (String(p.steamid) !== id) return;
      var kind = NADE_ITEMS[String(p.item_name || '').toLowerCase().replace(/^weapon_/, '')]; if (!kind) return;
      var r = M.roundAtBuy(p.tick); if (!r) return;
      var o = bought[r.n] = bought[r.n] || { flash: 0, he: 0, smoke: 0, molly: 0 };
      if (!p.was_sold) o[kind]++;
    });
    M.rounds.forEach(function (r) {
      var pr = st.perRound[r.n]; if (!pr) return;
      var b = bought[r.n];
      if (pr.eq >= 3700 && pr.type !== 'pistol') { st.fullRounds++; if (b) st.nadesBoughtFull += b.flash + b.he + b.smoke + b.molly; }
      if (!pr.died || !b) return;
      var t = thrownByRound[r.n] || { flash: 0, he: 0, smoke: 0, molly: 0 };
      var left = 0, names = [];
      ['flash', 'he', 'smoke', 'molly'].forEach(function (k) { var l = b[k] - t[k]; if (l > 0) { left += l; names.push(NADE_RU[k]); } });
      if (left > 0 && pr.deathT > 8) { st.unusedDeaths.push({ round: r.n, left: left, names: names, t: pr.deathT }); if (pr.deathK) pr.deathK.unused = names; }
    });

    // --- стороны, половины, типы раундов, пассивность, экономика ---
    M.rounds.forEach(function (r) {
      var my = M.side[r.n][id], pr = st.perRound[r.n]; if (!my || !pr) return;
      var sd = st.side[my]; sd.r++; sd.dmg += pr.dmg; sd.k += pr.kills; sd.wpa += pr.wpa; if (pr.died) sd.d++;
      var h = st.half[r.n <= 12 ? 0 : 1]; h.r++; h.dmg += pr.dmg;
      var tr_ = typeRow(pr.type); tr_.r++; if (pr.won) tr_.won++; tr_.dmg += pr.dmg; tr_.wpa += pr.wpa; tr_.kills += pr.kills; if (pr.died) tr_.deaths++;
      if (pr.kills > 0 || pr.assisted || pr.survived || pr.traded) tr_.kast++;
      if (!pr.won && pr.dmg < 15 && pr.kills === 0 && !pr.assisted) st.passiveLost.push(r.n);
      // закуп без отдачи
      if (pr.eq >= 3800 && pr.died && pr.kills === 0 && !pr.assisted && pr.dmg < 40 && pr.type !== 'pistol') st.overbuy.push({ round: r.n, eq: pr.eq });
      // синхронность закупа с командой
      if (pr.type !== 'pistol') {
        var mates = Object.keys(M.side[r.n]).filter(function (pid) { return pid !== id && M.side[r.n][pid] === my; });
        if (mates.length >= 3) {
          var mAvg = sum(mates, function (pid) { return M.equip[r.n][pid] || 0; }) / mates.length;
          var bal = (M.balance[r.n] || {})[id] || 0;
          if (pr.eq >= 3600 && mAvg < 1700) st.desync.push({ round: r.n, kind: 'solo_buy', me: pr.eq, team: Math.round(mAvg) });
          else if (pr.eq < 1500 && mAvg >= 3600 && bal >= 2700) st.desync.push({ round: r.n, kind: 'solo_save', me: pr.eq, team: Math.round(mAvg), bal: bal });
        }
      }
      // после выигранной пистолетки — нужен апгрейд оружия
      if ((r.n === 2 || r.n === 14) && st.perRound[r.n - 1] && st.perRound[r.n - 1].won && st.perRound[r.n - 1].side === my) {
        var bal2 = (M.balance[r.n] || {})[id] || 0;
        if (pr.eq < 1900 && bal2 >= 1200) st.pistolNoBuy.push({ round: r.n, eq: pr.eq, bal: bal2 });
      }
    });

    // --- контекст каждой смерти ---
    st.deaths_.forEach(function (dp) {
      var snaps = M.snapsByTick[dp.tick];
      if (snaps) {
        var best = null;
        snaps.forEach(function (s) {
          var pid = String(s.steamid); if (pid === id || !s.is_alive) return;
          var sd = s.team_num === 2 ? 'T' : (s.team_num === 3 ? 'CT' : null);
          if (sd !== dp.side) return;
          var d = dist(dp.x, dp.y, s.X, s.Y);
          if (best == null || d < best) best = d;
        });
        dp.mateDist = best;
      }
      if (!dp.enemy) return;
      var mine_ = dp.side === 'T' ? dp.alive.T : dp.alive.CT, theirs = dp.side === 'T' ? dp.alive.CT : dp.alive.T;
      dp.adv = mine_ - theirs;
      if (!dp.traded && dp.mateDist != null && dp.mateDist > ISOLATED_DIST) { dp.isolated = true; st.isolated.push(dp); }
      // проигранный раунд, где спасти оружие было правильнее, чем умирать
      if (!dp.won && dp.wpB < 0.12 && dp.myEq >= 3700 && mine_ <= theirs - 1 && !dp.traded && dp.type !== 'pistol') { dp.noSave = true; st.noSave.push(dp); }
      // смерть в анти-эко раунде
      if (dp.type === 'antieco' && dp.atkEq < 2000) { dp.antiEco = true; st.antiEcoDeaths.push(dp); }
      // отдали численное преимущество
      if (dp.adv >= 1 && !dp.traded && !dp.won) { dp.advThrow = true; st.advThrows.push(dp); }
      // атака: смерть после установки бомбы без размена в проигранном раунде
      if (dp.side === 'T' && dp.planted && !dp.traded && !dp.won) { dp.postPlant = true; st.postPlantDeaths.push(dp); }
    });
    return st;
  }

  /** Средние по всем игрокам матча — чтобы сравнивать игрока с его же лобби, а не с абстрактной нормой. */
  function matchBase(M) {
    if (M._base) return M._base;
    var acc = { iso: [], miss: [], adv: [], early: [] };
    Object.keys(M.players).forEach(function (pid) {
      var s = playerStats(M, pid); if (s.rounds < 8) return;
      if (s.deaths >= 5) acc.iso.push(s.isolated.length / s.deaths);
      if (s.tradeChances >= 3) acc.miss.push(s.missedTrades.length / s.tradeChances);
      acc.adv.push(s.advThrows.length / s.rounds);
    });
    function avg(a, d) { return a.length ? sum(a) / a.length : d; }
    M._base = { iso: avg(acc.iso, 0.25), miss: avg(acc.miss, 0.4), adv: avg(acc.adv, 0.08) };
    return M._base;
  }

  /* ------------------------------------------------------------------ */
  /* 3. Роль игрока                                                      */
  /* ------------------------------------------------------------------ */
  function inferRole(st) {
    var K = st.kills, R = st.rounds;
    var tR = st.side.T.r || 1;
    var awpShare = K ? st.awpKills / K : 0;
    var openT = st.openAttT / tR;
    var nadesPerR = (st.nades.flash + st.nades.he + st.nades.smoke + st.nades.molly) / Math.max(1, R);
    var lateDeaths = st.deathTimes.filter(function (t) { return t > 55; }).length / Math.max(1, st.deaths);
    var farDeaths = st.deaths_.filter(function (d) { return d.side === 'T' && d.mateDist != null && d.mateDist > 1400; }).length / Math.max(1, st.deaths_.filter(function (d) { return d.side === 'T'; }).length);
    if (awpShare >= 0.33) return { id: 'awp', name: 'AWPer', text: 'снайперские убийства — ' + pct(st.awpKills, K) + '% ваших фрагов' };
    if (openT >= 0.33) return { id: 'entry', name: 'entry-фраггер', text: 'за атаку вы участвовали в первой дуэли ' + pct(st.openAttT, tR) + '% раундов' };
    if (farDeaths >= 0.45 && lateDeaths >= 0.4) return { id: 'lurk', name: 'люркер', text: 'за атаку вы чаще играли отдельно от команды и умирали в конце раунда' };
    if (nadesPerR >= 1.6 && st.flashes / Math.max(1, R) >= 0.6) return { id: 'support', name: 'игрок поддержки', text: 'вы бросали ' + r1(nadesPerR) + ' гранаты за раунд' };
    return { id: 'rifle', name: 'райфлер', text: 'без выраженной специализации' };
  }

  /* ------------------------------------------------------------------ */
  /* 4. Правила → отчёт                                                  */
  /* ------------------------------------------------------------------ */
  function clustersByPlace(points) {
    var withPlace = points.filter(function (p) { return p.place; });
    var cl = [];
    if (withPlace.length >= points.length * 0.7) {
      var m = {};
      withPlace.forEach(function (p) { var k = p.side + '|' + p.place; (m[k] = m[k] || { side: p.side, place: p.place, items: [] }).items.push(p); });
      Object.keys(m).forEach(function (k) { cl.push(m[k]); });
    } else {
      points.forEach(function (p) {
        if (p.x == null || p.y == null) return;
        var c = cl.filter(function (c) { return c.side === p.side && dist(c.x, c.y, p.x, p.y) <= SPOT_RADIUS; })[0];
        if (c) { c.items.push(p); c.x = (c.x * (c.items.length - 1) + p.x) / c.items.length; c.y = (c.y * (c.items.length - 1) + p.y) / c.items.length; }
        else cl.push({ x: p.x, y: p.y, side: p.side, place: p.place || '', items: [p] });
      });
    }
    return cl.sort(function (a, b) { return b.items.length - a.items.length; });
  }
  function evDeath(d, nameOf, extra) {
    return 'Раунд ' + d.round + ' · ' + mmss(d.t) + (d.place ? ' · ' + placeName(d.place) : '') + ' — ' + (extra || ('смерть' + (d.atk ? ' от ' + nameOf(d.atk) : ''))) + ' (' + sgn(d.cost) + ' к шансу раунда)';
  }
  function costRounds(list) { return -sum(list, function (d) { return Math.min(0, d.cost); }); }

  function analyze(M, id, nameOf) {
    var st = playerStats(M, id);
    var res = playerResult(M, id);
    var items = [];
    var R = st.rounds, D = st.deaths, K = st.kills;
    nameOf = nameOf || function (pid) { return (M.players[pid] || {}).name || 'соперник'; };
    if (R < 8) {
      return finish([N('few', 'Мало данных', 'В этой записи слишком мало раундов для надёжного разбора.')], { title: 'Разбор тренера · CS2' });
    }
    var role = inferRole(st);
    var base = matchBase(M);
    var adr = st.dmg / R, kast = pct(st.kast, R), kd = D > 0 ? K / D : K;
    var hsPct = K > 0 ? pct(st.hs, K) : 0, isAwp = role.id === 'awp';
    var openAtt = st.openWin + st.openLoss, openPct = pct(st.openWin, openAtt);
    var enemyDeaths = st.tradedDeaths + st.untradedDeaths;
    var untradedPct = pct(st.untradedDeaths, enemyDeaths);
    var wpa = st.wpaKills + st.wpaDeaths + st.wpaObj + st.wpaAssist;
    var wpaPer24 = wpa / R * 24;

    /* ===== Главные ошибки: считаем их цену в раундах ===== */

    /* 1. Смерти в одиночку (соло-контакты) */
    var isoShare = st.isolated.length / Math.max(1, D);
    if (st.isolated.length >= 3 && isoShare >= Math.max(0.3, base.iso + 0.1)) {
      var cIso = costRounds(st.isolated);
      items.push(P('isolated', 32 + cIso * 28 + (isoShare - base.iso) * 40, 'Соло-контакты: умираете один, без шанса на размен',
        st.isolated.length + ' из ' + D + ' ' + plural(D, 'смерти', 'смертей', 'смертей') + ' (' + Math.round(isoShare * 100) + '%, в среднем по лобби ' + Math.round(base.iso * 100) + '%) — вдали от команды: ближайший напарник дальше ~' + ISOLATED_DIST + ' юнитов, никто физически не мог вас разменять. Эти смерти стоили команде ≈' + r1(cIso).toString().replace('.', ',') + ' ' + roundsWord(cIso) + '.',
        'Правило пары: перед выходом на дуэль посмотрите на радар — кто сможет вас разменять в течение 2–3 секунд? Если никого — не выходите, а ждите напарника или играйте от информации. Цель на 3 матча: не больше 2 смертей в одиночку за игру.',
        { why: 'Тренеры (Alienn, chopper) повторяют одно: даже выигранный соло-контакт — это удача; проигранный оставляет команду без зоны и в меньшинстве. Дуэль, которую можно разменять, стоит вдвое дешевле.', evidence: st.isolated.slice().sort(function (a, b) { return a.cost - b.cost; }).slice(0, 5).map(function (d) { return evDeath(d, nameOf, 'один, напарники в ≈' + Math.round(d.mateDist) + ' юн.' + (d.atk ? ', убил ' + nameOf(d.atk) : '')); }), cost: cIso }));
    }

    /* 2. Не разменяли напарника */
    var missRate = st.missedTrades.length / Math.max(1, st.tradeChances);
    if (st.missedTrades.length >= 3 && missRate >= Math.max(0.5, base.miss + 0.12)) {
      items.push(P('missed_trades', 30 + st.missedTrades.length * 3 + (missRate - base.miss) * 50 - (role.id === 'awp' ? 10 : 0), 'Не размениваете напарников',
        st.missedTrades.length + ' ' + plural(st.missedTrades.length, 'раз', 'раза', 'раз') + ' напарник погиб в нескольких шагах от вас (вы были ближайшим, до ~' + TRADE_DIST + ' юнитов), а его убийца прожил ещё ' + TRADE_SEC + '+ секунд. Из ' + st.tradeChances + ' таких ситуаций убийцу наказали только в ' + (st.tradeChances - st.missedTrades.length) + ' (в среднем по лобби упускают ' + Math.round(base.miss * 100) + '%).' + (role.id === 'awp' ? ' С AWP размен сложнее, но держите позицию так, чтобы видеть угол, где стоит напарник.' : ''),
        'Как только рядом умирает напарник — сразу выходите на того, кто его убил: он ещё в прицеле на месте убийства и часто без патронов. Отработка: DM в паре с другом — один пикает, второй сразу добивает.',
        { why: 'Rachel и ct0m показывают: на высоком уровне смерть почти всегда разменивается за 1–2 секунды. Неразменянная смерть превращает 5v5 в 4v5 — это −20–25% к шансу раунда.', evidence: st.missedTrades.slice(0, 5).map(function (m) { return 'Раунд ' + m.round + ' · ' + mmss(m.t) + (m.place ? ' · ' + placeName(m.place) : '') + ' — погиб ' + nameOf(m.mate) + ' в ' + m.dist + ' юн. от вас, размена нет'; }) }));
    }

    /* 3. Отдали численное преимущество */
    var cAdv = costRounds(st.advThrows);
    if (st.advThrows.length >= 2 && (st.advThrows.length >= 3 || cAdv >= 0.35) && st.advThrows.length / R >= base.adv * 1.3) {
      items.push(P('adv_throw', 32 + cAdv * 28 + st.advThrows.length * 2, 'Отдаёте численное преимущество',
        'В ' + st.advThrows.length + ' ' + plural(st.advThrows.length, 'раунде', 'раундах', 'раундах') + ' ваша команда была в большинстве, вы погибли без размена — и раунд проигран (раунды ' + roundsText(st.advThrows.map(function (d) { return d.round; })) + ').',
        'В большинстве не нужно искать дуэли — нужно обменивать время на позицию: играйте вдвоём, берите зону гранатами и заставляйте соперника выходить на вас. Перед пиком спросите себя: «зачем мне этот угол, если нас больше?»',
        { why: 'Chopper: «в большинстве — забирайте пространство парами и не давайте бесплатных дуэлей; в меньшинстве — выживайте и ищите размен». Каждая смерть при 5v4 возвращает сопернику около 15–20% шанса.', evidence: st.advThrows.slice().sort(function (a, b) { return a.cost - b.cost; }).slice(0, 5).map(function (d) { var m = d.side === 'T' ? d.alive.T : d.alive.CT, t = d.side === 'T' ? d.alive.CT : d.alive.T; return evDeath(d, nameOf, 'при ' + m + 'v' + t + (d.atk ? ', убил ' + nameOf(d.atk) : '')); }), cost: cAdv }));
    }

    /* 4. Открывающие дуэли (с учётом роли) */
    var openDeathsUntraded = st.deaths_.filter(function (d) { return d.open && d.enemy && !d.traded; });
    if (openAtt >= 5 && openPct <= 40 && openDeathsUntraded.length >= 3) {
      var cOpen = costRounds(openDeathsUntraded);
      var entry = role.id === 'entry';
      items.push(P('opening', 36 + (45 - openPct) * 0.6 + cOpen * 15 - (entry ? 6 : 0), entry ? 'Entry без поддержки: первые дуэли не разменивают' : 'Проигранные открывающие дуэли',
        'Первые дуэли раунда: выиграно ' + st.openWin + ' из ' + openAtt + ' (' + openPct + '%). ' + openDeathsUntraded.length + ' ' + plural(openDeathsUntraded.length, 'открывающая смерть осталась', 'открывающие смерти остались', 'открывающих смертей остались') + ' без размена — команда сразу играла 4 против 5.',
        entry ? 'Вы entry — первые смерти для вас нормальны, но только с разменом. Договаривайтесь о выходе: флешка от напарника → вы пикаете → второй сразу за вами. Не выходите, пока напарник не готов (chopper: «он не готов, а ты уже бежишь»).'
              : 'Не берите первую дуэль без причины: только с флешкой напарника или когда второй готов разменять. Иначе играйте вторым номером и ловите соперника на размене.',
        { why: 'Открывающая смерть без размена — самая дорогая ошибка в CS: 5v4 у атаки ≈ 65% на победу. Тренеры называют это «отдали раунд на первой секунде».', evidence: openDeathsUntraded.slice().sort(function (a, b) { return a.cost - b.cost; }).slice(0, 5).map(function (d) { return evDeath(d, nameOf, 'первая смерть раунда' + (d.atk ? ' от ' + nameOf(d.atk) : '') + ', без размена'); }), cost: cOpen }));
    } else if (openAtt >= 5 && openPct >= 60) {
      items.push(S('opening', 40 + (openPct - 55) * 0.5, 'Выигрываете открывающие дуэли', 'Первые дуэли раунда: выиграно ' + st.openWin + ' из ' + openAtt + ' (' + openPct + '%) — вы задаёте темп команде.'));
    }

    /* 5. Не сохранили оружие в проигранном раунде */
    if (st.noSave.length >= 2) {
      var lostEq = sum(st.noSave, function (d) { return d.myEq; });
      items.push(P('no_save', 30 + st.noSave.length * 6 + lostEq / 1500, 'Не сохраняете оружие в проигранных раундах',
        st.noSave.length + ' ' + plural(st.noSave.length, 'раз', 'раза', 'раз') + ' вы погибли с полным закупом, когда раунд уже был почти проигран (шанс команды ниже 12%). Сопернику ушло снаряжение на ≈$' + Math.round(lostEq / 100) * 100 + ', а следующий раунд команда начинала без вашего оружия.',
        'Если вы остались в меньшинстве (1v3, 2v4) без времени или бомба уже стоит, а вы далеко — сохраняйте оружие: отойдите в безопасное место и не показывайтесь. Сейв — это бесплатный закуп на следующий раунд.',
        { why: 'Tried (топ FACEIT) и chopper: «нет смысла брать плохие дуэли — сейв». Сохранённая винтовка часто решает исход следующего раунда сильнее, чем шанс на чудо-клатч.', evidence: st.noSave.slice(0, 5).map(function (d) { var m = d.side === 'T' ? d.alive.T : d.alive.CT, t = d.side === 'T' ? d.alive.CT : d.alive.T; return 'Раунд ' + d.round + ' · ' + mmss(d.t) + (d.place ? ' · ' + placeName(d.place) : '') + ' — ' + m + 'v' + t + (d.planted ? ', бомба стоит' : '') + ', шанс команды ' + Math.round(d.wpB * 100) + '%, потеряно снаряжения на $' + d.myEq; }) }));
    }

    /* 6. Смерти в анти-эко */
    if (st.antiEcoDeaths.length >= 2) {
      var cEco = costRounds(st.antiEcoDeaths);
      items.push(P('anti_eco', 32 + st.antiEcoDeaths.length * 5 + cEco * 15, 'Умираете против эко-закупа соперника',
        'В раундах, где у вас полный закуп, а у соперника эко или слабый форс, вы погибли ' + st.antiEcoDeaths.length + ' ' + plural(st.antiEcoDeaths.length, 'раз', 'раза', 'раз') + ' (раунды ' + roundsText(st.antiEcoDeaths.map(function (d) { return d.round; })) + '). Каждая такая смерть дарит сопернику винтовку.',
        'Анти-эко играется «дефолтом» без риска (Alienn): держите дальние дистанции, не выходите в ближний бой против пистолетов и дробовиков, играйте парами. Ваша задача — не дать им оружие.',
        { why: 'Проигранный анти-эко ломает экономику на 2–3 раунда вперёд. В таких раундах тренеры требуют дисциплину, а не красивые фраги.', evidence: st.antiEcoDeaths.slice(0, 5).map(function (d) { return evDeath(d, nameOf, 'убил ' + (d.atk ? nameOf(d.atk) : 'соперник') + ' с закупом $' + d.atkEq + ' (у вас $' + d.myEq + ')'); }), cost: cEco }));
    }

    /* 7. Смерти после установки бомбы (атака) */
    if (st.postPlantDeaths.length >= 2) {
      var cPP = costRounds(st.postPlantDeaths);
      items.push(P('post_plant', 32 + st.postPlantDeaths.length * 5 + cPP * 18, 'Проигрываете пост-плант: ищете дуэли вместо игры от бомбы',
        st.postPlantDeaths.length + ' ' + plural(st.postPlantDeaths.length, 'раз', 'раза', 'раз') + ' вы погибли после установки бомбы без размена, и раунд был проигран (раунды ' + roundsText(st.postPlantDeaths.map(function (d) { return d.round; })) + ').',
        'После установки время работает на вас: займите позицию с видом на бомбу (лучше перекрёстную с напарником), не пикайте ретейкеров первым, а ждите звука дефуза. Молотов/HE оставляйте на дефуз.',
        { why: 'Rachel: «после установки не бери эти дуэли — у тебя самый выгодный спот, раз бомба стоит». donk/sh1ro отмечают «не занял позицию после установки — проиграл раунд».', evidence: st.postPlantDeaths.slice(0, 5).map(function (d) { var m = d.alive.T, t = d.alive.CT; return evDeath(d, nameOf, 'после установки, ' + m + 'v' + t + (d.atk ? ', убил ' + nameOf(d.atk) : '')); }), cost: cPP }));
    }

    /* 8. Ранние смерти (до информации) */
    var earlyShare = st.earlyDeaths.length / Math.max(1, D);
    if (st.earlyDeaths.length >= 4 && earlyShare >= 0.3 && earlyShare - M.earlyRate >= 0.12 && role.id !== 'entry') {
      var early = st.deaths_.filter(function (d) { return d.enemy && d.t < 25; });
      var cEarly = costRounds(early);
      items.push(P('early', 30 + st.earlyDeaths.length * 1.5 + cEarly * 22, 'Умираете в первые секунды раунда',
        st.earlyDeaths.length + ' ' + plural(st.earlyDeaths.length, 'раз', 'раза', 'раз') + ' (' + Math.round(earlyShare * 100) + '% ваших смертей, в среднем по матчу ' + Math.round(M.earlyRate * 100) + '%) вы погибли в первые 25 секунд — до того, как команда получила информацию.',
        'Ранний раунд — это сбор информации и гранаты, а не дуэли: слушайте, подсвечивайте угол, выходите только с поддержкой. Отрабатывайте префайр ваших стандартных позиций на пустой карте.',
        { why: 'Смерть «за ничто» в начале раунда забирает и фраг, и темп команды (Alienn: «это не вы крутые, это соперники на этом уровне слабые — на 2500 вас накажут»).', evidence: early.slice().sort(function (a, b) { return a.cost - b.cost; }).slice(0, 5).map(function (d) { return evDeath(d, nameOf); }), cost: cEarly }));
    }

    /* 9. Один и тот же убийца */
    var killerIds = Object.keys(st.killers).filter(function (kid) {
      var n = st.killers[kid];
      return n >= 4 && n / Math.max(1, D) >= 0.35 && binomTail(D, n, 0.2) < 0.03;
    }).sort(function (a, b) { return st.killers[b] - st.killers[a]; });
    if (killerIds.length) {
      var kid0 = killerIds[0], n0 = st.killers[kid0];
      var kd0 = st.deaths_.filter(function (d) { return d.atk === kid0; });
      var placesK = uniq(kd0.map(function (d) { return placeName(d.place); }).filter(Boolean));
      items.push(P('repeat_killer', 30 + n0 * 3, 'Один соперник «читает» вас',
        nameOf(kid0) + ' убил вас ' + n0 + ' ' + plural(n0, 'раз', 'раза', 'раз') + ' из ' + D + (placesK.length ? ' (места: ' + placesK.slice(0, 3).join(', ') + ')' : '') + '. При пяти соперниках каждый в среднем забирает пятую часть смертей — это не случайность.',
        'Запоминайте, кто и где вас убил (Rachel: «Малага всегда играет андер — не иди на него как мясо»). Меняйте тайминг и маршрут против этого игрока, выманивайте его гранатой, играйте против него второй волной.',
        { why: 'Соперник выучил ваш паттерн. donk и sh1ro называют это «маленький пул действий»: одинаковые выходы легко читаются.', evidence: kd0.slice(0, 5).map(function (d) { return evDeath(d, nameOf, 'снова ' + nameOf(kid0)); }) }));
    }

    /* 10. Одно и то же место смерти (предсказуемость) */
    var cl = clustersByPlace(st.deaths_.filter(function (d) { return d.enemy; }));
    if (cl.length && cl[0].items.length >= 3 && cl[0].items.length / Math.max(1, D) >= 0.22) {
      var c0 = cl[0];
      items.push(P('spot', 28 + c0.items.length * 4, 'Предсказуемость: умираете в одном и том же месте',
        c0.items.length + ' ' + plural(c0.items.length, 'раз', 'раза', 'раз') + ' вы погибли ' + (c0.place ? 'в зоне «' + placeName(c0.place) + '»' : 'в одной точке') + ' за ' + (c0.side === 'T' ? 'атаку' : 'защиту') + ' (раунды ' + roundsText(c0.items.map(function (d) { return d.round; })) + '). Соперники знают, где вы будете.',
        'Расширяйте пул действий: меняйте позицию и тайминг каждые 2–3 раунда, после смерти в точке не возвращайтесь туда тем же способом. За защиту — играйте от информации и меняйте углы (Kuro: «не умирай за этот клочок земли — отдай его и забери выход»).',
        { why: 'donk/sh1ro: «у него слишком маленький пул действий — один и тот же выход 4 раунда подряд, соперник это прочитал».', evidence: c0.items.slice(0, 5).map(function (d) { return evDeath(d, nameOf); }) }));
    }

    /* 11. Смерти от AWP / через дым / ослеплённым */
    if (st.awpDeaths.length >= 3 && st.awpDeaths.length / Math.max(1, D) >= 0.25) {
      items.push(P('awp_deaths', 32 + st.awpDeaths.length * 4, 'Выходите на линию снайпера',
        st.awpDeaths.length + ' из ' + D + ' смертей — от AWP (раунды ' + roundsText(st.awpDeaths) + ').',
        'Против AWP: разрывайте линию дымом, пикайте вдвоём (один показывается — второй добивает), не выходите в длинный проём без флешки. Сухой пик снайпера = подарок.'));
    }
    if (st.smokeDeaths.length >= 2) {
      items.push(P('smoke_deaths', 30 + st.smokeDeaths.length * 5, 'Вас убивают через дым',
        st.smokeDeaths.length + ' ' + plural(st.smokeDeaths.length, 'раз', 'раза', 'раз') + ' вас убили сквозь дымовую завесу (раунды ' + roundsText(st.smokeDeaths) + ').',
        'Не стойте на краю дыма и не пересиживайте в нём: после броска отходите в сторону — в дым стреляют на звук.'));
    }
    if (st.blindDeaths.length >= 3) {
      items.push(P('blind_deaths', 32 + st.blindDeaths.length * 4, 'Погибаете ослеплёнными',
        'В ' + st.blindDeaths.length + ' ' + plural(st.blindDeaths.length, 'раунде', 'раундах', 'раундах') + ' вы погибли, пока были ослеплены флешкой (раунды ' + roundsText(st.blindDeaths) + ').',
        'Слышите бросок — отворачивайтесь и уходите за угол до взрыва (антиблайнд), разворачивайтесь после хлопка. В CS2 это базовый навык против любых выходов.'));
    }

    /* 12. Гранаты */
    var utilPerRound = st.utilDmg / R;
    if (st.unusedDeaths.length >= 4 && st.unusedDeaths.length / Math.max(1, D) >= 0.35) {
      items.push(P('unused', 32 + st.unusedDeaths.length * 2, 'Умираете с гранатами в кармане',
        'В ' + st.unusedDeaths.length + ' ' + plural(st.unusedDeaths.length, 'раунде', 'раундах', 'раундах') + ' вы погибли, не использовав купленные гранаты (раунды ' + roundsText(st.unusedDeaths.map(function (x) { return x.round; })) + ').',
        'Тратьте гранаты до контакта или при отходе: флешка под выход, молотов в угол, HE по пробегающим. Граната в руке у мёртвого — потерянные деньги.',
        { why: 'donk и sh1ro: «не использовал молотов в 1v2 — а с ним выиграл бы раунд».', evidence: st.unusedDeaths.slice(0, 5).map(function (u) { return 'Раунд ' + u.round + ' · ' + mmss(u.t) + ' — остались: ' + u.names.join(', '); }) }));
    }
    if (st.fullRounds >= 5 && st.nadesBoughtFull / st.fullRounds < 1.4) {
      items.push(P('no_util_buy', 30 + (1.4 - st.nadesBoughtFull / st.fullRounds) * 20, 'Полный закуп без гранат',
        'В раундах с полным закупом вы покупали в среднем ' + r1(st.nadesBoughtFull / st.fullRounds).toString().replace('.', ',') + ' гранаты (нормально — 3–4: дым, флешка, молотов/HE).',
        'Правило Rachel: «осталось 250 — где флешка?». Сначала гранаты, потом второстепенное. Выучите по 2–3 гранаты на каждую позицию вашей карты (10–15 минут на пустом сервере).'));
    }
    if (st.flashes >= 6) {
      var effPct = pct(st.flashEff, st.flashes);
      if (effPct <= 35) items.push(P('flash_eff', 32 + (45 - effPct) * 0.5, 'Флешки пропадают зря',
        'Только ' + st.flashEff + ' из ' + st.flashes + ' ваших флешек (' + effPct + '%) ослепили соперника хотя бы на секунду.',
        'Бросайте флешку под выход напарника и в известный угол, а не «потому что купил». Поп-флешка должна лететь чуть вперёд выходящего, а не взрываться за его спиной (Tried, chopper).'));
      else if (effPct >= 60) items.push(S('flash_eff', 34, 'Полезные флешки', st.flashEff + ' из ' + st.flashes + ' флешек (' + effPct + '%) ослепили соперника' + (st.flashAssists ? ', флеш-ассистов: ' + st.flashAssists : '') + '.'));
    }
    if (st.teamFlashes.length >= 3) {
      items.push(P('team_flash', 32 + st.teamFlashes.length * 3, 'Слепите своих',
        st.teamFlashes.length + ' ' + plural(st.teamFlashes.length, 'раз', 'раза', 'раз') + ' ваши флешки надолго ослепляли напарников (раунды ' + roundsText(st.teamFlashes.map(function (x) { return x.round; })) + ').',
        'Говорите «флешка» перед броском и кидайте так, чтобы она взрывалась перед соперником, а не на линии напарника.'));
    }
    if (R >= 14 && utilPerRound >= 9) items.push(S('util_dmg', 32, 'Урон гранатами', 'HE и молотовы наносят ' + r1(utilPerRound) + ' урона за раунд — panas называет это «бесконтактный урон каждый раунд».'));

    /* 13. Экономика */
    var soloBuys = st.desync.filter(function (x) { return x.kind === 'solo_buy'; }), soloSaves = st.desync.filter(function (x) { return x.kind === 'solo_save'; });
    if (st.desync.length >= 2) {
      items.push(P('desync', 28 + st.desync.length * 5, 'Закуп не совпадает с командой',
        (soloBuys.length ? 'В ' + soloBuys.length + ' ' + plural(soloBuys.length, 'раунде', 'раундах', 'раундах') + ' вы закупились полностью, когда команда экономила (раунды ' + roundsText(soloBuys.map(function (x) { return x.round; })) + '). ' : '') +
        (soloSaves.length ? 'В ' + soloSaves.length + ' ' + plural(soloSaves.length, 'раунде', 'раундах', 'раундах') + ' вы экономили при деньгах, когда команда покупала (раунды ' + roundsText(soloSaves.map(function (x) { return x.round; })) + ').' : ''),
        'Закуп — командное решение: один полностью закупленный против пятерых на пистолетах проигрывает, а команда без одного ствола теряет раунд. Смотрите на деньги команды в начале раунда и договаривайтесь (Alienn: эко — все вместе, форс — все вместе).'));
    }
    if (st.pistolNoBuy.length) {
      items.push(P('pistol_conv', 26, 'Не усилились после выигранной пистолетки',
        'После выигранной пистолетки (раунд ' + st.pistolNoBuy.map(function (x) { return x.round; }).join(', ') + ') вы остались со снаряжением на $' + st.pistolNoBuy[0].eq + ', хотя деньги были.',
        'Второй раунд после победы на пистолетах — «забивающий»: покупайте SMG/броню и гранаты, чтобы добить экономику соперника (Rachel: «почему ты взял деку вместо мака?»).'));
    }
    if (st.overbuy.length >= 3) {
      items.push(P('overbuy', 30 + st.overbuy.length * 3, 'Дорогие раунды без отдачи',
        'В ' + st.overbuy.length + ' ' + plural(st.overbuy.length, 'раунде', 'раундах', 'раундах') + ' вы закупились полностью, но погибли без убийств и почти без урона (раунды ' + roundsText(st.overbuy.map(function (x) { return x.round; })) + ').',
        'Дорогой закуп обязывает играть с командой: берите дуэли только при поддержке и с гранатами.'));
    }

    /* 14. Пассивность в проигранных раундах */
    if (st.rLost >= 6 && st.passiveLost.length >= 5 && st.passiveLost.length / st.rLost >= 0.4) {
      items.push(P('passive_lost', 32 + st.passiveLost.length * 2, 'Нет вклада в проигранных раундах',
        'В ' + st.passiveLost.length + ' из ' + st.rLost + ' проигранных раундов вы не нанесли и 15 урона и ничего не сделали для команды (раунды ' + roundsText(st.passiveLost) + ').',
        'Даже при отходе наносите урон и давайте информацию: пара выстрелов или флешка вовремя превращают проигранный раунд в размен. panas: «стоять испуганным в яме — каждая секунда отнимает шанс на раунд».'));
    }

    /* 15. Слабая сторона, спад, тильт */
    var sT = st.side.T, sC = st.side.CT;
    if (sT.r >= 8 && sC.r >= 8) {
      var aT = sT.dmg / sT.r, aC = sC.dmg / sC.r, hi = Math.max(aT, aC), lo = Math.min(aT, aC);
      if (hi - lo >= 35 && lo / hi <= 0.65) {
        var weak = aT < aC ? 'атаку' : 'защиту', weakS = aT < aC ? sT : sC;
        items.push(P('weak_side', 28 + (hi - lo) * 0.45, 'Провал за ' + weak,
          'Урон за раунд за ' + weak + ' — ' + Math.round(lo) + ', за ' + (aT < aC ? 'защиту' : 'атаку') + ' — ' + Math.round(hi) + ' (' + weakS.k + ' убийств и ' + weakS.d + ' смертей за ' + weakS.r + ' ' + plural(weakS.r, 'раунд', 'раунда', 'раундов') + ').',
          aT < aC ? 'За атаку выходите вторым за entry с флешкой, договаривайтесь о выходе и держите дистанцию размена. donk: «атака — это больше колы и коммуникация, чем индивидуальный скилл».'
                  : 'За защиту играйте от информации: сначала слушайте и подсвечивайте, потом дуэль. Меняйте точки от раунда к раунду.'));
      }
    }
    if (st.half[0].r >= 9 && st.half[1].r >= 7) {
      var h1 = st.half[0].dmg / st.half[0].r, h2 = st.half[1].dmg / st.half[1].r;
      if (h2 / Math.max(1, h1) <= 0.65 && h1 - h2 >= 30) {
        items.push(P('fade', 28 + (h1 - h2) * 0.45, 'Спад во второй половине',
          'Урон за раунд упал с ' + Math.round(h1) + ' в первой половине до ' + Math.round(h2) + ' во второй.',
          'Следите за концентрацией: короткие паузы между раундами, вода, без споров в голосовом. В конце матча играйте проще и надёжнее — берите дуэли с поддержкой.'));
      } else if (h2 / Math.max(1, h1) >= 1.4 && h2 - h1 >= 22) {
        items.push(S('rise', 34, 'Разгоняетесь к концу матча', 'Урон за раунд вырос с ' + Math.round(h1) + ' до ' + Math.round(h2) + ' — вы адаптируетесь по ходу игры.'));
      }
    }
    // тильт: раунды после серии из 2+ проигрышей подряд
    var streak = 0, tiltR = [], normR = [];
    M.rounds.forEach(function (r) {
      var pr = st.perRound[r.n]; if (!pr) return;
      (streak >= 2 ? tiltR : normR).push(pr);
      streak = pr.won ? 0 : streak + 1;
    });
    if (tiltR.length >= 4 && normR.length >= 6) {
      var tw = sum(tiltR, function (p) { return p.wpa; }) / tiltR.length, nw = sum(normR, function (p) { return p.wpa; }) / normR.length;
      var td = sum(tiltR, function (p) { return p.dmg; }) / tiltR.length, nd = sum(normR, function (p) { return p.dmg; }) / normR.length;
      if (tw < nw - 0.12 && td < nd * 0.75) {
        items.push(P('tilt', 34 + (nw - tw) * 60, 'Проседаете после серии поражений',
          'В раундах после двух и более проигрышей подряд ваш урон — ' + Math.round(td) + ' за раунд против ' + Math.round(nd) + ' в остальных, а вклад в шанс раунда падает. Похоже на тильт или торопливость.',
          'После двух проигранных раундов: 10 секунд тишины, простой план на раунд, никаких «геройских» соло-выходов. donk/sh1ro называют «играть без тильта» одним из трёх правил роста эло.'));
      }
    }

    /* ===== Сильные стороны ===== */
    if (wpaPer24 >= 1.2) items.push(S('impact', 44 + wpaPer24 * 4, 'Решающий вклад в раунды', 'Ваши действия добавили команде ≈' + roundsVal(wpa) + ' ' + roundsWord(wpa) + ' по сравнению со средним игроком в тех же ситуациях.'));
    var tradePct = pct(st.tradeKills, K);
    if (K >= 8 && tradePct >= 30) items.push(S('trade_kills', 36, 'Мстите за напарников', st.tradeKills + ' из ' + K + ' ваших убийств — размены. Это признак хорошей игры в паре.'));
    if (st.tradeChances >= 4 && st.missedTrades.length / st.tradeChances <= 0.2) items.push(S('trading', 34, 'Надёжный размен', 'Из ' + st.tradeChances + ' ситуаций, где напарник погибал рядом с вами, вы не дали убийце уйти в ' + (st.tradeChances - st.missedTrades.length) + '.'));
    if (st.clutch.won >= 2) items.push(S('clutch', 34 + st.clutch.won * 2, 'Клатчи', 'Выиграно ' + st.clutch.won + ' из ' + st.clutch.att + ' клатчей (лучший — 1 против ' + st.clutch.best + ').'));
    if (st.multi.k3 + st.multi.k4 + st.multi.k5 >= 2) items.push(S('multi', 32, 'Мультикиллы', 'Раундов с тремя и более убийствами: ' + (st.multi.k3 + st.multi.k4 + st.multi.k5) + '.'));
    if (st.ecoHeroKills >= 2) items.push(S('eco_hero', 36, 'Фраги на эко против полного закупа', st.ecoHeroKills + ' ' + plural(st.ecoHeroKills, 'убийство', 'убийства', 'убийств') + ' с дешёвым оружием по полностью закупленным соперникам — это ломает им экономику.'));
    if (adr >= 85) items.push(S('adr', 38 + (adr - 85) * 0.6, 'Высокий урон', 'Средний урон ' + Math.round(adr) + ' за раунд.'));
    if (kast >= 76) items.push(S('kast', 36, 'Почти всегда полезны', 'Вы убивали, помогали, выживали или были разменяны в ' + kast + '% раундов.'));
    if (!isAwp && K >= 8 && hsPct >= 55) items.push(S('hs', 32, 'Точный прицел', 'Хедшоты — ' + hsPct + '% убийств.'));

    /* ===== Общие метрики (если больше нечего сказать) ===== */
    if (adr < 60) items.push(P('adr', 30 + (65 - adr) * 1.0, 'Низкий урон за раунд', 'Средний урон ' + Math.round(adr) + ' за раунд — ниже нормы (65–75 для среднего уровня).',
      'Наносите урон даже при отходе и разменах: 15 минут DM с винтовкой перед играми, цель — ADR выше 75.'));
    if (!isAwp && K >= 8 && hsPct < 33) items.push(P('hs', 26 + (38 - hsPct), 'Низкий процент хедшотов', 'Хедшоты — ' + hsPct + '% убийств: прицел держится ниже головы.',
      'Crosshair placement: прицел на уровне головы при движении. 10 минут aim_botz (только голова) + DM с одной винтовкой.'));

    /* ===== Заметки ===== */
    var cheapShare = K ? st.cheapKills / K : 0;
    if (K >= 10 && cheapShare >= 0.3) items.push(N('cheap_kills', 'Часть фрагов почти не влияла на раунд',
      st.cheapKills + ' из ' + K + ' убийств случились, когда раунд уже был фактически решён (добивания, «выходные» фраги). donk и sh1ro предупреждают: K/D может выглядеть хорошо, а влияние на результат — нет.'));
    if (isAwp) items.push(N('awp', 'Вы играли с AWP', 'Снайперские убийства — ' + pct(st.awpKills, K) + '% ваших фрагов: процент хедшотов не оценивался. Ценность AWP — открывающие убийства и контроль: открывающих дуэлей выиграно ' + st.openWin + ' из ' + openAtt + '.'));

    /* ===== Оценка ===== */
    var perf = 50 + 230 * (wpa / R) + 0.28 * (adr - 75) + 0.25 * (kast - 70);
    var score = Math.round(clamp(perf, 8, 98));
    var hasMajor = items.some(function (i) { return i.kind === 'problem' && i.severity >= 45; });
    if (!res.win && !res.draw && score >= 66 && !hasMajor) items.push(N('context_loss', 'Поражение при сильной игре', 'Ваш вклад выше среднего, но матч проигран. Ищите причины в командных решениях и закупах — по вашей игре серьёзных провалов нет.'));
    else if (res.win && score < 38) items.push(N('context_win', 'Победа при слабом вкладе', 'Матч выигран, но ваш вклад в раунды ниже среднего — команда вас вытащила.'));

    var r = finish(items, {
      title: 'Разбор тренера · CS2' + (M.map ? ' · ' + M.map : ''),
      score: score,
      foot: 'Разбор по записи матча. Вклад в раунды — оценка того, как каждое ваше убийство и смерть меняли шанс команды выиграть раунд (численность, бомба, закуп). Раунд на ножах и разминка не учитываются; гранаты и закупы оценены по событиям записи.'
    });
    r.role = role;
    r.impact = {
      value: wpa, perRound: wpa / R,
      parts: [
        { label: 'Убийства', value: roundsVal(st.wpaKills), tone: st.wpaKills >= 0 ? 'good' : 'bad' },
        { label: 'Смерти', value: roundsVal(st.wpaDeaths), tone: 'bad' },
        { label: 'Бомба', value: roundsVal(st.wpaObj), tone: st.wpaObj > 0.05 ? 'good' : '' },
        { label: 'Ассисты', value: roundsVal(st.wpaAssist), tone: '' }
      ],
      headline: 'Итог вклада: ' + roundsVal(wpa) + ' ' + roundsWord(wpa),
      note: 'Сколько раундов ваша игра добавила (+) или стоила (−) команде относительно средних шансов в тех же ситуациях.'
    };
    r.verdict = verdict(r, st, res, M, adr, kast, wpa, role);
    r.facts = facts(st, adr, kast, kd, hsPct, isAwp, openAtt, openPct, untradedPct, R, Math.round((1 - M.tradeRate) * 100), wpa);
    r.phases = phases(st);
    r.timeline = timeline(st, M, nameOf);
    r.goals = goals(r, st, R);
    r.summary = r.verdict;
    r.stats = { rounds: R, kills: K, deaths: D, assists: st.assists, adr: Math.round(adr), kast: kast, hs: hsPct, won: res.won, lost: res.lost, name: st.name, wpa: Math.round(wpa * 10) / 10, role: role.id };
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

  function verdict(r, st, res, M, adr, kast, wpa, role) {
    var head = (res.draw ? 'Ничья' : res.win ? 'Победа' : 'Поражение') + (M.map ? ' на ' + M.map : '') + ' ' + res.won + ':' + res.lost + '. Ваша роль по игре — ' + role.name + ' (' + role.text + ').';
    var parts = [head];
    parts.push('Счёт ' + st.kills + '/' + st.deaths + '/' + st.assists + ', ADR ' + Math.round(adr) + ', а реальный вклад в раунды — ' + roundsVal(wpa) + ' (убийства ' + roundsVal(st.wpaKills) + ', смерти ' + roundsVal(st.wpaDeaths) + ').');
    var pr = r.problems.slice(0, 2);
    if (pr.length) {
      var costTxt = pr[0].cost ? ' — это стоило команде ≈' + r1(pr[0].cost).toString().replace('.', ',') + ' ' + roundsWord(pr[0].cost) : '';
      parts.push('Главное, что тянуло вниз: «' + pr[0].title + '»' + costTxt + '.' + (pr[1] ? ' Следом — «' + pr[1].title + '».' : ''));
    } else parts.push('Серьёзных системных ошибок не найдено.');
    if (r.strengths[0]) parts.push('Сильная сторона, на которую стоит опираться, — ' + lower(r.strengths[0].title) + '.');
    return parts.join(' ');
  }

  function facts(st, adr, kast, kd, hsPct, isAwp, openAtt, openPct, untradedPct, R, baseUntraded, wpa) {
    var f = [];
    f.push({ label: 'Вклад в раунды', value: roundsVal(wpa), sub: 'за ' + R + ' ' + plural(R, 'раунд', 'раунда', 'раундов'), tone: wpa >= 0.8 ? 'good' : wpa <= -0.8 ? 'bad' : '' });
    f.push({ label: 'Урон за раунд (ADR)', value: String(Math.round(adr)), sub: adr >= 85 ? 'Высокий' : adr < 60 ? 'Низкий' : 'Нормально', tone: adr >= 85 ? 'good' : adr < 60 ? 'bad' : '' });
    f.push({ label: 'KAST', value: kast + '%', sub: kast >= 76 ? 'Высокий' : kast < 62 ? 'Низкий' : 'Нормально', tone: kast >= 76 ? 'good' : kast < 62 ? 'bad' : '' });
    f.push({ label: 'K/D', value: r1(kd).toFixed(1), sub: st.kills + ' / ' + st.deaths, tone: kd >= 1.2 ? 'good' : kd < 0.8 ? 'bad' : '' });
    if (openAtt >= 3) f.push({ label: 'Открывающие дуэли', value: st.openWin + ' из ' + openAtt, sub: openPct + '%', tone: openPct >= 60 ? 'good' : openPct <= 35 ? 'bad' : '' });
    var ed = st.tradedDeaths + st.untradedDeaths;
    if (ed >= 5) f.push({ label: 'Смерти без размена', value: untradedPct + '%', sub: 'в среднем по матчу ' + baseUntraded + '%', tone: untradedPct <= baseUntraded - 12 ? 'good' : untradedPct >= baseUntraded + 10 ? 'bad' : '' });
    if (st.tradeChances >= 3) f.push({ label: 'Размены напарников', value: (st.tradeChances - st.missedTrades.length) + ' из ' + st.tradeChances, sub: 'когда были рядом', tone: st.missedTrades.length / st.tradeChances <= 0.25 ? 'good' : st.missedTrades.length / st.tradeChances >= 0.5 ? 'bad' : '' });
    if (st.flashes >= 4) f.push({ label: 'Полезные флешки', value: pct(st.flashEff, st.flashes) + '%', sub: st.flashEff + ' из ' + st.flashes, tone: pct(st.flashEff, st.flashes) >= 60 ? 'good' : pct(st.flashEff, st.flashes) <= 35 ? 'bad' : '' });
    f.push({ label: 'Урон гранатами', value: r1(st.utilDmg / R).toFixed(1), sub: 'за раунд', tone: st.utilDmg / R >= 9 ? 'good' : st.utilDmg / R < 3 ? 'bad' : '' });
    if (st.clutch.att) f.push({ label: 'Клатчи', value: st.clutch.won + ' из ' + st.clutch.att, sub: st.clutch.won ? 'лучший 1v' + st.clutch.best : '', tone: st.clutch.won ? 'good' : '' });
    return f;
  }

  var TYPE_RU = { pistol: 'Пистолетки', eco: 'Эко', force: 'Форс / полузакуп', full: 'Полный закуп', antieco: 'Анти-эко' };
  function phases(st) {
    var rows = [];
    ['pistol', 'eco', 'force', 'full', 'antieco'].forEach(function (k) {
      var t = st.byType[k]; if (!t || !t.r) return;
      rows.push([TYPE_RU[k], String(t.r), t.won + ' из ' + t.r, String(Math.round(t.dmg / t.r)), pct(t.kast, t.r) + '%', roundsVal(t.wpa)]);
    });
    if (!rows.length) return null;
    return { title: 'Раунды по типу закупа', cols: ['Тип раунда', 'Раундов', 'Выиграно', 'ADR', 'KAST', 'Вклад'], rows: rows,
      note: 'Анти-эко — у вас полный закуп, у соперника эко. Пистолетки во многом случайны (chopper), поэтому там оценивается в основном стрельба.' };
  }

  function timeline(st, M, nameOf) {
    var ev = [];
    st.moments.forEach(function (m) { ev.push({ round: m.round, imp: m.imp, tone: m.tone, text: m.text, t: 0 }); });
    st.deaths_.forEach(function (d) {
      var why = [];
      if (d.open && !d.traded) why.push('первая смерть раунда без размена');
      else if (d.isolated) why.push('в одиночку, напарники в ≈' + Math.round(d.mateDist) + ' юн.');
      if (d.advThrow) { var m = d.side === 'T' ? d.alive.T : d.alive.CT, t = d.side === 'T' ? d.alive.CT : d.alive.T; why.push('при численном преимуществе ' + m + 'v' + t); }
      if (d.noSave) why.push('без сейва в проигранном раунде (-$' + d.myEq + ')');
      if (d.antiEco) why.push('против эко-закупа');
      if (d.postPlant) why.push('после установки бомбы');
      if (d.blind) why.push('ослеплённым');
      if (d.unused) why.push('с гранатами: ' + d.unused.join(', '));
      var line = 'Смерть' + (d.atk ? ' от ' + nameOf(d.atk) : '') + (d.place ? ' · ' + placeName(d.place) : '') + ' · ' + mmss(d.t) + ' — ' + (why.length ? why.join('; ') : (d.traded ? 'размен был' : 'без размена')) + ' (' + sgn(d.cost) + ')';
      ev.push({ round: d.round, imp: -d.cost * 100 + why.length * 6, tone: d.cost < -0.06 ? 'bad' : '', text: line, t: d.t });
    });
    st.kills_.forEach(function (k) {
      if (k.val < 0.12) return;
      var line = 'Убийство' + (k.place ? ' · ' + placeName(k.place) : '') + ' · ' + mmss(k.t) + (k.open ? ' — открывающее' : k.trade ? ' — размен за напарника' : '') + ' (' + sgn(k.val) + ')';
      ev.push({ round: k.round, imp: k.val * 100, tone: 'good', text: line, t: k.t });
    });
    Object.keys(st.perRound).forEach(function (n) { var pr = st.perRound[n]; if (pr.kills >= 3) ev.push({ round: +n, imp: 24 + pr.kills * 5, tone: 'good', text: pr.kills + ' убийства за раунд.', t: 0 }); });
    ev.sort(function (a, b) { return b.imp - a.imp; });
    var top = ev.slice(0, 12).sort(function (a, b) { return a.round - b.round || a.t - b.t; });
    return top.map(function (e) { return { t: e.t, label: 'Раунд ' + e.round, tone: e.tone, text: e.text }; });
  }

  function goals(r, st, R) {
    var g = [];
    r.problems.slice(0, 3).forEach(function (p) {
      if (p.id === 'isolated') g.push('Смертей в одиночку — не больше 2 за матч (сейчас ' + st.isolated.length + ').');
      else if (p.id === 'missed_trades') g.push('Разменивать напарника, когда вы рядом, — хотя бы в 3 из 4 случаев (сейчас ' + (st.tradeChances - st.missedTrades.length) + ' из ' + st.tradeChances + ').');
      else if (p.id === 'adv_throw') g.push('В большинстве — ни одной смерти без размена: играйте парой и от гранат.');
      else if (p.id === 'opening') g.push('Открывающие смерти без размена — не больше 2 за матч (сейчас ' + st.deaths_.filter(function (d) { return d.open && d.enemy && !d.traded; }).length + ').');
      else if (p.id === 'no_save') g.push('Сохранять оружие в безнадёжных раундах — 0 потерянных винтовок при шансе раунда ниже 10%.');
      else if (p.id === 'anti_eco') g.push('Анти-эко без смертей в ближнем бою против пистолетов.');
      else if (p.id === 'post_plant') g.push('После установки — позиция на бомбу и ожидание дефуза, без пиков первым.');
      else if (p.id === 'early') g.push('Не умирать в первые 25 секунд чаще 2 раз за матч.');
      else if (p.id === 'unused') g.push('Ни одной смерти с неиспользованной гранатой после 30-й секунды раунда.');
      else if (p.id === 'no_util_buy') g.push('В каждом раунде с полным закупом — минимум 3 гранаты.');
      else if (p.id === 'spot' || p.id === 'repeat_killer') g.push('Менять позицию или тайминг после каждой смерти в одной и той же точке.');
      else if (p.id === 'tilt') g.push('После двух проигранных раундов подряд — пауза и простой план, без соло-выходов.');
      else if (p.id === 'desync') g.push('Закупаться синхронно с командой: эко и форс — все вместе.');
      else if (p.drill) g.push(p.title + ': ' + lower(p.drill.split('.')[0]) + '.');
    });
    return uniq(g).slice(0, 3);
  }

  return { buildMatch: buildMatch, listPlayers: listPlayers, analyze: analyze, playerStats: playerStats, playerResult: playerResult, _wpT: wpT };
});
