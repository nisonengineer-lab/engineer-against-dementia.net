/* ==========================================================================
   BeKavod — страница состояния.

   Она отвечает на один вопрос: где именно порвалось. Проверка идёт по
   цепочке, звено за звеном, в том порядке, в каком сигнал реально идёт
   от вашего телефона до коробки в Явне:

       устройство → интернет → адрес API → сам API → узлы внутри дома

   Показываем весь путь, а не только место обрыва: когда видно, что первые
   три звена зелёные, а четвёртое красное, вопрос «это у меня или у них»
   отпадает сам, без объяснений.

   ВАЖНАЯ ОГОВОРКА ПРО ТРЕТИЙ ШАГ. Он грузит картинку /api/ping.png и тем
   проверяет, отзывается ли вообще что-нибудь по адресу API. Если на
   сервере этой картинки нет — шаг покажет отказ, хотя API живо. Поэтому
   приговор выносит четвёртый шаг, настоящий запрос; третий только
   объясняет его результат.
   ========================================================================== */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };

  var STEPS = [
    { id: 'device', t: 'Устройство и его сеть' },
    { id: 'site',   t: 'Интернет: сайт отвечает' },
    { id: 'addr',   t: 'Адрес API отзывается' },
    { id: 'api',    t: 'API отвечает по правилам' },
    { id: 'parts',  t: 'Узлы внутри дома' }
  ];

  var OK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.2 4.3L19 7.2" ' +
           'fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" ' +
           'stroke-linejoin="round"/></svg>';
  var NO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" ' +
           'fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';
  var WARN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v8" fill="none" ' +
             'stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>' +
             '<circle cx="12" cy="18.4" r="1.5" fill="currentColor"/></svg>';

  var chain = $('#chain');
  chain.innerHTML = STEPS.map(function (s) {
    return '<li class="step" id="s-' + s.id + '">' +
      '<span class="step__dot" aria-hidden="true"></span>' +
      '<p class="step__t">' + s.t + '</p>' +
      '<p class="step__d">не проверяли</p>' +
    '</li>';
  }).join('');

  function set(id, cls, text, ms) {
    var li = $('#s-' + id);
    li.className = 'step ' + cls;
    $('.step__d', li).innerHTML = text +
      (ms != null ? '<span class="step__ms">' + ms + ' мс</span>' : '');
    var dot = $('.step__dot', li);
    dot.innerHTML = cls === 'is-ok' ? OK
                  : cls === 'is-bad' ? NO
                  : cls === 'is-warn' ? WARN : '';
  }
  function reset() {
    STEPS.forEach(function (s) { set(s.id, 'is-skip', 'не проверяли'); });
    $('#verdict').innerHTML = '';
    $('#verdict').hidden = true;
    $('#parts').hidden = true;
  }

  var t0 = (window.performance && performance.now)
    ? function () { return performance.now(); } : function () { return Date.now(); };

  /* ------------------------------------------------------------ проверка */
  function run() {
    reset();
    var btn = $('#again');
    btn.disabled = true;
    var stamp = $('#stamp');
    stamp.textContent = 'идёт проверка…';

    /* --- 1. устройство ------------------------------------------------- */
    set('device', 'is-run', 'спрашиваем браузер');
    if (API.mixedContent()) {
      set('device', 'is-bad', 'страница отдаётся по https, а API настроен на http — ' +
          'такой запрос браузер не отправит вообще');
    } else if (!API.online()) {
      set('device', 'is-bad', 'устройство сообщает, что сети нет');
      set('site', 'is-skip', 'без сети проверять нечего');
      set('addr', 'is-skip', 'без сети проверять нечего');
      set('api',  'is-skip', 'без сети проверять нечего');
      return finish({ kind: 'network', ms: 0, url: API.base + '/api/health',
                      method: 'GET' }, null);
    } else {
      set('device', 'is-ok', 'сеть на устройстве есть');
    }

    /* --- 2. свой сайт --------------------------------------------------- */
    set('site', 'is-run', 'тянем собственный файл мимо кэша');
    var a = t0();
    return API.probeSite().then(function (ok) {
      var ms = Math.round(t0() - a);
      if (location.protocol === 'file:' && !API.simulated) {
        set('site', 'is-warn', 'страница открыта с диска — проверять нечего. ' +
            'Запустите из папки сайта: python3 -m http.server 8000');
      } else if (ok) {
        set('site', 'is-ok', 'сайт отдаётся прямо сейчас', ms);
      } else {
        /* Значок сети горит, а собственный файл не пришёл — почти всегда
           это Wi-Fi без интернета или страница входа гостевой сети. */
        set('site', 'is-bad', 'сеть есть, но не открывается даже этот сайт — ' +
            'похоже на Wi-Fi без интернета', ms);
      }

      /* --- 3. адрес API ------------------------------------------------- */
      set('addr', 'is-run', 'грузим проверочную картинку — она не подчиняется CORS');
      var b = t0();
      return API.probeApi().then(function (up) {
        var ms2 = Math.round(t0() - b);
        if (up) {
          set('addr', 'is-ok', 'по адресу ' + API.origin() + ' кто-то отвечает', ms2);
        } else {
          set('addr', 'is-bad', 'с адреса ' + API.origin() +
              ' не пришло ничего (или на сервере нет ' + API.ping + ')', ms2);
        }

        /* --- 4. настоящий запрос --------------------------------------- */
        set('api', 'is-run', 'спрашиваем состояние: GET /api/health');
        var c = t0();
        /* Без повторов и с коротким ожиданием: это диагностика, её дело —
           быстро назвать причину, а не героически дозвониться. */
        return API.getShaped('/api/health', ['ok', 'parts'], { tries: 1, timeout: 6000 })
          .then(function (r) {
            set('api', 'is-ok', 'ответ пришёл, версия ' +
                (r.data.version || '—'), r.ms);
            return finish(null, r.data);
          })
          .catch(function (err) {
            var ms3 = Math.round(t0() - c);
            set('api', 'is-bad', errLine(err), err.ms != null ? err.ms : ms3);
            set('parts', 'is-skip', 'без ответа от API узлы не видны');
            return finish(err, null);
          });
      });
    });
  }

  function errLine(e) {
    if (e.kind === 'http') return 'сервер ответил кодом ' + e.status;
    if (e.kind === 'timeout') return 'ответа не было до самого конца ожидания';
    if (e.kind === 'parse') return 'вместо данных пришло что-то другое';
    if (e.kind === 'shape') return 'данные пришли, но не той формы';
    return 'запрос не ушёл или ответ не вернулся';
  }

  /* ---------------------------------------------------------- приговор */
  function finish(err, health) {
    $('#again').disabled = false;
    $('#stamp').textContent = 'проверено в ' +
      new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit',
        second: '2-digit' }).format(new Date());

    var box = $('#verdict');
    box.hidden = false;

    if (err) {
      return API.diagnose(err).then(function (d) {
        Fault.mount(box, d, { onStatus: true, onRetry: run });
      });
    }

    /* API живо — дальше решают узлы */
    /* У узла три состояния, а не два. ok:true — проверено и работает,
       ok:false — проверено и лежит, ok:null — проверить нечем (например,
       радары падения ещё не установлены). Считать «не проверено» за
       «сломано» — это ложная тревога, а считать за «работает» — ложное
       спокойствие. Поэтому третье состояние показываем отдельно. */
    var parts = (health && health.parts) || [];
    var bad = parts.filter(function (p) { return p.ok === false; });
    var unknown = parts.filter(function (p) { return p.ok == null; });
    showParts(parts);

    if (bad.length) {
      set('parts', 'is-warn', 'не отвечает: ' +
          bad.map(function (p) { return p.name; }).join(', '));
      Fault.mount(box, {
        code: 'home.degraded', where: 'server', level: 'warn', retry: true,
        title: bad.length === 1 ? bad[0].name + ' не отвечает'
                                : 'Часть системы дома не отвечает',
        why: 'Журнал открывается, записи целы. Но ' +
             (bad.length > 1 ? 'не отвечают: ' : 'не отвечает ') +
             bad.map(function (p) {
               return p.name + (p.why ? ' (' + p.why + ')' : '');
             }).join(', ') + '. Пока это так, новые события могут не ' +
             'попадать в журнал, а тревоги — не приходить.',
        hint: ['Записи за прошлое доступны как обычно.',
               'Если через десять минут не поднимется — перезапустите коробку.'],
        tech: { url: API.base + '/api/health', method: 'GET',
                status: 200, kind: 'degraded', when: new Date().toISOString(),
                page: location.href, agent: navigator.userAgent }
      }, { onStatus: true, onRetry: run });
      return;
    }

    var live = parts.length - unknown.length;
    set('parts', 'is-ok', live + ' из ' + live + ' на связи' +
        (unknown.length ? ' · не проверяется: ' +
          unknown.map(function (p) { return p.name; }).join(', ') : ''));
    box.innerHTML =
      '<section class="fx fx--ok">' +
        '<div class="fx__head">' +
          '<span class="fx__icon" aria-hidden="true"><svg viewBox="0 0 24 24">' + OK +
          '</svg></span>' +
          '<div><p class="fx__eyebrow">Всё работает</p>' +
          '<h2 class="fx__t">Система на связи</h2></div>' +
        '</div>' +
        '<p class="fx__why">Цепочка цела на всём пути: устройство, интернет, ' +
        'адрес, API и узлы дома. Версия ' + (health.version || '—') +
        ', без перезапусков ' + uptime(health.uptimeSec) + '.</p>' +
      '</section>';
  }

  function uptime(sec) {
    if (!sec) return '—';
    var d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600);
    if (d) return d + ' сут ' + h + ' ч';
    var m = Math.floor(sec % 3600 / 60);
    return h ? h + ' ч ' + m + ' мин' : m + ' мин';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function showParts(parts) {
    if (!parts.length) return;
    var box = $('#parts');
    box.hidden = false;
    $('#partsGrid').innerHTML = parts.map(function (p) {
      var cls = p.ok === false ? ' part--bad' : (p.ok == null ? ' part--unknown' : '');
      var d = p.ok === true
        ? (p.note || (p.ms != null ? 'отвечает за ' + p.ms + ' мс' : 'в порядке'))
        : p.ok == null
          ? (p.note || 'проверить нечем')
          : (p.why || 'не отвечает') +
            (p.since ? ' · с ' + new Intl.DateTimeFormat('ru-RU',
              { hour: '2-digit', minute: '2-digit' }).format(new Date(p.since)) : '');
      return '<li class="part' + cls + '">' +
        '<p class="part__t"><span class="part__led" aria-hidden="true"></span>' +
        esc(p.name) + '</p>' +
        '<p class="part__d">' + esc(d) + '</p></li>';
    }).join('');
  }

  /* -------------------------------------------------------- сценарии
     Инструмент для проверки, а не часть сайта. Обычному посетителю он
     не нужен и только путает: половина карточек называется «туннель
     отвалился». Показываем по явному ?dev=1. */
  (function scenes() {
    var box = document.querySelector('.scenes');
    if (!/[?&]dev=1/.test(location.search)) {
      if (box) box.remove();
      if (API.simulated) {
        var w = document.createElement('div');
        w.className = 'wire-note';
        w.innerHTML = '<b>Это имитация.</b> Сценарий <code>?fail=' +
          esc(API.sim) + '</code>. <a href="./">Настоящая проверка</a> · ' +
          '<a href="?dev=1">все сценарии</a>';
        $('#simSlot').appendChild(w);
      }
      return;
    }
    var grid = $('#scenes');
    var html = '<a class="scene" href="./"' +
      (API.simulated ? '' : ' aria-current="true"') +
      '>Без имитации<code>как есть сейчас</code></a>';
    API.sceneOrder.forEach(function (k) {
      var s = API.scenes[k];
      if (!s) return;
      html += '<a class="scene" href="?fail=' + k + '"' +
        (API.sim === k ? ' aria-current="true"' : '') + '>' +
        esc(s.title) + '<code>?fail=' + k + '</code></a>';
    });
    grid.innerHTML = html;

    if (API.simulated) {
      var n = document.createElement('div');
      n.className = 'wire-note';
      n.innerHTML = '<b>Это имитация.</b> Показан сценарий <code>?fail=' +
        esc(API.sim) + '</code> — настоящий сервер сейчас не опрашивается. ' +
        '<a href="./">Вернуться к настоящей проверке</a>';
      $('#simSlot').appendChild(n);
    }
  })();

  $('#again').addEventListener('click', run);
  run();

  /* Связь вернулась — не заставляем нажимать кнопку. */
  window.addEventListener('online', function () { setTimeout(run, 400); });
})();
