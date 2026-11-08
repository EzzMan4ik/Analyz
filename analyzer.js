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
      problems: problems.slice(0, 4),
      strengths: strengths.slice(0, 3),
      notes: notes.slice(0, 3),
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
      imp: isNum(extra.imp) ? num(extra.imp) : null,
      stratz: !!extra.stratz,
      items: items,
      parsed: lhT.length > 0 || Array.isArray(p.gold_t) || isNum(p.actions_per_min)
    };
  }

  // «оценка 0..1» метрики: процентиль OpenDota, а если его нет — отношение к про-ориентиру
  function metricScore(pctVal, ratio) {
    if (pctVal != null) return pctVal;
    if (ratio != null) return clamp((ratio - 0.4) / 0.8, 0, 1);
    return null;
  }
  function pctText(p) { return Math.round(p * 100); }

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
        ? 'ниже, чем у ' + (100 - pctText(m.pct.gpm)) + '% игроков на этом герое'
        : 'про-ориентир для роли — около ' + pro.gpm;
      var srcHigh = m.pct.gpm != null
        ? 'выше, чем у ' + pctText(m.pct.gpm) + '% игроков на этом герое'
        : 'про-ориентир для роли — около ' + pro.gpm;
      if (sc.gpm < 0.4) {
        items.push(P('farm_gpm', (0.5 - sc.gpm) * 100 + 25,
          'Слабая экономика',
          'GPM ' + m.gpm + ' — ' + srcLow + '. Для ' + posName.toLowerCase() + ' этого мало: предметы выходят поздно, и команде не хватает вашей силы в драках.',
          'Фарм: в демо-режиме 10 минут на героя без соперника, цель — 60+ добитых крипов (керри) или 50+ (мид). Затем в игре между волнами забирайте ближайший лес и стакайте лагерь на :53.'));
      } else if (sc.gpm >= 0.75) {
        items.push(S('farm_gpm', sc.gpm * 100 - 40,
          'Сильная экономика', 'GPM ' + m.gpm + ' — ' + srcHigh + '.'));
      }
    }
    /* --- ЛАЙНИНГ (ластхиты на 10-й минуте) --- */
    if (core && m.lh10 != null && m.durMin >= 12) {
      var r10 = m.lh10 / pro.lh10;
      if (r10 < 0.6) {
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
    /* --- СМЕРТИ --- */
    var dLimit = sup ? 4.5 : 3.5;
    if (dp10 >= dLimit && m.d >= 5) {
      var dp = Math.round(dp10 * 10) / 10;
      items.push(P('deaths', 30 + (dp10 - dLimit) * 18 + (m.won ? 0 : 10),
        'Слишком много смертей',
        m.d + ' ' + plural(m.d, 'смерть', 'смерти', 'смертей') + ' за ' + Math.round(m.durMin) + ' мин (' + dp + ' на 10 минут). Каждая смерть на кор-позиции — это пауза в фарме и потеря темпа.',
        'Перед каждой вылазкой задавайте себе вопрос: «Где вражеские герои на миникарте?» Если не видите 2+ героев — не заходите за реку и не идите в лес в одиночку. После первого же смертельного пика меняйте поведение.'));
    } else if (dp10 <= 1.4 && m.durMin >= 15) {
      items.push(S('deaths', 40, 'Хорошая выживаемость', m.d + ' ' + plural(m.d, 'смерть', 'смерти', 'смертей') + ' за ' + Math.round(m.durMin) + ' мин — вы редко отдаёте врагу золото.'));
    }
    /* --- УЧАСТИЕ В ДРАКАХ --- */
    if (m.kp != null && m.teamKills >= 15) {
      var kpLow = sup ? 45 : 35;
      if (m.kp < kpLow) {
        items.push(P('kp', (kpLow - m.kp) * 1.4 + 25, 'Мало участия в драках',
          'Участие в убийствах команды — ' + Math.round(m.kp) + '%. Вас не хватает в моменты, когда команда дерётся.',
          sup ? 'Саппорт: держите ротацию к тиммейтам после установки варда; ждите кор-героя у линии боя.'
              : 'Следите за миникартой каждые 5 секунд; когда команда собирается на объект, телепортируйтесь/идите к ней раньше фарма.'));
      } else if (m.kp >= 70) {
        items.push(S('kp', 38, 'Присутствие в драках', 'Участие в ' + Math.round(m.kp) + '% убийств команды — вы там, где решается игра.'));
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
    /* --- КОНТЕКСТ РЕЗУЛЬТАТА --- */
    var parts = [];
    ['gpm', 'xpm', 'hd', 'kills'].forEach(function (k) { if (sc[k] != null) parts.push(sc[k]); });
    parts.push(survScore);
    if (m.kp != null) parts.push(clamp(m.kp / 70, 0, 1));
    if (sup && m.obs != null && m.sen != null) parts.push(clamp(((m.obs + m.sen) / m.durMin) / 0.55, 0, 1));
    if (core) { /* у кор-героев фарм важнее — учитываем GPM дважды */ if (sc.gpm != null) parts.push(sc.gpm); }
    var perf = parts.reduce(function (a, b) { return a + b; }, 0) / parts.length;
    var score = Math.round(clamp(perf, 0, 1) * 100);

    /* --- ОБЩИЙ ВКЛАД В МАТЧ (собственный индекс на данных OpenDota) --- */
    if (parts.length >= 3) {
      if (score <= 22) items.push(P('impact', 55 - score, 'Низкий общий вклад в матч',
        'По сумме фарма, урона, опыта и участия в боях ваш вклад в этот матч ниже среднего (' + score + ' из 100).',
        'Посмотрите повтор целиком: на какой минуте вы перестали успевать за игрой — фарм, драки или карта?'));
      else if (score >= 82) items.push(S('impact', score - 40, 'Высокий общий вклад в матч',
        'По сумме фарма, урона, опыта и участия в боях вы были одним из сильнейших игроков матча (' + score + ' из 100).'));
    }

    if (!m.won && score >= 68) {
      items.push(N('context_loss', 'Поражение при сильных показателях',
        'Ваши цифры выше среднего, но матч проигран. По статистике упрекнуть себя не в чем — ищите причины в драфте, выборе моментов для драки и решениях команды.'));
    } else if (m.won && score < 40) {
      items.push(N('context_win', 'Победа при слабых показателях',
        'Матч выигран, но ваш личный вклад ниже среднего — команда вас вытащила. На следующей игре такого везения может не быть.'));
    }

    var res = finish(items, {
      title: 'Разбор тренера · ' + m.hero + ' · ' + posName,
      score: score,
      foot: m.parsed ? '' : 'Матч не распарсен OpenDota — часть правил (лайнинг, предметы, фарм по минутам) недоступна. Запросите парсинг на opendota.com и повторите анализ.'
    });
    res.summary = dotaSummary(res, m);
    return res;
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
  function renderReport(r) {
    if (!r) return '';
    var h = '<div class="result-block"><div class="result-block-title"><svg class="ico"><use href="#i-spark"/></svg> ' + esc(r.title) + '</div>';
    if (r.score) {
      var cls = r.score.value >= 60 ? 'good' : (r.score.value < 40 ? 'bad' : '');
      h += '<div class="metrics-grid"><div class="metric-card"><div class="metric-label">Оценка матча</div><div class="metric-value">' + r.score.value + '<span style="font-size:0.9rem;color:#888;"> / 100</span></div><div class="metric-sub ' + cls + '">' + esc(r.score.label) + '</div></div></div>';
    }
    if (r.summary) h += '<div class="analysis-text">' + esc(r.summary) + '</div>';
    if (r.main) {
      h += '<div class="problem-block" style="margin-top:16px;"><div class="problem-title">Главная проблема: ' + esc(r.main.title) + '</div><div class="problem-text">' + esc(r.main.text) + '</div>' +
        (r.main.drill ? '<div class="rec-exercise" style="margin-top:12px;"><strong>Упражнение:</strong> ' + esc(r.main.drill) + '</div>' : '') + '</div>';
    }
    if (r.problems.length > 1 || (r.problems.length === 1 && !r.main)) {
      h += '<div class="analysis-section"><div class="analysis-section-title"><svg class="ico"><use href="#i-warn"/></svg> Что исправить</div>';
      r.problems.forEach(function (p, i) {
        if (i === 0 && r.main) return;
        h += '<div class="analysis-item negative"><strong>' + esc(p.title) + '</strong> — ' + esc(p.text) +
          (p.drill ? '<div class="rec-exercise"><strong>Упражнение:</strong> ' + esc(p.drill) + '</div>' : '') + '</div>';
      });
      h += '</div>';
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
    if (r.plan.length) {
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
