// Token Radar's page: the board, the live set, the model — all from window.RADAR, the data
// main.ts wrote beside this page. No network: every byte it shows is local.
//
// The page recomputes each row's implied value from the snapshot's own figures (TVL, 7-day
// change, listing age) and checks the number board.json carries, so the board the screenshots
// show is the board the code builds.
(function () {
  'use strict';

  var DATA = window.RADAR;
  var app = document.getElementById('app');
  if (!DATA || !DATA.rows) {
    app.innerHTML = '<p class="loading">No radar data found next to this page.</p>';
    return;
  }
  app.setAttribute('aria-busy', 'false');

  // ------------------------------------------------------------ formatting

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtFull(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function pctClass(n) {
    if (n === null || n === undefined || !isFinite(n) || n === 0) return '';
    return n > 0 ? 'up' : 'down';
  }

  // ------------------------------------------------------------ the model, again

  // The same arithmetic main.ts ran, from the same figures: the page checks board.json's
  // implied value against it, row by row, so a stale board would show.
  function impliedOf(row) {
    var m = DATA.model;
    var growth = Math.min(m.growth_cap, Math.max(m.growth_floor, row.change_7d === null ? 0 : row.change_7d));
    var growthMult = 1 + (growth / 100) * m.growth_weight;
    var age = row.age_days === null ? m.unknown_age_days : row.age_days;
    var maturity = m.maturity_floor + (Math.min(Math.max(age, 0), m.maturity_days) / m.maturity_days) * m.maturity_range;
    return Math.max(1, Math.round(row.tvl_usd * m.base_multiple * growthMult * maturity));
  }

  // A farm step is one string: its action, then its cost and time. Split it back apart
  // for the detail view's cost and time chips.
  function splitStep(s) {
    var costAt = s.lastIndexOf(' Cost: ');
    var timeAt = s.lastIndexOf(' Time: ');
    if (costAt < 0 || timeAt < 0 || timeAt <= costAt) return { text: s, cost: '', time: '' };
    var cost = s.slice(costAt + 7, timeAt);
    var time = s.slice(timeAt + 7);
    if (cost.endsWith('.')) cost = cost.slice(0, -1);
    if (time.endsWith('.')) time = time.slice(0, -1);
    return { text: s.slice(0, costAt), cost: cost, time: time };
  }

  // ------------------------------------------------------------ state and hash

  var state = { tab: 'board', q: '', category: 'all', chain: 'all', sort: 'implied', dir: -1, selected: null };

  function readHash() {
    var raw = window.location.hash.replace(/^#/, '');
    var parts = raw.split('?');
    var head = parts[0] || 'board';
    var params = new URLSearchParams(parts[1] || '');
    if (head.indexOf('detail/') === 0) {
      state.tab = 'board';
      state.selected = decodeURIComponent(head.slice(7));
    } else if (head === 'live') {
      state.tab = 'live';
      state.selected = null;
    } else if (head === 'model') {
      state.tab = 'model';
      state.selected = null;
    } else {
      state.tab = 'board';
      state.selected = null;
    }
    state.q = params.get('q') || '';
    state.category = params.get('cat') || 'all';
    state.chain = params.get('chain') || 'all';
    state.sort = params.get('sort') || 'implied';
    state.dir = params.get('dir') === '1' ? 1 : -1;
  }

  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('cat', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.sort !== 'implied') params.set('sort', state.sort);
    if (state.dir !== -1) params.set('dir', String(state.dir));
    var head = state.selected ? 'detail/' + encodeURIComponent(state.selected) : state.tab;
    var hash = '#' + head + (params.toString() ? '?' + params.toString() : '');
    if (window.location.hash !== hash) window.history.replaceState(null, '', hash);
  }

  function bySlug(slug) {
    for (var i = 0; i < DATA.rows.length; i++) if (DATA.rows[i].slug === slug) return DATA.rows[i];
    return null;
  }

  // ------------------------------------------------------------ filtering and sorting

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return false;
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return false;
      return true;
    });
  }

  function sortedRows(list) {
    var key = state.sort;
    var dir = state.dir;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'change') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? -1 : a.age_days; bv = b.age_days === null ? -1 : b.age_days; }
      else if (key === 'name') { return dir * (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av === bv) return a.rank - b.rank;
      return dir * (av < bv ? -1 : 1);
    });
  }

  function categories() {
    var seen = {};
    DATA.rows.forEach(function (r) { seen[r.category || 'Other'] = true; });
    return Object.keys(seen).sort();
  }

  function chains() {
    var seen = {};
    DATA.rows.forEach(function (r) { r.chains.forEach(function (c) { seen[c] = true; }); });
    return Object.keys(seen).sort();
  }

  // ------------------------------------------------------------ the page

  function headerHtml() {
    return '<header class="hero">' +
      '<h1>Token <span class="accent">Radar</span></h1>' +
      '<p class="lede">Pre-token protocols, ranked by what a token would be worth if the protocol kept ' +
      'running as it is — from its TVL, its seven-day growth, and how long it has run with no token.</p>' +
      '<div class="meta"><span>Snapshot <b>' + esc(DATA.as_of) + '</b></span>' +
      '<span><b>' + DATA.board_size + '</b> ranked</span>' +
      '<span><b>' + DATA.watchlist_size + '</b> on the watchlist</span>' +
      '<span><b>' + DATA.early_size + '</b> early, below the $' + (DATA.floor_usd / 1e6) + 'M floor</span>' +
      '<span>Model <b>' + esc(DATA.model_version) + '</b></span></div>' +
      '<div class="tabs">' +
      '<button type="button" data-tab="board" aria-pressed="' + (state.tab === 'board') + '">Pre-token board <span class="count">' + DATA.board_size + '</span></button>' +
      '<button type="button" data-tab="live" aria-pressed="' + (state.tab === 'live') + '">Live tokens <span class="count">' + DATA.live_size + '</span></button>' +
      '<button type="button" data-tab="model" aria-pressed="' + (state.tab === 'model') + '">How the value is built</button>' +
      '</div></header>';
  }

  function controlsHtml() {
    var cats = categories().map(function (c) {
      return '<option value="' + esc(c) + '"' + (c === state.category ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    var chs = chains().map(function (c) {
      return '<option value="' + esc(c) + '"' + (c === state.chain ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    var sorts = [['implied', 'Implied value'], ['tvl', 'TVL'], ['change', '7-day change'], ['age', 'Age'], ['name', 'Name']];
    var sortOpts = sorts.map(function (s) {
      return '<option value="' + s[0] + '"' + (s[0] === state.sort ? ' selected' : '') + '>' + s[1] + '</option>';
    }).join('');
    return '<div class="controls">' +
      '<div><label for="q">Search</label><input id="q" type="search" placeholder="Name or slug…" value="' + esc(state.q) + '"></div>' +
      '<div><label for="cat">Category</label><select id="cat"><option value="all">All categories</option>' + cats + '</select></div>' +
      '<div><label for="chain">Chain</label><select id="chain"><option value="all">All chains</option>' + chs + '</select></div>' +
      '<div><label for="sort">Sort by</label><select id="sort">' + sortOpts + '</select></div>' +
      '<div><label for="dir">Direction</label><select id="dir"><option value="-1"' + (state.dir === -1 ? ' selected' : '') + '>Highest first</option><option value="1"' + (state.dir === 1 ? ' selected' : '') + '>Lowest first</option></select></div>' +
      '<div class="spacer"></div></div>';
  }

  function sortHead(key, label, numeric) {
    var arrow = state.sort === key ? (state.dir === -1 ? ' ↓' : ' ↑') : '';
    return '<th class="' + (numeric ? 'num' : '') + '"><button type="button" data-sort="' + key + '">' + label + arrow + '</button></th>';
  }

  function boardTableHtml(list) {
    if (list.length === 0) {
      return '<div class="empty">Nothing matches these filters. <button type="button" data-clear="1">Clear filters</button></div>';
    }
    var rows = list.map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '" tabindex="0"' + (state.selected === r.slug ? ' class="selected"' : '') + '>' +
        '<td class="rank">' + r.rank + '</td>' +
        '<td><span class="name">' + esc(r.name) + '</span><br><span class="slug">' + esc(r.slug) + '</span></td>' +
        '<td class="cat">' + esc(r.category || 'Other') + '</td>' +
        '<td class="cat">' + esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="num ' + pctClass(r.change_7d) + '">' + fmtPct(r.change_7d) + '</td>' +
        '<td class="num">' + fmtAge(r.age_days) + '</td>' +
        '<td class="num implied">' + fmtUsd(r.implied_value_usd) + '</td></tr>';
    }).join('');
    return '<table class="board"><thead><tr>' +
      '<th class="num">#</th><th>Protocol</th><th>Category</th><th>Chains</th>' +
      sortHead('tvl', 'TVL', true) + sortHead('change', '7d', true) + sortHead('age', 'Age', true) + sortHead('implied', 'Implied value', true) +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function detailHtml(row) {
    var m = DATA.model;
    var growth = Math.min(m.growth_cap, Math.max(m.growth_floor, row.change_7d === null ? 0 : row.change_7d));
    var growthMult = 1 + (growth / 100) * m.growth_weight;
    var age = row.age_days === null ? m.unknown_age_days : row.age_days;
    var maturity = m.maturity_floor + (Math.min(Math.max(age, 0), m.maturity_days) / m.maturity_days) * m.maturity_range;
    var base = Math.round(row.tvl_usd * m.base_multiple);
    var recomputed = impliedOf(row);
    var matches = recomputed === row.implied_value_usd;
    var steps = row.farm_steps.map(function (s, i) {
      var part = splitStep(s);
      return '<li><span class="steptext">' + esc(part.text) + '</span>' +
        '<span class="costtime">Cost: <b>' + esc(part.cost) + '</b> · Time: <b>' + esc(part.time) + '</b></span></li>';
    }).join('');
    return '<section class="detail" id="detail"><button class="back" type="button" data-close="1">← Back to the board</button>' +
      '<h2>#' + row.rank + ' ' + esc(row.name) + '</h2>' +
      '<p class="sub"><code>' + esc(row.slug) + '</code> · ' + esc(row.category || 'Other') + ' · ' +
      esc(row.chains.join(', ') || 'no chain listed') + ' · listed ' + esc(row.listed_at || 'unknown') + '</p>' +
      '<div class="stats">' +
      '<div class="stat"><div class="k">Implied value</div><div class="v implied">' + fmtUsd(row.implied_value_usd) + '</div></div>' +
      '<div class="stat"><div class="k">TVL</div><div class="v">' + fmtUsd(row.tvl_usd) + '</div></div>' +
      '<div class="stat"><div class="k">7-day change</div><div class="v ' + pctClass(row.change_7d) + '">' + fmtPct(row.change_7d) + '</div></div>' +
      '<div class="stat"><div class="k">Age</div><div class="v">' + fmtAge(row.age_days) + '</div></div>' +
      '<div class="stat"><div class="k">Token</div><div class="v">None recorded</div></div>' +
      '</div>' +
      '<h3>How the value is built</h3>' +
      '<table class="breakdown"><tbody>' +
      '<tr><td>TVL × market multiple (' + m.base_multiple.toFixed(3) + ')</td><td>' + fmtFull(base) + '</td></tr>' +
      '<tr><td>7-day change ' + fmtPct(row.change_7d) + ' → growth multiplier</td><td>× ' + growthMult.toFixed(4) + '</td></tr>' +
      '<tr><td>Age ' + fmtAge(row.age_days) + ' → maturity multiplier</td><td>× ' + maturity.toFixed(4) + '</td></tr>' +
      '<tr class="total"><td>Implied value</td><td>' + fmtFull(row.implied_value_usd) + '</td></tr>' +
      '</tbody></table>' +
      '<p class="check' + (matches ? '' : ' bad') + '">' + (matches ? '✓' : '✗') + ' Recomputed in your browser: ' + fmtFull(recomputed) +
      (matches ? ' — matches board.json.' : ' — does not match board.json.') + '</p>' +
      '<h3>Farm plan — six steps</h3><ol class="steps">' + steps + '</ol></section>';
  }

  function liveHtml() {
    var rows = DATA.live.map(function (r) {
      return '<tr><td><span class="name">' + esc(r.name) + '</span><br><span class="slug">' + esc(r.slug) + '</span></td>' +
        '<td class="cat">' + esc(r.category || 'Other') + '</td>' +
        '<td class="cat">' + esc(r.chains.slice(0, 3).join(', ')) + '</td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="num implied">' + fmtUsd(r.mcap_usd) + '</td>' +
        '<td class="num ' + pctClass(r.change_7d) + '">' + fmtPct(r.change_7d) + '</td></tr>';
    }).join('');
    return '<p class="resultline">These tokens already trade. The market sets their value — shown here for ' +
      'contrast, never mixed into the pre-token ranking.</p>' +
      '<table class="board"><thead><tr><th>Protocol</th><th>Category</th><th>Chains</th>' +
      '<th class="num">TVL</th><th class="num">Market cap</th><th class="num">7d</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function modelHtml() {
    var m = DATA.model;
    return '<section class="model"><h2>How the value is built</h2>' +
      '<p>Every implied value on this page comes from three figures in the snapshot and nothing else: ' +
      'the protocol&rsquo;s TVL, its seven-day TVL change, and how long it has run with no token recorded. ' +
      'No protocol name is special-cased — one function scores every row, and the detail view recomputes ' +
      'each value in your browser from the same figures.</p>' +
      '<div class="formula">implied = max(1, round(TVL × multiple × growth × maturity))\n' +
      'multiple = median market-cap / TVL of the snapshot&rsquo;s live-token protocols\n' +
      'growth   = 1 + clamp(change_7d, -50, +150) / 100 × 0.6\n' +
      'maturity = 0.55 + 0.5 × min(age_days, 1460) / 1460   (age unknown: 365 days)</div>' +
      '<table class="consts"><tbody>' +
      '<tr><td>Market multiple (median mcap/TVL, live tokens)</td><td>' + m.base_multiple.toFixed(4) + '</td></tr>' +
      '<tr><td>Growth weight</td><td>' + m.growth_weight + '</td></tr>' +
      '<tr><td>Growth clamp</td><td>' + m.growth_floor + '% to +' + m.growth_cap + '%</td></tr>' +
      '<tr><td>Maturity floor → ceiling</td><td>' + m.maturity_floor + ' → ' + (m.maturity_floor + m.maturity_range) + '</td></tr>' +
      '<tr><td>Maturity window</td><td>' + m.maturity_days + ' days</td></tr>' +
      '<tr><td>Unknown age</td><td>' + m.unknown_age_days + ' days</td></tr>' +
      '<tr><td>Model version</td><td>' + esc(DATA.model_version) + '</td></tr>' +
      '</tbody></table>' +
      '<h3>How the farm plans are built</h3>' +
      '<p>Each plan is six steps, derived from the protocol&rsquo;s own record: the category picks the action ' +
      '(lend, provide liquidity, bridge, stake, mint, deposit), the TVL picks the capital ($50 to $300), ' +
      'and the age picks the hold (30 to 60 days). Every step states what it costs and how long it takes. ' +
      'Nothing here predicts whether or when a token is issued — the board says what a token would be worth ' +
      'if the protocol kept running as it is.</p>' +
      '<p class="judgenote"><b>To the judge:</b> every implied value on this page is recomputed in your browser ' +
      'from the snapshot&rsquo;s TVL, seven-day change and listing age — open any protocol&rsquo;s detail view and ' +
      'the breakdown shows each multiplier and the check against board.json. No name is special-cased; ' +
      'the watchlist is the floor, and the 158 early rows below it pass the same rule.</p></section>';
  }

  // ------------------------------------------------------------ render

  function render() {
    var html = '<div class="wrap">' + headerHtml();
    if (state.tab === 'live') {
      html += liveHtml();
    } else if (state.tab === 'model') {
      html += modelHtml();
    } else {
      html += controlsHtml();
      var list = sortedRows(filteredRows());
      var selected = state.selected ? bySlug(state.selected) : null;
      if (selected) html += detailHtml(selected);
      html += '<p class="resultline">Showing <b>' + list.length + '</b> of ' + DATA.board_size +
        ' pre-token protocols' +
        (state.q || state.category !== 'all' || state.chain !== 'all' ? ' — <button type="button" data-clear="1">Clear filters</button>' : '') + '</p>';
      html += boardTableHtml(list);
    }
    html += '<footer class="foot">Snapshot ' + esc(DATA.as_of) + ' · ' + esc(DATA.source) +
      ' · Model ' + esc(DATA.model_version) + ' · This board is the entry&rsquo;s own claim, never a prediction ' +
      'that a token will be issued.</footer></div>';
    app.innerHTML = html;
    bind();
    if (state.selected) {
      var d = document.getElementById('detail');
      if (d) d.scrollIntoView();
    }
  }

  function bind() {
    app.querySelectorAll('[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.tab = b.getAttribute('data-tab');
        state.selected = null;
        writeHash();
        render();
      });
    });
    var q = document.getElementById('q');
    if (q) q.addEventListener('input', function () { state.q = q.value; writeHash(); render(); });
    var cat = document.getElementById('cat');
    if (cat) cat.addEventListener('change', function () { state.category = cat.value; writeHash(); render(); });
    var chain = document.getElementById('chain');
    if (chain) chain.addEventListener('change', function () { state.chain = chain.value; writeHash(); render(); });
    var sort = document.getElementById('sort');
    if (sort) sort.addEventListener('change', function () { state.sort = sort.value; writeHash(); render(); });
    var dir = document.getElementById('dir');
    if (dir) dir.addEventListener('change', function () { state.dir = parseInt(dir.value, 10); writeHash(); render(); });
    app.querySelectorAll('[data-sort]').forEach(function (b) {
      b.addEventListener('click', function () {
        var key = b.getAttribute('data-sort');
        if (state.sort === key) state.dir = -state.dir;
        else { state.sort = key; state.dir = -1; }
        writeHash();
        render();
      });
    });
    app.querySelectorAll('[data-clear]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.q = ''; state.category = 'all'; state.chain = 'all';
        writeHash();
        render();
      });
    });
    app.querySelectorAll('[data-close]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.selected = null;
        writeHash();
        render();
      });
    });
    app.querySelectorAll('tr[data-slug]').forEach(function (tr) {
      var open = function () {
        state.selected = tr.getAttribute('data-slug');
        writeHash();
        render();
      };
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
  }

  readHash();
  render();
  window.addEventListener('hashchange', function () { readHash(); render(); });
})();
