/* ==========================================================================
   BeKavod — разговор с сервером и, главное, разбор поломок.

   ЗАЧЕМ ЭТОТ ФАЙЛ. «Не работает» — бесполезное сообщение. Человеку, который
   в три часа ночи открыл журнал и увидел пустоту, нужно знать одно: это у
   него пропал интернет, или дома выключилась коробка, или сервер жив, но
   отвечает ошибкой. Это три разных действия, и страница обязана их
   различать сама, а не предлагать «попробуйте позже».

   ЧТО БРАУЗЕР ПОКАЗЫВАЕТ, А ЧТО ПРЯЧЕТ.
   fetch() при любой сетевой беде бросает один и тот же TypeError: «Failed
   to fetch». Он намеренно не говорит, что именно случилось — иначе через
   этот канал можно было бы сканировать чужую локальную сеть. Поэтому
   причину приходится вычислять пробами:

     1) navigator.onLine === false   — устройство само знает, что офлайн.
     2) запрос к СВОЕМУ origin       — жив ли вообще интернет прямо сейчас.
        Страница могла открыться двадцать минут назад, это ничего не значит.
     3) картинка с адреса API        — вот главный трюк. Загрузка <img> не
        подчиняется CORS. Если наш 1×1 PNG по адресу /api/ping.png
        загрузился, значит приложение на том конце ЖИВО и достижимо, а
        ответ не дошёл только из-за правил браузера (нет заголовков CORS
        или смешанный http/https). Если картинка не загрузилась — на том
        конце не отвечает ничего: коробка, туннель, DNS.
     4) время до отказа              — отказ за 60 мс это «дверь закрыта»
        (порт не слушает, имя не разрешилось). Отказ через восемь секунд —
        «пакеты уходят в никуда» (туннель висит, файрвол молча глотает).

   Чего мы честно НЕ различаем: сбитую DNS-запись от закрытого порта.
   Из браузера это неотличимо, и врать точностью хуже, чем назвать обе
   причины и дать команду для проверки каждой.

   ОТДЕЛЬНО ПРО CLOUDFLARE. Когда туннель лежит, ошибку рисует не наш
   сервер, а край Cloudflare (521/522/523/524, 530 для Argo 1033). На этих
   страницах нет заголовков CORS, поэтому при запросе с другого origin
   браузер превратит их в тот же TypeError, и код статуса мы не увидим.
   Увидим только если API отдаётся с того же origin, что и сайт. Поэтому
   проба картинкой важнее кода статуса: она работает в обоих случаях.

   ПРОВЕРКА БЕЗ СЕРВЕРА. Бэкенда пока нет, а поведение проверять надо, и
   не «на глаз» в день аварии. Любой сценарий поломки включается адресом:
       ?fail=offline  ?fail=refused  ?fail=hang  ?fail=cors
       ?fail=401  ?fail=500  ?fail=502  ?fail=503  ?fail=530
       ?fail=html  ?fail=badjson  ?fail=version  ?fail=degraded  ?fail=slow
   Полный список с описаниями — на странице /status/.
   ========================================================================== */
