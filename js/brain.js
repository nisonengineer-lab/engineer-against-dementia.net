/* ==========================================================================
   BeKavod — «мозг» наблюдения.

   Живая сетка узлов внутри силуэта мозга. Никаких библиотек: точки
   раскидываются случайно и отбраковываются по Path2D — попала внутрь
   силуэта, оставляем; не попала, бросаем заново. Так форма задаётся одним
   контуром, а не руками расставленными координатами.

   Что происходит в кадре:
     • узлы медленно дрейфуют; вышел за контур — скорость разворачивается
     • соседи ближе порога соединяются линией, прозрачность от расстояния
     • по случайным рёбрам бегут импульсы — это и есть «наблюдение идёт»
     • рядом с курсором узлы разгораются и тянутся к нему нитями

   Экономим батарею: считаем только когда блок в кадре и вкладка видима.
   При «меньше движения» рисуем один статичный кадр и выходим.
   ========================================================================== */
(function () {
  var canvas = document.getElementById('brain');
  if (!canvas || !canvas.getContext) return;

  var ctx = canvas.getContext('2d');
  var still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Палитра берётся из CSS, чтобы холст не разъезжался с сайтом по цвету. */
  var css = getComputedStyle(document.documentElement);
  var ACCENT = (css.getPropertyValue('--accent') || '#F0A868').trim();
  var HOT = (css.getPropertyValue('--accent-hi') || '#F6B87E').trim();

  function rgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
  }
  var A = rgb(ACCENT), H = rgb(HOT);
  function ink(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }

  /* ---- силуэт ----------------------------------------------------------
     Один замкнутый контур в системе 0…1000: лоб слева, темя сверху,
     височная доля внизу слева, ствол по центру вниз, мозжечок справа.
     Собран кривыми Безье — из склеенных эллипсов мозг не читается,
     пересечения дают дыры при заливке nonzero. */
  var path, W = 0, Ht = 0, dpr = 1;

  function buildPath(w, h) {
    var p = new Path2D();
    var s = Math.min(w, h) / 1000 * 0.94;
    var ox = (w - 1000 * s) / 2, oy = (h - 1000 * s) / 2;
    var X = function (v) { return v * s + ox; };
    var Y = function (v) { return v * s + oy; };
    var C = function (a, b, c, d, e, f) {
      p.bezierCurveTo(X(a), Y(b), X(c), Y(d), X(e), Y(f));
    };

    p.moveTo(X(470), Y(70));
    C(300, 78, 175, 180, 150, 320);    // лоб
    C(136, 400, 160, 455, 205, 490);   // переход к виску
    C(160, 530, 155, 600, 200, 645);   // височная доля
    C(245, 690, 330, 700, 400, 678);   // её низ
    C(440, 665, 470, 645, 500, 640);
    C(540, 636, 575, 650, 600, 672);   // основание
    C(596, 730, 600, 800, 612, 860);   // ствол вниз
    C(618, 886, 660, 886, 664, 858);
    C(672, 796, 668, 736, 676, 700);   // ствол вверх
    C(740, 720, 806, 700, 838, 650);   // мозжечок снизу
    C(872, 598, 866, 540, 830, 505);   // мозжечок сверху
    C(880, 470, 900, 400, 884, 320);   // затылок
    C(860, 180, 680, 62, 470, 70);     // темя
    p.closePath();
    return p;
  }

  /* ---- узлы ---- */
  var seed = 20260817;
  function rnd() {                       // свой генератор: форма повторяема
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  }

  var nodes = [], links = [], pulses = [];
  var LINK = 0;                          // порог связи, считается от размера

  /* isPointInPath сравнивает точку в НЕтрансформированных координатах,
     а сам контур прогоняет через текущую матрицу. При dpr=2 контур
     раздувается вдвое, и точки разъезжаются с силуэтом. Поэтому проверку
     ведём в отдельном контексте с единичной матрицей. */
  var hit = document.createElement('canvas').getContext('2d');
  function inside(x, y) { return hit.isPointInPath(path, x, y); }

  function seedNodes(count) {
    nodes.length = 0;
    var guard = count * 400;
    while (nodes.length < count && guard-- > 0) {
      var x = rnd() * W, y = rnd() * Ht;
      if (!inside(x, y)) continue;
      var a = rnd() * Math.PI * 2, v = 0.06 + rnd() * 0.16;
      nodes.push({
        x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        r: 0.9 + rnd() * 1.9,
        ph: rnd() * Math.PI * 2,          // фаза мерцания
        sp: 0.6 + rnd() * 1.1
      });
    }
  }

  function resize() {
    var box = canvas.getBoundingClientRect();
    if (!box.width) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = box.width; Ht = box.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(Ht * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    path = buildPath(W, Ht);
    LINK = Math.min(W, Ht) * 0.17;
    seed = 20260817;
    seedNodes(Math.round(Math.min(W, Ht) / 2.3));   // плотность от размера
    pulses.length = 0;
  }

  /* ---- курсор ---- */
  var mx = -1e4, my = -1e4;
  if (!still) {
    canvas.addEventListener('pointermove', function (e) {
      var b = canvas.getBoundingClientRect();
      mx = e.clientX - b.left; my = e.clientY - b.top;
    }, { passive: true });
    canvas.addEventListener('pointerleave', function () { mx = my = -1e4; }, { passive: true });
  }

  /* ---- кадр ---- */
  var t = 0;

  function step() {
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var nx = n.x + n.vx, ny = n.y + n.vy;
      if (inside(nx, ny)) { n.x = nx; n.y = ny; }
      else { n.vx = -n.vx; n.vy = -n.vy; }   // упёрлись в контур — назад
    }

    // новый импульс по случайному ребру
    if (links.length && pulses.length < 7 && rnd() < 0.05) {
      var l = links[(rnd() * links.length) | 0];
      pulses.push({ a: l[0], b: l[1], k: 0, v: 0.012 + rnd() * 0.02 });
    }
    for (var j = pulses.length - 1; j >= 0; j--) {
      pulses[j].k += pulses[j].v;
      if (pulses[j].k > 1) pulses.splice(j, 1);
    }
  }

  function draw() {
    ctx.clearRect(0, 0, W, Ht);

    // тёплое свечение в глубине — «ядро»
    var g = ctx.createRadialGradient(W * 0.47, Ht * 0.52, 0, W * 0.47, Ht * 0.52, Math.min(W, Ht) * 0.52);
    g.addColorStop(0, ink(H, 0.13));
    g.addColorStop(0.55, ink(A, 0.05));
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, Ht);

    // еле заметная обводка силуэта — глаз достраивает по ней форму мозга
    ctx.strokeStyle = ink(A, 0.13);
    ctx.lineWidth = 1;
    ctx.stroke(path);

    // рёбра
    links.length = 0;
    ctx.lineWidth = 1;
    for (var i = 0; i < nodes.length; i++) {
      for (var k = i + 1; k < nodes.length; k++) {
        var a = nodes[i], b = nodes[k];
        var dx = a.x - b.x, dy = a.y - b.y;
        var d2 = dx * dx + dy * dy;
        if (d2 > LINK * LINK) continue;
        var d = Math.sqrt(d2);
        links.push([i, k]);
        var al = (1 - d / LINK) * 0.42;
        // рядом с курсором связи разгораются
        var cx = (a.x + b.x) / 2 - mx, cy = (a.y + b.y) / 2 - my;
        var near = Math.max(0, 1 - Math.sqrt(cx * cx + cy * cy) / (LINK * 1.25));
        ctx.strokeStyle = ink(near > 0 ? H : A, al + near * 0.5);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    // импульсы
    for (var p = 0; p < pulses.length; p++) {
      var s = pulses[p], na = nodes[s.a], nb = nodes[s.b];
      if (!na || !nb) continue;
      var px = na.x + (nb.x - na.x) * s.k, py = na.y + (nb.y - na.y) * s.k;
      var fade = Math.sin(s.k * Math.PI);
      ctx.fillStyle = ink(H, 0.9 * fade);
      ctx.beginPath(); ctx.arc(px, py, 1.9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = ink(H, 0.18 * fade);
      ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.fill();
    }

    // узлы
    for (var n2 = 0; n2 < nodes.length; n2++) {
      var nd = nodes[n2];
      var puls = 0.55 + 0.45 * Math.sin(t * 0.02 * nd.sp + nd.ph);
      var dxm = nd.x - mx, dym = nd.y - my;
      var hot = Math.max(0, 1 - Math.sqrt(dxm * dxm + dym * dym) / (LINK * 1.15));
      ctx.fillStyle = ink(hot > 0.02 ? H : A, 0.35 + puls * 0.45 + hot * 0.5);
      ctx.beginPath();
      ctx.arc(nd.x, nd.y, nd.r * (1 + hot * 0.8), 0, Math.PI * 2);
      ctx.fill();
      if (nd.r > 2.2) {                       // крупным — ореол
        ctx.fillStyle = ink(A, 0.10 * puls);
        ctx.beginPath(); ctx.arc(nd.x, nd.y, nd.r * 4.5, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  /* ---- цикл ---- */
  var raf = null, visible = false;

  function loop() {
    t++; step(); draw();
    raf = requestAnimationFrame(loop);
  }
  function start() { if (!raf && visible && !document.hidden && !still) raf = requestAnimationFrame(loop); }
  function stop() { if (raf) { cancelAnimationFrame(raf); raf = null; } }

  resize();
  draw();                                  // первый кадр — сразу, без ожидания
  if (still) return;

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (es) {
      visible = es[0].isIntersecting;
      visible ? start() : stop();
    }, { rootMargin: '80px' }).observe(canvas);
  } else { visible = true; start(); }

  document.addEventListener('visibilitychange', function () {
    document.hidden ? stop() : start();
  });

  var rt = null;
  addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () { resize(); draw(); }, 150);
  }, { passive: true });
})();
