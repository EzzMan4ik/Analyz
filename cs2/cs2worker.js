/* Фоновый обработчик демо-записи CS 2: распаковка + разбор в WebAssembly.
 * Файл не покидает компьютер игрока. Страница в это время не зависает. */
'use strict';
importScripts('fzstd.js', 'demoparser2.js');

function conv(v) {
  if (v instanceof Map) { var o = {}; v.forEach(function (x, k) { o[k] = conv(x); }); return o; }
  if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) v[i] = conv(v[i]); return v; }
  return v;
}
function say(p, text) { postMessage({ type: 'progress', p: p, text: text }); }

async function gunzip(u8) {
  var ds = new DecompressionStream('gzip');
  var stream = new Blob([u8]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

onmessage = async function (e) {
  try {
    var u8 = new Uint8Array(e.data.buffer);
    var tag = String.fromCharCode.apply(null, u8.subarray(0, 8));
    var data = u8;
    if (u8[0] === 0x28 && u8[1] === 0xB5 && u8[2] === 0x2F && u8[3] === 0xFD) {
      say(5, 'Распаковка файла (zstd)…');
      data = fzstd.decompress(u8);
    } else if (u8[0] === 0x1F && u8[1] === 0x8B) {
      say(5, 'Распаковка файла (gzip)…');
      data = await gunzip(u8);
    } else if (u8[0] === 0x42 && u8[1] === 0x5A && u8[2] === 0x68) {
      throw new Error('BZ2');
    }
    u8 = null;
    tag = String.fromCharCode.apply(null, data.subarray(0, 7));
    if (tag !== 'PBDEMS2') throw new Error('NOT_DEMO');

    say(15, 'Запуск разборщика…');
    await wasm_bindgen('demoparser2_bg.wasm');
    var wb = wasm_bindgen;

    say(25, 'Читаю заголовок матча…');
    var header = conv(wb.parseHeader(data));

    say(35, 'Разбираю убийства, гранаты и закупы… (до 10 секунд)');
    var names = ['player_death', 'round_end', 'round_freeze_end', 'player_hurt', 'player_blind', 'item_purchase',
      'flashbang_detonate', 'hegrenade_detonate', 'smokegrenade_detonate', 'inferno_startburn', 'bomb_planted', 'bomb_defused'];
    var events;
    // last_place_name — название зоны карты («Connector», «BombsiteA»): нужно для разбора «где вы умираете»
    try { events = conv(wb.parseEvents(data, names, ['X', 'Y', 'team_num', 'last_place_name'], [])); }
    catch (e1) { events = conv(wb.parseEvents(data, names, ['X', 'Y', 'team_num'], [])); }

    say(70, 'Считаю позиции игроков и закупы…');
    var tickSet = {};
    events.forEach(function (ev) { if (ev.event_name === 'round_freeze_end' || ev.event_name === 'player_death') tickSet[ev.tick] = 1; });
    var ticks = Object.keys(tickSet).map(Number).sort(function (a, b) { return a - b; });
    var snaps = conv(wb.parseTicks(data, ['X', 'Y', 'is_alive', 'team_num', 'current_equip_value', 'balance', 'name'], new Int32Array(ticks)));

    postMessage({ type: 'done', raw: { header: header, events: events, snaps: snaps } });
  } catch (err) {
    var m = String((err && err.message) || err);
    postMessage({ type: 'error', code: /^(BZ2|NOT_DEMO)$/.test(m) ? m : 'FAIL', message: m });
  }
};