(function () {
  'use strict';

  /* Адрес API. Пусто — тот же origin, что и страница. Меняется одной
     строкой в <head>:  <meta name="api-base" content="https://api.…"> */
  var meta = document.querySelector('meta[name="api-base"]');
  var BASE = (meta && meta.content ? meta.content : '').replace(/\/+$/, '');

  /* Ждать дольше семи секунд бессмысленно: человек уже решил, что сломалось.
     Две попытки, а не три — иначе перед сообщением о сбое проходит
     полминуты пустого экрана, и это хуже самого сбоя. */
  var TIMEOUT = { get: 7000, write: 12000 };
  var TRIES = 2;                 // всего попыток для безопасных запросов
  var PING = '/api/ping.png';    // 1×1 PNG без авторизации, см. docs/api-journal.md

  /* Всегда приводим к полному адресу: в отчёте о сбое «/api/health» ничего
     не говорит, а «https://api.…/api/health» сразу показывает, куда ушёл
     запрос — и что именно надо проверять. */
  function full(path) {
    if (/^https?:/i.test(path)) return path;
    try { return new URL(BASE + path, location.href).href; }
    catch (e) { return BASE + path; }
  }
  function apiOrigin() {
    try { return new URL(full('/api/health'), location.href).origin; }
    catch (e) { return location.origin; }
  }
  var t0 = (window.performance && performance.now)
    ? function () { return performance.now(); }
    : function () { return Date.now(); };

  /* ====================================================== имитация аварий */
  var SIM = (new URLSearchParams(location.search).get('fail') || '').toLowerCase();

  /* net: 'reject' — fetch бросит TypeError, 'hang' — не ответит вовсе.
     site/api — что покажут пробы. status — код ответа, если ответ дошёл. */
  var SCENES = {
    offline:  { title: 'Устройство офлайн',        net: 'reject', online: false, site: false, api: false, ms: 20 },
    isp:      { title: 'Интернета нет, но Wi-Fi есть', net: 'reject', site: false, api: false, ms: 2600 },
    refused:  { title: 'Адрес API молчит сразу',   net: 'reject', site: true,  api: false, ms: 70 },
    hang:     { title: 'Адрес API висит',          net: 'reject', site: true,  api: false, ms: 5200 },
    timeout:  { title: 'Ответа не дождались',      net: 'hang',   site: true,  api: false },
    cors:     { title: 'Сервер жив, ответ не пустил браузер', net: 'reject', site: true, api: true, ms: 190 },
    mixed:    { title: 'http-API на https-странице', net: 'reject', site: true, api: true, ms: 25, mixed: true },
    '401':    { title: 'Сессия истекла',           status: 401 },
    '403':    { title: 'Доступ закрыт',            status: 403 },
    '404':    { title: 'Адрес не найден',          status: 404 },
    '429':    { title: 'Слишком часто',            status: 429, retryAfter: 34 },
    '500':    { title: 'Ошибка внутри сервера',    status: 500 },
    '502':    { title: 'Шлюз не дозвонился',       status: 502 },
    '503':    { title: 'Сервис поднимается',       status: 503, retryAfter: 90 },
    '504':    { title: 'Шлюз ждал слишком долго',  status: 504 },
    '530':    { title: 'Туннель Cloudflare отвалился', status: 530 },
    html:     { title: 'Отвечает не наше приложение', status: 200, html: true },
    badjson:  { title: 'Ответ оборвался на середине', status: 200, badjson: true },
    version:  { title: 'Сервер новее страницы',    status: 200, shape: true },
    degraded: { title: 'API жив, узлы дома — нет', status: 200, degraded: true },
    /* Отдельный и очень частый случай: читать можно, писать нельзя —
       диск кончился, база в режиме только чтения, очередь встала.
       Лента при этом открывается, а оценка и удаление молча не проходят,
       если не проверить ответ. Поэтому сценарий нужен свой. */
    write:    { title: 'Читается, но не записывается', status: 503,
                writeOnly: true, retryAfter: 20 },
    slow:     { title: 'Всё работает, но медленно', status: 200, slowMs: 4200 }
  };
  var scene = SCENES[SIM] || null;

  function online() {
    if (scene && scene.online === false) return false;
    return navigator.onLine !== false;
  }

  /* ============================================================== пробы */

  /* Жив ли интернет ПРЯМО СЕЙЧАС: дёргаем свой же файл мимо кэша.
     Свой origin — значит без CORS и без сюрпризов. */
  function probeSite() {
    // В сценарии, где сервер ответил кодом, сеть заведомо цела: не идём
    // в неё, иначе на тестовом стенде шаг покажет отказ без причины.
    if (scene) return Promise.resolve(scene.site !== false);
    /* Страница открыта с диска: у file:// нет origin, тянуть нечего.
       Возвращаем «цело» — лучше не проверить, чем соврать про обрыв. */
    if (location.protocol === 'file:') return Promise.resolve(true);
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 4000);
    return fetch(location.origin + '/robots.txt?b=' + Date.now(),
                 { cache: 'no-store', signal: ctl.signal })
      .then(function (r) { clearTimeout(timer); return r.ok || r.status === 404; })
      .catch(function () { clearTimeout(timer); return false; });
  }

  /* Отвечает ли что-нибудь по адресу API. Картинкой — потому что <img>
     не проверяется на CORS, и это единственный способ из браузера
     отличить «сервер жив, но заголовки не те» от «там никого нет». */
  function probeApi() {
    if (scene) return Promise.resolve(scene.api !== false);
    return new Promise(function (done) {
      var img = new Image();
      var timer = setTimeout(function () { img.src = ''; done(false); }, 4000);
      img.onload  = function () { clearTimeout(timer); done(true); };
      img.onerror = function () { clearTimeout(timer); done(false); };
      img.src = full(PING) + '?b=' + Date.now();
    });
  }

  /* Смешанное содержимое видно без всяких проб: https-страница не имеет
     права ходить на http-адрес, браузер режет запрос до отправки. */
  function mixedContent() {
    if (scene && scene.mixed) return true;
    return location.protocol === 'https:' && /^http:/i.test(BASE);
  }

  /* ============================================================ запросы */

  function ApiError(kind, extra) {
    var e = new Error(kind);
    e.kind = kind;                       // network | timeout | http | parse | shape
    for (var k in extra) if (extra.hasOwnProperty(k)) e[k] = extra[k];
    return e;
  }

  function retryAfterMs(h) {
    if (!h) return null;
    var n = Number(h);
    if (!isNaN(n)) return n * 1000;
    var d = Date.parse(h);
    return isNaN(d) ? null : Math.max(0, d - Date.now());
  }

  /* Правдоподобное тело ответа для имитации. Здоровье системы отдаём
     покомпонентно — иначе на странице состояния нечего показывать. */
  function fakeBody(path) {
    if (path.indexOf('/api/health') !== -1) {
      var bad = !!(scene && scene.degraded);
      return JSON.stringify({
        ok: !bad,
        version: '1.4.2',
        time: new Date().toISOString(),
        uptimeSec: bad ? 214 : 396120,
        parts: [
          { id: 'db', name: 'База событий', ok: true, ms: 3 },
          { id: 'mqtt', name: 'MQTT · Mosquitto', ok: !bad, ms: bad ? null : 11,
            why: bad ? 'брокер не принимает подключение' : null,
            since: bad ? new Date(Date.now() - 26 * 60000).toISOString() : null },
          { id: 'frigate', name: 'Frigate NVR', ok: !bad, ms: bad ? null : 42,
            why: bad ? 'не отвечает на /api/version' : null,
            since: bad ? new Date(Date.now() - 24 * 60000).toISOString() : null },
          { id: 'cams', name: 'Камеры', ok: true, note: '2 из 2 отдают поток' },
          { id: 'radar', name: 'Радары падения', ok: true, note: '2 из 2 на связи' },
          { id: 'media', name: 'Хранилище кадров', ok: true, note: 'свободно 118 ГБ' }
        ]
      });
    }
    /* Бэкенда пока нет: на успешных сценариях отдаём пустой,
       но правильный по форме ответ. Лента подставит тестовые записи. */
    return '{"items":[],"nextCursor":null}';
  }

  /* Подделка ответа для ?fail=… Возвращает Promise как настоящий fetch,
     включая отказы, чтобы дальше по коду ничего не ветвилось. */
  function simulate(method, path, ms) {
    if (!scene) return null;
    var wait = scene.ms || 60;

    // Сценарий «только чтение»: GET проходит как обычно.
    if (scene.writeOnly && method === 'GET') {
      return new Promise(function (ok) {
        setTimeout(function () {
          ok(new Response(fakeBody(path), { status: 200,
            headers: { 'content-type': 'application/json' } }));
        }, 60);
      });
    }

    if (scene.net === 'hang') {
      /* Соединение приняли и молчат. В жизни такой запрос убивает наш
         же таймер, поэтому и здесь отвечаем ровно тем, чем ответил бы
         AbortController — иначе имитация вела бы себя мягче реальности. */
      return new Promise(function (_, no) {
        setTimeout(function () {
          var e = new Error('The operation was aborted');
          e.name = 'AbortError';
          no(e);
        }, ms);
      });
    }
    if (scene.net === 'reject') {
      return new Promise(function (_, no) {
        setTimeout(function () {
          no(new TypeError('Failed to fetch'));    // ровно то, что даёт браузер
        }, Math.min(wait, ms - 100));
      });
    }
    if (scene.status) {
      var body = scene.html
            ? '<!doctype html><title>502 Bad Gateway</title><h1>502 Bad Gateway</h1>'
        : scene.badjson ? '{"items":[{"id":"e1042","ts":'
        : scene.shape   ? '{"data":{"records":[]},"apiVersion":"3.0"}'
        : scene.status >= 400
            ? JSON.stringify({ error: {
                code: ({ 401: 'session_expired', 403: 'forbidden', 404: 'not_found',
                         429: 'rate_limited', 500: 'internal', 502: 'upstream_down',
                         503: 'starting', 504: 'upstream_timeout',
                         530: 'tunnel_down' })[scene.status] || 'error',
                message: scene.title,
                requestId: 'r_sim_' + Math.random().toString(36).slice(2, 10) } })
            : fakeBody(path);

      var head = { 'content-type': scene.html ? 'text/html' : 'application/json' };
      if (scene.retryAfter) head['retry-after'] = String(scene.retryAfter);

      var delay = scene.slowMs || wait;
      return new Promise(function (ok) {
        setTimeout(function () {
          ok(new Response(body, { status: scene.status, headers: head }));
        }, delay);
      });
    }
    return null;
  }

  function once(method, path, body, timeout) {
    var started = t0();
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, timeout);

    var opts = {
      method: method,
      signal: ctl.signal,
      credentials: 'include',            // сессия живёт в HttpOnly-куке
      cache: 'no-store',
      headers: { 'accept': 'application/json' }
    };
    if (body !== undefined && body !== null) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    var call = simulate(method, path, timeout) || fetch(full(path), opts);

    return call.then(function (res) {
      clearTimeout(timer);
      var ms = Math.round(t0() - started);
      var rid = res.headers.get('x-request-id') || null;

      return res.text().then(function (text) {
        var ct = res.headers.get('content-type') || '';
        var data = null, broken = false;
        if (text) {
          try { data = JSON.parse(text); } catch (e) { broken = true; }
        }

        if (!res.ok) {
          throw ApiError('http', {
            status: res.status, statusText: res.statusText, ms: ms,
            url: full(path), method: method, requestId: (data && data.error &&
              data.error.requestId) || rid,
            server: data && data.error ? data.error : null,
            retryAfter: retryAfterMs(res.headers.get('retry-after')),
            html: /text\/html/i.test(ct)
          });
        }
        /* Ответ 200, но не JSON — почти всегда значит, что до нас отвечает
           кто-то другой: заглушка хостинга, страница ошибки, или гостевой
           Wi-Fi, который подсовывает свою страницу входа. */
        if (broken || (text && !/json/i.test(ct))) {
          throw ApiError('parse', {
            status: res.status, ms: ms, url: full(path), method: method,
            requestId: rid, html: /text\/html|<html/i.test(ct + text.slice(0, 80)),
            sample: text.slice(0, 140)
          });
        }
        return { data: data, ms: ms, requestId: rid, status: res.status };
      });
    }, function (err) {
      clearTimeout(timer);
      var ms = Math.round(t0() - started);
      throw ApiError(err && err.name === 'AbortError' ? 'timeout' : 'network', {
        ms: ms, url: full(path), method: method, raw: String(err && err.message || err)
      });
    });
  }

  /* Повторяем только то, что безопасно повторять: GET и явные «зайди
     позже» (429/503). Повторить POST на удаление — значит удалить дважды. */
  function canRetry(err, method) {
    if (method !== 'GET') return false;
    if (err.kind === 'network' || err.kind === 'timeout') return true;
    if (err.kind !== 'http') return false;
    return err.status === 429 || err.status === 502 ||
           err.status === 503 || err.status === 504;
  }

  function send(method, path, body, opt) {
    opt = opt || {};
    var timeout = opt.timeout || (method === 'GET' ? TIMEOUT.get : TIMEOUT.write);
    var left = opt.tries || (method === 'GET' ? TRIES : 1);

    function attempt(n) {
      return once(method, path, body, timeout).catch(function (err) {
        if (n >= left || !canRetry(err, method)) throw err;
        /* Пауза растёт, плюс разброс: если связь оборвалась у всех сразу,
           не надо всем возвращаться в одну и ту же миллисекунду. */
        var wait = err.retryAfter && err.retryAfter < 10000
          ? err.retryAfter
          : (n === 1 ? 400 : 1400) + Math.random() * 300;
        return new Promise(function (r) { setTimeout(r, wait); }).then(function () {
          return attempt(n + 1);
        });
      });
    }
    return attempt(1);
  }

  /* ========================================================== диагноз */

  /* Каждый диагноз отвечает на три вопроса и ни на один лишний:
       что сломалось · почему именно так решили · что делать.
     hint — для любого человека, ops — команды для владельца системы,
     их показываем только ему. */
  function D(o) {
    o.hint = o.hint || [];
    o.ops = o.ops || [];
    return o;
  }

  var HTTP = {
    400: function (e) { return D({
      code: 'app.bad_request', where: 'app', level: 'warn', retry: false,
      title: 'Сервер не понял запрос',
      why: 'Страница отправила данные в том виде, которого сервер не ждёт. ' +
           'Обычно так бывает после обновления одной стороны без другой.',
      hint: ['Обновите страницу с очисткой кэша — Ctrl+Shift+R.'] }); },
    401: function (e) { return D({
      code: 'auth.expired', where: 'auth', level: 'warn', retry: false, signin: true,
      title: 'Вход больше не действует',
      why: 'Сервер отвечает, всё цело — просто сессия закончилась. Так и ' +
           'задумано: журнал не должен оставаться открытым вечно.',
      hint: ['Войдите заново — записи на месте.'] }); },
    403: function (e) { return D({
      code: 'auth.forbidden', where: 'auth', level: 'warn', retry: false,
      title: 'Этот журнал не ваш',
      why: 'Вы вошли, но у этой учётной записи нет доступа к этому дому.',
      hint: ['Проверьте, под каким телефоном или почтой вы вошли.'] }); },
    404: function (e) { return D({
      code: 'app.route', where: 'app', level: 'warn', retry: false,
      title: 'Сервер отвечает, но такого адреса у него нет',
      why: 'Дозвонились до приложения, а нужного раздела API там нет. Значит ' +
           'страница и сервер разных версий, либо запрос ушёл не на тот адрес.',
      hint: ['Обновите страницу.'],
      ops: ['проверьте маршрут в reverse proxy: ' + e.url,
            'сверьте версию: GET /api/health → version'] }); },
    408: function () { return HTTP[504](); },
    429: function (e) { return D({
      code: 'app.rate', where: 'app', level: 'warn', retry: true,
      title: 'Слишком много запросов подряд',
      why: 'Сервер жив и намеренно притормаживает — защита от перебора. ' +
           (e.retryAfter ? 'Он просит подождать ' +
              Math.ceil(e.retryAfter / 1000) + ' с.' : ''),
      hint: ['Подождите полминуты и повторите.'] }); },
    500: function (e) { return D({
      code: 'server.internal', where: 'server', level: 'crit', retry: true,
      title: 'Сервер поймал ошибку внутри себя',
      why: 'Связь целая, запрос дошёл. Упал сам обработчик — это не у вас, ' +
           'это на стороне системы.',
      hint: ['Повторите. Если повторяется — сообщите номер запроса ниже.'],
      ops: ['journalctl -u bekavod-api -n 200 --no-pager',
            'ищите по номеру запроса: ' + (e.requestId || '—')] }); },
    502: function (e) { return D({
      code: 'link.gateway', where: 'link', level: 'crit', retry: true,
      title: 'Шлюз на месте, а сервер за ним не ответил',
      why: 'До входной двери мы дошли, а комната за ней пустая: приложение ' +
           'не запущено или упало, а туннель/прокси остался стоять.',
      hint: ['Проверьте, включена ли коробка дома.'],
      ops: ['docker compose ps', 'systemctl status cloudflared',
            'curl -sS http://127.0.0.1:8080/api/health'] }); },
    503: function (e) { return D({
      code: 'server.starting', where: 'server', level: 'warn', retry: true,
      title: 'Сервис ещё поднимается',
      why: 'Сервер отвечает честно: сейчас он не готов принимать запросы. ' +
           'Так бывает первую минуту после перезапуска или во время работ.' +
           (e.retryAfter ? ' Просит вернуться через ' +
              Math.ceil(e.retryAfter / 1000) + ' с.' : ''),
      hint: ['Подождите минуту и обновите страницу.'],
      ops: ['docker compose logs --tail 80 api'] }); },
    504: function (e) { return D({
      code: 'link.gwtimeout', where: 'link', level: 'crit', retry: true,
      title: 'Шлюз ждал дом и не дождался',
      why: 'Запрос дошёл до Cloudflare, тот постучался домой и не получил ' +
           'ответа вовремя. Коробка либо занята под завязку, либо связь у ' +
           'неё еле живая.',
      hint: ['Повторите через минуту.'],
      ops: ['uptime и iotop на хосте', 'docker stats --no-stream',
            'проверьте, не идёт ли перестройка индексов/бэкап'] })}
  };
  function cloudflare(e) {
    var map = {
      520: 'край Cloudflare получил из дома невнятный ответ',
      521: 'дом отказал в соединении — процесс не слушает порт',
      522: 'дом не ответил на соединение вовремя',
      523: 'дом недостижим — обычно сбита DNS-запись origin',
      524: 'дом принял соединение, но ответ не прислал',
      525: 'не сложилось TLS-рукопожатие с домом',
      530: 'туннель не найден (Argo 1033) — cloudflared не подключён'
    };
    return D({
      code: 'link.cloudflare', where: 'link', level: 'crit', retry: true,
      title: 'Cloudflare на месте, дом — нет',
      why: 'Ошибку нарисовал край Cloudflare, а не наш сервер: ' +
           (map[e.status] || 'связь с origin нарушена') + '. Значит домен ' +
           'жив, интернет жив, а до коробки в Явне дозвониться не вышло.',
      hint: ['Похоже, дома пропало электричество или интернет.'],
      ops: ['systemctl status cloudflared', 'journalctl -u cloudflared -n 100 --no-pager',
            'cloudflared tunnel info <name>'] });
  }

  function fromHttp(e) {
    if (e.status >= 520 && e.status <= 530) return cloudflare(e);
    var f = HTTP[e.status];
    if (f) return f(e);
    if (e.status >= 500) return HTTP[500](e);
    return D({
      code: 'app.http', where: 'app', level: 'warn', retry: e.status !== 400,
      title: 'Сервер ответил ошибкой ' + e.status,
      why: (e.server && e.server.message) || 'Причину сервер не объяснил.',
      hint: ['Повторите запрос.'] });
  }

  /* Разбор сетевого отказа — тот самый случай, когда браузер молчит. */
  function fromNetwork(e) {
    if (mixedContent()) {
      return Promise.resolve(D({
        code: 'net.mixed', where: 'app', level: 'crit', retry: false,
        title: 'Страница по https, а API по http',
        why: 'Браузер режет такой запрос ещё до отправки — и правильно ' +
             'делает: наполовину зашифрованная связь не защищает ничего.',
        hint: ['Это ошибка настройки сайта, не ваша.'],
        ops: ['выдайте API сертификат и смените meta[name="api-base"] на https'] }));
    }
    if (!online()) {
      return Promise.resolve(D({
        code: 'net.offline', where: 'device', level: 'warn', retry: true,
        title: 'Интернет пропал на этом устройстве',
        why: 'Само устройство сообщает, что сети нет. С домом и сервером ' +
             'при этом может быть всё в порядке.',
        hint: ['Проверьте Wi-Fi или мобильные данные.',
               'Страница обновится сама, как только связь вернётся.'] }));
    }
    return probeSite().then(function (siteOk) {
      if (!siteOk) {
        return D({
          code: 'net.dead', where: 'device', level: 'warn', retry: true,
          title: 'Связи нет ни с чем',
          why: 'Значок сети горит, но не открывается даже сам сайт. Так ' +
               'выглядит Wi-Fi без интернета: точка есть, дальше неё — нет.',
          hint: ['Переключитесь на мобильный интернет и попробуйте снова.',
                 'Если вы в кафе или в отеле — возможно, нужно принять их ' +
                 'условия на странице входа.'] });
      }
      return probeApi().then(function (apiOk) {
        if (apiOk) {
          /* Картинка с того же адреса загрузилась. Приложение живо и
             достижимо — значит ответ зарубил сам браузер. */
          return D({
            code: 'net.cors', where: 'app', level: 'crit', retry: false,
            title: 'Сервер отвечает, но браузер не пустил ответ',
            why: 'Проверочная картинка с адреса API загрузилась — значит ' +
                 'приложение работает и доступно. А обычный запрос браузер ' +
                 'отбросил: на ответе нет разрешения для домена ' +
                 location.hostname + '. Это настройка сервера, не поломка.',
            hint: ['Со стороны пользователя ничего сделать нельзя.'],
            ops: ['Access-Control-Allow-Origin: https://' + location.hostname,
                  'Access-Control-Allow-Credentials: true',
                  'Access-Control-Expose-Headers: X-Request-Id, Retry-After',
                  'отдельно проверьте ответ на предварительный OPTIONS'] });
        }
        var fast = e.kind !== 'timeout' && e.ms < 800;
        return D({
          code: fast ? 'link.refused' : 'link.silent',
          where: 'link', level: 'crit', retry: true,
          title: fast ? 'По адресу API никто не отвечает'
                      : 'Запрос ушёл в никуда и не вернулся',
          why: fast
            ? 'Интернет есть, сайт открывается, а вот адрес ' + apiOrigin() +
              ' отказал сразу, за ' + e.ms + ' мс. Мгновенный отказ значит ' +
              'одно из двух: имя не разрешилось в адрес, либо разрешилось, ' +
              'но никто не слушает порт.'
            : 'Интернет есть, сайт открывается, а от ' + apiOrigin() +
              ' ответа не было ' + Math.round(e.ms / 1000) + ' с. Так ведёт ' +
              'себя не «выключено», а «зависло»: соединение принимают и ' +
              'молчат, или пакеты глотает файрвол по дороге.',
          hint: ['Скорее всего, дома выключили свет или пропал интернет.',
                 'Если дом на месте — перезапустите коробку.'],
          ops: fast
            ? ['dig +short ' + apiOrigin().replace(/^https?:\/\//, ''),
               'systemctl status cloudflared',
               'ss -ltnp | grep 8080']
            : ['ping -c4 8.8.8.8 с хоста',
               'journalctl -u cloudflared -n 100 --no-pager',
               'docker compose ps — не висит ли контейнер в restarting'] });
      });
    });
  }

  function fromParse(e) {
    if (e.html) {
      return D({
        code: 'app.notours', where: 'link', level: 'crit', retry: true,
        title: 'По этому адресу отвечает не наша система',
        why: 'Вместо данных пришла обычная веб-страница. Так отвечает ' +
             'заглушка хостинга, чужая страница ошибки или гостевой Wi-Fi, ' +
             'который перехватывает всё подряд и подсовывает свой вход.',
        hint: ['Если вы в кафе, отеле или аэропорту — откройте любой сайт и ' +
               'примите условия их сети.'],
        ops: ['curl -i ' + e.url + ' — посмотрите, кто именно отвечает'] });
    }
    return D({
      code: 'app.truncated', where: 'server', level: 'crit', retry: true,
      title: 'Ответ пришёл обрезанным',
      why: 'Данные начали приходить и оборвались на середине — до конца ' +
           'JSON не дожил. Обычно это разрыв связи прямо посреди передачи ' +
           'или сервер, которого убили на полуслове.',
      hint: ['Повторите — чаще всего со второго раза проходит.'],
      ops: ['ищите OOM-killer: dmesg -T | tail -40'] });
  }

  function fromShape(e) {
    return D({
      code: 'app.shape', where: 'app', level: 'warn', retry: false,
      title: 'Сервер говорит на другом языке',
      why: 'Ответ пришёл целым и правильным JSON, но полей, которых ждёт ' +
           'страница, в нём нет. Значит сервер обновили, а страницу — нет ' +
           '(или наоборот).',
      hint: ['Обновите страницу с очисткой кэша — Ctrl+Shift+R.'],
      ops: ['сверьте версии: GET /api/health → version и <meta name="app-version">'] });
  }

  /* Единая точка: на входе ошибка, на выходе — обещание диагноза.
     Обещание, потому что часть выводов требует проб по сети. */
  function diagnose(err) {
    var e = err || {};
    var base;
    if (e.kind === 'http')   base = Promise.resolve(fromHttp(e));
    else if (e.kind === 'parse') base = Promise.resolve(fromParse(e));
    else if (e.kind === 'shape') base = Promise.resolve(fromShape(e));
    else base = fromNetwork(e);

    return base.then(function (d) {
      d.tech = {
        url: e.url || null,
        method: e.method || null,
        status: e.status || null,
        ms: e.ms != null ? e.ms : null,
        requestId: e.requestId || null,
        kind: e.kind || 'network',
        raw: e.raw || (e.server && e.server.code) || null,
        when: new Date().toISOString(),
        page: location.href,
        agent: navigator.userAgent
      };
      return d;
    });
  }

  /* ======================================================= внешний вид */
  window.API = {
    base: BASE,
    origin: apiOrigin,
    scenes: SCENES,
    /* Порядок для показа: от «это у вас» к «это у нас», а не как ключи
       легли в объекте — там числовые имена всегда всплывают наверх. */
    sceneOrder: ['offline', 'isp', 'refused', 'hang', 'timeout', 'cors', 'mixed',
                 '502', '504', '530', '503', '500', '429', '401', '403', '404',
                 'html', 'badjson', 'version', 'write', 'degraded', 'slow'],
    sim: SIM,
    simulated: !!scene,
    ping: PING,

    get:  function (p, o) { return send('GET', p, null, o); },
    post: function (p, b, o) { return send('POST', p, b || {}, o); },
    del:  function (p, o) { return send('DELETE', p, null, o); },

    /* Запрос с проверкой формы ответа: пусть лучше страница честно
       скажет «версии разъехались», чем нарисует пустую ленту. */
    getShaped: function (p, need, o) {
      return send('GET', p, null, o).then(function (r) {
        for (var i = 0; i < need.length; i++) {
          if (!(need[i] in (r.data || {}))) {
            throw ApiError('shape', { url: full(p), method: 'GET',
              ms: r.ms, requestId: r.requestId, status: r.status });
          }
        }
        return r;
      });
    },

    probeSite: probeSite,
    probeApi: probeApi,
    mixedContent: mixedContent,
    online: online,
    diagnose: diagnose,
    error: ApiError
  };
})();
