/* ==========================================================================
   BeKavod — прорисовка проводов по скроллу.

   Идея простая: у всего раздела один общий «кончик провода». Его положение
   на странице = позиция скролла плюс 62% высоты экрана, то есть он идёт
   чуть ниже середины взгляда. Кончик только опускается и никогда не
   поднимается обратно — поэтому нарисованное остаётся нарисованным, даже
   если пролистать вверх. Это и есть «анимация происходит один раз».

   Дальше каждый кусок провода спрашивает: насколько кончик прошёл сквозь
   меня? Ответ 0…1 кладётся в --p, а CSS растягивает полоску scaleY.
   Когда кончик дошёл до развилки блока, блоку ставится .is-on — и уже CSS
   дочерчивает изгиб, подвод и проявляет картинки.

   Когда всё дорисовано, слушатель скролла снимается совсем: дальше
   считать нечего.

   Измеряем по offsetHeight и по рамке РОДИТЕЛЯ: у самих полосок в этот
   момент уже стоит transform, и getBoundingClientRect вернул бы сжатую
   высоту, а не настоящую.
   ========================================================================== */
(function () {
  var root = document.documentElement;
  var rail = document.querySelector('.rail');
  if (!rail) return;

  // Просили меньше движения — показываем всё сразу и уходим.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  root.classList.add('js-draw');          // прячем только когда скрипт жив

  var LOOK = 0.62;                        // где на экране идёт кончик провода
  var EASE = 0.16;                        // насколько кончик догоняет за кадр

  var lanes = [], nodes = [];
  var target = 0, shown = 0, done = false, raf = null, near = false;

  function measure() {
    var sy = window.scrollY;
    lanes = [];
    rail.querySelectorAll('.lane').forEach(function (el) {
      var box = el.parentElement.getBoundingClientRect();
      lanes.push({ el: el, top: box.top + sy, h: Math.max(el.offsetHeight, 1), p: -1 });
    });
    nodes = [];
    rail.querySelectorAll('.node').forEach(function (el) {
      // линия развилки — это высота подвода: он стоит ровно на ней
      var f = el.querySelector('[data-fork]') || el.querySelector('.feed') || el;
      nodes.push({ el: el, y: f.getBoundingClientRect().top + sy,
                   on: el.classList.contains('is-on') });
    });
  }

  function tipNow() {
    var sy = window.scrollY, ih = window.innerHeight;
    var doc = document.documentElement.scrollHeight;
    // Кончик идёт ниже экрана, поэтому последние ~38% страницы он бы не
    // достал никогда. Долистали до конца — считаем, что дошёл до дна.
    if (sy + ih >= doc - 2) return doc + ih;
    return sy + ih * LOOK;
  }

  function apply() {
    var all = true;

    for (var i = 0; i < lanes.length; i++) {
      var L = lanes[i];
      var p = (shown - L.top) / L.h;
      p = p < 0 ? 0 : p > 1 ? 1 : p;
      if (p !== L.p) {
        L.p = p;
        L.el.style.setProperty('--p', p.toFixed(4));
      }
      if (p < 1) all = false;
    }

    for (var j = 0; j < nodes.length; j++) {
      var N = nodes[j];
      if (!N.on && shown >= N.y) { N.on = true; N.el.classList.add('is-on'); }
      if (!N.on) all = false;
    }
    return all;
  }

  function loop() {
    raf = null;
    var t = tipNow();
    if (t > target) target = t;
    shown += (target - shown) * EASE;
    if (target - shown < 0.5) shown = target;

    var all = apply();

    if (all && shown === target) {           // дорисовали — можно замолчать
      done = true;
      window.removeEventListener('scroll', onScroll);
      lanes.forEach(function (L) { L.el.style.willChange = 'auto'; });
      return;
    }
    if (near) raf = requestAnimationFrame(loop);
  }

  function onScroll() {
    var t = tipNow();
    if (t > target) target = t;
    if (near && !raf && !done) raf = requestAnimationFrame(loop);
  }

  measure();
  target = shown = tipNow();
  apply();

  // Считаем только пока раздел рядом с экраном.
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (es) {
      near = es[0].isIntersecting;
      if (near && !raf && !done) {
        lanes.forEach(function (L) { L.el.style.willChange = 'transform'; });
        raf = requestAnimationFrame(loop);
      }
    }, { rootMargin: '200% 0px 200% 0px' }).observe(rail);
  } else {
    near = true; raf = requestAnimationFrame(loop);
  }

  window.addEventListener('scroll', onScroll, { passive: true });

  var rt = null;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () {
      // Снимаем трансформы, чтобы померить настоящую геометрию, и возвращаем.
      root.classList.remove('js-draw');
      measure();
      root.classList.add('js-draw');
      done = false; near = true;
      if (!raf) raf = requestAnimationFrame(loop);
    }, 160);
  }, { passive: true });
})();
