/* ==========================================================================
   BeKavod — журнал событий. Работает против настоящего сервера.

   Адрес сервера задаётся в <head>:
       <meta name="api-base" content="https://api.engineeragainstdementia.net">
   Для проверки против другого сервера адрес можно подменить прямо в
   ссылке:  /journal/?api=<адрес>

   ЧТО ЗДЕСЬ ВАЖНО ПОНИМАТЬ.

   1) Гость и владелец разделены НА СЕРВЕРЕ, а не в разметке. Гостю в
      ответе просто нет полей media, evidence, vote — доставать из браузера
      нечего. Размытие кадра осталось оформлением пустой рамки.

   2) Фильтры и поиск ушли на сервер. В базе могут быть тысячи эпизодов,
      тянуть их целиком ради поиска по слову — плохой план, а на телефоне
      через туннель ещё и медленный.

   3) Листание курсорное, а не по номеру страницы. Пока человек читает,
      сверху добавляются новые записи; со смещением он на второй странице
      увидел бы то же, что на первой.

   4) Удаление и голос сначала подтверждает сервер и только потом экран.
      Обратный порядок выглядит быстрее, но врёт.

   Разбор поломок — в js/api.js, показ — в js/fault.js.
   ========================================================================== */
(function () {
  'use strict';

  var PAGE = 10;

  /* Запасной список типов — на случай, если /api/kinds не ответит.
     Совпадает с KINDS на сервере. */
  var KINDS = [
    { id: 'exit',     label: 'Уход из дома', level: 'crit' },
    { id: 'fall',     label: 'Падение',      level: 'crit' },
    { id: 'unsteady', label: 'Шаткая походка', level: 'warn' },
    { id: 'night',    label: 'Ночная активность', level: 'warn' },
    { id: 'long',     label: 'Долгое отсутствие/неподвижность', level: 'warn' },
    { id: 'toilet',   label: 'Туалет',       level: 'ok' },
    { id: 'sleep',    label: 'Сон',          level: 'ok' },
    { id: 'meal',     label: 'Приём пищи',   level: 'ok' },
    { id: 'meds',     label: 'Лекарства',    level: 'ok' },
    { id: 'quiet',    label: 'Спокойно',     level: 'ok' }
  ];
  var LVL = {
    crit: { t: 'Тревога',  c: 'crit' },
    warn: { t: 'Внимание', c: 'warn' },
    ok:   { t: 'Норма',    c: 'ok' }
  };
  var kindById = {};
  function indexKinds() {
    kindById = {};
    KINDS.forEach(function (k) { kindById[k.id] = k; });
  }
  indexKinds();

  /* Улики приходят парами {k, v}, где k — уже готовая русская подпись
     («маршрут», «камера», «опознан»). Раньше здесь стоял словарь перевода
     с английских ключей — он не совпадал с сервером, и подписи пропадали,
     а список рисовался голыми значениями. */

  /* ------------------------------------------------------------- состояние */
  var state = {
    authed: false,
    user: null,
    q: '', from: '', to: '',
    kinds: {},                 // id -> true
    cursor: null,              // курсор следующей порции
    total: 0,
    items: [],
    loading: false
  };

  /* ----------------------------------------------------------- обращения */
  var $ = function (s) { return document.querySelector(s); };
  var feed = $('#feed'), counter = $('#counter'), empty = $('#empty');
  var moreBtn = $('#more'), moreN = $('#moreN'), endMsg = $('#end');
  var dlg = $('#auth'), faultBox = $('#fault');

  var fmtDay = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
  var fmtTime = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function ms(iso) { return iso ? Date.parse(iso) : null; }

  function sameDay(a, b) {
    var x = new Date(a), y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth()
        && x.getDate() === y.getDate();
  }
  function human(min) {
    if (min < 1) return 'меньше минуты';
    if (min < 60) return min + ' мин';
    var h = Math.floor(min / 60), m = min % 60;
    return h + ' ч' + (m ? ' ' + m + ' мин' : '');
  }
  function dayLabel(t) {
    var now = new Date(), d = new Date(t);
    if (sameDay(now, d)) return 'Сегодня';
    if (sameDay(now - 864e5, d)) return 'Вчера';
    return fmtDay.format(d);
  }

  /* Время записи. Момент — одна отметка. Отрезок — от и до. Незакончившееся
     событие показываем как «с 20:41 · идёт», а не подставляем текущее время
     в конец: оно ещё не наступило. */
  function whenHTML(e) {
    var a = ms(e.startedAt), b = ms(e.endedAt);
    var from = fmtTime.format(new Date(a));
    var mins = Math.round((e.durationSec || 0) / 60);

    if (e.ongoing) {
      var going = Math.max(1, Math.round((Date.now() - a) / 60000));
      return '<time class="entry__time" datetime="' + esc(e.startedAt) + '">с ' + from +
        '</time><span class="dur dur--live"><i aria-hidden="true"></i>идёт ' +
        human(going) + '</span>';
    }
    if (!b || mins < 1) {
      return '<time class="entry__time" datetime="' + esc(e.startedAt) + '">' +
             from + '</time>';
    }
    return '<time class="entry__time" datetime="' + esc(e.startedAt) + '">' + from +
      '</time><span class="entry__dash" aria-hidden="true">–</span>' +
      '<time class="entry__time entry__time--to" datetime="' + esc(e.endedAt) + '">' +
      fmtTime.format(new Date(b)) + '</time>' +
      '<span class="dur">' + human(mins) + '</span>' +
      /* Сервер закрывает зависшие эпизоды по таймауту. Молчать об этом
         нельзя: «6 ч 00 мин» ровно — это не измерение, а предел. */
      (e.closedBy === 'timeout'
        ? '<span class="tag-cap" title="Событие не закрылось само, ' +
          'сервер закрыл его по предельной длительности">по таймауту</span>' : '');
  }

  /* ---------------------------------------------------------------- отрисовка */
  function mediaHTML(e) {
    // Гостю сервер поля media не присылает вовсе — доставать нечего.
    if (!state.authed || !e.media) {
      return '<div class="shot shot--locked" aria-hidden="true">' +
             '<span class="shot__grain"></span></div>' +
             '<span class="shot__lock" title="Доступно после входа">' +
             '<svg viewBox="0 0 24 24" aria-hidden="true">' +
             '<path d="M7 10V7a5 5 0 0 1 10 0v3" fill="none" stroke="currentColor" ' +
             'stroke-width="1.8" stroke-linecap="round"/>' +
             '<rect x="4.5" y="10" width="15" height="10.5" rx="2.6" fill="currentColor"/>' +
             '</svg></span>';
    }
    var m = e.media;
    var cam = evValue(e, 'камера') || '';
    var inner = '<span class="shot__grain"></span>' +
      (cam ? '<span class="shot__cam">' + esc(cam) + '</span>' : '');

    if (m.poster) {
      /* Кадр отдаёт сам API по сессии. Кука SameSite=Lax уходит и на
         поддомен: api.<домен> и сам домен — один сайт, поэтому картинка
         грузится обычным <img> без ухищрений.
         onerror нужен на случай истёкшей сессии: вместо битой иконки
         показываем ту же рамку, что видит гость. */
      inner += '<img class="shot__img" src="' + esc(API.base + m.poster) +
        '" alt="Кадр события" loading="lazy" decoding="async" ' +
        'onerror="this.remove()">';
    }
    if (m.type === 'video' && m.clip) {
      inner += '<a class="shot__play" href="' + esc(API.base + m.clip) +
        '" target="_blank" rel="noopener" title="Открыть запись">▶</a>' +
        '<span class="shot__dur">видео</span>';
    } else if (m.type === 'photo') {
      inner += '<span class="shot__dur">кадр</span>';
    } else {
      inner += '<span class="shot__dur">без кадра</span>';
    }
    return '<div class="shot">' + inner + '</div>';
  }

  function evValue(e, key) {
    var list = e.evidence || [];
    for (var i = 0; i < list.length; i++) if (list[i].k === key) return list[i].v;
    return null;
  }

  function evidenceHTML(e) {
    if (!e.evidence || !e.evidence.length) return '';
    return '<ul class="ev">' + e.evidence.map(function (x) {
      return '<li><b>' + esc(x.k) + ':</b> ' + esc(x.v) + '</li>';
    }).join('') + '</ul>';
  }

  /* ====================================================== ответы шагов

     Разбор идёт цепочкой отдельных запросов к модели, и каждый вопрос
     задаётся только когда для него есть повод. Поэтому пустое поле здесь
     значит «такой вопрос не задавали», и это НЕ то же самое, что «нет».
     Разница видна глазом: спросили и получили «нет» — тег приглушённый;
     не спрашивали — тега нет вовсе. Без этого нельзя понять, модель
     ошиблась или её просто не спросили. */

  /* «на чём» приходит в именительном: пол, диван, кровать. В строке нужен
     предложный, иначе выходит «сидит на диван». Список короткий и закрытый —
     это словарь зон, а не свободный текст. */
  var ON_WHAT = {
    'пол': 'полу', 'земля': 'земле', 'кровать': 'кровати', 'диван': 'диване',
    'кресло': 'кресле', 'стул': 'стуле', 'унитаз': 'унитазе'
  };
  function onWhat(v) {
    if (!v || v === 'не видно') return '';
    return ' на ' + (ON_WHAT[v] || v);
  }

  function fact(cls, label, value) {
    return '<span class="fact fact--' + cls + '">' +
           '<b>' + esc(label) + '</b>' + esc(value) + '</span>';
  }

  function factsHTML(e) {
    var f = e.facts;
    if (!f) return '';
    var out = [];

    if (f.posture) {
      out.push(fact(f.posture === 'лежит' ? 'warn' : 'on',
                    'поза', f.posture + onWhat(f.onWhat)));
    }
    if (f.gait) out.push(fact('on', 'походка', f.gait));
    if (f.gaitSupport && !/никто|ничего|нет/i.test(f.gaitSupport)) {
      out.push(fact('on', 'опора', f.gaitSupport));
    }
    if (f.gaitRisk && f.gaitRisk !== 'норма') out.push(fact('warn', 'риск', f.gaitRisk));

    if (f.sleeping === true) out.push(fact('on', 'сон', 'спит'));
    else if (f.sleeping === false) out.push(fact('off', 'сон', 'не спит'));

    if (f.fallen === true) {
      out.push(fact('bad', 'падение', f.fallSurface ? 'упал на ' + f.fallSurface : 'упал'));
    } else if (f.fallen === false) {
      out.push(fact('off', 'падение', 'лёг сам'));
    }

    if (f.toilet) out.push(fact('on', 'туалет', f.toilet));

    /* Еда, питьё и лекарства — три ответа одного шага. Порознь они дали бы
       три приглушённых тега «не ест», «не пьёт», «без лекарств» почти на
       каждой карточке. Поэтому положительные показываем по отдельности, а
       сплошное «нет» сворачиваем в один тег. */
    var meal = [];
    if (f.eating === true) meal.push('ест');
    if (f.drinking === true) meal.push('пьёт');
    if (f.meds === true) meal.push('лекарства');
    if (meal.length) out.push(fact('on', 'еда', meal.join(', ')));
    else if (f.eating === false || f.drinking === false) {
      out.push(fact('off', 'еда', 'не ест и не пьёт'));
    }

    return out.length ? '<p class="facts">' + out.join('') + '</p>' : '';
  }

  /* Почему выставлен именно такой уровень. Это вывод кода по ответам шагов,
     а не мнение модели, — поэтому строка отдельная, а не среди улик. */
  function reasonHTML(e) {
    if (!e.dangerReason) return '';
    var warn = e.level === 'crit' || e.level === 'warn';
    return '<p class="why why--' + (warn ? 'warn' : 'ok') + '">' +
      '<b>' + (warn ? 'Почему тревога:' : 'Оценка:') + '</b> ' +
      esc(e.dangerReason) + '</p>';
  }

  /* ---- ответ одного шага человеческой строкой ----
     Показывать сырой JSON нельзя: размечать по нему невозможно. Каждый шаг
     знает, как рассказать о себе; незнакомый шаг (появится в будущем)
     раскладывается парами ключ-значение, а не пропадает молча. */
  function yn(v, yes, no) { return v === true ? yes : v === false ? no : null; }

  function answerText(step) {
    var a = step.answer || {}, p = [];
    switch (step.step) {
      case 'validate':
        p.push(yn(a.subject_found, 'это он', 'это не он'));
        p.push(a.match);
        if (a.people_in_frame != null) p.push('людей в кадре: ' + a.people_in_frame);
        p.push(a.quality);
        break;
      case 'gait':
        p.push(yn(a.walks, 'идёт', 'стоит на месте'));
        p.push(a.gait); p.push(a.speed);
        if (a.support && !/никто|ничего|нет/i.test(a.support)) p.push('опора: ' + a.support);
        if (a.risk && a.risk !== 'норма') p.push('риск: ' + a.risk);
        break;
      case 'posture':
        p.push(a.posture + onWhat(a.on_what));
        p.push(a.sure);
        break;
      case 'scene':
        p.push(a.action);
        if (a.objects && a.objects.length) p.push('предметы: ' + a.objects.join(', '));
        break;
      case 'sleep':
        p.push(yn(a.sleeping, 'спит', 'не спит'));
        p.push(a.sure);
        if (a.eyes) p.push('глаза ' + a.eyes);
        if (a.covered) p.push(a.covered);
        break;
      case 'fall':
        p.push(yn(a.fallen, 'упал', 'лёг сам'));
        if (a.surface && a.surface !== 'не видно') p.push('под ним ' + a.surface);
        if (a.trying_to_get_up) p.push('пытается встать');
        p.push(a.sure);
        break;
      case 'meal':
        var m = [];
        if (a.eating) m.push('ест');
        if (a.drinking) m.push('пьёт');
        if (a.meds) m.push('лекарства');
        p.push(m.length ? m.join(', ') : 'не ест и не пьёт');
        if (a.items && a.items.length) p.push('видит: ' + a.items.join(', '));
        break;
      case 'toilet_in':
        p.push(yn(a.entered, 'зашёл в туалет', 'не заходил'));
        p.push(a.sure);
        break;
      case 'toilet_out':
        p.push(yn(a.exited, 'вышел из туалета', 'не выходил'));
        if (a.steady) p.push('держится ' + a.steady);
        p.push(a.sure);
        break;
      default:
        Object.keys(a).forEach(function (k) {
          var v = a[k];
          if (v != null && v !== '' && typeof v !== 'object') p.push(k + ': ' + v);
        });
    }
    return p.filter(Boolean).join(' · ');
  }

  /* Полный разбор под кнопкой. <details> взят намеренно: браузер сам делает
     раскрытие, клавиатуру и доступность — руками это пишется хуже. */
  function chainHTML(e) {
    if (!state.authed || !e.chain || !e.chain.length) return '';
    var rows = e.chain.map(function (s) {
      if (s.failed) {
        return '<li class="step step--fail"><b>' + esc(s.title) + '</b>' +
               '<span class="step__t">не ответила</span></li>';
      }
      var note = (s.answer && s.answer.note) ? s.answer.note : '';
      return '<li class="step"><b>' + esc(s.title) + '</b>' +
        '<span class="step__t">' + (s.seconds != null ? s.seconds + ' с' : '') +
        (s.frames ? ' · ' + s.frames + ' кадр.' : '') + '</span>' +
        '<span class="step__a">' + esc(answerText(s)) + '</span>' +
        (note ? '<span class="step__n">' + esc(note) + '</span>' : '') +
        '</li>';
    }).join('');
    var n = e.stepsAsked || e.chain.length;
    return '<details class="chain"><summary>Что спросили у модели' +
      ' <span class="chain__n">' + n + '</span></summary>' +
      '<ol class="chain__list">' + rows + '</ol></details>';
  }

  /* Кнопка «Переоценить». Это не оценка, а запрос на повторный разбор
     записи моделью, поэтому она стоит отдельно от пальцев и не снимается
     повторным нажатием: задача уже ушла в очередь. */
  function redoHTML(e) {
    var busy = e.recheck && e.recheck.state === 'queued';
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
    var k = kindById[e.kind] || { label: e.kind };
    var l = LVL[e.level] || LVL.ok;
    return '<li class="entry' + (e.ongoing ? ' entry--live' : '') +
      '" data-id="' + esc(e.id) + '">' +
      (withDay ? '<p class="entry__day">' + dayLabel(ms(e.startedAt)) + '</p>' : '') +
      '<article class="entry__in">' +
        '<div class="entry__media">' + mediaHTML(e) + '</div>' +
        '<div class="entry__body">' +
          '<p class="entry__top">' +
            whenHTML(e) +
            '<span class="lvl lvl--' + l.c + '">' + l.t + '</span>' +
            '<span class="kind">' + esc(k.label) + '</span>' +
            (e.recheck && e.recheck.state === 'queued'
              ? '<span class="tag-redo">на переоценке</span>' : '') +
          '</p>' +
          '<p class="entry__text">' + esc(e.text) + '</p>' +
          factsHTML(e) +
          reasonHTML(e) +
          evidenceHTML(e) +
          chainHTML(e) +
          voteHTML(e) +
        '</div>' +
      '</article>' +
    '</li>';
  }

  function render() {
    var html = '', prevDay = null;
    state.items.forEach(function (e) {
      var d = dayLabel(ms(e.startedAt));
      html += entryHTML(e, d !== prevDay);
      prevDay = d;
    });
    feed.innerHTML = html;

    /* «из 12» показываем только когда фильтров нет: сервер считает total
       по всей таблице, без учёта условий, и рядом с отфильтрованным
       списком это число означало бы не то, что читается. */
    counter.textContent = state.items.length
      ? 'Показано ' + state.items.length +
        (state.total && !filtersOn() ? ' из ' + state.total : '')
      : '';
    empty.hidden = state.items.length !== 0 || state.loading;

    moreBtn.hidden = !state.cursor;
    moreN.textContent = '';
    endMsg.hidden = !(state.items.length > PAGE && !state.cursor);

    paintChrome();
  }

  /* Обвязка страницы — кто вошёл, что ему доступно. Отдельно от render(),
     потому что нужна и когда ленты нет вовсе: при сбое шапка не должна
     врать, будто человек вышел из системы. */
  function paintChrome() {
    document.documentElement.classList.toggle('authed', state.authed);
    if (nowBox && !state.authed) { nowBox.hidden = true; nowData = null; }
    $('#lockbar').hidden = state.authed;
    $('#signin').hidden = state.authed;
    $('#signout').hidden = !state.authed;
    var who = document.querySelector('.who');
    who.hidden = !state.authed;
    if (state.authed) {
      who.querySelector('.who__name').textContent =
        (state.user && state.user.name) || 'владелец';
    }
    // Поля фильтров гостю не просто прикрыты накладкой, но и выключены:
    // иначе до них можно добраться табом.
    document.querySelectorAll('#filters input, #filters button').forEach(function (el) {
      el.disabled = !state.authed;
    });
  }

  /* ================================================ где он сейчас

     Журнал отвечает на вопрос «что было». Открывают его обычно ради
     другого — «где он сейчас». Поэтому сверху отдельная панель: последнее
     ПОДТВЕРЖДЁННОЕ появление человека в кадре.

     Данные берутся из памяти системы (точка /api/last_seen). Она живёт
     отдельно от журнала: одна строка, всегда перезаписываемая, обновляется
     только когда модель подтвердила, что на кадрах именно он. Событие, где
     его не нашли, память не трогает — иначе «где он» врало бы каждый раз,
     когда мимо камеры прошёл кто-то другой.

     Панель не опрашивает сервер часто: строка меняется не чаще, чем
     человек переходит из комнаты в комнату. Раз в минуту пересчитываем
     «сколько минут назад» на месте, а к серверу ходим раз в пять минут и
     при появлении новых записей. */

  var nowBox = $('#now');
  var nowData = null;

  function agoText(min) {
    if (min == null) return '';
    if (min < 1) return 'только что';
    if (min < 60) return min + ' мин назад';
    var h = Math.floor(min / 60);
    if (h < 24) return h + ' ч назад';
    return Math.floor(h / 24) + ' сут назад';
  }

  function paintNow() {
    if (!nowBox) return;
    // Гостю панель не показываем вовсе: сервер ему данных и не отдаёт.
    if (!state.authed || !nowData || !nowData.known) { nowBox.hidden = true; return; }
    var d = nowData;
    var l = LVL[d.level] || LVL.ok;
    var shot = d.media && d.media.poster
      ? '<img class="now__img" src="' + esc(API.base + d.media.poster) +
        '" alt="" loading="lazy" decoding="async" onerror="this.remove()">'
      : '';
    var line = [d.where, d.posture].filter(Boolean).join(', ');
    var extra = [];
    if (d.sleeping) extra.push('спит');
    if (d.toilet) extra.push('туалет: ' + d.toilet);
    if (d.action) extra.push(d.action);

    nowBox.innerHTML =
      '<div class="now__shot">' + shot + '</div>' +
      '<div class="now__body">' +
        '<p class="now__eyebrow">Где он сейчас' +
          '<span class="lvl lvl--' + l.c + '">' + l.t + '</span></p>' +
        '<p class="now__line">' + esc(line || 'вне зон') +
          '<span class="now__ago">' + esc(agoText(d.agoMinutes)) + '</span></p>' +
        (extra.length ? '<p class="now__extra">' + esc(extra.join(' · ')) + '</p>' : '') +
      '</div>';
    nowBox.className = 'now now--' + l.c;
    nowBox.hidden = false;
  }

  function loadNow() {
    if (!state.authed) { if (nowBox) nowBox.hidden = true; return Promise.resolve(); }
    // tries:1 — панель второстепенна. Не ответила, значит её просто нет;
    // поднимать из-за неё карточку сбоя поверх живой ленты незачем.
    return API.get('/api/last_seen', { tries: 1 }).then(function (r) {
      nowData = r.data; paintNow();
    }, function () { /* молчим: лента важнее */ });
  }

  /* ============================================================== загрузка */

  function filtersOn() {
    return !!(state.q || state.from || state.to ||
      Object.keys(state.kinds).some(function (k) { return state.kinds[k]; }));
  }

  function query(cursor) {
    var p = [];
    if (state.q) p.push('q=' + encodeURIComponent(state.q));
    if (state.from) p.push('from=' + state.from);
    if (state.to) p.push('to=' + state.to);
    var on = Object.keys(state.kinds).filter(function (k) { return state.kinds[k]; });
    if (on.length) p.push('kind=' + on.join(','));
    if (cursor) p.push('cursor=' + encodeURIComponent(cursor));
    p.push('limit=' + PAGE);
    return '/api/events?' + p.join('&');
  }

  var waitEl = null, slowTimer = null;
  function waitOn(text) {
    waitOff();
    waitEl = document.createElement('p');
    waitEl.className = 'jrn__wait';
    waitEl.textContent = text;
    feed.parentNode.insertBefore(waitEl, feed);
    // Пустой экран на десять секунд — сам по себе плохая новость.
    slowTimer = setTimeout(function () {
      if (!waitEl) return;
      waitEl.textContent = 'Дом отвечает дольше обычного. Ещё ждём…';
      waitEl.classList.add('is-long');
    }, 4000);
  }
  function waitOff() {
    clearTimeout(slowTimer);
    if (waitEl && waitEl.parentNode) waitEl.parentNode.removeChild(waitEl);
    waitEl = null;
  }

  function load(more) {
    if (state.loading) return;
    state.loading = true;
    faultBox.hidden = true;
    faultBox.innerHTML = '';
    $('#filters').hidden = false;
    var note = document.querySelector('.wire-note');
    if (note) note.parentNode.removeChild(note);

    if (!more) { waitOn('Загружаем журнал…'); }
    else { moreBtn.disabled = true; moreBtn.textContent = 'Загружаем…'; }

    /* ДОБОР СТРАНИЦЫ.
       Сервер отбирает записи по типу уже ПОСЛЕ того, как взял из базы
       свои LIMIT строк. Поэтому при включённом фильтре страница может
       вернуться почти пустой, хотя подходящие записи есть — просто они
       ниже по времени. Тянем дальше по курсору, пока не наберём экран.
       Ограничение на число доборов обязательно: если под фильтр не
       попадает ничего, без него мы прочитали бы всю базу подряд.
       Правильное лечение — фильтровать в SQL, это на стороне сервера. */
    var collected = [], hops = 0, MAX_HOPS = 4;
    var startCursor = more ? state.cursor : null;
    var slowest = 0;

    function pull(cursor) {
      return API.getShaped(query(cursor), ['items']).then(function (r) {
        slowest = Math.max(slowest, r.ms);
        collected = collected.concat(r.data.items || []);
        state.cursor = r.data.nextCursor || null;
        state.total = r.data.total || 0;
        if (collected.length < PAGE && state.cursor && hops < MAX_HOPS) {
          hops++;
          return pull(state.cursor);
        }
        return r;
      });
    }

    return pull(startCursor)
      .then(function (r) {
        state.loading = false;
        waitOff();
        moreBtn.disabled = false;
        moreBtn.innerHTML = 'Показать ещё <span id="moreN"></span>';
        moreN = $('#moreN');

        state.items = more ? state.items.concat(collected) : collected;
        render();
        if (!more) loadNow();
        if (slowest > 2500) slowNote(slowest);
      })
      .catch(function (err) {
        state.loading = false;
        waitOff();
        moreBtn.disabled = false;
        return showFault(err);
      });
  }

  /* Ответ дошёл, но еле-еле. Это не поломка, а предупреждение: так
     выглядит связь с домом за минуту до того, как она отвалится. */
  function slowNote(t) {
    var n = document.createElement('div');
    n.className = 'wire-note';
    n.innerHTML = '<b>Связь с домом медленная.</b> Ответ шёл ' +
      (t / 1000).toFixed(1) + ' с. Записи на месте, но кадры могут ' +
      'подгружаться долго. <a href="../status/">Проверить цепочку</a>';
    feed.parentNode.insertBefore(n, feed);
  }

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
        onRetry: function () { load(false); },
        onSignin: openAuth
      });
    });
  }

  /* ------------------------------------------------------------- фильтры */
  var chipbox = $('#kinds');
  function paintChips() {
    chipbox.innerHTML = KINDS.map(function (k) {
      return '<button class="chip" type="button" data-kind="' + k.id + '" ' +
             'aria-pressed="' + (state.kinds[k.id] ? 'true' : 'false') + '">' +
             esc(k.label) + '</button>';
    }).join('');
    paintChrome();
  }
  paintChips();

  chipbox.addEventListener('click', function (e) {
    var b = e.target.closest('.chip');
    if (!b || b.disabled) return;
    var id = b.dataset.kind;
    state.kinds[id] = !state.kinds[id];
    b.setAttribute('aria-pressed', String(!!state.kinds[id]));
    load(false);
  });

  var typing = null;
  $('#q').addEventListener('input', function (e) {
    clearTimeout(typing);
    var v = e.target.value;
    // Каждое нажатие — запрос к дому через туннель. Ждём паузу в наборе.
    typing = setTimeout(function () { state.q = v.trim(); load(false); }, 350);
  });
  $('#from').addEventListener('change', function (e) {
    state.from = e.target.value; load(false);
  });
  $('#to').addEventListener('change', function (e) {
    state.to = e.target.value; load(false);
  });
  $('#reset').addEventListener('click', function () {
    state.q = ''; state.from = ''; state.to = ''; state.kinds = {};
    $('#q').value = ''; $('#from').value = ''; $('#to').value = '';
    chipbox.querySelectorAll('.chip').forEach(function (c) {
      c.setAttribute('aria-pressed', 'false');
    });
    load(false);
  });

  moreBtn.addEventListener('click', function () { load(true); });

  /* ================================================== действия над записью

     Цена ошибки здесь другая, чем при загрузке. Не пришла лента — экран
     пустой, это видно. А если не прошло удаление, но запись исчезла с
     экрана, человек уверен, что дело сделано, и узнает правду через сутки.
     Поэтому оценка ставится сразу и откатывается при отказе, а удаление
     сначала подтверждает сервер. */

  function byId(id) {
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].id === id) return state.items[i];
    }
    return null;
  }

  function entryErr(li, err, what) {
    API.diagnose(err).then(function (d) {
      var old = li.querySelector('.enerr');
      if (old) old.parentNode.removeChild(old);
      var p = document.createElement('p');
      p.className = 'enerr';
      p.setAttribute('role', 'alert');
      p.innerHTML = '<b>' + what + '.</b> ' + esc(d.title) +
        '. <a href="../status/">Что случилось</a>';
      li.querySelector('.entry__body').appendChild(p);
      // Сессия кончилась — предлагаем вход прямо отсюда, не гоняя на статус.
      if (d.signin) {
        state.authed = false;
        paintChrome();
      }
    });
  }

  /* ---------------------------------------------------------- оценка записи */
  feed.addEventListener('click', function (e) {
    var b = e.target.closest('[data-vote]');
    if (!b) return;
    var li = b.closest('.entry');
    var ev = byId(li.dataset.id);
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

    API.post('/api/events/' + ev.id + '/vote', { vote: ev.vote })
      .catch(function (err) {
        ev.vote = was;                    // сервер не принял — возвращаем как было
        paint();
        entryErr(li, err, 'Оценка не сохранилась');
      });
  });

  /* ------------------------------------------------- запрос на переоценку
     Сервер принимает задачу и отвечает 202. Сам воркер переоценки пока
     стаб — значит запись пометится, но модель по ней ещё не прогонится.
     Врать кнопкой об этом не будем, когда воркер появится — ничего в
     разметке менять не придётся. */
  feed.addEventListener('click', function (e) {
    var b = e.target.closest('[data-recheck]');
    if (!b || b.disabled) return;
    var li = b.closest('.entry');
    var ev = byId(li.dataset.id);
    if (!ev) return;

    b.disabled = true;
    b.querySelector('span').textContent = 'Отправляем…';

    API.post('/api/events/' + ev.id + '/recheck').then(function (r) {
      ev.recheck = { state: (r.data && r.data.state) || 'queued' };
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
     пальцем по списку — обычное дело. Сервер удаляет мягко и даёт десять
     секунд на возврат — ровно столько живёт полоса отмены. */
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

    var yes = e.target.closest('[data-del-yes]');
    if (!yes) return;

    var id = li.dataset.id;
    var idx = -1;
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].id === id) { idx = i; break; }
    }
    if (idx < 0) return;

    yes.disabled = true;
    yes.textContent = 'Удаляем…';

    API.del('/api/events/' + id).then(function (r) {
      trash = { at: idx, item: state.items[idx] };
      state.items.splice(idx, 1);
      if (state.total) state.total--;
      render();
      // Сколько именно даётся на возврат, решает сервер.
      var until = r.data && r.data.restorableUntil
        ? Math.max(3000, Date.parse(r.data.restorableUntil) - Date.now())
        : 10000;
      showToast(until);
    }, function (err) {
      yes.disabled = false;
      yes.textContent = 'Удалить';
      entryErr(li, err, 'Удалить не получилось');
    });
  });

  function showToast(life) {
    toast.querySelector('.toast__t').textContent = 'Запись удалена';
    var u = $('#undo');
    u.disabled = false;
    u.textContent = 'Вернуть';
    toast.hidden = false;
    toast.classList.remove('is-out');
    void toast.offsetWidth;              // перезапустить полоску времени
    toast.style.setProperty('--life', Math.round(life) + 'ms');
    toast.classList.add('is-out');
    clearTimeout(trashTimer);
    trashTimer = setTimeout(hideToast, life);
  }
  function hideToast() {
    toast.hidden = true;
    toast.classList.remove('is-out');
    trash = null;                        // вернуть уже нельзя
  }
  $('#undo').addEventListener('click', function () {
    if (!trash) return;
    var back = trash, btn = $('#undo');
    btn.disabled = true;
    btn.textContent = 'Возвращаем…';

    API.post('/api/events/' + back.item.id + '/restore').then(function (r) {
      state.items.splice(back.at, 0, (r.data && r.data.id) ? r.data : back.item);
      if (state.total) state.total++;
      clearTimeout(trashTimer);
      hideToast();
      btn.disabled = false;
      btn.textContent = 'Вернуть';
      render();
    }, function () {
      /* Отсрочка на сервере могла истечь, или связь оборвалась. Молчать
         нельзя: человек нажал «вернуть» и уверен, что вернул. */
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

  /* ================================================================== вход
     Сессия живёт в куке HttpOnly: страница её не видит и видеть не должна.
     Поэтому «вошёл ли я» — это не флаг в localStorage, а вопрос к серверу. */
  function openAuth() {
    $('#authErr').hidden = true;
    dlg.showModal();
    setTimeout(function () { $('#login').focus(); }, 30);
  }
  $('#signin').addEventListener('click', openAuth);
  $('#signin2').addEventListener('click', openAuth);
  $('#authCancel').addEventListener('click', function () { dlg.close('cancel'); });

  $('#authForm').addEventListener('submit', function (e) {
    e.preventDefault();                  // окно закроем сами, после ответа
    var err = $('#authErr');
    var login = $('#login').value.trim(), pass = $('#pass').value;
    if (!login || !pass) {
      err.textContent = 'Заполните оба поля.';
      err.hidden = false;
      return;
    }
    var go = $('#authForm button[value="ok"]');
    go.disabled = true;
    go.textContent = 'Проверяем…';

    API.post('/api/session', { login: login, password: pass }).then(function (r) {
      go.disabled = false; go.textContent = 'Войти';
      state.authed = true;
      state.user = r.data && r.data.user;
      $('#pass').value = '';
      dlg.close('ok');
      load(false);
    }, function (e2) {
      go.disabled = false; go.textContent = 'Войти';
      if (e2.kind === 'http' && e2.status === 401) {
        // Сервер намеренно не говорит, что именно неверно.
        err.textContent = 'Неверный логин или пароль.';
      } else if (e2.kind === 'http' && e2.status === 429) {
        err.textContent = 'Слишком много попыток. Подождите четверть часа.';
      } else {
        err.textContent = 'Сервер не отвечает. Проверьте связь с домом.';
      }
      err.hidden = false;
    });
  });

  $('#signout').addEventListener('click', function () {
    API.del('/api/session').then(function () {
      state.authed = false;
      state.user = null;
      load(false);
    }, function () {
      // Даже если запрос не дошёл — на экране больше ничего не показываем.
      state.authed = false;
      state.user = null;
      render();
    });
  });

  /* =================================================================== старт */
  function boot() {
    /* Кто мы. Ответ 401 здесь — не ошибка, а «гость»: показывать из-за
       него карточку сбоя было бы враньём. */
    API.get('/api/session', { tries: 1 }).then(function (r) {
      state.authed = true;
      state.user = r.data && r.data.user;
    }, function () {
      state.authed = false;
    }).then(function () {
      paintChrome();
      // Справочник типов берём с сервера: там он один на всех.
      return API.get('/api/kinds', { tries: 1 }).then(function (r) {
        if (Array.isArray(r.data) && r.data.length) { KINDS = r.data; indexKinds(); }
      }, function () {});
    }).then(function () {
      paintChips();
      return load(false);
    });
  }
  boot();

  /* Связь вернулась сама — не заставляем нажимать кнопку. */
  window.addEventListener('online', function () {
    if (!faultBox.hidden) setTimeout(function () { load(false); }, 500);
  });

  /* У незакончившегося события счётчик должен идти сам, а не только при
     перерисовке. Обновляем раз в минуту и только его — трогать всю ленту
     ради одной строки незачем. */
  setInterval(function () {
    document.querySelectorAll('.entry--live .dur--live').forEach(function (el) {
      var li = el.closest('.entry');
      var ev = byId(li.dataset.id);
      if (!ev || !ev.ongoing) return;
      var m = Math.max(1, Math.round((Date.now() - ms(ev.startedAt)) / 60000));
      el.lastChild.textContent = 'идёт ' + human(m);
    });
    // «12 минут назад» стареет само по себе — пересчитываем на месте,
    // не тревожа сервер.
    if (nowData && nowData.known && nowData.agoMinutes != null) {
      nowData.agoMinutes++;
      paintNow();
    }
  }, 60000);

  /* Свериться с сервером раз в пять минут: реже, чем человек ходит по дому,
     чаще нет смысла — строка меняется только с новым подтверждённым
     появлением, а о нём и так придёт событие в поток. */
  setInterval(loadNow, 300000);

  /* ------------------------------------------------------- живые события
     Сервер держит поток SSE и присылает новые записи по мере появления.
     Полностью перезагружать ленту не надо: показываем полосу «есть новое»,
     а вставку делает сам человек. Иначе список дёргается под пальцем, а
     если открыто подтверждение удаления — оно исчезает вместе с записью. */
  var fresh = 0, bar = null;
  function liveBar() {
    if (!bar) {
      bar = document.createElement('button');
      bar.type = 'button';
      bar.className = 'newbar';
      bar.addEventListener('click', function () {
        fresh = 0; bar.remove(); bar = null; load(false);
      });
      feed.parentNode.insertBefore(bar, feed);
    }
    bar.textContent = fresh === 1 ? 'Новая запись — показать'
                                  : 'Новых записей: ' + fresh + ' — показать';
  }
  function listen() {
    if (!window.EventSource || API.simulated) return;
    var es;
    try { es = new EventSource(API.base + '/api/events/stream',
                              { withCredentials: true }); }
    catch (e) { return; }
    es.addEventListener('created', function () { fresh++; liveBar(); loadNow(); });
    // Обрыв EventSource переподключает сам; молчим, чтобы не пугать зря.
    es.onerror = function () {};
  }
  listen();
})();
