/* ==========================================================================
   BeKavod — журнал событий.

   Сейчас это только вёрстка: записи берутся отсюда же, входа как такового
   нет. Но лента, фильтры и подгрузка сделаны настоящими, а не нарисованными,
   чтобы поведение можно было проверить до бэкенда и не переписывать потом.

   ЧТО ВИДИТ ГОСТЬ. Время, тип и что произошло. Кадра, оценок, поиска и
   фильтров — нет. Кадр при этом не «спрятан стилями»: в разметке у него
   попросту нет адреса. Когда появится сервер, он не должен отдавать
   ссылки на медиа анонимному запросу — размытие это оформление, а не
   защита, всё пришедшее в браузер достаётся из него за минуту.

   ЧТО ЖДЁТ БЭКЕНД (когда дойдут руки):
       GET  /api/events?from=&to=&kind=&q=&cursor=&limit=10
       POST   /api/events/<id>/vote      { vote: 1 | -1 }
       POST   /api/events/<id>/recheck   переоценка
       DELETE /api/events/<id>           мягкое удаление
       POST   /api/events/<id>/restore   вернуть в течение отсрочки
       POST   /api/session               вход, кука HttpOnly
   Разметка карточки уже под это разложена: id лежит в data-id.
   ========================================================================== */
(function () {
  'use strict';

  var PAGE = 10;                      // сколько записей показываем за раз
  var KEY = 'bekavod.demo.session';   // заглушка входа, до появления сервера

  /* ---------------------------------------------------------------- типы */
  var KINDS = [
    { id: 'exit',  label: 'Уход из дома',  lvl: 'crit' },
    { id: 'fall',  label: 'Падение',       lvl: 'crit' },
    { id: 'night', label: 'Ночной подъём', lvl: 'warn' },
    { id: 'long',  label: 'Долго без движения', lvl: 'warn' },
    { id: 'meal',  label: 'Еда',           lvl: 'ok' },
    { id: 'meds',  label: 'Лекарства',     lvl: 'ok' },
    { id: 'quiet', label: 'Спокойно',      lvl: 'ok' }
  ];
  var LVL = {
    crit: { t: 'Тревога',  c: 'crit' },
    warn: { t: 'Внимание', c: 'warn' },
    ok:   { t: 'Норма',    c: 'ok' }
  };
  var kindById = {};
  KINDS.forEach(function (k) { kindById[k.id] = k; });

  /* ------------------------------------------------------- тестовые данные
     Свой генератор со снапшотом семени: набор всегда один и тот же,
     иначе при каждой перезагрузке лента прыгала бы. */
  var seed = 20260818;
  function rnd() {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  }
  function pick(a) { return a[(rnd() * a.length) | 0]; }

  /* В текстах нет длительностей: их показывает плашка рядом со временем.
     Иначе получалось «Завтрак, двадцать минут» с подписью «33 мин». */
  var SAY = {
    exit: ['Открыл калитку и вышел на улицу',
           'Вышел за ворота и пошёл вдоль забора',
           'Ушёл со двора, калитка осталась открытой'],
    fall: ['Резкое падение у входа в ванную',
           'Упал в ванной, поднялся сам'],
    night: ['Встал с кровати, дошёл до туалета',
            'Второй подъём за ночь, вернулся в кровать',
            'Встал и включил свет на кухне'],
    long: ['Без движения в кресле',
           'Дневной отдых'],
    meal: ['Завтрак на кухне', 'Обед на кухне', 'Ужин на кухне'],
    meds: ['Открыл коробку с лекарствами, утро',
           'Вечерний приём, коробка открыта'],
    quiet: ['Смотрит телевизор в гостиной',
            'Сидит в кресле у окна',
            'Читает у окна']
  };
  /* Сколько минут длится событие: [от, до]. Ноль — событие-момент.
     Падение и открытие коробки с лекарствами происходят мгновенно,
     а «вышел из дома» или «без движения» — это отрезок, и для ухода за
     человеком важен именно он: не «вышел», а «отсутствовал сорок минут». */
  var LASTS = { exit: [6, 70], fall: [0, 0], night: [2, 14], long: [35, 110],
                meal: [12, 35], meds: [0, 0], quiet: [20, 120] };

  var WHERE = { exit: 'двор · калитка', fall: 'ванная', night: 'спальня',
                long: 'гостиная', meal: 'кухня', meds: 'кухня', quiet: 'гостиная' };
  var SRC   = { exit: 'камера двора', fall: 'радар ванной', night: 'радар спальни',
                long: 'камера гостиной', meal: 'камера кухни',
                meds: 'камера кухни', quiet: 'камера гостиной' };

  // Текст тоже подбираем по часу: «завтрак» в шесть вечера выглядит
  // как недоделка, а не как тестовые данные.
  function sayFor(kind, h) {
    if (kind === 'meal') {
      return h < 11 ? 'Завтрак на кухне'
           : h < 16 ? 'Обед на кухне'
                    : 'Ужин на кухне';
    }
    if (kind === 'meds') {
      return h < 12 ? 'Открыл коробку с лекарствами, утро'
                    : 'Вечерний приём, коробка открыта';
    }
    return pick(SAY[kind]);
  }

  // Что вообще может случиться в такой час. Иначе в ленте оказывается
  // «завтрак» в шесть вечера и «ночной подъём» в полдень.
  function kindsForHour(h) {
    // Тревожных типов в списках мало намеренно: в жизни их единицы за
    // неделю, и лента не должна выглядеть сводкой происшествий.
    if (h < 6)  return ['night', 'night', 'night', 'quiet', 'quiet', 'exit', 'fall'];
    if (h < 11) return ['meds', 'meal', 'quiet', 'quiet', 'long', 'quiet'];
    if (h < 16) return ['meal', 'quiet', 'long', 'quiet', 'quiet'];
    if (h < 21) return ['meal', 'meds', 'quiet', 'long', 'quiet'];
    return ['quiet', 'quiet', 'night', 'long', 'exit'];
  }

  function makeEvents(n) {
    seed = 20260818;          // тот же набор при каждом вызове, см. rnd()
    var out = [];
    // Идём назад во времени от «сейчас», по 40…260 минут между записями.
    var t = Date.now() - 14 * 60 * 1000;
    for (var i = 0; i < n; i++) {
      var choices = kindsForHour(new Date(t).getHours());
      // Первую запись берём только из длящихся: иначе состояние
      // «событие ещё идёт» на странице негде увидеть.
      if (i === 0) {
        choices = choices.filter(function (c) { return LASTS[c][1] > 0; });
      }
      var kind = pick(choices);
      var k = kindById[kind];
      var span = LASTS[kind];
      var mins = span[1] ? span[0] + ((rnd() * (span[1] - span[0])) | 0) : 0;
      // Самая свежая запись пусть идёт прямо сейчас — иначе состояние
      // «событие ещё не кончилось» негде увидеть.
      var live = i === 0 && mins > 0;

      out.push({
        id: 'e' + (1000 + n - i),
        ts: t,
        end: live ? null : (mins ? t + mins * 60000 : null),
        mins: mins,
        live: live,
        kind: kind,
        lvl: k.lvl,
        text: sayFor(kind, new Date(t).getHours()),
        media: rnd() < 0.72 ? 'video' : 'photo',
        dur: (8 + ((rnd() * 40) | 0)),
        evidence: [
          'лицо: дед',
          'зона: ' + WHERE[kind],
          SRC[kind],
          'уверенность ' + (0.72 + rnd() * 0.27).toFixed(2)
        ],
        vote: 0,
        recheck: null       // null | 'queued' | 'done'
      });
      t -= (40 + ((rnd() * 220) | 0)) * 60 * 1000;
    }
    return out;
  }
  var EVENTS = [];              // наполняется в boot(), см. конец файла

  /* ------------------------------------------------------------- состояние */
  var state = {
    authed: false,
    q: '', from: '', to: '',
    kinds: {},                 // id -> true
    shown: PAGE
  };
  try { state.authed = localStorage.getItem(KEY) === '1'; } catch (e) {}

  /* ----------------------------------------------------------- обращения */
  var $ = function (s) { return document.querySelector(s); };
  var feed = $('#feed'), counter = $('#counter'), empty = $('#empty');
  var moreBtn = $('#more'), moreN = $('#moreN'), endMsg = $('#end');
  var dlg = $('#auth');

  var fmtDay = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
  var fmtTime = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

  function sameDay(a, b) {
    var x = new Date(a), y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth()
        && x.getDate() === y.getDate();
  }
  /* Человеческая длительность: 8 мин · 1 ч 12 мин */
  function human(min) {
    if (min < 60) return min + ' мин';
    var h = Math.floor(min / 60), m = min % 60;
    return h + ' ч' + (m ? ' ' + m + ' мин' : '');
  }

  /* Время записи. Момент — одна отметка. Отрезок — от и до.
     Незакончившееся событие показываем как «с 20:41 · идёт», а не
     подставляем текущее время в конец: оно ещё не наступило. */
  function whenHTML(e) {
    var a = fmtTime.format(new Date(e.ts));
    if (!e.mins) {
      return '<time class="entry__time" datetime="' + new Date(e.ts).toISOString() + '">' +
             a + '</time>';
    }
    if (e.live) {
      var going = Math.max(1, Math.round((Date.now() - e.ts) / 60000));
      return '<time class="entry__time" datetime="' + new Date(e.ts).toISOString() + '">' +
             'с ' + a + '</time>' +
             '<span class="dur dur--live"><i aria-hidden="true"></i>идёт ' +
             human(going) + '</span>';
    }
    return '<time class="entry__time" datetime="' + new Date(e.ts).toISOString() + '">' +
           a + '</time>' +
           '<span class="entry__dash" aria-hidden="true">–</span>' +
           '<time class="entry__time entry__time--to" datetime="' +
           new Date(e.end).toISOString() + '">' + fmtTime.format(new Date(e.end)) + '</time>' +
           '<span class="dur">' + human(e.mins) + '</span>';
  }

  function dayLabel(ts) {
    var now = new Date(), d = new Date(ts);
    if (sameDay(now, d)) return 'Сегодня';
    if (sameDay(now - 864e5, d)) return 'Вчера';
    return fmtDay.format(d);
  }

  /* ------------------------------------------------------------- фильтрация */
  function match(e) {
    if (state.q) {
      var hay = (e.text + ' ' + kindById[e.kind].label + ' ' +
                 (e.mins ? human(e.mins) + ' ' : '') +
                 (e.live ? 'идёт сейчас ' : '') +
                 e.evidence.join(' ')).toLowerCase();
      if (hay.indexOf(state.q.toLowerCase()) === -1) return false;
    }
    // Отрезок попадает в диапазон, если ПЕРЕСЕКАЕТСЯ с ним, а не если в
    // него уложилось начало: событие может начаться вчера и кончиться
    // сегодня, и по обеим датам его надо находить.
    var a = e.ts, b = e.live ? Date.now() : (e.end || e.ts);
    if (state.from && b < Date.parse(state.from + 'T00:00:00')) return false;
    if (state.to && a > Date.parse(state.to + 'T23:59:59')) return false;
    var on = Object.keys(state.kinds).filter(function (k) { return state.kinds[k]; });
    if (on.length && on.indexOf(e.kind) === -1) return false;
    return true;
  }

  /* ---------------------------------------------------------------- отрисовка */
  function mediaHTML(e) {
    // Гостю адрес кадра не подставляем вовсе — в разметке нечего доставать.
    if (!state.authed) {
      return '<div class="shot shot--locked" aria-hidden="true">' +
             '<span class="shot__grain"></span>' +
             '</div>' +
             '<span class="shot__lock" title="Доступно после входа">' +
             '<svg viewBox="0 0 24 24" aria-hidden="true">' +
             '<path d="M7 10V7a5 5 0 0 1 10 0v3" fill="none" stroke="currentColor" ' +
             'stroke-width="1.8" stroke-linecap="round"/>' +
             '<rect x="4.5" y="10" width="15" height="10.5" rx="2.6" fill="currentColor"/>' +
             '</svg></span>';
    }
    // Владельцу — рамка кадра. Настоящий постер придёт из Frigate.
    return '<div class="shot">' +
           '<span class="shot__grain"></span>' +
           '<span class="shot__cam">' + SRC[e.kind] + '</span>' +
           (e.media === 'video'
             ? '<span class="shot__play" aria-hidden="true">▶</span>' +
               '<span class="shot__dur">0:' + String(e.dur).padStart(2, '0') + '</span>'
             : '<span class="shot__dur">кадр</span>') +
           '</div>';
  }

  /* Кнопка «Переоценить». Это не оценка, а запрос на повторный разбор
     записи моделью, поэтому она стоит отдельно от пальцев и не снимается
     повторным нажатием: задача уже ушла в очередь. */
  function redoHTML(e) {
    var busy = e.recheck === 'queued';
    return '<button class="redo" data-recheck' + (busy ? ' disabled' : '') + '>' +
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M20 12a8 8 0 1 1-2.3-5.6" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round"/>' +
      '<path d="M20 3.5V9h-5.5" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '<span>' + (busy ? 'На переоценке' : 'Переоценить') + '</span></button>';
  }

  function voteHTML(e) {
    if (!state.authed) return '';
    return '<div class="acts">' +
      '<div class="vote" role="group" aria-label="Оценка записи">' +
      '<button class="vote__b" data-vote="1" aria-pressed="' + (e.vote === 1) + '" ' +
        'title="Сработало правильно">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 22V10l5-8 1.4.7c.7.4 1 1.2.8 2L13 10h5.7c1.3 0 2.3 1.2 2 2.5l-1.6 7c-.2 1.4-1.4 2.5-2.9 2.5H7Z"/><rect x="2" y="10" width="3.4" height="12" rx="1.2"/></svg>' +
        '<span>Верно</span></button>' +
      '<button class="vote__b" data-vote="-1" aria-pressed="' + (e.vote === -1) + '" ' +
        'title="Ложная тревога">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 2v12l-5 8-1.4-.7c-.7-.4-1-1.2-.8-2L11 14H5.3C4 14 3 12.8 3.3 11.5l1.6-7C5.1 3.1 6.3 2 7.8 2H17Z"/><rect x="18.6" y="2" width="3.4" height="12" rx="1.2"/></svg>' +
        '<span>Ложно</span></button>' +
      '</div>' + redoHTML(e) +
      '<button class="del" data-del title="Удалить запись">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M4 7h16M10 4h4M9 7v12M15 7v12M6 7l1 13.2A2 2 0 0 0 9 22h6' +
        'a2 2 0 0 0 2-1.8L18 7" fill="none" stroke="currentColor" ' +
        'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '<span>Удалить</span></button>' +
      '</div>' +
      /* Подтверждение прямо в карточке, а не отдельным окном: список
         длинный, и модалка отрывает от места, где ты был. */
      '<div class="confirm" hidden>' +
        '<p class="confirm__t">Удалить запись? Кадр и видео уйдут вместе с ней.</p>' +
        '<span class="confirm__go">' +
          '<button class="btn btn--danger btn--sm" data-del-yes>Удалить</button>' +
          '<button class="btn btn--ghost btn--sm" data-del-no>Отмена</button>' +
        '</span>' +
      '</div>';
  }

  function entryHTML(e, withDay) {
    var k = kindById[e.kind], l = LVL[e.lvl];
    return '<li class="entry' + (e.live ? ' entry--live' : '') +
      '" data-id="' + e.id + '">' +
      (withDay ? '<p class="entry__day">' + dayLabel(e.ts) + '</p>' : '') +
      '<article class="entry__in">' +
        '<div class="entry__media">' + mediaHTML(e) + '</div>' +
        '<div class="entry__body">' +
          '<p class="entry__top">' +
            whenHTML(e) +
            '<span class="lvl lvl--' + l.c + '">' + l.t + '</span>' +
            '<span class="kind">' + k.label + '</span>' +
            (e.recheck === 'queued'
              ? '<span class="tag-redo">на переоценке</span>' : '') +
          '</p>' +
          '<p class="entry__text">' + e.text + '</p>' +
          '<ul class="ev">' + e.evidence.map(function (x) {
              return '<li>' + x + '</li>'; }).join('') + '</ul>' +
          voteHTML(e) +
        '</div>' +
      '</article>' +
    '</li>';
  }

  function render() {
    var list = EVENTS.filter(match);
    var slice = list.slice(0, state.shown);

    var html = '', prevDay = null;
    slice.forEach(function (e) {
      var d = dayLabel(e.ts);
      html += entryHTML(e, d !== prevDay);
      prevDay = d;
    });
    feed.innerHTML = html;

    counter.textContent = list.length
      ? 'Показано ' + slice.length + ' из ' + list.length
      : '';
    empty.hidden = list.length !== 0;

    var left = list.length - slice.length;
    moreBtn.hidden = left <= 0;
    moreN.textContent = left > 0 ? '(' + Math.min(PAGE, left) + ')' : '';
    endMsg.hidden = !(list.length > PAGE && left <= 0);

    paintChrome();
  }

  /* Обвязка страницы — кто вошёл, что ему доступно. Вынесена отдельно,
     потому что нужна и когда ленты нет вовсе: при сбое шапка не должна
     врать, будто человек вышел из системы. */
  function paintChrome() {
    document.documentElement.classList.toggle('authed', state.authed);
    $('#lockbar').hidden = state.authed;
    $('#signin').hidden = state.authed;
    $('#signout').hidden = !state.authed;
    var who = document.querySelector('.who');
    who.hidden = !state.authed;
    if (state.authed) who.querySelector('.who__name').textContent = 'владелец';

    // Поля фильтров гостю не просто прикрыты накладкой, но и выключены:
    // иначе до них можно добраться табом.
    document.querySelectorAll('#filters input, #filters button').forEach(function (el) {
      el.disabled = !state.authed;
    });
  }

  /* ------------------------------------------------------------- фильтры */
  var chipbox = $('#kinds');
  chipbox.innerHTML = KINDS.map(function (k) {
    return '<button class="chip" type="button" data-kind="' + k.id + '" ' +
           'aria-pressed="false">' + k.label + '</button>';
  }).join('');

  chipbox.addEventListener('click', function (e) {
    var b = e.target.closest('.chip');
    if (!b || b.disabled) return;
    var id = b.dataset.kind;
    state.kinds[id] = !state.kinds[id];
    b.setAttribute('aria-pressed', String(!!state.kinds[id]));
    state.shown = PAGE;
    render();
  });

  var t = null;
  $('#q').addEventListener('input', function (e) {
    clearTimeout(t);
    var v = e.target.value;
    t = setTimeout(function () { state.q = v.trim(); state.shown = PAGE; render(); }, 180);
  });
  $('#from').addEventListener('change', function (e) {
    state.from = e.target.value; state.shown = PAGE; render();
  });
  $('#to').addEventListener('change', function (e) {
    state.to = e.target.value; state.shown = PAGE; render();
  });
  $('#reset').addEventListener('click', function () {
    state.q = ''; state.from = ''; state.to = ''; state.kinds = {}; state.shown = PAGE;
    $('#q').value = ''; $('#from').value = ''; $('#to').value = '';
    chipbox.querySelectorAll('.chip').forEach(function (c) {
      c.setAttribute('aria-pressed', 'false');
    });
    render();
  });

  moreBtn.addEventListener('click', function () {
    state.shown += PAGE;
    render();
  });

  /* ================================================== действия над записью

     Здесь другая цена ошибки, чем при загрузке. Если не пришла лента —
     страница пустая, это видно. А если не прошло удаление, а запись с
     экрана исчезла, человек уверен, что дело сделано, и узнает правду
     через сутки. Поэтому:
       · оценку ставим сразу и откатываем при отказе — она дёшева;
       · удаление сначала подтверждает сервер, и только потом экран.
     Ошибку показываем в самой карточке, а не общей плашкой: сломалось
     одно действие, а не вся страница. */

  function mutate(method, path, body) {
    // Бэкенда нет: без ?fail= считаем, что всё прошло.
    if (!API.simulated) return Promise.resolve({ data: { ok: true } });
    return method === 'DELETE' ? API.del(path) : API.post(path, body);
  }

  function entryErr(li, err, what) {
    API.diagnose(err).then(function (d) {
      var old = li.querySelector('.enerr');
      if (old) old.parentNode.removeChild(old);
      var p = document.createElement('p');
      p.className = 'enerr';
      p.setAttribute('role', 'alert');
      p.innerHTML = '<b>' + what + '.</b> ' + d.title +
        '. <a href="../status/">Что случилось</a>';
      li.querySelector('.entry__body').appendChild(p);
    });
  }

  /* ---------------------------------------------------------- оценка записи */
  feed.addEventListener('click', function (e) {
    var b = e.target.closest('[data-vote]');
    if (!b) return;
    var li = b.closest('.entry');
    var ev = EVENTS.filter(function (x) { return x.id === li.dataset.id; })[0];
    if (!ev) return;
    var was = ev.vote;
    var v = Number(b.dataset.vote);
    ev.vote = ev.vote === v ? 0 : v;      // повторное нажатие снимает оценку

    var box = b.closest('.vote');
    function paint() {
      box.querySelectorAll('.vote__b').forEach(function (x) {
        x.setAttribute('aria-pressed', String(Number(x.dataset.vote) === ev.vote));
      });
    }
    paint();

    mutate('POST', '/api/events/' + ev.id + '/vote', { vote: ev.vote })
      .catch(function (err) {
        ev.vote = was;                    // сервер не принял — возвращаем как было
        paint();
        entryErr(li, err, 'Оценка не сохранилась');
      });
  });

  /* ------------------------------------------------- запрос на переоценку
     Сейчас только помечаем запись. На сервере это будет POST, который
     ставит задачу в очередь и возвращает её номер; результат придёт
     позже — опросом статуса или потоком событий. Отменить нельзя:
     задача уже принята. */
  feed.addEventListener('click', function (e) {
    var b = e.target.closest('[data-recheck]');
    if (!b || b.disabled) return;
    var li = b.closest('.entry');
    var ev = EVENTS.filter(function (x) { return x.id === li.dataset.id; })[0];
    if (!ev || ev.recheck === 'queued') return;

    b.disabled = true;
    b.querySelector('span').textContent = 'Отправляем…';

    mutate('POST', '/api/events/' + ev.id + '/recheck').then(function () {
      ev.recheck = 'queued';
      b.querySelector('span').textContent = 'На переоценке';
      var top = li.querySelector('.entry__top');
      if (!top.querySelector('.tag-redo')) {
        var tag = document.createElement('span');
        tag.className = 'tag-redo';
        tag.textContent = 'на переоценке';
        top.appendChild(tag);
      }
    }, function (err) {
      // Задача не принята — кнопку возвращаем, иначе человек уверен,
      // что запись стоит в очереди, а её там нет.
      b.disabled = false;
      b.querySelector('span').textContent = 'Переоценить';
      entryErr(li, err, 'Запрос на переоценку не ушёл');
    });
  });

  /* ------------------------------------------------------------- удаление
     Два шага намеренно: запись уносит с собой кадр и видео, а промах
     пальцем по списку — обычное дело. После удаления десять секунд можно
     вернуть: на сервере это будет мягкое удаление с отметкой времени,
     а не DELETE FROM. */
  var trash = null, trashTimer = null;
  var toast = $('#toast');

  function closeConfirm(li) {
    li.classList.remove('is-confirming');
    var c = li.querySelector('.confirm');
    if (c) c.hidden = true;
  }

  feed.addEventListener('click', function (e) {
    var li = e.target.closest && e.target.closest('.entry');
    if (!li) return;

    if (e.target.closest('[data-del]')) {
      li.classList.add('is-confirming');
      li.querySelector('.confirm').hidden = false;
      li.querySelector('[data-del-yes]').focus();
      return;
    }
    if (e.target.closest('[data-del-no]')) { closeConfirm(li); return; }
    if (!e.target.closest('[data-del-yes]')) return;

    var id = li.dataset.id;
    var idx = -1;
    for (var i = 0; i < EVENTS.length; i++) if (EVENTS[i].id === id) { idx = i; break; }
    if (idx < 0) return;

    var yes = e.target.closest('[data-del-yes]');
    yes.disabled = true;
    yes.textContent = 'Удаляем…';

    /* Убираем с экрана только после подтверждения сервера. Обратный
       порядок выглядит быстрее, но врёт: запись вернётся при обновлении
       страницы, и человек уже не вспомнит, что удалял её. */
    mutate('DELETE', '/api/events/' + id).then(function () {
      trash = { at: idx, item: EVENTS[idx] };
      EVENTS.splice(idx, 1);
      render();
      showToast();
    }, function (err) {
      yes.disabled = false;
      yes.textContent = 'Удалить';
      entryErr(li, err, 'Удалить не получилось');
    });
  });

  function showToast() {
    // Полоса могла остаться после неудачной попытки вернуть — сбрасываем.
    toast.querySelector('.toast__t').textContent = 'Запись удалена';
    var u = $('#undo');
    u.disabled = false;
    u.textContent = 'Вернуть';
    toast.hidden = false;
    toast.classList.remove('is-out');
    void toast.offsetWidth;              // перезапустить полоску времени
    toast.classList.add('is-out');
    clearTimeout(trashTimer);
    trashTimer = setTimeout(hideToast, 10000);
  }
  function hideToast() {
    toast.hidden = true;
    toast.classList.remove('is-out');
    trash = null;                        // вернуть уже нельзя
  }
  $('#undo').addEventListener('click', function () {
    if (!trash) return;
    var back = trash;
    var btn = $('#undo');
    btn.disabled = true;
    btn.textContent = 'Возвращаем…';

    mutate('POST', '/api/events/' + back.item.id + '/restore').then(function () {
      EVENTS.splice(back.at, 0, back.item);
      clearTimeout(trashTimer);
      hideToast();
      btn.disabled = false;
      btn.textContent = 'Вернуть';
      render();
    }, function () {
      /* Отсрочка на сервере могла уже истечь, или связь оборвалась.
         Молчать нельзя: человек нажал «вернуть» и уверен, что вернул. */
      btn.disabled = false;
      btn.textContent = 'Ещё раз';
      toast.querySelector('.toast__t').textContent = 'Вернуть не вышло — нет связи';
      clearTimeout(trashTimer);
      trashTimer = setTimeout(hideToast, 10000);
    });
  });

  // Esc закрывает подтверждение, если оно открыто
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var open = feed.querySelector('.entry.is-confirming');
    if (open) { closeConfirm(open); e.stopPropagation(); }
  });

  /* ------------------------------------------------------------------ вход */
  function openAuth() {
    $('#authErr').hidden = true;
    dlg.showModal();
    setTimeout(function () { $('#login').focus(); }, 30);
  }
  $('#signin').addEventListener('click', openAuth);
  $('#signin2').addEventListener('click', openAuth);
  $('#authCancel').addEventListener('click', function () { dlg.close('cancel'); });

  $('#authForm').addEventListener('submit', function (e) {
    // method="dialog" закрывает окно сам, нам нужно только принять решение
    if (!$('#login').value.trim() || !$('#pass').value) {
      e.preventDefault();
      var err = $('#authErr');
      err.textContent = 'Заполните оба поля.';
      err.hidden = false;
      return;
    }
    state.authed = true;
    try { localStorage.setItem(KEY, '1'); } catch (x) {}
    state.shown = PAGE;
    setTimeout(render, 0);
  });

  $('#signout').addEventListener('click', function () {
    state.authed = false;
    try { localStorage.removeItem(KEY); } catch (x) {}
    state.shown = PAGE;
    render();
  });

  /* ==================================================== загрузка ленты

     Что показывать, когда данных нет — вопрос не менее важный, чем как
     показывать данные. Пустая лента без объяснения читается как «за
     сутки ничего не случилось», а это ровно противоположная новость по
     сравнению с «мы не смогли ничего получить». Поэтому при отказе лента
     не пустеет, а заменяется карточкой с причиной.

     Разбор причины живёт в js/api.js — здесь только показ. */
  var faultBox = $('#fault');

  function showFault(err) {
    return API.diagnose(err).then(function (d) {
      feed.innerHTML = '';
      counter.textContent = '';
      empty.hidden = true;
      moreBtn.hidden = true;
      endMsg.hidden = true;
      $('#filters').hidden = true;      // фильтровать нечего
      paintChrome();
      Fault.mount(faultBox, d, {
        statusHref: '../status/',
        onRetry: boot,
        onSignin: openAuth
      });
      faultBox.scrollIntoView({ block: 'nearest' });
    });
  }

  /* Ответ дошёл, но еле-еле. Это не поломка, а предупреждение: так
     выглядит связь с домом за минуту до того, как она отвалится. */
  function slowNote(ms) {
    var n = document.createElement('div');
    n.className = 'wire-note';
    n.innerHTML = '<b>Связь с домом медленная.</b> Ответ шёл ' +
      (ms / 1000).toFixed(1) + ' с. Записи на месте, но видео может ' +
      'подтормаживать. <a href="../status/">Проверить цепочку</a>';
    feed.parentNode.insertBefore(n, feed);
  }

  function boot() {
    faultBox.hidden = true;
    faultBox.innerHTML = '';
    $('#filters').hidden = false;
    var old = document.querySelector('.wire-note');
    if (old) old.parentNode.removeChild(old);

    /* Бэкенда пока нет. Без ?fail= и ?api= просто рисуем тестовые записи —
       так страница остаётся показываемой. С параметром идём настоящим
       путём: через сетевой слой, с настоящим разбором отказа. */
    if (!API.simulated) { EVENTS = makeEvents(34); render(); return; }

    /* Пустой экран на десять секунд — сам по себе плохая новость: человек
       успевает решить, что сломано всё. Поэтому сначала говорим, что
       ждём, а через четыре секунды — что ждём слишком долго. */
    var wait = document.createElement('p');
    wait.className = 'jrn__wait';
    wait.textContent = 'Загружаем журнал…';
    feed.parentNode.insertBefore(wait, feed);
    var slowTimer = setTimeout(function () {
      wait.textContent = 'Дом отвечает дольше обычного. Ещё ждём…';
      wait.classList.add('is-long');
    }, 4000);
    function stop() {
      clearTimeout(slowTimer);
      if (wait.parentNode) wait.parentNode.removeChild(wait);
    }

    API.getShaped('/api/events?limit=' + PAGE, ['items'])
      .then(function (r) {
        stop();
        // Сервера нет, брать нечего: успешные сценарии показываем на тех
        // же тестовых записях. Проверяется здесь путь, а не данные.
        EVENTS = makeEvents(34);
        render();
        if (r.ms > 2500) slowNote(r.ms);
      })
      .catch(function (err) { stop(); return showFault(err); });
  }

  boot();

  /* Связь вернулась сама — не заставляем нажимать кнопку. */
  window.addEventListener('online', function () {
    if (!faultBox.hidden) setTimeout(boot, 500);
  });

  /* У незакончившегося события счётчик должен идти сам, а не только при
     перерисовке. Обновляем раз в минуту и только его — трогать всю ленту
     ради одной строки незачем. */
  setInterval(function () {
    document.querySelectorAll('.entry--live .dur--live').forEach(function (el) {
      var li = el.closest('.entry');
      var ev = EVENTS.filter(function (x) { return x.id === li.dataset.id; })[0];
      if (!ev || !ev.live) return;
      var m = Math.max(1, Math.round((Date.now() - ev.ts) / 60000));
      el.lastChild.textContent = 'идёт ' + human(m);
    });
  }, 60000);
})();
