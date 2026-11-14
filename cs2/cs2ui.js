/* Вкладка «Разбор демки» CS 2: загрузка файла, разбор в браузере, выбор игрока, отчёт. */
(function () {
  'use strict';
  var worker = null, M = null, busy = false, fileLabel = '', counted = false;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function getNick() { try { return localStorage.getItem('ga_cs_nick') || ''; } catch (e) { return ''; } }
  function setNick(n) { try { localStorage.setItem('ga_cs_nick', n); } catch (e) {} }

  function prog(p, text) {
    var w = $('demoProgress'); if (!w) return;
    w.classList.add('visible');
    $('demoProgressFill').style.width = Math.max(0, Math.min(100, p)) + '%';
    $('demoProgressText').textContent = text || '';
  }
  function hideProg() { var w = $('demoProgress'); if (w) w.classList.remove('visible'); }
  function showMsg(title, text) {
    var r = $('demoResults');
    r.innerHTML = '<div class="result-block"><div class="problem-title">' + esc(title) + '</div><div class="problem-text">' + esc(text) + '</div></div>';
    r.classList.add('visible');
  }
  function stopWorker() { if (worker) { try { worker.terminate(); } catch (e) {} worker = null; } }

  function playerOptions(players, selId) {
    var h = '', teams = { A: 'Команда A', B: 'Команда B', '?': 'Игроки' };
    ['A', 'B', '?'].forEach(function (t) {
      var list = players.filter(function (p) { return p.team === t; });
      if (!list.length) return;
      h += '<optgroup label="' + teams[t] + '">';
      list.forEach(function (p) {
        h += '<option value="' + esc(p.id) + '"' + (p.id === selId ? ' selected' : '') + '>' + esc(p.name + ' — ' + p.k + '/' + p.d + '/' + p.a) + '</option>';
      });
      h += '</optgroup>';
    });
    return h;
  }

  function renderPlayer(id) {
    var res = $('demoResults');
    var players = CS2Demo.listPlayers(M);
    var nameOf = function (pid) { return (M.players[pid] || {}).name || 'соперник'; };
    var report = CS2Demo.analyze(M, id, nameOf);
    var picker = '<div class="player-select" style="margin-bottom:16px;"><label for="demoPlayer" style="display:block;margin-bottom:8px;color:#aaa;font-size:0.9rem;">Игрок для разбора (выберите себя):</label>' +
      '<select class="player-select-dropdown" id="demoPlayer" aria-label="Игрок для разбора">' + playerOptions(players, id) + '</select></div>';
    res.innerHTML = picker + GA.renderReport(report);
    res.classList.add('visible');
    $('demoPlayer').addEventListener('change', function () { setNick((M.players[this.value] || {}).name || ''); renderPlayer(this.value); });
    return report;
  }

  function pickDefault(players) {
    var nick = getNick().toLowerCase();
    if (nick) { var f = players.filter(function (p) { return (p.name || '').toLowerCase() === nick; })[0]; if (f) return f.id; }
    return players.slice().sort(function (a, b) { return b.k - a.k; })[0].id;
  }

  async function onParsed(raw) {
    hideProg();
    try {
      M = CS2Demo.buildMatch(raw);
      var players = CS2Demo.listPlayers(M);
      if (!players.length || M.rounds.length < 8) { showMsg('Мало данных', 'В записи слишком мало раундов для разбора. Загрузите полную запись матча.'); return; }
      var id = pickDefault(players);
      var report = renderPlayer(id);
      $('demoResults').scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (!counted) {
        counted = true;
        try {
          await incrementUsage('cs');
          var s = report.stats || {};
          await saveAnalysis('cs2', (fileLabel || 'demo').slice(0, 60), (s.name || 'игрок') + ' K/D:' + (s.kills || 0) + '/' + (s.deaths || 0) + ' ADR:' + (s.adr || 0), s.deaths ? (s.kills / s.deaths) : (s.kills || 0), s.adr || 0, 0, 0);
          await showLimitWarning('demoLimitWarning', 'cs');
        } catch (e) { console.warn('demo save', e && e.message); }
      }
    } catch (err) {
      console.error(err);
      showMsg('Не удалось построить разбор', 'Запись прочиталась, но структура данных необычная. Попробуйте другой матч или напишите нам.');
    }
  }

  async function handleFile(file) {
    if (busy || !file) return;
    var u = getCurrentUser(); if (!u) return;
    var ok = await checkLimit('cs');
    if (!ok) { await showLimitWarning('demoLimitWarning', 'cs'); return; }
    if (file.size > 900 * 1024 * 1024) { showMsg('Файл слишком большой', 'Максимум 900 МБ. Загрузите сжатую запись FACEIT (.dem.zst) или обычный .dem.'); return; }
    busy = true; counted = false; M = null; fileLabel = file.name;
    $('demoResults').classList.remove('visible'); $('demoResults').innerHTML = '';
    prog(2, 'Читаю файл…');
    var buf;
    try { buf = await file.arrayBuffer(); }
    catch (e) { busy = false; hideProg(); showMsg('Не хватило памяти', 'Не удалось прочитать файл. Закройте лишние вкладки и попробуйте ещё раз.'); return; }
    stopWorker();
    try { worker = new Worker('cs2/cs2worker.js?v=20261116'); }
    catch (e) { busy = false; hideProg(); showMsg('Браузер не поддерживается', 'Для разбора нужен современный браузер (Chrome, Edge, Firefox).'); return; }
    worker.onmessage = function (ev) {
      var m = ev.data;
      if (m.type === 'progress') { prog(m.p, m.text); return; }
      busy = false; stopWorker();
      if (m.type === 'done') { onParsed(m.raw); return; }
      hideProg();
      if (m.code === 'BZ2') showMsg('Это архив .bz2', 'Записи матчмейкинга и Premier приходят в архиве .bz2. Распакуйте его программой 7-Zip (получится файл .dem) и загрузите снова. Прямая поддержка .bz2 появится позже.');
      else if (m.code === 'NOT_DEMO') showMsg('Это не запись матча CS 2', 'Файл не похож на демо-запись CS 2. Нужен .dem, .dem.zst или .dem.gz (кнопка «Скачать демо» на странице матча FACEIT).');
      else showMsg('Не удалось разобрать запись', 'Возможно, не хватило памяти или запись повреждена. Закройте лишние вкладки и попробуйте ещё раз. Подробность: ' + m.message);
    };
    worker.onerror = function () { busy = false; stopWorker(); hideProg(); showMsg('Ошибка разбора', 'Разборщик остановился. Попробуйте обновить страницу и повторить.'); };
    worker.postMessage({ buffer: buf }, [buf]);
  }

  function init() {
    var inp = $('demoFile'), drop = $('demoDrop');
    if (!inp || !drop) return;
    inp.addEventListener('change', function () { var f = inp.files && inp.files[0]; if (f) handleFile(f); inp.value = ''; });
    ['dragenter', 'dragover'].forEach(function (n) { drop.addEventListener(n, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (n) { drop.addEventListener(n, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) handleFile(f); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
