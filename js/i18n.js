/* ==========================================================================
   BeKavod — переключение языка.

   Тексты лежат в i18n/<код>.json. В разметке узлы помечены атрибутами:
       data-i18n="ключ"                   — подставить в содержимое узла
       data-i18n-attr="alt:ключ;title:.."  — подставить в атрибуты

   Какой язык показать, решается по порядку:
       1) ?lang=xx в адресе — чтобы можно было дать ссылку сразу на нужном
       2) выбор, сохранённый в прошлый раз
       3) язык браузера (navigator.languages, по первому совпадению)
       4) русский — основная аудитория проекта

   В разметке лежит русский текст. Значит без JS и без сети страница
   остаётся полностью читаемой, а не пустой: подмена только улучшает.

   ВАЖНО ПРО ЗАПУСК С ДИСКА. Если открыть index.html двойным кликом,
   адрес будет file://, и браузер запретит fetch к соседним файлам —
   это его собственная защита, из кода её не обойти. Тогда сайт молча
   остаётся на русском, а в консоль уходит понятное объяснение.
   Для проверки английского и иврита нужен любой статический сервер:
       python3 -m http.server 8000

   Иврит — RTL. Вёрстка написана на логических свойствах
   (inline-start/end вместо left/right), поэтому достаточно переставить
   dir у <html> — колонки, отступы и провода зеркалятся сами.
   ========================================================================== */
(function () {
  var LANGS = { ru: 1, en: 1, he: 1 };
  var RTL = { he: 1, ar: 1, fa: 1, ur: 1 };
  var FALLBACK = 'ru';
  var STORE = 'bekavod.lang';

  var root = document.documentElement;

  function saved() {
    try { return localStorage.getItem(STORE); } catch (e) { return null; }
  }
  function save(code) {
    try { localStorage.setItem(STORE, code); } catch (e) { /* приватный режим */ }
  }

  function fromBrowser() {
    var list = navigator.languages || [navigator.language || ''];
    for (var i = 0; i < list.length; i++) {
      var short = String(list[i]).toLowerCase().split('-')[0];
      // iw — старый код иврита, его до сих пор отдают некоторые браузеры
      if (short === 'iw') short = 'he';
      if (LANGS[short]) return short;
    }
    return null;
  }

  function pick() {
    var q = new URLSearchParams(location.search).get('lang');
    if (q && LANGS[q.toLowerCase()]) return q.toLowerCase();
    var s = saved();
    if (s && LANGS[s]) return s;
    return fromBrowser() || FALLBACK;
  }

  function explain(code, err) {
    if (location.protocol === 'file:') {
      console.warn('[i18n] Страница открыта с диска (file://), поэтому браузер ' +
        'не даёт загрузить i18n/' + code + '.json. Запустите статический сервер ' +
        'из папки сайта:  python3 -m http.server 8000  — и откройте ' +
        'http://localhost:8000/?lang=' + code);
    } else {
      console.warn('[i18n] не удалось загрузить i18n/' + code + '.json:',
                   err && err.message);
    }
  }

  /* ---- подстановка ---- */
  function paint(code, dict) {
    root.setAttribute('lang', code);
    root.setAttribute('dir', RTL[code] ? 'rtl' : 'ltr');

    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var v = dict[el.getAttribute('data-i18n')];
      if (v == null) return;                       // нет перевода — оставляем как есть
      if (el.tagName === 'TITLE') el.textContent = v;
      else el.innerHTML = v;                       // тексты свои, из наших же файлов
    });

    document.querySelectorAll('[data-i18n-attr]').forEach(function (el) {
      el.getAttribute('data-i18n-attr').split(';').forEach(function (pair) {
        var p = pair.split(':');
        if (p.length !== 2) return;
        var v = dict[p[1].trim()];
        if (v != null) el.setAttribute(p[0].trim(), v);
      });
    });

    mark(code);
    document.dispatchEvent(new CustomEvent('i18n:ready', { detail: { lang: code } }));
  }

  /* Отметить активный язык в обоих переключателях — в шапке и в подвале. */
  function mark(code) {
    document.querySelectorAll('[data-lang]').forEach(function (a) {
      var on = a.getAttribute('data-lang') === code;
      if (on) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    });
  }

  function apply(code) {
    // Русский уже лежит в разметке — грузить нечего.
    if (code === FALLBACK && !root.hasAttribute('data-i18n-painted')) {
      paint(code, {});
      return Promise.resolve();
    }
    return fetch('i18n/' + code + '.json', { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (dict) {
        root.setAttribute('data-i18n-painted', code);
        paint(code, dict);
      });
  }

  var start = pick();
  save(start);
  apply(start).catch(function (e) {
    explain(start, e);
    save(FALLBACK);            // не залипаем на языке, который не грузится
    paint(FALLBACK, {});
  });

  /* ---- клик по переключателю ---- */
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('[data-lang]');
    if (!a) return;
    e.preventDefault();
    var code = a.getAttribute('data-lang');
    if (!LANGS[code] || code === root.getAttribute('lang')) return;

    save(code);
    history.replaceState(null, '',
      code === FALLBACK ? location.pathname
                        : location.pathname + '?lang=' + code);

    // Русский лежит в разметке, а её мы уже перезаписали другим языком —
    // вернуть можно только перезагрузкой. Выбор уже сохранён.
    if (code === FALLBACK && root.hasAttribute('data-i18n-painted')) {
      location.reload();
      return;
    }
    apply(code).catch(function (err) {
      explain(code, err);
      save(root.getAttribute('lang') || FALLBACK);
      mark(root.getAttribute('lang') || FALLBACK);   // кнопка не должна врать
    });
  });
})();
